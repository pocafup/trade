"""
组合回测测试。

核心验证：
  1. 组合权益 = 各股权益之和（数学一致性）
  2. 初始权益 = 初始资金（资金守恒）
  3. 组合交易笔数 = 各股笔数之和
  4. 胜率、最大回撤等指标基于正确的组合曲线
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from backtest.portfolio import PortfolioResult, run_portfolio
from backtest.engine import run


# ── 工具 ───────────────────────────────────────────────────────────────────────

def _ohlcv(prices: np.ndarray, opens: np.ndarray | None = None) -> pd.DataFrame:
    n = len(prices)
    if opens is None:
        opens = prices * 0.999
    dates = pd.date_range("2020-01-02", periods=n, freq="B")
    return pd.DataFrame(
        {
            "Open":   opens,
            "High":   prices * 1.005,
            "Low":    prices * 0.995,
            "Close":  prices,
            "Volume": [100_000] * n,
        },
        index=dates,
    )


def _bnh(prices: pd.Series) -> pd.Series:
    """买入持有信号：第一天买入，之后不动。"""
    s = pd.Series(0, index=prices.index, dtype=int)
    s.iloc[0] = 1
    return s


def _cross_signal(prices: pd.Series) -> pd.Series:
    """简单的一次买卖信号，用于构造已知交易。"""
    s = pd.Series(0, index=prices.index, dtype=int)
    s.iloc[2] = 1    # 买入
    s.iloc[10] = -1  # 卖出
    return s


# ── 数学一致性 ────────────────────────────────────────────────────────────────

def test_portfolio_equity_equals_sum_of_individuals():
    """
    组合权益曲线应精确等于各股权益曲线之和。
    用 3 只股票 × 等权资金验证。
    """
    prices_a = np.linspace(100.0, 130.0, 50)
    prices_b = np.linspace(100.0, 110.0, 50)
    prices_c = np.linspace(100.0, 120.0, 50)

    data = {
        "A": _ohlcv(prices_a),
        "B": _ohlcv(prices_b),
        "C": _ohlcv(prices_c),
    }

    result = run_portfolio(data, _bnh, initial_capital=9_000, commission=0.0)

    # 手动计算各股结果（用 Close Series，保持 DatetimeIndex 与 OHLCV 一致）
    df_a, df_b, df_c = _ohlcv(prices_a), _ohlcv(prices_b), _ohlcv(prices_c)
    r_a = run(df_a, _bnh(df_a["Close"]), 3_000, 0.0)
    r_b = run(df_b, _bnh(df_b["Close"]), 3_000, 0.0)
    r_c = run(df_c, _bnh(df_c["Close"]), 3_000, 0.0)

    expected = r_a.equity + r_b.equity + r_c.equity
    pd.testing.assert_series_equal(result.equity, expected, check_names=False)


def test_initial_equity_equals_capital():
    """第一天组合权益应等于初始资金（尚未交易）。"""
    prices = np.linspace(100.0, 120.0, 30)
    data   = {"X": _ohlcv(prices), "Y": _ohlcv(prices)}

    # 无信号策略
    result = run_portfolio(
        data,
        lambda p: pd.Series(0, index=p.index, dtype=int),
        initial_capital=10_000,
    )

    assert result.equity.iloc[0] == pytest.approx(10_000.0)


def test_capital_split_equally():
    """每只股票分到 initial_capital / N 的资金。"""
    prices = np.linspace(100.0, 110.0, 30)
    data   = {sym: _ohlcv(prices) for sym in ["A", "B", "C", "D", "E"]}

    result = run_portfolio(data, _bnh, initial_capital=10_000, commission=0.0)

    for sym, r in result.per_stock.items():
        # 每只 2000，第一天全是现金
        assert r.equity.iloc[0] == pytest.approx(2_000.0), f"{sym} 初始权益不是 2000"


# ── 交易统计 ──────────────────────────────────────────────────────────────────

def test_n_trades_equals_sum_of_individual():
    """组合总交易笔数 = 各股已完成笔数之和。"""
    prices = np.linspace(100.0, 120.0, 20)
    data   = {"A": _ohlcv(prices), "B": _ohlcv(prices), "C": _ohlcv(prices)}

    result = run_portfolio(data, _cross_signal, initial_capital=9_000, commission=0.0)

    individual_total = sum(r.n_trades for r in result.per_stock.values())
    assert result.n_trades == individual_total


def test_win_rate_nan_when_no_trades():
    """无已完成交易时，胜率为 NaN。"""
    prices = np.linspace(100.0, 110.0, 20)
    data   = {"A": _ohlcv(prices)}

    result = run_portfolio(
        data,
        lambda p: pd.Series(0, index=p.index, dtype=int),
    )

    assert np.isnan(result.win_rate)


# ── 绩效指标 ──────────────────────────────────────────────────────────────────

def test_total_return_consistent_with_equity():
    """total_return = (equity[-1] / equity[0]) - 1"""
    prices = np.linspace(100.0, 150.0, 60)
    data   = {"A": _ohlcv(prices), "B": _ohlcv(prices)}

    result = run_portfolio(data, _bnh, initial_capital=10_000, commission=0.0)

    expected = result.equity.iloc[-1] / result.equity.iloc[0] - 1
    assert result.total_return == pytest.approx(expected, rel=1e-9)


def test_max_drawdown_negative_for_volatile_portfolio():
    """随机波动的组合，最大回撤应 ≤ 0。"""
    rng = np.random.default_rng(42)
    data = {
        sym: _ohlcv(100.0 * np.exp(np.cumsum(rng.normal(0.001, 0.02, 150))))
        for sym in ["A", "B", "C"]
    }

    result = run_portfolio(data, _bnh, initial_capital=9_000)
    assert result.max_dd <= 0


def test_open_positions_count():
    """open_positions_count = 回测结束时仍持仓的股票数。"""
    prices = np.linspace(100.0, 120.0, 20)
    data   = {
        "A": _ohlcv(prices),   # 买入后持有（B&H）
        "B": _ohlcv(prices),   # 无信号，不持仓
    }

    def mixed_signal(p: pd.Series) -> pd.Series:
        """A 持有，B 不买。"""
        s = pd.Series(0, index=p.index, dtype=int)
        return s

    result_no_hold = run_portfolio(data, mixed_signal, initial_capital=10_000)
    assert result_no_hold.n_open_positions == 0

    result_hold = run_portfolio(data, _bnh, initial_capital=10_000)
    # 两只都买了，回测结束时都持仓
    assert result_hold.n_open_positions == 2
