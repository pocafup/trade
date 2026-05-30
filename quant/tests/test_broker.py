"""
Unit tests for broker.alpaca — all calls are mocked; no real credentials needed.
"""
import pytest
from unittest.mock import MagicMock, patch

import broker.alpaca as mod
from broker.alpaca import (
    cancel_order,
    get_account,
    get_order,
    get_orders,
    get_position,
    get_positions,
    place_limit_order,
    place_market_order,
)
from alpaca.trading.enums import OrderSide, TimeInForce
from alpaca.trading.requests import LimitOrderRequest, MarketOrderRequest


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("APCA_API_KEY_ID", "test_key")
    monkeypatch.setenv("APCA_API_SECRET_KEY", "test_secret")


@pytest.fixture
def tc():
    """Patch TradingClient; yield the mock instance."""
    with patch("broker.alpaca.TradingClient") as cls:
        instance = MagicMock()
        cls.return_value = instance
        yield instance


# ── Account & positions ───────────────────────────────────────────────────────

def test_get_account(tc):
    tc.get_account.return_value = MagicMock(equity="100000", cash="50000")
    result = get_account()
    tc.get_account.assert_called_once()
    assert result.equity == "100000"


def test_get_positions_empty(tc):
    tc.get_all_positions.return_value = []
    assert get_positions() == []
    tc.get_all_positions.assert_called_once()


def test_get_positions_returns_list(tc):
    tc.get_all_positions.return_value = [MagicMock(symbol="AAPL"), MagicMock(symbol="TSLA")]
    result = get_positions()
    assert len(result) == 2


def test_get_position(tc):
    tc.get_open_position.return_value = MagicMock(symbol="AAPL")
    result = get_position("AAPL")
    tc.get_open_position.assert_called_once_with("AAPL")
    assert result.symbol == "AAPL"


# ── Market orders ─────────────────────────────────────────────────────────────

def test_place_market_order_buy(tc):
    tc.submit_order.return_value = MagicMock(id="ord-001")
    place_market_order("AAPL", 10, "buy")

    req = tc.submit_order.call_args[0][0]
    assert isinstance(req, MarketOrderRequest)
    assert req.symbol == "AAPL"
    assert req.qty == 10
    assert req.side == OrderSide.BUY
    assert req.time_in_force == TimeInForce.DAY


def test_place_market_order_sell(tc):
    place_market_order("NVDA", 5, "sell")
    req = tc.submit_order.call_args[0][0]
    assert req.side == OrderSide.SELL


def test_place_market_order_invalid_side(tc):
    with pytest.raises(ValueError, match="side must be"):
        place_market_order("AAPL", 1, "long")


# ── Limit orders ──────────────────────────────────────────────────────────────

def test_place_limit_order(tc):
    place_limit_order("TSLA", 2, "buy", 190.50)
    req = tc.submit_order.call_args[0][0]
    assert isinstance(req, LimitOrderRequest)
    assert req.symbol == "TSLA"
    assert req.qty == 2
    assert req.side == OrderSide.BUY
    assert req.limit_price == 190.50
    assert req.time_in_force == TimeInForce.DAY


def test_place_limit_order_sell(tc):
    place_limit_order("MSFT", 3, "sell", 420.0)
    req = tc.submit_order.call_args[0][0]
    assert req.side == OrderSide.SELL
    assert req.limit_price == 420.0


# ── Order status ──────────────────────────────────────────────────────────────

def test_get_order(tc):
    tc.get_order_by_id.return_value = MagicMock(id="ord-123", status="filled")
    result = get_order("ord-123")
    tc.get_order_by_id.assert_called_once_with("ord-123")
    assert result.status == "filled"


def test_get_orders(tc):
    tc.get_orders.return_value = [MagicMock(), MagicMock()]
    result = get_orders()
    assert len(result) == 2


def test_cancel_order(tc):
    cancel_order("ord-456")
    tc.cancel_order_by_id.assert_called_once_with("ord-456")


# ── Missing env vars ──────────────────────────────────────────────────────────

def test_missing_key_raises(monkeypatch):
    monkeypatch.delenv("APCA_API_KEY_ID")
    with pytest.raises(KeyError):
        mod._client()


def test_missing_secret_raises(monkeypatch):
    monkeypatch.delenv("APCA_API_SECRET_KEY")
    with pytest.raises(KeyError):
        mod._client()
