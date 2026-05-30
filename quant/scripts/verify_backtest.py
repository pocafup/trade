"""
用 AAPL 运行双均线回测，与 AAPL/SPY 买入持有对比绩效。
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


# ── 工具 ───────────────────────────────────────────────────────────────────────

def _bnh_signals(ohlcv: pd.DataFrame) -> pd.Series:
    """第 0 天收盘发出买入信号，之后永久持有。"""
    s = pd.Series(0, index=ohlcv.index, dtype=int)
    s.iloc[0] = 1
    return s


def _fmt(val: float, fmt: str) -> str:
    return "N/A" if (val is None or (isinstance(val, float) and np.isnan(val))) else format(val, fmt)


def _print_table(rows: list[tuple[str, BacktestResult]]) -> None:
    col = ["策略", "累计收益", "年化收益", "年化波动", "夏普", "最大回撤", "交易数", "胜率"]
    w   = [22,      9,          9,          8,          6,      9,          6,         7]
    header = "  ".join(f"{c:>{w[i]}s}" for i, c in enumerate(col))
    sep    = "─" * len(header)
    print(header)
    print(sep)
    for name, r in rows:
        wr = _fmt(r.win_rate, ".1%")
        if r.has_open_position:
            wr += "*"
        print("  ".join([
            f"{name:>{w[0]}s}",
            f"{_fmt(r.total_return,     '+.2%'):>{w[1]}s}",
            f"{_fmt(r.annualized_return,'+.2%'):>{w[2]}s}",
            f"{_fmt(r.annualized_vol,   '.2%'):>{w[3]}s}",
            f"{_fmt(r.sharpe,           '.2f'):>{w[4]}s}",
            f"{_fmt(r.max_dd,           '+.2%'):>{w[5]}s}",
            f"{r.n_trades:>{w[6]}d}",
            f"{wr:>{w[7]}s}",
        ]))
    print(sep)
    print("  * 回测结束时仍持仓，胜率仅统计已完成交易")


def main() -> None:
    print("拉取 AAPL 和 SPY 两年数据…\n")
    data = fetch(["AAPL", "SPY"], lookback="2y")
    aapl = data["AAPL"]
    spy  = data["SPY"]

    # ── 三种策略 ─────────────────────────────────────────────────────────────
    aapl_sigs   = ma_cross_signal(aapl["Close"], fast=20, slow=50)
    aapl_ma     = run(aapl, aapl_sigs,    INITIAL, COMMISSION)
    aapl_bnh    = run(aapl, _bnh_signals(aapl), INITIAL, COMMISSION)
    spy_bnh     = run(spy,  _bnh_signals(spy),  INITIAL, COMMISSION)

    # ── 报告头 ───────────────────────────────────────────────────────────────
    start = aapl.index[0].date()
    end   = aapl.index[-1].date()
    n     = len(aapl)
    print(f"回测区间：{start}  →  {end}  （{n} 个交易日）")
    print(f"初始资金：${INITIAL:>,.0f}   手续费：{COMMISSION:.1%} 单边\n")

    # ── 绩效表格 ─────────────────────────────────────────────────────────────
    _print_table([
        ("AAPL MA20/50 交叉", aapl_ma),
        ("AAPL 买入持有",     aapl_bnh),
        ("SPY  买入持有",     spy_bnh),
    ])

    # ── 详细交易记录 ──────────────────────────────────────────────────────────
    print(f"\nAAP MA 交叉策略 — 全部 {aapl_ma.n_trades} 笔已完成交易：")
    if aapl_ma.trades:
        print(f"  {'买入日':12s}  {'买入价':>8s}  {'卖出日':12s}  {'卖出价':>8s}  {'净收益':>9s}")
        print("  " + "─" * 58)
        for t in aapl_ma.trades:
            marker = "✓" if t.pnl_pct > 0 else "✗"
            print(
                f"  {t.entry_date.date()!s:12s}  {t.entry_price:>8.2f}"
                f"  {t.exit_date.date()!s:12s}  {t.exit_price:>8.2f}"
                f"  {t.pnl_pct:>+9.2%}  {marker}"
            )
    else:
        print("  （回测期间未完成任何往返交易）")

    # ── 未平仓情况 ───────────────────────────────────────────────────────────
    if aapl_ma.has_open_position:
        last_close   = aapl["Close"].iloc[-1]
        unrealized   = last_close / aapl_ma.open_entry_price - 1
        print(
            f"\n未平仓：买入于 {aapl_ma.open_entry_date.date()}  "
            f"@ ${aapl_ma.open_entry_price:.2f}，"
            f"当前未实现收益 {unrealized:+.2%}"
        )

    # ── 权益曲线对比（最近 10 天） ───────────────────────────────────────────
    print("\n权益曲线末尾对比（最近 10 天，初始资金 $10,000）：")
    cmp = pd.DataFrame({
        "AAPL_MA": aapl_ma.equity,
        "AAPL_BnH": aapl_bnh.equity,
        "SPY_BnH":  spy_bnh.equity,
    })
    print(cmp.tail(10).to_string(float_format="${:>,.2f}".format))


if __name__ == "__main__":
    main()
