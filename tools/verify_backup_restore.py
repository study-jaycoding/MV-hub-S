r"""운영 DB를 건드리지 않는 MV Hub 백업 복원 훈련.

사용:
  python tools/verify_backup_restore.py
  python tools/verify_backup_restore.py --backup D:\backups\content_hub_....db
  python tools/verify_backup_restore.py --backup-set D:\backups\content_hub_....db
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
    verify_restore_set,
)
from app.services.restore_runtime_verify import verify_restored_set_runtime  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="MV Hub SQLite 백업 복원 훈련")
    parser.add_argument("--source", type=Path, help="백업을 만들 운영 DB(기본: 현재 DB)")
    parser.add_argument("--backup", type=Path, help="검증할 기존 백업 DB")
    parser.add_argument(
        "--backup-set",
        type=Path,
        help="검증할 DB 세트의 content_hub_<시각>.db 대표 파일",
    )
    parser.add_argument("--restored", type=Path, help="복원 결과 보관 경로(기본: 임시 후 삭제)")
    parser.add_argument(
        "--restored-dir",
        type=Path,
        help="DB 세트 복원 데이터 폴더 보관 경로(기본: 임시 후 삭제)",
    )
    parser.add_argument(
        "--server-timeout",
        type=float,
        default=60.0,
        help="DB 세트 격리 서버 준비 제한(초, 기본 60)",
    )
    args = parser.parse_args()

    if args.backup_set and (args.source or args.backup or args.restored):
        parser.error("--backup-set은 --source/--backup/--restored와 함께 사용할 수 없습니다")
    if args.restored_dir and not args.backup_set:
        parser.error("--restored-dir은 --backup-set과 함께 사용하세요")
    if args.source and args.backup:
        parser.error("--source와 --backup은 함께 사용할 수 없습니다")
    if args.server_timeout <= 0:
        parser.error("--server-timeout은 0보다 커야 합니다")

    try:
        with tempfile.TemporaryDirectory(prefix="mvhub-restore-drill-") as tmp:
            temp_dir = Path(tmp)
            if args.backup_set:
                restored_data_dir = (
                    args.restored_dir.resolve()
                    if args.restored_dir
                    else temp_dir / "restored-data"
                )
                report = verify_restore_set(args.backup_set, restored_data_dir)
                report["isolated_server"] = verify_restored_set_runtime(
                    restored_data_dir,
                    timeout_seconds=args.server_timeout,
                )
                report["restored_kept"] = bool(args.restored_dir)
            else:
                if args.backup:
                    backup = args.backup.resolve()
                    created_snapshot = False
                else:
                    source = (args.source or get_db_path()).resolve()
                    backup = temp_dir / "online-backup.db"
                    create_sqlite_snapshot(source, backup)
                    created_snapshot = True

                restored = (
                    args.restored.resolve() if args.restored else (temp_dir / "restored.db")
                )
                report = verify_restore_drill(backup, restored)
                report["mode"] = "single_database"
                report["created_snapshot"] = created_snapshot
                report["restored_kept"] = bool(args.restored)
            print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:  # noqa: BLE001 — 운영 도구는 traceback 대신 한 줄 구조화 오류
        print(
            json.dumps(
                {
                    "ok": False,
                    "error_type": type(exc).__name__,
                    "error": str(exc),
                },
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
