"""
Daily OHLCV cache — yfinance → SQLite, with incremental updates.

On first call for a symbol, the full requested history is downloaded.
On subsequent calls, only the missing tail (latest_cached+1 → today) is
fetched; everything else is served from the local SQLite file.

Schema (single table, primary key prevents duplicates):
    symbol TEXT, date TEXT (ISO YYYY-MM-DD), open, high, low, close, volume
"""
from __future__ import annotations

import re
import sqlite3
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

_DEFAULT_CACHE = Path(__file__).parent / "cache" / "prices.db"

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS ohlcv (
    symbol  TEXT    NOT NULL,
    date    TEXT    NOT NULL,
    open    REAL,
    high    REAL,
    low     REAL,
    close   REAL,
    volume  INTEGER,
    PRIMARY KEY (symbol, date)
)
"""

_INSERT = """
INSERT OR REPLACE INTO ohlcv (symbol, date, open, high, low, close, volume)
VALUES (?, ?, ?, ?, ?, ?, ?)
"""


# ── Helpers ────────────────────────────────────────────────────────────────────

def _parse_lookback(lookback: str) -> date:
    """
    Convert a lookback string to a start date.
    Supported units: d (days), mo (months ≈30d), y (years ≈365d).
    Examples: '2y', '6mo', '90d'
    """
    m = re.fullmatch(r"(\d+)(d|mo|y)", lookback)
    if not m:
        raise ValueError(f"Invalid lookback '{lookback}'. Use e.g. '2y', '6mo', '90d'.")
    n, unit = int(m.group(1)), m.group(2)
    days_per_unit = {"d": 1, "mo": 30, "y": 365}[unit]
    return date.today() - timedelta(days=n * days_per_unit)


def _open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute(_CREATE_TABLE)
    con.commit()
    return con


def _max_cached_date(con: sqlite3.Connection, symbol: str) -> date | None:
    """Latest date in cache for this symbol, or None if not cached at all."""
    row = con.execute(
        "SELECT MAX(date) FROM ohlcv WHERE symbol = ?", (symbol,)
    ).fetchone()
    return date.fromisoformat(row[0]) if row[0] else None


def _write_df(con: sqlite3.Connection, symbol: str, df: pd.DataFrame) -> int:
    """Persist rows from a yfinance OHLCV DataFrame; return row count written."""
    if df.empty:
        return 0
    # Normalize index: strip time/tz component so d.date() is always reliable
    idx = df.index.normalize()
    rows = [
        (
            symbol,
            idx[i].date().isoformat(),
            float(df["Open"].iloc[i]),
            float(df["High"].iloc[i]),
            float(df["Low"].iloc[i]),
            float(df["Close"].iloc[i]),
            int(df["Volume"].iloc[i]),
        )
        for i in range(len(df))
    ]
    con.executemany(_INSERT, rows)
    con.commit()
    return len(rows)


def _read_from_cache(
    con: sqlite3.Connection, symbol: str, start: date
) -> pd.DataFrame:
    """Return all cached rows for symbol from start onward."""
    rows = con.execute(
        "SELECT date, open, high, low, close, volume FROM ohlcv "
        "WHERE symbol = ? AND date >= ? ORDER BY date",
        (symbol, start.isoformat()),
    ).fetchall()
    if not rows:
        return pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"])
    df = pd.DataFrame(rows, columns=["Date", "Open", "High", "Low", "Close", "Volume"])
    df["Date"] = pd.to_datetime(df["Date"])
    df["Volume"] = df["Volume"].astype("int64")
    return df.set_index("Date")


def _download(symbol: str, start: date, end: date) -> pd.DataFrame:
    """
    Download OHLCV from yfinance.
    end is inclusive — we pass end+1 because yfinance treats end as exclusive.
    Returns empty DataFrame if no data available (e.g., non-trading days).
    """
    raw = yf.download(
        symbol,
        start=start.isoformat(),
        end=(end + timedelta(days=1)).isoformat(),
        progress=False,
        auto_adjust=True,  # prices already adjusted; no separate Adj Close column
    )
    if raw.empty:
        return raw
    # yfinance can return MultiIndex columns when extra metadata is attached
    if isinstance(raw.columns, pd.MultiIndex):
        raw.columns = raw.columns.get_level_values(0)
    return raw[["Open", "High", "Low", "Close", "Volume"]]


# ── Public API ─────────────────────────────────────────────────────────────────

def fetch(
    symbols: list[str],
    lookback: str = "2y",
    cache_path: Path | str | None = None,
) -> dict[str, pd.DataFrame]:
    """
    Return daily OHLCV DataFrames for each symbol, using a local SQLite cache.

    First call: downloads the full requested history.
    Subsequent calls: downloads only rows newer than the latest cached date.

    Parameters
    ----------
    symbols    : ticker list, e.g. ["AAPL", "SPY"]
    lookback   : history window — '2y', '1y', '6mo', '90d', …
    cache_path : override the default cache file path

    Returns
    -------
    dict[symbol → DataFrame(Open, High, Low, Close, Volume)] with DatetimeIndex.
    Missing symbols return empty DataFrames (yfinance returned nothing).
    """
    cache_path = Path(cache_path) if cache_path else _DEFAULT_CACHE
    start = _parse_lookback(lookback)
    today = date.today()

    con = _open_db(cache_path)
    result: dict[str, pd.DataFrame] = {}

    try:
        for symbol in symbols:
            max_cached = _max_cached_date(con, symbol)

            if max_cached is None:
                # No cache at all — fetch the full window
                fetch_from = start
            elif max_cached < today - timedelta(days=1):
                # Cache is at least one trading day stale — fetch the tail
                fetch_from = max_cached + timedelta(days=1)
            else:
                # Cache is current (today or yesterday for weekends/holidays)
                fetch_from = None

            if fetch_from is not None:
                df_new = _download(symbol, fetch_from, today)
                _write_df(con, symbol, df_new)

            result[symbol] = _read_from_cache(con, symbol, start)
    finally:
        con.close()

    return result
