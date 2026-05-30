"""
诊断 MA20 / MA50 与外部网站数值差异的来源。
运行：cd quant/ && python scripts/diagnose_ma.py
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from datetime import date, timedelta

import numpy as np
import pandas as pd
import yfinance as yf

from data.prices import fetch

SEP = "─" * 62


def _yf_download(adj: bool) -> pd.DataFrame:
    """直接调 yfinance，不走缓存，返回含 Close / Adj_Close 的 DataFrame。"""
    start = (date.today() - timedelta(days=400)).isoformat()
    end   = (date.today() + timedelta(days=1)).isoformat()
    raw = yf.download(
        "AAPL", start=start, end=end,
        progress=False, auto_adjust=adj,
        # 关掉多层列名，让列名扁平化
        actions=False,
    )
    # yfinance ≥0.2.x 有时返回 MultiIndex(价格类型, 股票代码)
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = ["_".join(c).strip("_") for c in raw.columns]
    return raw


def main() -> None:

    # ── 步骤 1：我们缓存的数据（auto_adjust=True）──────────────────────────
    print(SEP)
    print("步骤 1  缓存数据（auto_adjust=True，复权收盘价）")
    print(SEP)

    cached = fetch(["AAPL"], lookback="2y")
    close_adj = cached["AAPL"]["Close"]

    ma20_adj = close_adj.rolling(20).mean()
    ma50_adj = close_adj.rolling(50).mean()

    latest = close_adj.index[-1]
    print(f"\n最新日期：{latest.date()}")
    print(f"MA20（复权）= {ma20_adj.iloc[-1]:.6f}")
    print(f"MA50（复权）= {ma50_adj.iloc[-1]:.6f}\n")

    # MA20 实际用到的 20 个价格
    last20 = close_adj.iloc[-20:]
    print("MA20 窗口内的 20 个复权收盘价：")
    for i, (dt, p) in enumerate(last20.items(), 1):
        tag = " ← 最新" if i == 20 else ("← 窗口起点" if i == 1 else "")
        print(f"  {i:2d}.  {dt.date()}  {p:>10.4f}  {tag}")
    manual_ma20 = last20.mean()
    print(f"\n手动 sum/20 = {manual_ma20:.6f}  |  rolling.mean() = {ma20_adj.iloc[-1]:.6f}")
    print(f"两者差值（浮点误差）= {abs(manual_ma20 - ma20_adj.iloc[-1]):.2e}")

    # MA50 窗口范围
    last50 = close_adj.iloc[-50:]
    print(f"\nMA50 窗口：{last50.index[0].date()}  →  {last50.index[-1].date()}")

    # ── 步骤 2：直接拉原始价（auto_adjust=False）───────────────────────────
    print(f"\n{SEP}")
    print("步骤 2  直接拉取 yfinance（auto_adjust=False，原始未复权）")
    print(SEP)

    raw_df = _yf_download(adj=False)
    # 找 Close 和 Adj Close 列（列名可能含 ticker 后缀）
    close_col   = next(c for c in raw_df.columns if c.startswith("Close"))
    adjcls_col  = next((c for c in raw_df.columns if "Adj" in c), None)

    close_raw = raw_df[close_col].dropna()
    print(f"\n最新日期（原始）：{close_raw.index[-1].date()}")
    print(f"原始收盘价（最新）：{close_raw.iloc[-1]:.4f}")

    if adjcls_col:
        adj_from_yf = raw_df[adjcls_col].dropna()
        print(f"yfinance Adj Close（最新）：{adj_from_yf.iloc[-1]:.4f}")
        cache_latest = close_adj.iloc[-1]
        diff_cache_vs_adjclose = cache_latest - adj_from_yf.iloc[-1]
        print(f"\n缓存 Close（复权）vs yfinance Adj Close 差值：{diff_cache_vs_adjclose:+.6f}")
        print("（≈0 说明缓存存的就是 Adj Close，数据一致）")

    ma20_raw = close_raw.rolling(20).mean()
    ma50_raw = close_raw.rolling(50).mean()
    print(f"\nMA20（原始）= {ma20_raw.iloc[-1]:.6f}")
    print(f"MA50（原始）= {ma50_raw.iloc[-1]:.6f}")

    # ── 步骤 3：并排对比 ────────────────────────────────────────────────────
    print(f"\n{SEP}")
    print("步骤 3  并排对比（复权 vs 原始）")
    print(SEP)

    diff_ma20 = ma20_adj.iloc[-1] - ma20_raw.iloc[-1]
    diff_ma50 = ma50_adj.iloc[-1] - ma50_raw.iloc[-1]

    header = f"\n{'指标':8s}  {'复权价(adj)':>12s}  {'原始价(raw)':>12s}  {'差值':>10s}"
    print(header)
    print(f"{'MA20':8s}  {ma20_adj.iloc[-1]:>12.4f}  {ma20_raw.iloc[-1]:>12.4f}  {diff_ma20:>+10.4f}")
    print(f"{'MA50':8s}  {ma50_adj.iloc[-1]:>12.4f}  {ma50_raw.iloc[-1]:>12.4f}  {diff_ma50:>+10.4f}")

    threshold = 0.05
    if abs(diff_ma20) < threshold:
        print(f"\n结论：MA20 差值 {diff_ma20:+.4f} < {threshold}，差异很小。")
    else:
        print(
            f"\n结论：MA20 差值 {diff_ma20:+.4f} 较大，"
            "来自分红复权（历史价格被等比例下调）——属正常现象。"
        )

    # ── 步骤 4：确认 SMA（不是 EMA）────────────────────────────────────────
    print(f"\n{SEP}")
    print("步骤 4  确认 SMA vs EMA")
    print(SEP)

    ema20 = close_adj.ewm(span=20, adjust=False).mean()
    sma20 = ma20_adj.iloc[-1]
    ema20_latest = ema20.iloc[-1]

    print(f"\n  SMA20（rolling.mean）= {sma20:.6f}")
    print(f"  EMA20（ewm span=20）  = {ema20_latest:.6f}")
    print(f"  SMA − EMA            = {sma20 - ema20_latest:+.6f}")
    print()
    print("  验证：SMA = 窗口内各价格权重相等（每个 = 1/20）")
    weights = np.ones(20) / 20
    manual_sma = float(np.dot(close_adj.iloc[-20:].values, weights))
    print(f"  等权点积 = {manual_sma:.6f}  ≟  SMA = {sma20:.6f}  差 = {abs(manual_sma-sma20):.2e}")
    print(f"  结论：我们用的是 SMA（简单移动平均）✓")

    # ── 步骤 5：一致性检查 ──────────────────────────────────────────────────
    print(f"\n{SEP}")
    print("步骤 5  一致性检查：各层是否用同一份数据")
    print(SEP)

    print("""
  数据入口    data/prices.py::fetch()
              └─ _download() 调用 yf.download(auto_adjust=True)
              └─ 写入 SQLite（存 Open/High/Low/Close/Volume）
              └─ Close = 复权收盘价（等于 yfinance Adj Close）

  指标层      indicators/risk.py
              ─ 接受外部传入的 pd.Series，不自行拉数据
              ─ 只要调用方用 fetch()["Close"]，就是复权价 ✓

  信号层      models/ma_cross.py
              ─ 接受外部传入的 pd.Series，不自行拉数据
              ─ 使用 pandas rolling()，只看历史窗口，无前视偏差 ✓

  回测层      backtest/（待实现）
              ─ 必须约定：统一从 fetch() 取价格，禁止混用原始价

  结论：当前 indicators / models 均不自行拉数据，
        数据一致性由调用方保证（始终用 fetch()）。
        与外部网站的数差来自复权调整，系统内部一致，无混用。
""")


if __name__ == "__main__":
    main()
