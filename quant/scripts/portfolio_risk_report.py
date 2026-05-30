"""
组合风险报告 — 从持仓文件读取真实数据。

持仓文件（二选一，均不提交 git）：
  quant/my_portfolio.json   — JSON 格式，含 input_type / risk_free / lookback 配置
  quant/my_portfolio.csv    — CSV 格式，两列：symbol,quantity（固定用 input_type=shares）

JSON 示例（input_type = "shares" / "value" / "weight"）：
  {
    "input_type": "shares",
    "risk_free": 0.045,
    "lookback": "2y",
    "holdings": {"AAPL": 10, "MSFT": 8, "SPY": 5}
  }

CSV 示例：
  symbol,quantity
  AAPL,10
  MSFT,8
  SPY,5

用法：
  cd quant
  python scripts/portfolio_risk_report.py [持仓文件路径]   # 默认 my_portfolio.json
"""
from __future__ import annotations

import json
import sys
import textwrap
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

from risk import compute_portfolio_risk

_QUANT_ROOT   = Path(__file__).resolve().parent.parent
_DEFAULT_JSON = _QUANT_ROOT / "my_portfolio.json"
_DEFAULT_CSV  = _QUANT_ROOT / "my_portfolio.csv"


# ── 持仓文件解析 ───────────────────────────────────────────────────────────────

def _load_json(path: Path) -> tuple[dict[str, float], str, float, str]:
    """返回 (holdings, input_type, risk_free, lookback)。"""
    data = json.loads(path.read_text(encoding="utf-8"))
    holdings = {k: float(v) for k, v in data["holdings"].items() if float(v) > 0}
    if not holdings:
        raise ValueError(
            f"{path} 里的持仓全为 0，请先填写真实持股数量或市值。"
        )
    return (
        holdings,
        data.get("input_type", "shares"),
        float(data.get("risk_free", 0.045)),
        data.get("lookback", "2y"),
    )


def _load_csv(path: Path) -> tuple[dict[str, float], str, float, str]:
    """CSV 固定 input_type=shares，risk_free/lookback 用默认值。"""
    df = pd.read_csv(path)
    # 列名容错：symbol/ticker/code + quantity/shares/value/weight
    col_map = {c.lower(): c for c in df.columns}
    sym_col = next(
        (col_map[k] for k in ("symbol", "ticker", "code") if k in col_map), None
    )
    qty_col = next(
        (col_map[k] for k in ("quantity", "shares", "qty", "value", "weight") if k in col_map),
        None,
    )
    if sym_col is None or qty_col is None:
        raise ValueError(
            f"{path} 缺少必要列。期望：symbol(或 ticker/code) + quantity(或 shares/value/weight)。"
            f"\n实际列：{list(df.columns)}"
        )
    holdings = {
        str(row[sym_col]).upper(): float(row[qty_col])
        for _, row in df.iterrows()
        if float(row[qty_col]) > 0
    }
    if not holdings:
        raise ValueError(f"{path} 里所有持仓数量为 0。")
    return holdings, "shares", 0.045, "2y"


def load_portfolio(path: Path | None = None) -> tuple[dict[str, float], str, float, str]:
    """
    自动选择持仓文件并解析。

    优先级：命令行参数 > my_portfolio.json > my_portfolio.csv。
    若都不存在，打印使用说明后退出。
    """
    if path is None:
        if _DEFAULT_JSON.exists():
            path = _DEFAULT_JSON
        elif _DEFAULT_CSV.exists():
            path = _DEFAULT_CSV
        else:
            print(
                "错误：未找到持仓文件。\n"
                f"  请创建 {_DEFAULT_JSON}\n"
                f"  或     {_DEFAULT_CSV}\n\n"
                "JSON 模板（input_type 可选 shares/value/weight）：\n"
                '  {"input_type":"shares","risk_free":0.045,"lookback":"2y",\n'
                '   "holdings":{"AAPL":10,"MSFT":8}}\n\n'
                "CSV 模板：\n"
                "  symbol,quantity\n"
                "  AAPL,10\n"
                "  MSFT,8\n"
            )
            sys.exit(1)

    suffix = path.suffix.lower()
    if suffix == ".json":
        return _load_json(path)
    if suffix == ".csv":
        return _load_csv(path)
    raise ValueError(f"不支持的文件格式 {suffix!r}，请用 .json 或 .csv。")


