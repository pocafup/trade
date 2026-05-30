"""
SPY 无幸存者偏差回测：MA20/50 + MA200 趋势过滤  vs  买入持有。

修正清单
────────
1. 单一标的 SPY — 天然无成分/存续偏差
2. 有效起点从 MA200 暖机（200 个交易日）完成后开始
   策略和 BnH 共用同一起始日，对比公平
3. 15 年数据 — 覆盖牛市/熊市/震荡市

运行：cd quant/ && python scripts/spy_backtest.py
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

from data.prices import fetch
from models.ma_cross import signal as ma_cross_signal
from backtest.engine import BacktestResult, run
from indicators.risk import max_drawdown

INITIAL    = 10_000.0
COMMISSION = 0.001
WARMUP     = 200   # MA200 需要 200 根 K 线，前 200 根为暖机期


# ── 工具函数 ──────────────────────────────────────────────────────────────────

def _fmt(val: float, fmt: str) -> str:
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return "N/A"
    return format(val, fmt)


def _position_mask(result: BacktestResult, index: pd.DatetimeIndex) -> pd.Series:
    """
    返回布尔 Series：True = 该日收盘时多头在手。
    exit_date 当天开盘卖出，收盘已是现金，因此上界用"小于"而非"小于等于"。
    """
    m = pd.Series(False, index=index)
    for t in result.trades:
        m[(index >= t.entry_date) & (index < t.exit_date)] = True
    if result.has_open_position and result.open_entry_date is not None:
        m[index >= result.open_entry_date] = True
    return m


def _annual_rows(spy: pd.DataFrame,
                 r_strat: BacktestResult,
                 r_bnh: BacktestResult,
                 pos_mask: pd.Series) -> list[dict]:
    rows = []
    for yr in sorted(spy.index.year.unique()):
        spy_yr   = spy[spy.index.year == yr]
        eq_s_yr  = r_strat.equity[r_strat.equity.index.year == yr]
        eq_b_yr  = r_bnh.equity[r_bnh.equity.index.year == yr]
        pos_yr   = pos_mask[pos_mask.index.year == yr]
        if len(spy_yr) < 2:
            continue

        # 当年价格涨跌（用第一、最后一个收盘价）
        spy_ret   = float(spy_yr["Close"].iloc[-1] / spy_yr["Close"].iloc[0] - 1)
        strat_ret = float(eq_s_yr.iloc[-1] / eq_s_yr.iloc[0] - 1) if len(eq_s_yr) >= 2 else float("nan")
        bnh_ret   = float(eq_b_yr.iloc[-1] / eq_b_yr.iloc[0] - 1) if len(eq_b_yr) >= 2 else float("nan")
        exp_yr    = float(pos_yr.mean())

        # 当年已完成交易（以卖出日归年）
        n_yr = sum(1 for t in r_strat.trades if t.exit_date.year == yr)
        if r_strat.has_open_position and r_strat.open_entry_date and r_strat.open_entry_date.year == yr:
            n_yr_label = f"{n_yr}+1持"
        else:
            n_yr_label = str(n_yr)

        rows.append(dict(
            year=yr,
            spy_ret=spy_ret,
            strat_ret=strat_ret,
            bnh_ret=bnh_ret,
            exposure=exp_yr,
            n_trades=n_yr,
            n_trades_label=n_yr_label,
            # 超额收益 = 策略 − BnH（同期）
            alpha=strat_ret - bnh_ret if not np.isnan(strat_ret) else float("nan"),
        ))
    return rows


def main() -> None:
    print("拉取 SPY 15 年数据…")
    data     = fetch(["SPY"], lookback="15y")
    spy_full = data["SPY"]
    n_full   = len(spy_full)
    print(f"  原始：{spy_full.index[0].date()} → {spy_full.index[-1].date()}"
          f"  ({n_full} 个交易日)\n")

    # ── 暖机修正 ─────────────────────────────────────────────────────────────
    # 在全量序列上算信号，保证暖机日前的 MA200 就是真实值
    full_close = spy_full["Close"]
    full_sigs  = ma_cross_signal(full_close, fast=20, slow=50, trend=200)

    # 有效区间从第 WARMUP 根 K 线（0-indexed）开始
    spy  = spy_full.iloc[WARMUP:].copy()
    sigs = full_sigs.iloc[WARMUP:].copy()

    start_date = spy.index[0].date()
    end_date   = spy.index[-1].date()
    n_days     = len(spy)

    print(f"暖机修正：跳过前 {WARMUP} 个交易日（MA200 暖机）")
    print(f"有效区间：{start_date}  →  {end_date}")
    print(f"          {n_days} 个交易日  ≈  {n_days/252:.1f} 年\n")

    # ── 策略与 BnH ─────────────────────────────────────────────────────────
    r_strat = run(spy, sigs, INITIAL, COMMISSION)

    bnh_sigs         = pd.Series(0, index=spy.index, dtype=int)
    bnh_sigs.iloc[0] = 1
    r_bnh = run(spy, bnh_sigs, INITIAL, COMMISSION)

    pos_mask = _position_mask(r_strat, spy.index)
    avg_exp  = float(pos_mask.mean())

    # ── 汇总绩效表 ────────────────────────────────────────────────────────────
    print("=" * 72)
    print("总体绩效对比")
    print("=" * 72)
    cols   = ["策略", "累计收益", "年化收益", "夏普", "最大回撤", "交易数", "胜率", "平均暴露"]
    widths = [22, 9, 9, 6, 9, 6, 7, 9]

    def _print_row(name, r, exp=None):
        wr  = _fmt(r.win_rate, ".1%") if not np.isnan(r.win_rate) else "—"
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

    header = "  ".join(f"{c:>{w}s}" for c, w in zip(cols, widths))
    sep    = "─" * len(header)
    print(header)
    print(sep)
    _print_row("MA20/50 + MA200 过滤", r_strat, avg_exp)
    _print_row("SPY 买入持有",          r_bnh)
    print(sep)
    print()

    # ── 逐年绩效 ──────────────────────────────────────────────────────────────
    print("=" * 72)
    print("逐年绩效（策略 vs BnH，及 SPY 当年价格涨跌）")
    print("=" * 72)

    ycols   = ["年份", "SPY涨跌", "BnH收益", "策略收益", "超额", "暴露度", "交易", "市场"]
    ywidths = [6, 9, 9, 9, 8, 7, 6, 5]
    yheader = "  ".join(f"{c:>{w}s}" for c, w in zip(ycols, ywidths))
    ysep    = "─" * len(yheader)
    print(yheader)
    print(ysep)

    annual = _annual_rows(spy, r_strat, r_bnh, pos_mask)
    for row in annual:
        spy_r = row["spy_ret"]
        # 市场环境标注（按 SPY 当年涨幅分类，适用于完整年）
        if spy_r > 0.15:
            regime = "牛"
        elif spy_r < -0.10:
            regime = "熊"
        else:
            regime = "震"

        alpha_s = _fmt(row["alpha"], "+.1%") if not np.isnan(row["alpha"]) else "N/A"

        cells = [
            f"{row['year']:>{ywidths[0]}d}",
            f"{_fmt(spy_r,         '+.1%'):>{ywidths[1]}s}",
            f"{_fmt(row['bnh_ret'],'+.1%'):>{ywidths[2]}s}",
            f"{_fmt(row['strat_ret'],'+.1%'):>{ywidths[3]}s}",
            f"{alpha_s:>{ywidths[4]}s}",
            f"{row['exposure']:.1%}",
            f"{row['n_trades_label']:>{ywidths[6]}s}",
            f"{regime:>{ywidths[7]}s}",
        ]
        print("  ".join(cells))

    print(ysep)
    # 市场环境说明
    bull_years = [r["year"] for r in annual if r["spy_ret"] > 0.15]
    bear_years = [r["year"] for r in annual if r["spy_ret"] < -0.10]
    rang_years = [r["year"] for r in annual if -0.10 <= r["spy_ret"] <= 0.15]
    print(f"  牛（年涨>15%）：{bull_years}")
    print(f"  熊（年跌>10%）：{bear_years}")
    print(f"  震（其余）    ：{rang_years}")
    print()

    # ── 市场环境分类汇总 ──────────────────────────────────────────────────────
    print("=" * 72)
    print("按市场环境分类：策略 vs BnH（年度算数均值）")
    print("=" * 72)
    regime_map = {
        "牛市 (SPY年涨>15%)":  [r for r in annual if r["spy_ret"] > 0.15],
        "熊市 (SPY年跌>10%)":  [r for r in annual if r["spy_ret"] < -0.10],
        "震荡 (其余)      ":  [r for r in annual if -0.10 <= r["spy_ret"] <= 0.15],
    }
    rcols   = ["市场环境", "年数", "策略均值", "BnH均值", "超额均值"]
    rwidths = [24, 4, 9, 9, 9]
    rheader = "  ".join(f"{c:>{w}s}" for c, w in zip(rcols, rwidths))
    rsep    = "─" * len(rheader)
    print(rheader)
    print(rsep)
    for label, rows in regime_map.items():
        if not rows:
            print(f"  {label:>{rwidths[0]}s}  {'0':>{rwidths[1]}s}  {'N/A':>{rwidths[2]}s}  {'N/A':>{rwidths[3]}s}  {'N/A':>{rwidths[4]}s}")
            continue
        valid = [r for r in rows if not np.isnan(r["strat_ret"])]
        if not valid:
            continue
        avg_s = np.mean([r["strat_ret"] for r in valid])
        avg_b = np.mean([r["bnh_ret"]   for r in valid])
        avg_a = np.mean([r["alpha"]     for r in valid if not np.isnan(r["alpha"])])
        cells = [
            f"{label:>{rwidths[0]}s}",
            f"{len(valid):>{rwidths[1]}d}",
            f"{_fmt(avg_s, '+.1%'):>{rwidths[2]}s}",
            f"{_fmt(avg_b, '+.1%'):>{rwidths[3]}s}",
            f"{_fmt(avg_a, '+.1%'):>{rwidths[4]}s}",
        ]
        print("  ".join(cells))
    print(rsep)
    print()

    # ── 已完成交易记录 ──────────────────────────────────────────────────────
    print("=" * 72)
    print(f"已完成交易记录（{r_strat.n_trades} 笔，按时间排序）")
    print("=" * 72)
    print(f"  {'买入日':12s}  {'买入价':>8s}  {'卖出日':12s}  {'卖出价':>8s}"
          f"  {'净收益':>9s}  {'持仓天':>6s}  结果")
    print("  " + "─" * 66)
    for t in r_strat.trades:
        hold = (t.exit_date - t.entry_date).days
        mark = "盈" if t.pnl_pct > 0 else "亏"
        print(f"  {t.entry_date.date()!s:12s}  {t.entry_price:>8.2f}"
              f"  {t.exit_date.date()!s:12s}  {t.exit_price:>8.2f}"
              f"  {t.pnl_pct:>+9.2%}  {hold:>6d}  {mark}")
    if r_strat.has_open_position:
        cur_p   = float(spy["Close"].iloc[-1])
        open_pnl = cur_p / r_strat.open_entry_price - 1
        hold     = (spy.index[-1] - r_strat.open_entry_date).days
        print(f"  {r_strat.open_entry_date.date()!s:12s}  "
              f"{r_strat.open_entry_price:>8.2f}"
              f"  {'（持仓中）':12s}  {cur_p:>8.2f}"
              f"  {open_pnl:>+9.2%}  {hold:>6d}  未平")
    print()

    # 交易分布统计
    if r_strat.trades:
        pnls   = [t.pnl_pct for t in r_strat.trades]
        holds  = [(t.exit_date - t.entry_date).days for t in r_strat.trades]
        w_hold = [(t.exit_date - t.entry_date).days for t in r_strat.trades if t.pnl_pct > 0]
        l_hold = [(t.exit_date - t.entry_date).days for t in r_strat.trades if t.pnl_pct <= 0]
        print(f"  胜率  {r_strat.win_rate:.1%}"
              f"  |  均值 {np.mean(pnls):>+.2%}  中位数 {np.median(pnls):>+.2%}")
        print(f"  最大盈 {max(pnls):>+.2%}   最大亏 {min(pnls):>+.2%}"
              f"   标准差 {np.std(pnls):.2%}")
        if w_hold:
            print(f"  盈利平均持仓 {np.mean(w_hold):.0f} 天"
                  f"   亏损平均持仓 {np.mean(l_hold):.0f} 天" if l_hold else "")
    print()

    # ── 权益曲线末尾 ─────────────────────────────────────────────────────────
    print("=" * 72)
    print("权益曲线末尾（最近 5 天，初始资金 $10,000）")
    print("=" * 72)
    cmp = pd.DataFrame({
        "MA过滤策略": r_strat.equity,
        "SPY_BnH":   r_bnh.equity,
    })
    print(cmp.tail(5).to_string(float_format="${:>,.2f}".format))


if __name__ == "__main__":
    main()
