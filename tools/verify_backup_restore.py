r"""운영 DB를 건드리지 않는 MV Hub 백업 복원 훈련.

사용:
  python tools/verify_backup_restore.py
  python tools/verify_backup_restore.py --backup D:\backups\content_hub_....db
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.db import get_db_path  # noqa: E402
from app.services.backup_verify import (  # noqa: E402
    create_sqlite_snapshot,
    verify_restore_drill,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="MV Hub SQLite 백업 복원 훈련")
    parser.add_argument("--source", type=Path, help="백업을 만들 운영 DB(기본: 현재 DB)")
    parser.add_argument("--backup", type=Path, help="검증할 기존 백업 DB")
    parser.add_argument("--restored", type=Path, help="복원 결과 보관 경로(기본: 임시 후 삭제)")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="mvhub-restore-drill-") as tmp:
        temp_dir = Path(tmp)
        if args.backup:
            backup = args.backup.resolve()
            created_snapshot = False
        else:
            source = (args.source or get_db_path()).resolve()
            backup = temp_dir / "online-backup.db"
            create_sqlite_snapshot(source, backup)
            created_snapshot = True

        restored = args.restored.resolve() if args.restored else (temp_dir / "restored.db")
        report = verify_restore_drill(backup, restored)
        report["created_snapshot"] = created_snapshot
        report["restored_kept"] = bool(args.restored)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