# ── 格式化工具 ─────────────────────────────────────────────────────────────────

def _pct(x: float, decimals: int = 1) -> str:
    return f"{x * 100:+.{decimals}f}%"


def _fmt(x: float, decimals: int = 2) -> str:
    return f"{x:.{decimals}f}"


def _bar(ratio: float, width: int = 20) -> str:
    filled = max(0, min(width, round(ratio * width)))
    return "█" * filled + "░" * (width - filled)


# ── 报告各节 ──────────────────────────────────────────────────────────────────

def _print_header(m, input_type: str, source_path: Path):
    print("=" * 72)
    print(" 组合风险报告")
    print(
        f" 数据区间：{m.start_date} → {m.end_date}"
        f"   持仓 {m.n_assets} 只"
        f"   输入类型：{input_type}"
    )
    print(f" 来源：{source_path.name}")
    print("=" * 72)


def _print_portfolio_overview(m):
    print("\n▌ 一、组合总览")
    print("-" * 50)
    rows = [
        ("年化波动率（协方差法）",   _pct(m.portfolio_vol)),
        ("年化波动率（加权平均上界）", _pct(m.weighted_avg_vol)),
        ("分散化节省的风险",
         f"{_pct(m.diversification_benefit)}  "
         f"（= 加权均值 − 协方差法，正值表示有效分散）"),
        ("最大回撤",             _pct(m.max_dd)),
        ("组合 Beta（vs SPY）",  _fmt(m.beta)),
        ("年化夏普比率",          _fmt(m.sharpe)),
        ("1日 VaR 95%",        _pct(m.var95)),
        ("1日 CVaR 95%",       _pct(m.cvar95)),
    ]
    for label, val in rows:
        print(f"  {label:<28}  {val}")


def _print_asset_table(m, input_type: str):
    qty_label = {"shares": "持股数", "value": "市值($)", "weight": "权重输入"}.get(input_type, "输入量")
    print(f"\n▌ 二、单只持仓明细（按风险贡献度降序）")
    header = (
        f"  {'代码':<6} {qty_label:>9} {'市值权重':>8} {'年化波动':>8} "
        f"{'风险贡献':>8} {'RC/W':>5} {'最大回撤':>8} {'Beta':>6} {'夏普':>6} {'风险档':>5}"
    )
    print(header)
    print("  " + "-" * 78)

    assets = sorted(
        m.per_asset.values(), key=lambda a: a.risk_contribution, reverse=True
    )
    for a in assets:
        rc_vs_w = a.risk_contribution / a.weight if a.weight > 0 else float("nan")
        flag    = " ▲" if rc_vs_w > 1.30 else "  "
        mv_str  = f"${a.market_value:>8,.0f}" if input_type != "weight" else f"{'—':>9}"
        print(
            f"  {a.symbol:<6} {mv_str} "
            f"{_pct(a.weight):>8} {_pct(a.vol):>8} "
            f"{_pct(a.risk_contribution):>7}{flag} "
            f"{rc_vs_w:>4.1f}x "
            f"{_pct(a.max_dd):>8} {_fmt(a.beta):>6} "
            f"{_fmt(a.sharpe):>6} {a.risk_tier:>5}"
        )
    print("  ▲ = 风险贡献/市值权重 > 1.30（风险集中）")


def _print_diversification(m):
    print("\n▌ 三、分散化分析")
    print(f"  加权平均波动率（忽略相关性，假设全部同向）：{_pct(m.weighted_avg_vol)}")
    print(f"  协方差法波动率（利用实际相关性）          ：{_pct(m.portfolio_vol)}")
    print(f"  分散化节省                              ：{_pct(m.diversification_benefit)}")
    eff = m.diversification_benefit / m.weighted_avg_vol if m.weighted_avg_vol > 0 else 0
    print(f"  分散化效率（节省 / 加权均值）            ：{_pct(eff)}")

    print()
    # 条形图
    assets = sorted(
        m.per_asset.values(), key=lambda a: a.risk_contribution, reverse=True
    )
    W = 18
    print(f"  {'代码':<6}  {'风险贡献':^20}  {'市值权重':^20}")
    print("  " + "-" * 56)
    for a in assets:
        rc_bar = _bar(a.risk_contribution, W)
        w_bar  = _bar(a.weight, W)
        print(
            f"  {a.symbol:<6}  {rc_bar} {_pct(a.risk_contribution):>6}  "
            f"{w_bar} {_pct(a.weight):>6}"
        )


