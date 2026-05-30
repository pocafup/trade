"""
Unit tests for risk.portfolio — portfolio risk monitoring module.

Hand-calculated reference (2-asset, ρ=0.5):
  σ_A=0.20, σ_B=0.30 (annual), w=[0.6, 0.4]

  Daily cov matrix Σ:
    Var_A  = (0.20)²/252 = 0.04/252
    Var_B  = (0.30)²/252 = 0.09/252
    Cov_AB = 0.5 × (0.20/√252) × (0.30/√252) = 0.03/252

  Portfolio daily variance = w'Σw:
    0.36×0.04 + 2×0.24×0.03 + 0.16×0.09 = 0.0432   (then ÷252)

  Annual σ_p = √(0.0432/252 × 252) = √0.0432 ≈ 0.20785

  Euler risk contributions:
    (Σw)_A = 0.6×0.04/252 + 0.4×0.03/252 = 0.036/252
    (Σw)_B = 0.6×0.03/252 + 0.4×0.09/252 = 0.054/252
    RC_A = 0.6 × 0.036 / 0.0432 = 0.5
    RC_B = 0.4 × 0.054 / 0.0432 = 0.5
"""
from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

from risk.portfolio import (
    _portfolio_vol_from_cov,
    _risk_contributions,
    _risk_tier,
    compute_portfolio_risk,
)

TRADING_DAYS = 252


# ── Covariance helper ──────────────────────────────────────────────────────────

def _make_cov(sigma_a: float, sigma_b: float, rho: float) -> np.ndarray:
    """Build a 2×2 daily covariance matrix from annual vols and correlation."""
    var_a = sigma_a ** 2 / TRADING_DAYS
    var_b = sigma_b ** 2 / TRADING_DAYS
    cov   = rho * (sigma_a / TRADING_DAYS**0.5) * (sigma_b / TRADING_DAYS**0.5)
    return np.array([[var_a, cov], [cov, var_b]])


# ── _portfolio_vol_from_cov ────────────────────────────────────────────────────

def test_portfolio_vol_two_asset_hand_calc():
    """σ_p = sqrt(0.0432) ≈ 0.20785 — matches pencil-and-paper calculation."""
    cov = _make_cov(0.20, 0.30, 0.5)
    w   = np.array([0.6, 0.4])
    got = _portfolio_vol_from_cov(w, cov)
    assert got == pytest.approx(np.sqrt(0.0432), rel=1e-6)


def test_portfolio_vol_single_asset():
    """One asset → portfolio vol must equal the asset's own annual vol."""
    sigma = 0.25
    cov   = np.array([[sigma**2 / TRADING_DAYS]])
    w     = np.array([1.0])
    got   = _portfolio_vol_from_cov(w, cov)
    assert got == pytest.approx(sigma, rel=1e-6)


def test_portfolio_vol_fully_correlated():
    """ρ=1 → diversification is zero; portfolio vol = weighted average vol."""
    sigma_a, sigma_b = 0.20, 0.30
    w = np.array([0.6, 0.4])
    cov = _make_cov(sigma_a, sigma_b, rho=1.0)
    got = _portfolio_vol_from_cov(w, cov)
    expected_weighted_avg = w[0] * sigma_a + w[1] * sigma_b   # 0.24
    assert got == pytest.approx(expected_weighted_avg, rel=1e-5)


def test_portfolio_vol_zero_correlation():
    """ρ=0 → σ_p = sqrt(Σ w_i²·σ_i²) < weighted average vol."""
    sigma_a, sigma_b = 0.20, 0.30
    w = np.array([0.6, 0.4])
    cov = _make_cov(sigma_a, sigma_b, rho=0.0)
    got = _portfolio_vol_from_cov(w, cov)
    # σ_p² = (0.6² × 0.04 + 0.4² × 0.09) = 0.0144 + 0.0144 = 0.0288
    expected = np.sqrt(0.0288)
    assert got == pytest.approx(expected, rel=1e-6)
    # Must be strictly less than the ρ=1 case
    weighted_avg = w[0] * sigma_a + w[1] * sigma_b
    assert got < weighted_avg


# ── _risk_contributions ────────────────────────────────────────────────────────

def test_risk_contributions_sum_to_one():
    """Euler decomposition: Σ RC_i must equal 1 exactly."""
    cov = _make_cov(0.20, 0.30, 0.5)
    w   = np.array([0.6, 0.4])
    rc  = _risk_contributions(w, cov)
    assert rc.sum() == pytest.approx(1.0, abs=1e-12)


def test_risk_contributions_two_asset_hand_calc():
    """RC_A = RC_B = 0.5 for our reference 2-asset case."""
    cov = _make_cov(0.20, 0.30, 0.5)
    w   = np.array([0.6, 0.4])
    rc  = _risk_contributions(w, cov)
    assert rc[0] == pytest.approx(0.5, abs=1e-10)
    assert rc[1] == pytest.approx(0.5, abs=1e-10)


