"""
Unit tests for data.prices — all yfinance network calls are mocked.
Uses tmp_path so each test gets an isolated SQLite database.
"""
from datetime import date, timedelta
from unittest.mock import patch

import pandas as pd
import pytest

from data.prices import (
    _max_cached_date,
    _open_db,
    _parse_lookback,
    _read_from_cache,
    _write_df,
    fetch,
)


# ── Test fixtures ──────────────────────────────────────────────────────────────

def _make_ohlcv(dates: list[str]) -> pd.DataFrame:
    """Build a minimal OHLCV DataFrame that looks like yfinance output."""
    idx = pd.to_datetime(dates)
    n = len(dates)
    return pd.DataFrame(
        {
            "Open":   [100.0 + i for i in range(n)],
            "High":   [101.0 + i for i in range(n)],
            "Low":    [99.0  + i for i in range(n)],
            "Close":  [100.5 + i for i in range(n)],
            "Volume": [1_000_000 + i * 1000 for i in range(n)],
        },
        index=idx,
    )


# ── _parse_lookback ────────────────────────────────────────────────────────────

def test_parse_lookback_years():
    assert _parse_lookback("2y") == date.today() - timedelta(days=730)

def test_parse_lookback_months():
    assert _parse_lookback("6mo") == date.today() - timedelta(days=180)

def test_parse_lookback_days():
    assert _parse_lookback("90d") == date.today() - timedelta(days=90)

def test_parse_lookback_invalid():
    with pytest.raises(ValueError, match="Invalid lookback"):
        _parse_lookback("2weeks")

def test_parse_lookback_invalid_no_unit():
    with pytest.raises(ValueError, match="Invalid lookback"):
        _parse_lookback("365")


# ── DB helpers ─────────────────────────────────────────────────────────────────

def test_open_db_creates_table(tmp_path):
    con = _open_db(tmp_path / "test.db")
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    con.close()
    assert "ohlcv" in tables


def test_max_cached_date_empty(tmp_path):
    con = _open_db(tmp_path / "test.db")
    assert _max_cached_date(con, "AAPL") is None
    con.close()


def test_write_and_read_roundtrip(tmp_path):
    con = _open_db(tmp_path / "test.db")
    df = _make_ohlcv(["2024-01-02", "2024-01-03", "2024-01-04"])

    written = _write_df(con, "AAPL", df)
    assert written == 3

    out = _read_from_cache(con, "AAPL", date(2024, 1, 1))
    con.close()

    assert len(out) == 3
    assert list(out.columns) == ["Open", "High", "Low", "Close", "Volume"]
    assert out.index[0] == pd.Timestamp("2024-01-02")
    assert out["Close"].iloc[0] == pytest.approx(100.5)


def test_max_cached_date_after_write(tmp_path):
    con = _open_db(tmp_path / "test.db")
    _write_df(con, "AAPL", _make_ohlcv(["2024-01-02", "2024-01-03", "2024-06-15"]))
    assert _max_cached_date(con, "AAPL") == date(2024, 6, 15)
    con.close()


def test_read_filters_by_start(tmp_path):
    con = _open_db(tmp_path / "test.db")
    _write_df(con, "SPY", _make_ohlcv(["2024-01-02", "2024-06-01", "2024-12-31"]))
    out = _read_from_cache(con, "SPY", date(2024, 6, 1))
    con.close()
    assert len(out) == 2  # only Jun 1 and Dec 31


def test_write_deduplicates(tmp_path):
    con = _open_db(tmp_path / "test.db")
    df = _make_ohlcv(["2024-01-02", "2024-01-03"])
    _write_df(con, "AAPL", df)
    _write_df(con, "AAPL", df)  # same rows again — INSERT OR REPLACE
    out = _read_from_cache(con, "AAPL", date(2024, 1, 1))
    con.close()
    assert len(out) == 2  # no duplicate rows


