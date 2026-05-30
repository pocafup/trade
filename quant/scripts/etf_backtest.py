"""
高波动板块 ETF 回测：MA20/50+MA200 趋势过滤 vs 买入持有。

目标：验证"MA 趋势跟踪在高波动标的上是否比 SPY 更有效"。
标的：无幸存者偏差的宽基/板块 ETF（规避选股污染）。
一致性约束：
  (a) 有效起点从 MA200 暖机（200根K线）后算起；
  (b) 策略与买入持有使用同一起始日；
  (c) 每只 ETF 各自取最长可用历史。

运行：cd quant/ && python scripts/etf_backtest.py
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

from data.prices import fetch
from models.ma_cross import signal as ma_cross_signal
from backtest.engine import BacktestResult, run

INITIAL    = 10_000.0
COMMISSION = 0.001
WARMUP     = 200   # MA200 需要 200 根 K 线完成暖机
LOOKBACK   = "25y" # 请求 25 年；数据不够的 ETF 直接取最长

# 标的列表（含 SPY 作为低波动参照基准）
ETFS = {
    "SPY":  "标普500（低波动参照）",
    "QQQ":  "纳指100（科技成长）",
    "SMH":  "半导体 (VanEck)",
    "XBI":  "生物科技",
    "ARKK": "方舟创新",
    "IWM":  "小盘（罗素2000）",
}


# ── 工具函数 ──────────────────────────────────────────────────────────────────

def _fmt(val: float, fmt: str, default: str = "N/A") -> str:
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return default
    return format(val, fmt)


def _position_mask(result: BacktestResult, index: pd.DatetimeIndex) -> pd.Series:
    """
    返回布尔 Series：True = 该日收盘时多头在手。
    exit_date 当天开盘卖出，收盘已是现金，故上界为"小于"。
    """
    m = pd.Series(False, index=index)
    for t in result.trades:
        m[(index >= t.entry_date) & (index < t.exit_date)] = True
    if result.has_open_position and result.open_entry_date is not None:
        m[index >= result.open_entry_date] = True
    return m


def _run_one(ticker: str, ohlcv_full: pd.DataFrame) -> dict:
    """
    单只 ETF：跑 MA 策略 + BnH，返回全量结果 dict。
    有效区间从暖机后第一天开始，两边起点相同。
    """
    full_close = ohlcv_full["Close"]
    full_sigs  = ma_cross_signal(full_close, fast=20, slow=50, trend=200)

    ohlcv  = ohlcv_full.iloc[WARMUP:].copy()
    sigs   = full_sigs.iloc[WARMUP:].copy()
    n_days = len(ohlcv)

    r_strat = run(ohlcv, sigs, INITIAL, COMMISSION)

    bnh_sigs         = pd.Series(0, index=ohlcv.index, dtype=int)
    bnh_sigs.iloc[0] = 1
    r_bnh = run(ohlcv, bnh_sigs, INITIAL, COMMISSION)

    pos_mask = _position_mask(r_strat, ohlcv.index)
    avg_exp  = float(pos_mask.mean())

    # 逐年数据
    annual = []
    for yr in sorted(ohlcv.index.year.unique()):
        yr_ohlcv = ohlcv[ohlcv.index.year == yr]
        yr_strat = r_strat.equity[r_strat.equity.index.year == yr]
        yr_bnh   = r_bnh.equity[r_bnh.equity.index.year == yr]
        yr_pos   = pos_mask[pos_mask.index.year == yr]
        if len(yr_ohlcv) < 2:
            continue
        etf_ret   = float(yr_ohlcv["Close"].iloc[-1] / yr_ohlcv["Close"].iloc[0] - 1)
        strat_ret = float(yr_strat.iloc[-1] / yr_strat.iloc[0] - 1) if len(yr_strat) >= 2 else float("nan")
        bnh_ret   = float(yr_bnh.iloc[-1]   / yr_bnh.iloc[0]   - 1) if len(yr_bnh)   >= 2 else float("nan")
        n_yr      = sum(1 for t in r_strat.trades if t.exit_date.year == yr)
        open_flag = (r_strat.has_open_position
                     and r_strat.open_entry_date is not None
                     and r_strat.open_entry_date.year == yr)
        annual.append(dict(
            year      = yr,
            etf_ret   = etf_ret,
            strat_ret = strat_ret,
            bnh_ret   = bnh_ret,
            alpha     = strat_ret - bnh_ret if not np.isnan(strat_ret) else float("nan"),
            exposure  = float(yr_pos.mean()),
            n_trades  = n_yr,
            has_open  = open_flag,
        ))

    return dict(
        ticker   = ticker,
        start    = ohlcv.index[0].date(),
        end      = ohlcv.index[-1].date(),
        n_days   = n_days,
        r_strat  = r_strat,
        r_bnh    = r_bnh,
        avg_exp  = avg_exp,
        annual   = annual,
    )


# ── 按市场环境分类：用高波动 ETF 自身涨跌作为分类依据 ─────────────────────────

def _regime(etf_ret: float) -> str:
    """
    对高波动 ETF 适用宽松分类（vs SPY 的 >15%/>-10%）：
      牛：年涨 > +20%（高波动 ETF 的"正常牛市"涨幅）
      熊：年跌 < -15%（包含高波动 ETF 的显著下跌年）
      震：其余
    """
    if etf_ret > 0.20:
        return "牛"
    elif etf_ret < -0.15:
        return "熊"
    return "震"


def _regime_summary(annual: list[dict]) -> dict[str, dict]:
    """
    按市场环境汇总逐年超额收益。
    返回 {'牛': {...}, '熊': {...}, '震': {...}}
    """
    out = {}
    for label in ("牛", "熊", "震"):
        rows = [r for r in annual if _regime(r["etf_ret"]) == label
                and not np.isnan(r["alpha"])]
        if not rows:
            out[label] = None
            continue
        out[label] = dict(
            n          = len(rows),
            avg_strat  = np.mean([r["strat_ret"] for r in rows]),
            avg_bnh    = np.mean([r["bnh_ret"]   for r in rows]),
            avg_alpha  = np.mean([r["alpha"]     for r in rows]),
        )
    return out


# ── 打印单只 ETF 报告 ─────────────────────────────────────────────────────────

def _print_ticker_report(res: dict, label: str) -> None:
    ticker  = res["ticker"]
    r_strat = res["r_strat"]
    r_bnh   = res["r_bnh"]
    avg_exp = res["avg_exp"]
    n_days  = res["n_days"]

    print(f"\n{'═'*68}")
    print(f"  {ticker}  ─  {label}")
    print(f"  区间：{res['start']}  →  {res['end']}"
          f"  ({n_days} 天 ≈ {n_days/252:.1f} 年)")
    print(f"{'═'*68}")

    # ── 绩效对比行 ──────────────────────────────────────────────────────────
    cols   = ["策略", "累计收益", "年化", "夏普", "最大回撤", "交易", "胜率", "平均暴露"]
    widths = [20, 9, 8, 6, 9, 5, 7, 9]
    header = "  ".join(f"{c:>{w}s}" for c, w in zip(cols, widths))
    sep    = "─" * len(header)
    print(header)
    print(sep)

    for name, r, exp in [("MA20/50+MA200", r_strat, avg_exp), ("买入持有", r_bnh, None)]:
        wr    = _fmt(r.win_rate, ".1%") if not np.isnan(r.win_rate) else "—"
        exp_s = f"{exp:.1%}" if exp is not None else "100.0%"
        cells = [
            f"{name:>{widths[0]}s}",
            f"{_fmt(r.total_return,      '+.2%'):>{widths[1]}s}",
            f"{_fmt(r.annualized_return, '+.2%'):>{widths[2]}s}",
            f"{_fmt(r.sharpe,            '.2f'):>{widths[3]}s}",
            f"{_fmt(r.max_dd,            '+.2%'):>{widths[4]}s}",
            f"{r.n_trades:>{widths[5]}d}",
            f"{wr:>{widths[6]}s}",
            f"{exp_s:>{widths[7]}s}",
        ]
        print("  ".join(cells))
    print(sep)

    # ── 逐年绩效表 ──────────────────────────────────────────────────────────
    annual  = res["annual"]
    ycols   = ["年份", "ETF涨跌", "BnH", "策略", "超额", "暴露", "交易", "市场"]
    ywidths = [5, 9, 8, 8, 7, 6, 5, 4]
    yheader = "  ".join(f"{c:>{w}s}" for c, w in zip(ycols, ywidths))
    ysep    = "─" * len(yheader)
    print()
    print(yheader)
    print(ysep)
    for row in annual:
        n_lbl = f"{row['n_trades']}+1" if row["has_open"] else str(row["n_trades"])
        cells = [
            f"{row['year']:>{ywidths[0]}d}",
            f"{_fmt(row['etf_ret'],    '+.1%'):>{ywidths[1]}s}",
            f"{_fmt(row['bnh_ret'],    '+.1%'):>{ywidths[2]}s}",
            f"{_fmt(row['strat_ret'],  '+.1%'):>{ywidths[3]}s}",
            f"{_fmt(row['alpha'],      '+.1%'):>{ywidths[4]}s}",
            f"{row['exposure']:>{ywidths[5]}.0%}",
            f"{n_lbl:>{ywidths[6]}s}",
            f"{_regime(row['etf_ret']):>{ywidths[7]}s}",
        ]
        print("  ".join(cells))
    print(ysep)

    # ── 按市场环境汇总 ──────────────────────────────────────────────────────
    regime_lbl = {"牛": "牛(年涨>20%)", "熊": "熊(年跌>15%)", "震": "震荡(其余) "}
    rsummary   = _regime_summary(annual)
    for k in ("牛", "熊", "震"):
        d = rsummary[k]
        if d is None:
            continue
        sign = "+" if d["avg_alpha"] > 0 else ""
        print(f"  {regime_lbl[k]}（{d['n']}年）: "
              f"策略 {d['avg_strat']:>+.1%}  BnH {d['avg_bnh']:>+.1%}  "
              f"超额 {sign}{d['avg_alpha']:.1%}")


# ── 横向汇总表 ────────────────────────────────────────────────────────────────

def _print_cross_table(all_results: list[tuple[str, dict]]) -> None:
    print(f"\n\n{'═'*88}")
    print("横向汇总：MA 策略 vs 买入持有（核心问题：在哪些标的上夏普跑赢？）")
    print(f"{'═'*88}\n")

    hcols   = ["标的", "描述", "年数",
               "MA夏普", "BnH夏普", "夏普胜负",
               "MA回撤", "BnH回撤", "回撤改善",
               "MA年化", "BnH年化", "平均暴露"]
    hwidths = [5, 16, 4,
               7, 8, 8,
               8, 8, 8,
               8, 8, 8]
    header = "  ".join(f"{c:>{w}s}" for c, w in zip(hcols, hwidths))
    sep    = "─" * len(header)
    print(header)
    print(sep)

    for label, res in all_results:
        r_s = res["r_strat"]
        r_b = res["r_bnh"]
        n_yr = res["n_days"] / 252

        sharpe_win = "✓ 跑赢" if r_s.sharpe > r_b.sharpe else "✗ 跑输"
        # 回撤改善 = MA回撤 − BnH回撤（均为负数）
        # 正值 = MA回撤更小 = 策略改善了回撤
        dd_diff = r_s.max_dd - r_b.max_dd

        cells = [
            f"{res['ticker']:>{hwidths[0]}s}",
            f"{label:>{hwidths[1]}s}",
            f"{n_yr:>{hwidths[2]}.1f}",
            f"{_fmt(r_s.sharpe,          '.2f'):>{hwidths[3]}s}",
            f"{_fmt(r_b.sharpe,          '.2f'):>{hwidths[4]}s}",
            f"{sharpe_win:>{hwidths[5]}s}",
            f"{_fmt(r_s.max_dd,          '+.1%'):>{hwidths[6]}s}",
            f"{_fmt(r_b.max_dd,          '+.1%'):>{hwidths[7]}s}",
            f"{_fmt(dd_diff,             '+.1%'):>{hwidths[8]}s}",
            f"{_fmt(r_s.annualized_return,'+.1%'):>{hwidths[9]}s}",
            f"{_fmt(r_b.annualized_return,'+.1%'):>{hwidths[10]}s}",
            f"{res['avg_exp']:>{hwidths[11]}.1%}",
        ]
        print("  ".join(cells))
    print(sep)
    print("  注：回撤改善 = MA回撤 − BnH回撤；正值=MA策略回撤更小（更好）")

    # 最终结论
    wins  = [res for _, res in all_results if res["r_strat"].sharpe > res["r_bnh"].sharpe]
    total = len(all_results)
    print()
    print(f"  夏普跑赢 BnH：{len(wins)}/{total} 只")
    for res in wins:
        s_diff = res["r_strat"].sharpe - res["r_bnh"].sharpe
        print(f"    {res['ticker']:5s}  MA夏普 {res['r_strat'].sharpe:.2f} vs BnH {res['r_bnh'].sharpe:.2f}"
              f"  （+{s_diff:.2f}）"
              f"  回撤改善 {res['r_strat'].max_dd - res['r_bnh'].max_dd:+.1%}")

    # 牛/熊/震超额汇总（跨标的聚合）
    print()
    print("  ── 跨标的超额收益汇总（市场环境分类，算数均值）──")
    regime_lbl = {"牛": "牛(年涨>20%)", "熊": "熊(年跌>15%)", "震": "震荡     "}
    for k in ("牛", "熊", "震"):
        per_ticker_alpha = []
        for label, res in all_results:
            rsummary = _regime_summary(res["annual"])
            d = rsummary[k]
            if d is not None:
                per_ticker_alpha.append(d["avg_alpha"])
        if not per_ticker_alpha:
            continue
        avg = np.mean(per_ticker_alpha)
        sign = "+" if avg > 0 else ""
        positives = sum(1 for a in per_ticker_alpha if a > 0)
        print(f"    {regime_lbl[k]}：各标的平均超额 {sign}{avg:.1%}"
              f"  （{positives}/{len(per_ticker_alpha)} 只标的超额>0）")


# ── 主函数 ────────────────────────────────────────────────────────────────────

def main() -> None:
    tickers = list(ETFS.keys())
    print(f"拉取 {len(tickers)} 只 ETF × {LOOKBACK} 历史数据…")
    data = fetch(tickers, lookback=LOOKBACK)
    print("  完成\n")

    all_results: list[tuple[str, dict]] = []
    for ticker, label in ETFS.items():
        raw = data.get(ticker)
        if raw is None or len(raw) <= WARMUP:
            n = len(raw) if raw is not None else 0
            print(f"  ⚠  {ticker}: 数据不足（{n} 行），跳过")
            continue
        print(f"  处理 {ticker}：{len(raw)} 行原始数据 → 暖机后 {len(raw)-WARMUP} 天有效…")
        res = _run_one(ticker, raw)
        all_results.append((label, res))

    print()

    # 每只 ETF 详细报告
    for label, res in all_results:
        _print_ticker_report(res, label)

    # 横向汇总
    _print_cross_table(all_results)


if __name__ == "__main__":
    main()
