"""
25 只 S&P 成分股组合回测：MA20/50 + MA200 过滤 vs 等权买入持有 vs SPY。
运行：cd quant/ && python scripts/verify_portfolio.py
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

from data.prices import fetch
from models.ma_cross import signal as ma_cross_signal
from backtest.portfolio import PortfolioResult, run_portfolio
from backtest.engine import run

# ── 标的池：5 个板块 × 5 只，共 25 只 S&P 500 成分股 ──────────────────────────
TICKERS = [
    # 科技 & 半导体
    "AAPL", "MSFT", "NVDA", "AVGO", "AMD",
    # 互联网 & 平台
    "GOOGL", "META", "AMZN", "NFLX", "CRM",
    # 金融
    "JPM", "BAC", "V", "MA", "GS",
    # 医疗 & 消费必需
    "UNH", "LLY", "JNJ", "PG", "KO",
    # 工业 & 能源
    "XOM", "CVX", "CAT", "HD", "MCD",
]

INITIAL    = 10_000.0
COMMISSION = 0.001   # 0.1% 单边


def _strategy(prices: pd.Series) -> pd.Series:
    return ma_cross_signal(prices, fast=20, slow=50, trend=200)


def _bnh(prices: pd.Series) -> pd.Series:
    s = pd.Series(0, index=prices.index, dtype=int)
    s.iloc[0] = 1
    return s


def _fmt(val: float, fmt: str, suffix: str = "") -> str:
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return "N/A"
    return format(val, fmt) + suffix


def _print_summary_table(rows: list[tuple[str, PortfolioResult | object]]) -> None:
    cols   = ["策略", "累计收益", "年化收益", "夏普", "最大回撤", "总交易数", "组合胜率"]
    widths = [26, 9, 9, 6, 9, 8, 9]

    header = "  ".join(f"{c:>{w}s}" for c, w in zip(cols, widths))
    sep    = "─" * len(header)
    print(header)
    print(sep)

    for name, r in rows:
        wr = _fmt(r.win_rate, ".1%")
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


def _print_per_stock(result: PortfolioResult) -> None:
    print(f"\n{'代码':6s}  {'累计收益':>9s}  {'交易数':>5s}  {'胜率':>7s}  {'状态':5s}")
    print("─" * 44)

    rows = []
    for sym, r in sorted(result.per_stock.items()):
        wr     = f"{r.win_rate:.1%}" if not np.isnan(r.win_rate) else "N/A"
        status = "持仓中" if r.has_open_position else "空仓"
        rows.append((sym, r.total_return, r.n_trades, wr, status))

    for sym, ret, n, wr, st in rows:
        print(f"{sym:6s}  {ret:>+9.2%}  {n:>5d}  {wr:>7s}  {st}")

    # 汇总
    all_trades = result.all_trades
    won        = sum(1 for t in all_trades if t.pnl_pct > 0)
    print("─" * 44)
    print(f"{'合计':6s}  {result.total_return:>+9.2%}  {result.n_trades:>5d}"
          f"  {result.win_rate:.1%}  {result.n_open_positions} 只持仓")


def main() -> None:
    print(f"拉取 {len(TICKERS)} 只股票 + SPY 两年数据…")
    all_syms = TICKERS + ["SPY"]
    data     = fetch(all_syms, lookback="2y")

    # 从 data 里分离出标的池和 SPY
    basket_data = {sym: data[sym] for sym in TICKERS if sym in data}
    spy_data    = data["SPY"]
    n_loaded    = len(basket_data)

    if n_loaded < len(TICKERS):
        missing = [s for s in TICKERS if s not in data]
        print(f"  警告：{missing} 数据缺失，跳过这些股票")

    print(f"  成功加载 {n_loaded} 只标的\n")

    # ── 三种策略 ─────────────────────────────────────────────────────────────
    r_strategy = run_portfolio(basket_data, _strategy,  INITIAL, COMMISSION)
    r_bnh      = run_portfolio(basket_data, _bnh,       INITIAL, COMMISSION)

    # SPY 买入持有（单股）
    spy_sig   = pd.Series(0, index=spy_data.index, dtype=int)
    spy_sig.iloc[0] = 1
    r_spy = run(spy_data, spy_sig, INITIAL, COMMISSION)

    # ── 报告头 ───────────────────────────────────────────────────────────────
    start = next(iter(basket_data.values())).index[0].date()
    end   = next(iter(basket_data.values())).index[-1].date()
    n_days = len(next(iter(basket_data.values())))
    per_cap = INITIAL / n_loaded

    print(f"回测区间：{start}  →  {end}  （{n_days} 个交易日）")
    print(f"标的池  ：{n_loaded} 只  |  每只分配 ${per_cap:>,.2f}  |  总初始资金 ${INITIAL:>,.0f}")
    print(f"手续费  ：{COMMISSION:.1%} 单边\n")

    # ── 汇总绩效表 ───────────────────────────────────────────────────────────
    class _SpyWrap:
        """让 SPY BacktestResult 和 PortfolioResult 能共用同一打印函数。"""
        def __init__(self, r):
            self._r = r
        total_return      = property(lambda self: self._r.total_return)
        annualized_return = property(lambda self: self._r.annualized_return)
        sharpe            = property(lambda self: self._r.sharpe)
        max_dd            = property(lambda self: self._r.max_dd)
        n_trades          = property(lambda self: self._r.n_trades)
        win_rate          = property(lambda self: float("nan"))

    _print_summary_table([
        (f"MA20/50+MA200 过滤（{n_loaded} 只）", r_strategy),
        (f"等权买入持有    （{n_loaded} 只）", r_bnh),
        ("SPY 买入持有",                        _SpyWrap(r_spy)),
    ])

    # ── 各股明细 ─────────────────────────────────────────────────────────────
    print("\n各股明细（MA 过滤策略）：")
    _print_per_stock(r_strategy)

    # ── 交易分布统计 ─────────────────────────────────────────────────────────
    all_trades = r_strategy.all_trades
    if all_trades:
        pnl_pcts = [t.pnl_pct for t in all_trades]
        print(f"\n交易收益分布（{len(all_trades)} 笔）：")
        print(f"  均值  {np.mean(pnl_pcts):>+.2%}   中位数 {np.median(pnl_pcts):>+.2%}")
        print(f"  最大  {max(pnl_pcts):>+.2%}   最小   {min(pnl_pcts):>+.2%}")
        print(f"  标准差 {np.std(pnl_pcts):.2%}")

    # ── 权益曲线末尾 ─────────────────────────────────────────────────────────
    print("\n权益曲线末尾（最近 5 天，初始资金 $10,000）：")
    cmp = pd.DataFrame({
        f"MA过滤({n_loaded}只)": r_strategy.equity,
        f"等权BnH({n_loaded}只)": r_bnh.equity,
        "SPY_BnH": r_spy.equity,
    })
    print(cmp.tail(5).to_string(float_format="${:>,.2f}".format))


if __name__ == "__main__":
    main()
