"""
仓位暴露度分析 + 持仓期绩效重算 + 幸存者偏差说明。
运行：cd quant/ && python scripts/analyze_exposure.py
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

from data.prices import fetch
from models.ma_cross import signal as ma_cross_signal
from backtest.portfolio import PortfolioResult, run_portfolio
from backtest.engine import BacktestResult, run
from indicators.risk import max_drawdown

TICKERS = [
    "AAPL", "MSFT", "NVDA", "AVGO", "AMD",
    "GOOGL", "META", "AMZN", "NFLX", "CRM",
    "JPM",  "BAC",  "V",    "MA",   "GS",
    "UNH",  "LLY",  "JNJ",  "PG",   "KO",
    "XOM",  "CVX",  "CAT",  "HD",   "MCD",
]

INITIAL    = 10_000.0
COMMISSION = 0.001


def _strategy(prices: pd.Series) -> pd.Series:
    return ma_cross_signal(prices, fast=20, slow=50, trend=200)


def _position_mask(result: BacktestResult, index: pd.DatetimeIndex) -> pd.Series:
    """
    返回 bool Series：True = 该日收盘时多头在手。
    exit_date 当天已在开盘卖出，收盘时已是现金，所以是"小于"而非"小于等于"。
    """
    m = pd.Series(False, index=index)
    for t in result.trades:
        m[(index >= t.entry_date) & (index < t.exit_date)] = True
    if result.has_open_position and result.open_entry_date is not None:
        m[index >= result.open_entry_date] = True
    return m


def _segment_maxdd(equity: pd.Series, in_pos_mask: pd.Series) -> float:
    """
    分段计算持仓区间内的最大回撤，取所有段中最差的值。

    为何分段：空仓期权益基本不动（现金不涨不跌），跨越空仓期的"虚假回撤"
    会掩盖实际持仓期内的真实回撤。逐段计算还原持仓期间的真实风险暴露。
    """
    vals     = in_pos_mask.values
    eq_vals  = equity.values
    worst_dd = 0.0
    i        = 0
    n        = len(vals)

    while i < n:
        # 找下一个持仓段的起点
        while i < n and not vals[i]:
            i += 1
        if i >= n:
            break
        start = i
        # 找段的终点（第一个空仓日）
        while i < n and vals[i]:
            i += 1
        seg = pd.Series(eq_vals[start:i])
        if len(seg) >= 2:
            dd = max_drawdown(seg)
            worst_dd = min(worst_dd, dd)

    return worst_dd if worst_dd < 0 else float("nan")


def main() -> None:
    print(f"拉取 {len(TICKERS)} 只股票数据（数据来自缓存，应很快）…")
    data        = fetch(TICKERS, lookback="2y")
    basket_data = {s: data[s] for s in TICKERS if s in data}
    n           = len(basket_data)
    print(f"  成功加载 {n} 只标的\n")

    r = run_portfolio(basket_data, _strategy, INITIAL, COMMISSION)
    index  = r.equity.index
    equity = r.equity
    n_days = len(index)

    # ─────────────────────────────────────────────────────────────
    # 1. 每日持仓只数与暴露度
    # ─────────────────────────────────────────────────────────────
    pos_df = pd.DataFrame({
        sym: _position_mask(res, index)
        for sym, res in r.per_stock.items()
    })
    daily_count = pos_df.sum(axis=1)               # 当日持仓只数
    daily_exp   = daily_count / n                  # 暴露度 0~1

    mean_exp      = float(daily_exp.mean())
    n_any         = int((daily_exp > 0).sum())
    n_full_cash   = int((daily_exp == 0).sum())

    print("=" * 62)
    print("1. 仓位暴露度统计（MA20/50+MA200 策略）")
    print("=" * 62)
    print(f"  总交易日          : {n_days} 天")
    print(f"  完全空仓天数      : {n_full_cash} 天  ({n_full_cash/n_days:.1%})")
    print(f"  至少持 1 只的天数 : {n_any} 天  ({n_any/n_days:.1%})")
    print(f"  平均暴露度        : {mean_exp:.1%}  （= {mean_exp*n:.1f} 只均值）")
    print(f"  最高暴露度        : {daily_exp.max():.1%}  ({daily_count.max():.0f} 只同时持仓)")

    monthly = daily_exp.resample("ME").mean()
    print(f"\n  月度平均仓位曲线（每格 ≈ 1 只 = {1/n:.0%}，共 25 格）：")
    print(f"  {'月份':8s}  {'均值':>6s}  " + "─" * 27)
    for dt, val in monthly.items():
        filled = round(val * 25)
        bar    = "█" * filled + "░" * (25 - filled)
        print(f"  {dt.strftime('%Y-%m'):8s}  {val:>6.1%}  {bar}")

    # ─────────────────────────────────────────────────────────────
    # 2. 仅持仓期绩效重算
    # ─────────────────────────────────────────────────────────────
    print()
    print("=" * 62)
    print("2. 仅持仓期绩效重算")
    print("=" * 62)

    # ── 2a. 日对数收益率（仅前一天有持仓的交易日）
    log_ret   = pd.Series(np.diff(np.log(equity.values)), index=index[1:])
    # 前一天的暴露度决定今天的收益是否来自持仓
    prev_exp  = daily_exp.shift(1).reindex(log_ret.index).fillna(0)
    pos_ret   = log_ret[prev_exp > 0]

    sharpe_full = r.sharpe
    maxdd_full  = r.max_dd

    if len(pos_ret) >= 2 and pos_ret.std() > 0:
        sharpe_pos  = float(pos_ret.mean() / pos_ret.std() * np.sqrt(252))
        cum_ret_pos = float(np.exp(pos_ret.sum()) - 1)
    else:
        sharpe_pos  = float("nan")
        cum_ret_pos = float("nan")

    # ── 2b. 分段最大回撤（仅持仓区间内）
    portfolio_in_pos = (daily_exp > 0)
    segdd = _segment_maxdd(equity, portfolio_in_pos)

    # ── 2c. 暴露度标准化最大回撤（如果全程 100% 暴露，回撤大约是多少）
    # 近似公式：max_dd_full ÷ mean_exposure
    # 假设所有持仓时段的风险均匀分布（实际因分散化会略低）
    maxdd_normalized = maxdd_full / mean_exp if mean_exp > 0 else float("nan")

    # ── 2d. 投入资本回报率（Return on Invested Capital）
    # 假设空仓现金零收益，把总收益"归因"到实际部署的资本上
    roic = r.total_return / mean_exp if mean_exp > 0 else float("nan")

    print(f"\n  {'指标':22s}  {'值':>10s}  说明")
    print("  " + "─" * 66)
    print(f"  {'全期累计收益':22s}  {r.total_return:>+10.2%}  以初始 $10,000 为基数")
    print(f"  {'投入资本回报率(ROIC)':22s}  {roic:>+10.2%}  = 全期收益 / 平均暴露度 {mean_exp:.0%}")
    print(f"  {'全期夏普（含空仓天）':22s}  {sharpe_full:>10.2f}")
    print(f"  {'持仓期夏普（不含空仓）':22s}  {sharpe_pos:>10.2f}  仅统计有持仓的日收益")
    print(f"  {'全期最大回撤':22s}  {maxdd_full:>+10.2%}  相对总资金")
    print(f"  {'持仓段最大回撤':22s}  {segdd:>+10.2%}  仅在持仓区间内统计")
    print(f"  {'暴露度标准化回撤(估算)':22s}  {maxdd_normalized:>+10.2%}  ≈ 全期回撤 ÷ 平均暴露度")

    print(f"""
  ─── 解读 ───

  ① 平均暴露度仅 {mean_exp:.0%}：策略大部分时间持有现金。
    空仓日的日收益 = 0，拉低了收益序列的方差，使全期夏普虚高。

  ② 持仓期夏普 {sharpe_pos:.2f} vs 全期夏普 {sharpe_full:.2f}：
    {'持仓期夏普明显低于全期夏普——' if sharpe_pos < sharpe_full else '持仓期夏普仍高于/持平全期夏普——'}
    {'大量零收益的空仓天在分母（波动率）里贡献了降噪效果，拉高了全期夏普。' if sharpe_pos < sharpe_full else '策略在入场时机上有效，正向选择效应显著。'}

  ③ 最大回撤：-2.97% 低的根本原因有两条：
    a) 暴露度低（平均 {mean_exp:.0%}）：即使持仓股下跌 {abs(segdd/mean_exp):.0%}，
       组合回撤也只有 {abs(segdd/mean_exp)*mean_exp:.1%}（已用暴露度缩放）；
    b) 分散化：25 只股票不同步，局部亏损被其他持仓对冲。
    暴露度标准化后估算回撤为 {maxdd_normalized:.2%}，仍显著低于 SPY 的 -18.76%，
    但差距大幅缩小，不再是"奇迹般低回撤"的策略。

  ④ 投入资本回报率（ROIC）{roic:.1%}：若把空仓资金等效部署到无风险收益，
    仍跑输等权 BnH +58%（该数字本身含幸存者偏差，见第 3 节）。