def test_risk_contributions_equal_weights_zero_corr():
    """Equal weights, zero correlation → RC_i = w_i = 1/n for all i."""
    n   = 3
    w   = np.ones(n) / n
    # Independent assets: diagonal covariance
    cov = np.diag([0.04, 0.09, 0.06]) / TRADING_DAYS
    rc  = _risk_contributions(w, cov)
    # Equal weights + non-equal vols → RC weighted by variance, NOT equal.
    # But if all vols are identical, then RC_i = 1/n.
    cov_equal = np.eye(n) * (0.04 / TRADING_DAYS)
    rc_equal  = _risk_contributions(w, cov_equal)
    for i in range(n):
        assert rc_equal[i] == pytest.approx(1.0 / n, abs=1e-10)


def test_risk_contributions_non_negative():
    """RC_i ≥ 0 for any positive semidefinite cov and non-negative weights."""
    cov = _make_cov(0.30, 0.25, 0.3)
    w   = np.array([0.7, 0.3])
    rc  = _risk_contributions(w, cov)
    assert all(rc >= -1e-14)


def test_risk_contributions_degenerate_equal_weights():
    """Near-zero portfolio variance → falls back to 1/n uniform contribution."""
    # All assets identical → portfolio vol = asset vol → RC all equal
    w   = np.array([0.5, 0.5])
    cov = np.array([[1e-20, 1e-20], [1e-20, 1e-20]])  # near-zero variance
    rc  = _risk_contributions(w, cov)
    assert rc.sum() == pytest.approx(1.0, abs=1e-10)


# ── Diversification benefit ────────────────────────────────────────────────────

def test_diversification_benefit_positive_when_imperfect_corr():
    """portfolio_vol < weighted_avg_vol when ρ < 1."""
    cov = _make_cov(0.20, 0.30, 0.5)
    w   = np.array([0.6, 0.4])
    port_vol     = _portfolio_vol_from_cov(w, cov)
    weighted_avg = 0.6 * 0.20 + 0.4 * 0.30
    assert weighted_avg - port_vol > 0


def test_diversification_benefit_zero_when_fully_correlated():
    """ρ=1 → no diversification benefit."""
    cov = _make_cov(0.20, 0.30, rho=1.0)
    w   = np.array([0.6, 0.4])
    port_vol     = _portfolio_vol_from_cov(w, cov)
    weighted_avg = 0.6 * 0.20 + 0.4 * 0.30
    assert weighted_avg - port_vol == pytest.approx(0.0, abs=1e-5)


# ── _risk_tier ─────────────────────────────────────────────────────────────────

def test_risk_tier_boundaries():
    assert _risk_tier(0.50) == "高"
    assert _risk_tier(0.41) == "高"
    assert _risk_tier(0.40) == "中"   # boundary is strict >: 0.40 is NOT 高
    assert _risk_tier(0.21) == "中"
    assert _risk_tier(0.20) == "低"   # boundary is strict >: 0.20 is NOT 中
    assert _risk_tier(0.01) == "低"


# ── compute_portfolio_risk integration (mocked fetch) ─────────────────────────

def _make_prices(n: int, seed: int, drift: float = 0.0, vol: float = 0.01) -> pd.Series:
    """Generate a synthetic price series of length n+1 (first row is base)."""
    rng = np.random.default_rng(seed)
    log_ret = rng.normal(drift / TRADING_DAYS, vol, size=n)
    prices  = np.exp(np.concatenate([[0.0], np.cumsum(log_ret)])) * 100.0
    dates   = pd.bdate_range(start="2022-01-03", periods=n + 1)
    return pd.Series(prices, index=dates)


def _make_ohlcv(prices: pd.Series) -> pd.DataFrame:
    return pd.DataFrame({
        "Open":   prices.values,
        "High":   prices.values * 1.005,
        "Low":    prices.values * 0.995,
        "Close":  prices.values,
        "Volume": np.ones(len(prices), dtype=int) * 1_000_000,
    }, index=prices.index)


@pytest.fixture()
def mock_fetch_two_assets():
    """Patch risk.portfolio.fetch to return two synthetic assets + SPY."""
    p_aapl = _make_prices(500, seed=1, vol=0.012)
    p_msft = _make_prices(500, seed=2, vol=0.010)
    p_spy  = _make_prices(500, seed=3, vol=0.008)
    fake   = {
        "AAPL": _make_ohlcv(p_aapl),
        "MSFT": _make_ohlcv(p_msft),
        "SPY":  _make_ohlcv(p_spy),
    }
    with patch("risk.portfolio.fetch", return_value=fake):
        yield


