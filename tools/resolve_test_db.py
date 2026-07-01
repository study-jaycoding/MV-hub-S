from __future__ import annotations

import json
import sys
from pathlib import Path

from account_paths import account_slug


def main() -> int:
    if len(sys.argv) not in (2, 3):
        return 2
    data_dir = Path(sys.argv[1]).resolve()
    mode = (sys.argv[2] if len(sys.argv) == 3 else "active").strip().lower()
    if mode not in {"active", "server"}:
        print(f"unknown db mode: {mode}", file=sys.stderr)
        return 2
    if not data_dir.exists():
        print(f"test data dir does not exist: {data_dir}", file=sys.stderr)
        return 1

    db = data_dir / "db" / "content_hub.db"

    if mode == "active":
        try:
            active = json.loads((data_dir / "active.json").read_text("utf-8"))
            email = (active or {}).get("email")
        except (OSError, ValueError, TypeError):
            email = None

        if email:
            account_db = data_dir / "db" / "acct" / account_slug(email) / "content_hub.db"
            if account_db.exists():
                db = account_db

    if not db.exists():
        print(f"test db does not exist: {db}", file=sys.stderr)
        return 1

    print(str(db))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
