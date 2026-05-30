#!/usr/bin/env python
"""
Verify connection to Alpaca paper-trading account.

Run from the quant/ directory:
    python scripts/verify_alpaca.py

Reads credentials from the nearest .env file (searches upward from quant/).
Or export them manually:
    export APCA_API_KEY_ID=<key>
    export APCA_API_SECRET_KEY=<secret>
"""
import os
import sys
from pathlib import Path

# Allow running from quant/ or quant/scripts/
quant_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(quant_dir))

# Load .env — search from quant/ upward so it finds trade/.env
from dotenv import load_dotenv  # noqa: E402
load_dotenv(quant_dir / ".env")          # quant/.env (if present)
load_dotenv(quant_dir.parent / ".env")   # trade/.env (project root)

from broker.alpaca import get_account, get_positions  # noqa: E402


def main() -> None:
    missing = [v for v in ("APCA_API_KEY_ID", "APCA_API_SECRET_KEY") if not os.getenv(v)]
    if missing:
        print(f"✗  Missing env vars: {', '.join(missing)}")
        print()
        print("  Add them to .env at the project root:")
        print("    APCA_API_KEY_ID=<your paper key>")
        print("    APCA_API_SECRET_KEY=<your paper secret>")
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
