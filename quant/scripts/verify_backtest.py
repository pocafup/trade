"""
AAPL 回测绩效对比：原始双均线 vs 趋势过滤双均线 vs SPY 买入持有。
运行：cd quant/ && python scripts/verify_backtest.py
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
COMMISSION = 0.001   # 0.1% 单边


def _bnh_signals(ohlcv: pd.DataFrame) -> pd.Series:
    s = pd.Series(0, index=ohlcv.index, dtype=int)
    s.iloc[0] = 1
    return s


def _fmt(val: float, fmt: str) -> str:
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return "N/A"
    return format(val, fmt)


def _print_table(rows: list[tuple[str, BacktestResult]]) -> None:
    cols = ["策略", "累计收益", "年化收益", "夏普", "最大回撤", "交易数", "胜率"]
    widths = [24, 9, 9, 6, 9, 6, 8]

    header = "  ".join(f"{c:>{w}s}" for c, w in zip(cols, widths))
    sep    = "─" * len(header)
    print(header)
    print(sep)

    for name, r in rows:
        wr = _fmt(r.win_rate, ".1%")
        if r.has_open_position:
            wr += "*"
        cells = [
            f"{name:>{widths[0]}s}",
            f"{_fmt(r.total_return,      '+.2%'):>{widths[1]}s}",
            f"{_fmt(r.annualized_return, '+.2%'):>{widths[2]}s}",
            f"{_fmt(r.sharpe,            '.2f'):>{widths[3]}s}",
            f"{_fmt(r.max_dd,            '+.2%'):>{widths[4]}s}",
            f"{r.n_trades:>{widths[5]}d}",
            f"{wr:>{widths[6]}s}",
        ]
        print("  ".join(cells))

    print(sep)
    print("  * 回测结束时仍持仓，胜率仅计已完成往返")


def _print_trades(result: BacktestResult, name: str) -> None:
    print(f"\n{name} — 已完成交易：")
    if not result.trades:
        print("  （无已完成往返）")
        return
    print(f"  {'买入日':12s}  {'买入价':>8s}  {'卖出日':12s}  {'卖出价':>8s}  {'净收益':>9s}")
    print("  " + "─" * 58)
    for t in result.trades:
        mark = "✓" if t.pnl_pct > 0 else "✗"
        print(
            f"  {t.entry_date.date()!s:12s}  {t.entry_price:>8.2f}"
            f"  {t.exit_date.date()!s:12s}  {t.exit_price:>8.2f}"
            f"  {t.pnl_pct:>+9.2%}  {mark}"
        )
    if result.has_open_position:
        print(
            f"  {'（持仓中）':12s}  {result.open_entry_price:>8.2f}"
            f"  {'─':>12s}  {'─':>8s}  （未平仓）"
        )


def main() -> None:
    print("拉取 AAPL 和 SPY 两年数据…\n")
    data = fetch(["AAPL", "SPY"], lookback="2y")
    aapl = data["AAPL"]
    spy  = data["SPY"]

    # ── 三种策略 ─────────────────────────────────────────────────────────────
    sigs_raw      = ma_cross_signal(aapl["Close"], fast=20, slow=50)
    sigs_filtered = ma_cross_signal(aapl["Close"], fast=20, slow=50, trend=200)

    r_raw      = run(aapl, sigs_raw,            INITIAL, COMMISSION)
    r_filtered = run(aapl, sigs_filtered,        INITIAL, COMMISSION)
    r_spy      = run(spy,  _bnh_signals(spy),    INITIAL, COMMISSION)

    # ── 报告头 ───────────────────────────────────────────────────────────────
    start, end, n = aapl.index[0].date(), aapl.index[-1].date(), len(aapl)
    print(f"回测区间：{start}  →  {end}  （{n} 个交易日）")
    print(f"初始资金：${INITIAL:>,.0f}   手续费：{COMMISSION:.1%} 单边\n")

    # ── 信号变化对比 ─────────────────────────────────────────────────────────
    n_buy_raw      = (sigs_raw      == 1).sum()
    n_buy_filtered = (sigs_filtered == 1).sum()
    print(f"信号统计：原始买入信号 {n_buy_raw} 次  →  趋势过滤后 {n_buy_filtered} 次"
          f"  （屏蔽了 {n_buy_raw - n_buy_filtered} 次价格低于 MA200 的金叉）\n")

    # ── 绩效表格 ─────────────────────────────────────────────────────────────
    _print_table([
        ("AAPL  MA20/50（原始）",       r_raw),
        ("AAPL  MA20/50 + MA200 过滤",  r_filtered),
        ("SPY   买入持有",              r_spy),
    ])

    # ── 详细交易记录 ──────────────────────────────────────────────────────────
    _print_trades(r_raw,      "原始双均线")
    _print_trades(r_filtered, "趋势过滤双均线")

    # ── 权益曲线末尾 ─────────────────────────────────────────────────────────
    print("\n权益曲线末尾（最近 10 天，初始资金 $10,000）：")
    cmp = pd.DataFrame({
        "原始MA":  r_raw.equity,
        "过滤MA":  r_filtered.equity,
        "SPY_BnH": r_spy.equity,
    })
    print(cmp.tail(10).to_string(float_format="${:>,.2f}".format))


if __name__ == "__main__":
    main()