def _print_correlation(m):
    print("\n▌ 四、相关系数矩阵（日对数收益率，Pearson）")
    syms = list(m.correlation.columns)
    col_w = max(6, max(len(s) for s in syms) + 1)
    header = "  " + " " * (col_w + 1) + "".join(f"{s:>{col_w}}" for s in syms)
    print(header)
    print("  " + "-" * (col_w + 1 + col_w * len(syms) + 2))
    for sym in syms:
        row = f"  {sym:<{col_w}}"
        for s2 in syms:
            r = m.correlation.loc[sym, s2]
            if sym == s2:
                cell = f"{'1.00':>{col_w}}"
            elif abs(r) >= 0.70:
                cell = f"{r:>{col_w - 1}.2f}*"
            else:
                cell = f"{r:>{col_w}.2f}"
            row += cell
        print(row)
    print("  * = |ρ| ≥ 0.70（高相关，分散化效果有限）")


def _collect_warnings(m) -> list[str]:
    warnings: list[str] = []

    # 1. 单只风险集中（RC/W > 1.5 报警，1.3~1.5 只标 ▲ 不报警）
    for a in sorted(m.per_asset.values(), key=lambda x: x.risk_contribution, reverse=True):
        if a.weight > 0:
            ratio = a.risk_contribution / a.weight
            if ratio > 1.5:
                warnings.append(
                    f"⚠ 【风险集中】{a.symbol} 市值权重 {_pct(a.weight)}，"
                    f"但风险贡献 {_pct(a.risk_contribution)}（RC/W = {ratio:.1f}x）。"
                    f" 波动率 {_pct(a.vol)}，最大回撤 {_pct(a.max_dd)}。"
                    f" 建议评估是否需要减仓或对冲。"
                )

    # 2. 高度相关对（分散化失效）
    syms = list(m.correlation.columns)
    high_corr_pairs: list[tuple[str, str, float]] = []
    for i, s1 in enumerate(syms):
        for s2 in syms[i + 1:]:
            r = m.correlation.loc[s1, s2]
            if r >= 0.70:
                high_corr_pairs.append((s1, s2, r))

    if high_corr_pairs:
        pairs_str = "、".join(f"{s1}-{s2}(ρ={r:.2f})" for s1, s2, r in high_corr_pairs)
        warnings.append(
            f"⚠ 【高相关】以下股票对高度相关：{pairs_str}。"
            f" 市场系统性下跌时这些持仓会同步下跌，分散化保护失效。"
        )

    # 3. 组合 Beta 过高
    if not (m.beta != m.beta):   # not NaN
        if m.beta > 1.30:
            warnings.append(
                f"⚠ 【高 Beta】组合 Beta = {m.beta:.2f}（>1.30）。"
                f" 市场每跌 1%，组合预期跌 {m.beta:.2f}%。"
                f" 若担忧系统性风险，可考虑增加低 Beta 防御性持仓（如消费品/医疗）或 SPY Put 对冲。"
            )
        elif m.beta > 1.10:
            warnings.append(
                f"ℹ 【Beta 偏高】组合 Beta = {m.beta:.2f}，略高于市场。"
                f" 在正常牛市中有杠杆效应，但下行时损失也会放大。"
            )

    # 4. 整体波动偏高
    if m.portfolio_vol > 0.30:
        warnings.append(
            f"⚠ 【高波动】组合年化波动率 {_pct(m.portfolio_vol)}（>30%）。"
            f" 对应 1日 CVaR = {_pct(m.cvar95)}，"
            f" 即极端情形下单日预期亏损超过组合的 {abs(m.cvar95) * 100:.1f}%。"
        )
    elif m.portfolio_vol > 0.20:
        warnings.append(
            f"ℹ 【波动中等】组合年化波动率 {_pct(m.portfolio_vol)}（20%~30%）。"
            f" 最大回撤 {_pct(m.max_dd)}，注意控制单次亏损容忍度。"
        )

    # 5. 高风险档持仓占比
    high_risk_assets = [a for a in m.per_asset.values() if a.risk_tier == "高"]
    high_weight = sum(a.weight for a in high_risk_assets)
    if high_weight > 0.25:
        names = "、".join(a.symbol for a in high_risk_assets)
        warnings.append(
            f"⚠ 【高风险持仓】波动率 >40% 的持仓（{names}）合计权重 {_pct(high_weight)}。"
            f" 这类持仓在板块回调时尾部损失尤为显著。"
        )

    # 6. 分散化效果差（所有资产高度相关）
    if m.diversification_benefit < 0.01 * m.weighted_avg_vol:
        warnings.append(
            f"ℹ 【分散化有限】分散化节省仅 {_pct(m.diversification_benefit)}，"
            f" 各持仓整体相关性较高，增持新标的时建议优先选择与现有持仓低相关的资产类别。"
        )

    return warnings