def test_write_empty_df_is_noop(tmp_path):
    con = _open_db(tmp_path / "test.db")
    written = _write_df(con, "AAPL", pd.DataFrame())
    con.close()
    assert written == 0


def test_symbols_are_isolated(tmp_path):
    """Rows for different symbols don't bleed into each other."""
    con = _open_db(tmp_path / "test.db")
    _write_df(con, "AAPL", _make_ohlcv(["2024-03-01", "2024-03-04"]))
    _write_df(con, "SPY",  _make_ohlcv(["2024-03-05"]))
    assert len(_read_from_cache(con, "AAPL", date(2024, 1, 1))) == 2
    assert len(_read_from_cache(con, "SPY",  date(2024, 1, 1))) == 1
    con.close()


# ── fetch() — mocked _download ────────────────────────────────────────────────

def test_fetch_empty_cache_downloads_full_period(tmp_path):
    # Use recent dates so they fall within the 1y lookback window
    today = date.today()
    recent = [(today - timedelta(days=i)).isoformat() for i in range(3, 0, -1)]
    df_remote = _make_ohlcv(recent)
    with patch("data.prices._download", return_value=df_remote) as mock_dl:
        result = fetch(["AAPL"], lookback="1y", cache_path=tmp_path / "p.db")
        mock_dl.assert_called_once()
        _sym, call_start, _end = mock_dl.call_args[0]
        # Full lookback — fetch should start from 1y ago
        assert call_start == date.today() - timedelta(days=365)
    assert len(result["AAPL"]) == 3


def test_fetch_up_to_date_skips_download(tmp_path):
    """Cache covers the full lookback window AND has today's data — no download."""
    db = tmp_path / "p.db"
    con = _open_db(db)
    today = date.today()
    # Must cover both ends: start of 1y window (head) and today (tail)
    # so neither backfill nor tail-update is triggered
    start_of_window = today - timedelta(days=365)
    _write_df(con, "AAPL", _make_ohlcv([start_of_window.isoformat(), today.isoformat()]))
    con.close()

    with patch("data.prices._download") as mock_dl:
        fetch(["AAPL"], lookback="1y", cache_path=db)
        mock_dl.assert_not_called()


def test_fetch_stale_cache_downloads_tail_only(tmp_path):
    """Cache is a few days old — only the missing tail is fetched."""
    db = tmp_path / "p.db"
    con = _open_db(db)
    stale = date.today() - timedelta(days=5)
    _write_df(con, "AAPL", _make_ohlcv([stale.isoformat()]))
    con.close()

    df_new = _make_ohlcv([(date.today() - timedelta(days=i)).isoformat() for i in range(4, 0, -1)])
    with patch("data.prices._download", return_value=df_new) as mock_dl:
        fetch(["AAPL"], lookback="1y", cache_path=db)
        _sym, call_start, _end = mock_dl.call_args[0]
        # Should resume the day after the last cached date
        assert call_start == stale + timedelta(days=1)


def test_fetch_multiple_symbols(tmp_path):
    today = date.today()
    recent = [(today - timedelta(days=i)).isoformat() for i in range(3, 0, -1)]
    df_remote = _make_ohlcv(recent)
    with patch("data.prices._download", return_value=df_remote):
        result = fetch(["AAPL", "SPY"], lookback="1y", cache_path=tmp_path / "p.db")
    assert set(result.keys()) == {"AAPL", "SPY"}
    assert len(result["AAPL"]) == 3
    assert len(result["SPY"]) == 3


def test_fetch_returns_dataframe_with_correct_columns(tmp_path):
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    df_remote = _make_ohlcv([yesterday])
    with patch("data.prices._download", return_value=df_remote):
        result = fetch(["TSLA"], lookback="1y", cache_path=tmp_path / "p.db")
    assert list(result["TSLA"].columns) == ["Open", "High", "Low", "Close", "Volume"]
    assert isinstance(result["TSLA"].index, pd.DatetimeIndex)
