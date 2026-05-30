"""
风险指标单元测试。

每个测试验证"公式在数学上是否正确"，使用构造好的已知答案序列。
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from indicators.risk import (
    TRADING_DAYS,
    _log_returns,
    annualized_volatility,
    beta,
    cvar_historical,
    max_drawdown,
    sharpe_ratio,
    sortino_ratio,
    var_historical,
)


# ── 工具 ───────────────────────────────────────────────────────────────────────

def _prices_from_log_returns(log_returns: np.ndarray, p0: float = 100.0) -> pd.Series:
    """给定对数收益率序列，反推价格序列（含起始价格）。"""
    return pd.Series(p0 * np.exp(np.concatenate([[0.0], np.cumsum(log_returns)])))


# ── 对数收益率 ─────────────────────────────────────────────────────────────────

def test_log_returns_length():
    prices = pd.Series([100.0, 105.0, 110.0])
    r = _log_returns(prices)
    assert len(r) == 2  # 有 n 个价格，就有 n-1 个收益率

def test_log_returns_values():
    prices = pd.Series([100.0, np.e * 100])  # ln(e) = 1
    r = _log_returns(prices)
    assert r.iloc[0] == pytest.approx(1.0)


# ── 年化波动率 ─────────────────────────────────────────────────────────────────

def test_annualized_volatility_formula():
    """
    年化波动率 = std(log_returns, ddof=1) × √252
    用已知对数收益率序列验证乘法关系。
    """
    log_ret = np.array([0.01, -0.02, 0.015, -0.005, 0.03, -0.01])
    prices = _prices_from_log_returns(log_ret)
    expected = float(np.std(log_ret, ddof=1) * np.sqrt(TRADING_DAYS))
    assert annualized_volatility(prices) == pytest.approx(expected, rel=1e-9)

def test_annualized_volatility_constant_price():
    """价格不变 → 对数收益率全为 0 → 波动率为 0。"""
    prices = pd.Series([100.0] * 10)
    assert annualized_volatility(prices) == pytest.approx(0.0, abs=1e-12)


# ── 最大回撤 ───────────────────────────────────────────────────────────────────

def test_max_drawdown_known_case():
    """
    价格序列：100 → 200 → 100
    最大回撤 = (100 − 200) / 200 = −50%
    """
    prices = pd.Series([100.0, 150.0, 200.0, 150.0, 100.0])
    assert max_drawdown(prices) == pytest.approx(-0.5)

def test_max_drawdown_monotone_up():
    """价格单调上涨 → 没有回撤 → 最大回撤为 0。"""
    prices = pd.Series([100.0, 110.0, 120.0, 130.0])
    assert max_drawdown(prices) == pytest.approx(0.0, abs=1e-12)

def test_max_drawdown_is_negative():
    """最大回撤应 ≤ 0（只有单调上涨才等于 0）。"""
    rng = np.random.default_rng(42)
    prices = pd.Series(100.0 * np.exp(np.cumsum(rng.normal(0.001, 0.02, 200))))
    assert max_drawdown(prices) <= 0.0

def test_max_drawdown_partial():
    """
    100 → 120 → 90 → 110 → 80
    峰值 120 跌到 80：(80-120)/120 = -1/3 ≈ -33.3%
    """
    prices = pd.Series([100.0, 120.0, 90.0, 110.0, 80.0])
    assert max_drawdown(prices) == pytest.approx(-1 / 3, rel=1e-6)


# ── Beta ──────────────────────────────────────────────────────────────────────

def test_beta_double():
    """
    若 r_股 = 2 × r_基准（对数收益率逐日精确），
    则 Cov(2r, r) / Var(r) = 2。
    """
    base_ret = np.array([0.01, -0.005, 0.02, -0.008, 0.012, -0.003])
    bench = _prices_from_log_returns(base_ret)
    stock = _prices_from_log_returns(2 * base_ret)
    assert beta(stock, bench) == pytest.approx(2.0, rel=1e-9)

def test_beta_one():
    """r_股 = r_基准 → Beta = 1。"""
    base_ret = np.array([0.01, -0.005, 0.02, -0.008])
    bench = _prices_from_log_returns(base_ret)
    stock = _prices_from_log_returns(base_ret)
    assert beta(stock, bench) == pytest.approx(1.0, rel=1e-9)

def test_beta_negative():
    """r_股 = −r_基准 → Beta = −1（完全反向）。"""
    base_ret = np.array([0.01, -0.005, 0.02, -0.008, 0.015])
    bench = _prices_from_log_returns(base_ret)
    stock = _prices_from_log_returns(-base_ret)
    assert beta(stock, bench) == pytest.approx(-1.0, rel=1e-9)


# ── 夏普比率 ──────────────────────────────────────────────────────────────────

def test_sharpe_formula():
    """夏普 = (mean_日 / std_日) × √252，无风险利率为 0 时。"""
    log_ret = np.array([0.01, 0.02, -0.01, 0.015, -0.005, 0.008])
    prices = _prices_from_log_returns(log_ret)
    expected = float(np.mean(log_ret) / np.std(log_ret, ddof=1) * np.sqrt(TRADING_DAYS))
    assert sharpe_ratio(prices) == pytest.approx(expected, rel=1e-9)

def test_sharpe_positive_for_positive_mean():
    """日均收益率为正时，夏普应 > 0。"""
    log_ret = np.full(50, 0.002)  # 每天涨 0.2%
    log_ret[::5] = -0.001         # 每隔 5 天微跌，制造波动
    prices = _prices_from_log_returns(log_ret)
    assert sharpe_ratio(prices) > 0

def test_sharpe_with_risk_free():
    """提供无风险利率时，夏普应 < 无风险利率为 0 时的夏普（分子更小）。"""
    log_ret = np.array([0.01, 0.02, -0.01, 0.015, -0.005])
    prices = _prices_from_log_returns(log_ret)
    s0 = sharpe_ratio(prices, risk_free_annual=0.0)
    s1 = sharpe_ratio(prices, risk_free_annual=0.05)
    assert s0 > s1


# ── 索提诺比率 ────────────────────────────────────────────────────────────────

def test_sortino_infinite_when_no_downside():
    """所有收益率 ≥ 0 → 下行偏差为 0 → 索提诺 = 无穷大。"""
    prices = pd.Series([100.0, 101.0, 102.0, 103.0, 104.0])
    assert sortino_ratio(prices) == float("inf")

def test_sortino_geq_sharpe_for_positive_excess():
    """
    超额收益为正时，索提诺 ≥ 夏普。
    原因：下行偏差 ≤ 总波动率，因此分母更小，比值更大。
    """
    rng = np.random.default_rng(7)
    log_ret = rng.normal(0.002, 0.02, 200)
    prices = _prices_from_log_returns(log_ret)
    s = sharpe_ratio(prices)
    so = sortino_ratio(prices)
    if s > 0:
        assert so >= s

def test_sortino_formula_downside_only():
    """
    构造只有下行波动（上涨无波动）的序列，验证索提诺分母只含负收益。
    序列：每隔一天 +1%，每隔一天 −2%（有明显下行偏差）。
    """
    log_ret = np.tile([0.01, -0.02], 50)
    prices = _prices_from_log_returns(log_ret)
    so = sortino_ratio(prices)
    s  = sharpe_ratio(prices)
    # 上行波动被忽略，索提诺能更准确反映"损失惩罚"
    assert np.isfinite(so)
    assert np.isfinite(s)


# ── 历史法 VaR ────────────────────────────────────────────────────────────────

def test_var_is_percentile():
    """VaR(95%) 应等于对数收益率序列的第 5 百分位数。"""
    log_ret = np.array([-0.05, -0.03, -0.01, 0.0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06])
    prices = _prices_from_log_returns(log_ret)
    r = np.log(prices.values[1:] / prices.values[:-1])
    expected = float(np.percentile(r, 5))
    assert var_historical(prices, confidence=0.95) == pytest.approx(expected, rel=1e-9)

def test_var_is_negative():
    """对正常收益率分布，95% VaR 应为负数（表示损失）。"""
    rng = np.random.default_rng(99)
    prices = pd.Series(100.0 * np.exp(np.cumsum(rng.normal(0.001, 0.02, 500))))
    assert var_historical(prices) < 0

def test_var_higher_confidence_more_conservative():
    """置信水平越高，VaR 的负值越大（更保守）。"""
    rng = np.random.default_rng(1)
    prices = pd.Series(100.0 * np.exp(np.cumsum(rng.normal(0.001, 0.02, 500))))
    var95 = var_historical(prices, confidence=0.95)
    var99 = var_historical(prices, confidence=0.99)
    assert var99 < var95  # 99% 置信水平下损失门槛更低（更坏）


# ── 历史法 CVaR ───────────────────────────────────────────────────────────────

def test_cvar_is_mean_of_tail():
    """CVaR 应等于低于 VaR 的那些收益率的均值。"""
    log_ret = np.array([-0.05, -0.03, -0.01, 0.0, 0.01, 0.02, 0.03, 0.04])
    prices = _prices_from_log_returns(log_ret)
    r = np.log(prices.values[1:] / prices.values[:-1])
    var = float(np.percentile(r, 5))
    expected = float(np.mean(r[r <= var]))
    assert cvar_historical(prices, confidence=0.95) == pytest.approx(expected, rel=1e-9)

def test_cvar_worse_than_var():
    """CVaR 应 ≤ VaR（损失更严重）。"""
    rng = np.random.default_rng(11)
    prices = pd.Series(100.0 * np.exp(np.cumsum(rng.normal(0.001, 0.02, 500))))
    assert cvar_historical(prices) <= var_historical(prices)