def test_compute_portfolio_risk_returns_correct_types(mock_fetch_two_assets):
    from risk.portfolio import PortfolioMetrics, AssetMetrics
    holdings = {"AAPL": 3_000.0, "MSFT": 2_000.0}
    result = compute_portfolio_risk(holdings, lookback="2y")

    assert isinstance(result, PortfolioMetrics)
    assert result.n_assets == 2
    assert set(result.per_asset.keys()) == {"AAPL", "MSFT"}
    for am in result.per_asset.values():
        assert isinstance(am, AssetMetrics)


def test_compute_portfolio_risk_portfolio_vol_positive(mock_fetch_two_assets):
    holdings = {"AAPL": 3_000.0, "MSFT": 2_000.0}
    result = compute_portfolio_risk(holdings, lookback="2y")
    assert result.portfolio_vol > 0


def test_compute_portfolio_risk_diversification_benefit_nonneg(mock_fetch_two_assets):
    """Weighted avg vol ≥ portfolio vol (diversification can only help)."""
    holdings = {"AAPL": 3_000.0, "MSFT": 2_000.0}
    result = compute_portfolio_risk(holdings, lookback="2y")
    assert result.diversification_benefit >= -1e-10


def test_compute_portfolio_risk_rc_sums_to_one(mock_fetch_two_assets):
    """Risk contributions across all assets must sum to 1."""
    holdings = {"AAPL": 3_000.0, "MSFT": 2_000.0}
    result = compute_portfolio_risk(holdings, lookback="2y")
    total_rc = sum(am.risk_contribution for am in result.per_asset.values())
    assert total_rc == pytest.approx(1.0, abs=1e-10)


def test_compute_portfolio_risk_weights_sum_to_one(mock_fetch_two_assets):
    holdings = {"AAPL": 3_000.0, "MSFT": 2_000.0}
    result = compute_portfolio_risk(holdings, lookback="2y")
    total_w = sum(am.weight for am in result.per_asset.values())
    assert total_w == pytest.approx(1.0, abs=1e-10)


def test_compute_portfolio_risk_var_less_than_zero(mock_fetch_two_assets):
    """VaR and CVaR are loss metrics — should be negative."""
    holdings = {"AAPL": 3_000.0, "MSFT": 2_000.0}
    result = compute_portfolio_risk(holdings, lookback="2y")
    assert result.var95 < 0
    assert result.cvar95 < 0


def test_compute_portfolio_risk_cvar_le_var(mock_fetch_two_assets):
    """CVaR ≤ VaR — expected shortfall is at least as bad as VaR."""
    holdings = {"AAPL": 3_000.0, "MSFT": 2_000.0}
    result = compute_portfolio_risk(holdings, lookback="2y")
    assert result.cvar95 <= result.var95 + 1e-10


def test_compute_portfolio_risk_correlation_matrix_shape(mock_fetch_two_assets):
    holdings = {"AAPL": 3_000.0, "MSFT": 2_000.0}
    result = compute_portfolio_risk(holdings, lookback="2y")
    assert result.correlation.shape == (2, 2)
    # Diagonal must be 1.0
    assert result.correlation.loc["AAPL", "AAPL"] == pytest.approx(1.0)
    assert result.correlation.loc["MSFT", "MSFT"] == pytest.approx(1.0)


def test_compute_portfolio_risk_single_asset(mock_fetch_two_assets):
    """Single asset: portfolio vol == weighted avg vol (diversification benefit = 0)."""
    p_single = _make_prices(500, seed=10, vol=0.015)
    fake_single = {
        "AAPL": _make_ohlcv(p_single),
        "SPY":  _make_ohlcv(_make_prices(500, seed=11, vol=0.008)),
    }
    with patch("risk.portfolio.fetch", return_value=fake_single):
        result = compute_portfolio_risk({"AAPL": 5_000.0}, lookback="2y")
    assert result.diversification_benefit == pytest.approx(0.0, abs=1e-10)
    assert result.portfolio_vol == pytest.approx(result.weighted_avg_vol, rel=1e-6)


def test_compute_portfolio_risk_input_type_weight(mock_fetch_two_assets):
    """input_type='weight' normalises arbitrary positive numbers to a valid portfolio."""
    holdings = {"AAPL": 3.0, "MSFT": 2.0}   # raw weights (unnormalised)
    result = compute_portfolio_risk(holdings, lookback="2y", input_type="weight")
    total_w = sum(am.weight for am in result.per_asset.values())
    assert total_w == pytest.approx(1.0, abs=1e-10)


def test_compute_portfolio_risk_invalid_input_type(mock_fetch_two_assets):
    with pytest.raises(ValueError, match="input_type"):
        compute_portfolio_risk({"AAPL": 1.0}, lookback="2y", input_type="bad")


def test_compute_portfolio_risk_max_dd_negative(mock_fetch_two_assets):
    """Max drawdown should be ≤ 0 (or 0 if prices only rose)."""
    holdings = {"AAPL": 3_000.0, "MSFT": 2_000.0}
    result = compute_portfolio_risk(holdings, lookback="2y")
    assert result.max_dd <= 0
