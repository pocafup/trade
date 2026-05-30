"""
Smoke-test: fetch 2 years of AAPL and SPY, print last 5 rows.
Run from quant/: python scripts/verify_data.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from data.prices import fetch


def main() -> None:
    print("Fetching 2y of daily OHLCV for AAPL and SPY …\n")
    data = fetch(["AAPL", "SPY"], lookback="2y")

    for symbol, df in data.items():
        print(f"── {symbol}  ({len(df)} trading days cached) ──")
        pd_opts = {"float_format": "{:.2f}".format}
        print(df.tail(5).to_string(**pd_opts))
        print()

    print("✓  Done.")


if __name__ == "__main__":
    import pandas as pd  # noqa: F401 — ensure pandas is available
    main()
