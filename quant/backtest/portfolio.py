"""
多股票等权组合回测。

每只股票独立运行策略，平均分配初始资金，
汇总各股权益曲线得到组合净值。

设计选择
────────
等权分配（而非按波动率加权）：
  简单、可重复、方便解读——每只股票贡献 1/N 的初始资金。
  仓位随各股盈亏自然漂移，不做再平衡（真实反映策略净值）。

权益汇总方式：
  portfolio_equity[t] = Σ stock_equity[t]
  取所有股票日期的交集（min_count=N 确保不因个别 NaN 误报）。
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd

from indicators.risk import annualized_volatility, max_drawdown, sharpe_ratio
from .engine import BacktestResult, Trade, run


@dataclass
class PortfolioResult:
    """
    组合回测输出。

    equity     : 组合权益曲线（各股权益之和），DatetimeIndex
    per_stock  : 各股独立回测结果，symbol → BacktestResult
    """

    equity:          pd.Series
    per_stock:       dict[str, BacktestResult]
    initial_capital: float
    commission:      float

    # ── 组合级绩效指标 ────────────────────────────────────────────────────────

    @property
    def total_return(self) -> float:
        return float(self.equity.iloc[-1] / self.equity.iloc[0] - 1)

    @property
    def annualized_return(self) -> float:
        n = max(len(self.equity), 1)
        return float((1 + self.total_return) ** (252 / n) - 1)

    @property
    def annualized_vol(self) -> float:
        return annualized_volatility(self.equity)

    @property
    def sharpe(self) -> float:
        log_ret = np.diff(np.log(self.equity.values))
        if np.std(log_ret) == 0:
            return float("nan")
        return sharpe_ratio(self.equity)

    @property
    def max_dd(self) -> float:
        return max_drawdown(self.equity)

    # ── 交易汇总 ──────────────────────────────────────────────────────────────

    @property
    def all_trades(self) -> list[Trade]:
        """所有股票的已完成交易，按买入日期排序。"""
        trades: list[Trade] = []
        for r in self.per_stock.values():
            trades.extend(r.trades)
        return sorted(trades, key=lambda t: t.entry_date)

    @property
    def n_trades(self) -> int:
        return sum(r.n_trades for r in self.per_stock.values())

    @property
    def win_rate(self) -> float:
        trades = self.all_trades
        if not trades:
            return float("nan")
        return sum(1 for t in trades if t.pnl_pct > 0) / len(trades)

    @property
    def n_open_positions(self) -> int:
        """回测结束时仍持仓的股票数量。"""
        return sum(1 for r in self.per_stock.values() if r.has_open_position)


# ── 主函数 ─────────────────────────────────────────────────────────────────────

def run_portfolio(
    data: dict[str, pd.DataFrame],
    signal_fn: Callable[[pd.Series], pd.Series],
    initial_capital: float = 10_000.0,
    commission: float = 0.001,
) -> PortfolioResult:
    """
    对 data 中每只股票独立运行策略，汇总成组合净值。

    Parameters
    ----------
    data          : symbol → OHLCV DataFrame（来自 data.prices.fetch()）
    signal_fn     : 接受收盘价 pd.Series，返回 +1/−1/0 信号 pd.Series
    initial_capital: 总初始资金（平均分配给每只股票）
    commission    : 单边手续费率

    Returns
    -------
    PortfolioResult（含组合权益曲线和各股明细）

    注意
    ────
    各股权益按共同交易日（全部股票都有数据的日期）加总。
    若某股某日数据缺失，该日组合权益可能偏低——建议使用同一数据源的股票。
    """
    symbols     = list(data.keys())
    n           = len(symbols)
    per_capital = initial_capital / n

    per_stock: dict[str, BacktestResult] = {}
    for sym in symbols:
        ohlcv            = data[sym]
        sigs             = signal_fn(ohlcv["Close"])
        per_stock[sym]   = run(ohlcv, sigs, per_capital, commission)

    # 各股权益 DataFrame：行 = 日期，列 = symbol
    equity_df = pd.DataFrame(
        {sym: r.equity for sym, r in per_stock.items()}
    )

    # 检查日期对齐
    n_missing = equity_df.isna().sum().sum()
    if n_missing > 0:
        warnings.warn(
            f"组合中有 {n_missing} 个股票/日期组合缺少数据，"
            "已用 0 填充（可能低估该日权益）。",
            stacklevel=2,
        )

    portfolio_equity = equity_df.fillna(0).sum(axis=1)
    portfolio_equity.name = "portfolio_equity"

    return PortfolioResult(
        equity          = portfolio_equity,
        per_stock       = per_stock,
        initial_capital = initial_capital,
        commission      = commission,
    )
