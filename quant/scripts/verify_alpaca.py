#!/usr/bin/env python
"""
Verify connection to Alpaca paper-trading account.

Run from the quant/ directory:
    APCA_API_KEY_ID=<key> APCA_API_SECRET_KEY=<secret> python scripts/verify_alpaca.py

Or with a .env file (e.g. via direnv / dotenv):
    python scripts/verify_alpaca.py
"""
import os
import sys
from pathlib import Path

# Allow running from quant/ or quant/scripts/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from broker.alpaca import get_account, get_positions  # noqa: E402


def main() -> None:
    missing = [v for v in ("APCA_API_KEY_ID", "APCA_API_SECRET_KEY") if not os.getenv(v)]
    if missing:
        print(f"✗  Missing env vars: {', '.join(missing)}")
        print()
        print("  export APCA_API_KEY_ID=<your paper key>")
        print("  export APCA_API_SECRET_KEY=<your paper secret>")
        sys.exit(1)

    print("Connecting to Alpaca paper account …\n")

    acct = get_account()
    print(f"  Account ID    : {acct.id}")
    print(f"  Status        : {acct.status}")
    print(f"  Equity        : ${float(acct.equity):>14,.2f}")
    print(f"  Cash          : ${float(acct.cash):>14,.2f}")
    print(f"  Buying power  : ${float(acct.buying_power):>14,.2f}")

    positions = get_positions()
    print(f"\n  Open positions: {len(positions)}")
    for p in positions:
        pct = float(p.unrealized_plpc) * 100
        print(
            f"    {p.symbol:<6}  {float(p.qty):>8.4f} shares"
            f"  @ ${float(p.avg_entry_price):>8.2f}"
            f"  now ${float(p.current_price):>8.2f}"
            f"  P&L {pct:+.2f}%"
        )

    print("\n✓  Connection successful — paper account is reachable.")


if __name__ == "__main__":
    main()