def _print_cluster_analysis(m, cluster: dict[str, list[str]]):
    """
    集群分析：计算每个自定义集群的合计权重、合计风险贡献，以及集群内两两相关系数。

    cluster = {"集群名": ["SYM1", "SYM2", ...]}
    """
    print("\n▌ 五、集群分析（自定义集群的隐性集中度）")
    print("-" * 72)

    corr = m.correlation
    all_syms = set(m.per_asset.keys())

    for cluster_name, members_raw in cluster.items():
        members = [s for s in members_raw if s in all_syms]
        if len(members) < 2:
            print(f"\n  [{cluster_name}] 集群内有效成员不足 2 只，跳过。")
            continue

        # 合计权重 & 风险贡献
        total_w  = sum(m.per_asset[s].weight           for s in members)
        total_rc = sum(m.per_asset[s].risk_contribution for s in members)

        # 两两相关系数
        pairs: list[tuple[str, str, float]] = []
        for i, s1 in enumerate(members):
            for s2 in members[i + 1:]:
                pairs.append((s1, s2, float(corr.loc[s1, s2])))

        avg_corr = sum(r for _, _, r in pairs) / len(pairs)
        min_pair = min(pairs, key=lambda x: x[2])
        max_pair = max(pairs, key=lambda x: x[2])

        print(f"\n  ▌ [{cluster_name}]  成员：{', '.join(members)}")
        print(f"    合计市值权重   ：{_pct(total_w)}")
        print(f"    合计风险贡献   ：{_pct(total_rc)}  （占组合总风险的 {total_rc * 100:.1f}%）")
        rc_vs_w = total_rc / total_w if total_w > 0 else float("nan")
        print(f"    集群 RC/W 比   ：{rc_vs_w:.2f}x  （>1 表示该集群风险超出持仓比例）")
        print(f"    集群内平均 ρ   ：{avg_corr:.3f}")
        print(f"    最高相关对     ：{max_pair[0]}-{max_pair[1]}  ρ = {max_pair[2]:.3f}")
        print(f"    最低相关对     ：{min_pair[0]}-{min_pair[1]}  ρ = {min_pair[2]:.3f}")

        # 两两相关矩阵（仅集群内）
        # cell_w 为每格宽度：1 前导空格 + col_w 数字 + 1 标记位 = col_w + 2
        col_w = max(5, max(len(s) for s in members) + 1)
        cell_w = col_w + 2   # " 0.527*" 或 "  0.401 " → 统一宽度
        print(f"\n    {'':>{col_w}}" + "".join(f"{s:>{cell_w}}" for s in members))
        print("    " + "-" * (col_w + cell_w * len(members)))
        for s1 in members:
            row = f"    {s1:<{col_w}}"
            for s2 in members:
                r = float(corr.loc[s1, s2])
                if s1 == s2:
                    cell = f"{'—':>{cell_w}}"
                elif r >= 0.50:
                    # 前导空格 + col_w 宽数字 + '*'  = 1 + col_w + 1 = cell_w
                    cell = f" {r:>{col_w}.3f}*"
                else:
                    # cell_w 宽（含前导空格，末尾无 *）
                    cell = f"{r:>{cell_w - 1}.3f} "
                row += cell
            print(row)
        print(f"    * = ρ ≥ 0.50（中高相关，同向波动明显）")

        # 结论
        if avg_corr >= 0.50:
            verdict = f"平均 ρ = {avg_corr:.2f}，集群内高度相关 — 遇系统性风险这 {len(members)} 只会基本同步下跌，构成真实的集中押注。"
        elif avg_corr >= 0.35:
            verdict = f"平均 ρ = {avg_corr:.2f}，集群内中等相关 — 存在一定的共同风险因子，不能视为完全独立持仓。"
        else:
            verdict = f"平均 ρ = {avg_corr:.2f}，集群内相关性较低 — 隐性集中度风险相对有限。"

        rc_note = ""
        if total_rc > total_w + 0.05:
            rc_note = f" 且风险贡献（{_pct(total_rc)}）显著高于市值权重（{_pct(total_w)}），集中度被进一步放大。"

        print(f"\n    结论：{verdict}{rc_note}")

    print()


