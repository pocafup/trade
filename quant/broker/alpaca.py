"""
Thin wrapper around alpaca-py TradingClient for paper trading.

Required env vars:
    APCA_API_KEY_ID      — Alpaca paper API key
    APCA_API_SECRET_KEY  — Alpaca paper secret key
"""
import os

from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, TimeInForce
from alpaca.trading.requests import (
    GetOrdersRequest,
    LimitOrderRequest,
    MarketOrderRequest,
)


def _client() -> TradingClient:
    return TradingClient(
        api_key=os.environ["APCA_API_KEY_ID"],
        secret_key=os.environ["APCA_API_SECRET_KEY"],
        paper=True,
    )


def _side(s: str) -> OrderSide:
    s = s.lower()
    if s not in ("buy", "sell"):
        raise ValueError(f"side must be 'buy' or 'sell', got {s!r}")
    return OrderSide.BUY if s == "buy" else OrderSide.SELL


# ── Account & positions ───────────────────────────────────────────────────────

def get_account():
    """Account overview: equity, cash, buying_power, status, etc."""
    return _client().get_account()


def get_positions() -> list:
    """All open positions."""
    return _client().get_all_positions()


def get_position(symbol: str):
    """Open position for one symbol. Raises if not held."""
    return _client().get_open_position(symbol)


# ── Orders ────────────────────────────────────────────────────────────────────

def place_market_order(symbol: str, qty: float, side: str):
    """Submit a DAY market order."""
    req = MarketOrderRequest(
        symbol=symbol,
        qty=qty,
        side=_side(side),
        time_in_force=TimeInForce.DAY,
    )
    return _client().submit_order(req)


def place_limit_order(symbol: str, qty: float, side: str, limit_price: float):
    """Submit a DAY limit order."""
    req = LimitOrderRequest(
        symbol=symbol,
        qty=qty,
        side=_side(side),
        limit_price=limit_price,
        time_in_force=TimeInForce.DAY,
    )
    return _client().submit_order(req)


def get_order(order_id: str):
    """Fetch a single order by UUID."""
    return _client().get_order_by_id(order_id)


def get_orders(status: str = "all") -> list:
    """List orders. status: 'open' | 'closed' | 'all'."""
    return _client().get_orders(GetOrdersRequest(status=status))


def cancel_order(order_id: str) -> None:
    """Cancel an open order by UUID."""
    _client().cancel_order_by_id(order_id)