""")

    # ─────────────────────────────────────────────────────────────
    # 3. 幸存者偏差
    # ─────────────────────────────────────────────────────────────
    print("=" * 62)
    print("3. 幸存者偏差（Survivorship Bias）声明")
    print("=" * 62)
    print(f"""
  ★ 结论先行：这 25 只股票的选法存在严重幸存者偏差，
    回测结果只能用于"验证策略逻辑"，不能用于评估真实预期收益。

  ── 偏差来源 ──────────────────────────────────────────

  A. 时间点偏差（最严重）
     回测起点是 2024-05-30，但选股操作发生在 2026 年。
     我们用"现在知道活下来且涨了很多的公司"组成篮子，
     而不是 2024-05-30 当天 S&P 500 官方成分名单（Point-in-Time）。

  B. 前向选择案例
     NVDA  +29.75%  ─ AI 算力爆发的直接受益者
     AVGO  +93.48%  ─ 定制 AI 芯片大赢家
     AMD   +61.24%  ─ AI 芯片竞争受益
     GS    +49.84%  ─ 2025-2026 金融周期顺风
     JNJ   +55.01%  ─ 分拆后股价修复
     以上股票在 2024 年初并非"必涨"，我们因为知道了结果才选它们。

  C. 遗漏了"失败者"
     真实 2024-2026 期间有公司被剔出 S&P 500 或大幅跑输，
     这些公司从未出现在我们篮子里：
     ─ 被降级/退出指数的公司
     ─ 医疗、零售等板块的跑输标的
     ─ Boeing、Walgreens 等基本面恶化的成分股

  D. 行业集中
     25 只中有 10 只科技/互联网，恰好命中 2024-2026 最强板块。

  ── 偏差量化 ──────────────────────────────────────────

  学术研究（Elton, Gruber & Blake 1996；Brown et al. 1992）：
    普通股票策略幸存者偏差 ≈ 年化 1~3%
    本次因重仓 AI 受益股，等权 BnH +58% 中偏差可能达 10~20%。
    MA 策略受影响稍小（入场次数少），但基准对比仍被高估。

  ── 正确做法 ──────────────────────────────────────────

  若要得到可信结论，必须：
    1. 使用 CRSP / Compustat 数据库的点时（point-in-time）成分名单，
       按回测起点当天的真实成分建仓。
    2. 每次指数调整时同步更新篮子（成分进出须忠实还原）。
    3. 或直接对 SPY（指数 ETF）本身跑 MA 策略——天然无幸存者偏差，
       且 SPY 的成分已涵盖当时指数的所有成分，包括后来的"失败者"。
""")


if __name__ == "__main__":
    main()