def _print_warnings(m, cluster_warnings: list[str] | None = None):
    print("\n▌ 六、风险提示")
    print("-" * 72)
    items = _collect_warnings(m)
    if cluster_warnings:
        items.extend(cluster_warnings)
    if not items:
        print("  ✓ 未发现明显的风险集中、高相关或高 Beta 问题。")
    else:
        for w in items:
            print()
            print(textwrap.fill(f"  {w}", width=72, subsequent_indent="    "))
    print()


# ── 主入口 ─────────────────────────────────────────────────────────────────────

def _build_cluster_warnings(m, cluster: dict[str, list[str]]) -> list[str]:
    """把集群分析结果转成风险提示文字，追加到总风险提示节。"""
    warnings: list[str] = []
    corr = m.correlation
    all_syms = set(m.per_asset.keys())

    for name, members_raw in cluster.items():
        members = [s for s in members_raw if s in all_syms]
        if len(members) < 2:
            continue
        total_w  = sum(m.per_asset[s].weight           for s in members)
        total_rc = sum(m.per_asset[s].risk_contribution for s in members)
        pairs    = [
            float(corr.loc[s1, s2])
            for i, s1 in enumerate(members)
            for s2 in members[i + 1:]
        ]
        avg_corr = sum(pairs) / len(pairs)

        if total_rc > 0.50:
            warnings.append(
                f"⚠ 【集群集中】[{name}] 合计风险贡献 {_pct(total_rc)}，"
                f"市值权重仅 {_pct(total_w)}（RC/W = {total_rc/total_w:.1f}x）。"
                f" 集群内平均 ρ = {avg_corr:.2f}，"
                f"{'高度相关，下行时会同步放大损失。' if avg_corr >= 0.45 else '中等相关，存在共同风险因子。'}"
            )
    return warnings


def main():
    # 命令行可选传入自定义持仓文件路径
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if source and not source.exists():
        print(f"错误：找不到文件 {source}")
        sys.exit(1)

    holdings, input_type, risk_free, lookback = load_portfolio(source)
    source_path = source or (_DEFAULT_JSON if _DEFAULT_JSON.exists() else _DEFAULT_CSV)

    # ── 自定义集群（可按需修改）────────────────────────────────────────────────
    CLUSTER = {
        "AI/半导体/高Beta": ["ARM", "MU", "TSLA", "NVDA", "PLTR"],
    }

    print(f"\n正在获取价格数据（lookback={lookback}，input_type={input_type}）…")
    print(f"持仓：{', '.join(f'{s}×{v:g}' for s, v in holdings.items())}\n")

    m = compute_portfolio_risk(
        holdings,
        lookback=lookback,
        input_type=input_type,
        risk_free=risk_free,
    )

    _print_header(m, input_type, source_path)
    _print_portfolio_overview(m)
    _print_asset_table(m, input_type)
    _print_diversification(m)
    _print_correlation(m)
    _print_cluster_analysis(m, CLUSTER)
    cluster_w = _build_cluster_warnings(m, CLUSTER)
    _print_warnings(m, cluster_w)


if __name__ == "__main__":
    main()
