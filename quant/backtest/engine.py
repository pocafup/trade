"""
回测引擎 — 单标的、只做多、逐日推进。

执行时点约定（无前视偏差的关键）
─────────────────────────────────
  第 T 天收盘后才能读到 signals[T]。
  因此 signals[T] 产生的交易，最早在第 T+1 天开盘价（Open[T+1]）执行。
  严禁用 Close[T] 成交 signals[T]——那是最常见的前视偏差来源。

手续费模型
──────────
  买入：shares = cash / (open * (1 + commission))
  卖出：proceeds = shares * open * (1 - commission)
  买卖各收一次，默认 0.1%。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd

from indicators.risk import annualized_volatility, max_drawdown, sharpe_ratio


# ── 交易记录 ───────────────────────────────────────────────────────────────────

@dataclass
class Trade:
    """一次完整的买入→卖出往返记录。"""

    entry_date:  pd.Timestamp
    entry_price: float      # T+1 开盘成交价（原始价，不含手续费）
    exit_date:   pd.Timestamp
    exit_price:  float      # T+1 开盘成交价（原始价，不含手续费）
    shares:      float      # 实际买入股数（已隐含买入手续费）
    commission:  float      # 单边手续费率

    @property
    def pnl(self) -> float:
        """净盈亏（双向手续费均已扣除）"""
        revenue = self.shares * self.exit_price  * (1 - self.commission)
        cost    = self.shares * self.entry_price * (1 + self.commission)
        return revenue - cost

    @property
    def pnl_pct(self) -> float:
        """
        净收益率 = 净卖出 / 净买入 − 1
                 = exit*(1−c) / (entry*(1+c)) − 1

        正值盈利，负值亏损；0.2% 以上涨幅才能覆盖双向手续费。
        """
        entry_net = self.entry_price * (1 + self.commission)
        if entry_net == 0:
            return 0.0
        return self.exit_price * (1 - self.commission) / entry_net - 1


# ── 回测结果 ───────────────────────────────────────────────────────────────────

@dataclass
class BacktestResult:
    """回测输出：权益曲线 + 交易记录 + 绩效指标。"""

    equity:          pd.Series         # 每日权益（现金 + 持仓市值），DatetimeIndex
    trades:          list[Trade]       # 已完成的往返交易
    initial_capital: float
    commission:      float
    # 若回测结束时仍持仓，记录未平仓信息（用于报告）
    open_entry_date:  pd.Timestamp | None = None
    open_entry_price: float | None        = None

    # ── 绩效属性 ──────────────────────────────────────────────────────────────

    @property
    def total_return(self) -> float:
        """累计收益率：(终值 / 初值) − 1"""
        return float(self.equity.iloc[-1] / self.equity.iloc[0] - 1)

    @property
    def annualized_return(self) -> float:
        """
        年化收益率 = (1 + 累计收益)^(252/n) − 1
        n = 实际交易日数，与夏普分母保持一致。
        """
        n = max(len(self.equity), 1)
        return float((1 + self.total_return) ** (252 / n) - 1)

    @property
    def annualized_vol(self) -> float:
        """年化波动率（基于权益曲线对数收益率）"""
        return annualized_volatility(self.equity)

    @property
    def sharpe(self) -> float:
        """年化夏普比率（无风险利率 = 0）"""
        log_ret = np.diff(np.log(self.equity.values))
        if np.std(log_ret) == 0:
            return float("nan")
        return sharpe_ratio(self.equity)

    @property
    def max_dd(self) -> float:
        """最大回撤（负数）"""
        return max_drawdown(self.equity)

    @property
    def n_trades(self) -> int:
        """已完成的往返交易笔数"""
        return len(self.trades)

    @property
    def win_rate(self) -> float:
        """
        胜率 = 盈利笔数 / 总笔数
        盈利：扣双向手续费后 pnl_pct > 0。
        无已完成交易时返回 NaN。
        """
        if not self.trades:
            return float("nan")
        wins = sum(1 for t in self.trades if t.pnl_pct > 0)
        return wins / len(self.trades)

    @property
    def has_open_position(self) -> bool:
        """回测结束时是否仍持有仓位（未卖出）"""
        return self.open_entry_date is not None


# ── 引擎主函数 ─────────────────────────────────────────────────────────────────

def run(
    ohlcv: pd.DataFrame,
    signals: pd.Series,
    initial_capital: float = 10_000.0,
    commission: float = 0.001,
) -> BacktestResult:
    """
    单标的、只做多回测。

    参数
    ────
    ohlcv          : OHLCV DataFrame，需含 "Open" 和 "Close" 列，DatetimeIndex
    signals        : +1 买 / −1 卖 / 0 不动；与 ohlcv 共享索引
    initial_capital: 初始资金
    commission     : 单边手续费率（买卖各收一次）

    时点规则
    ────────
    对于每个 i > 0：
      signals[i−1]（前一天收盘时观察到的信号）→ 在 ohlcv["Open"][i] 成交
    i = 0 时无前一天信号，不产生交易。
    """
    # 对齐信号与价格序列，缺失填 0
    sigs   = signals.reindex(ohlcv.index).fillna(0).values
    opens  = ohlcv["Open"].values
    closes = ohlcv["Close"].values
    index  = ohlcv.index
    n      = len(ohlcv)

    equity_arr = np.empty(n)
    cash        = float(initial_capital)
    shares      = 0.0
    trades: list[Trade] = []

    pending_entry_date:  Optional[pd.Timestamp] = None
    pending_entry_price: Optional[float]        = None

    for i in range(n):

        # ── 执行前一天的信号（在今天开盘价成交）──────────────────────────
        if i > 0:
            prev_sig = int(sigs[i - 1])
            open_p   = float(opens[i])

            if prev_sig == 1 and shares == 0 and cash > 0:
                # 全仓买入
                shares              = cash / (open_p * (1 + commission))
                cash                = 0.0
                pending_entry_date  = index[i]
                pending_entry_price = open_p

            elif prev_sig == -1 and shares > 0:
                # 全仓卖出
                proceeds = shares * open_p * (1 - commission)
                trades.append(Trade(
                    entry_date  = pending_entry_date,
                    entry_price = pending_entry_price,
                    exit_date   = index[i],
                    exit_price  = open_p,
                    shares      = shares,
                    commission  = commission,
                ))
                cash                = proceeds
                shares              = 0.0
                pending_entry_date  = None
                pending_entry_price = None

        # ── 今天收盘后标记权益（含未实现盈亏，市值法）────────────────────
        equity_arr[i] = cash + shares * float(closes[i])

    return BacktestResult(
        equity           = pd.Series(equity_arr, index=index, name="equity"),
        trades           = trades,
        initial_capital  = initial_capital,
        commission       = commission,
        open_entry_date  = pending_entry_date,
        open_entry_price = pending_entry_price,
    )
