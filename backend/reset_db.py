#!/usr/bin/env python3
"""DB 완전 초기화 — 로컬 허브/공유 서버 공용. 깨끗한 새 출발용.

지우기 전에 **항상 타임스탬프 백업**을 뜬다(되돌릴 수 있게). 기본은 점검(dry-run),
실제 삭제는 `--yes` 를 줄 때만. 반드시 그 허브/서버 프로세스를 **멈춘 뒤** 실행(파일 잠금 회피).

지우는 것(= 이 데이터 루트 전체 초기화):
  · data/db/content_hub.db (+ -wal/-shm)        — 메인 메타데이터(생성물·태그·계보·코멘트·계정·역할·프로젝트)
  · data/db/content_hub_trash.db (+ -wal/-shm)  — 휴지통
  · data/db/acct/                                — 계정별 DB 전부
  · data/active.json                             — 활성 계정 포인터
  · data/asset_mounts.json                       — 레거시 에셋 마운트
  · data/db-backups/        (--with-server-backups 일 때만)  — 서버 계정별 백업
미디어 캐시(data/media)는 힉스필드 공개 URL 재요청 캐시라 건드리지 않는다(원하면 수동 삭제).

사용:
  python reset_db.py                       # 점검만(무삭제) — 무엇을 지울지 보여줌
  python reset_db.py --yes                 # 백업 뜨고 초기화 + 빈 스키마 재생성
  python reset_db.py --yes --with-server-backups   # 서버 계정별 백업까지 초기화(공유 서버용)
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import config, db  # noqa: E402


def _targets(with_server_backups: bool) -> list[Path]:
    d = config.DATA_DIR
    out = [
        d / "db" / "content_hub.db",
        d / "db" / "content_hub.db-wal",
        d / "db" / "content_hub.db-shm",
        d / "db" / "content_hub_trash.db",
        d / "db" / "content_hub_trash.db-wal",
        d / "db" / "content_hub_trash.db-shm",
        d / "db" / "acct",          # 디렉터리
        d / "active.json",
        d / "asset_mounts.json",
    ]
    if with_server_backups:
        out.append(d / "db-backups")  # 디렉터리
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="DB 완전 초기화(백업 후)")
    ap.add_argument("--yes", action="store_true", help="실제 삭제(없으면 점검만)")
    ap.add_argument(
        "--with-server-backups", action="store_true",
        help="서버 계정별 백업(data/db-backups)까지 초기화 — 공유 서버에서만 권장",
    )
    args = ap.parse_args()

    d = config.DATA_DIR
    print(f"[데이터 루트] {d}")
    targets = _targets(args.with_server_backups)
    existing = [p for p in targets if p.exists()]
    if not existing:
        print("[결과] 지울 대상이 없습니다 — 이미 비어 있습니다.")
        # 그래도 빈 스키마는 보장
        if args.yes:
            db.init_db()
            print("[완료] 빈 스키마 확인(init_db).")
        return

    print("[대상] 초기화될 항목:")
    for p in existing:
        kind = "폴더" if p.is_dir() else "파일"
        print(f"  · {kind}: {p}")

    if not args.yes:
        print("\n[DRY-RUN] --yes 가 없어 아무것도 지우지 않았습니다.")
        print("실제 초기화하려면: python reset_db.py --yes"
              + (" --with-server-backups" if args.with_server_backups else ""))
        return

    # 1) 백업 — 지울 것들을 한 폴더로 모아 보존(되돌릴 수 있게)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    backup_root = d / "reset-backups" / f"reset-{stamp}"
    backup_root.mkdir(parents=True, exist_ok=True)
    for p in existing:
        try:
            dst = backup_root / p.name
            if p.is_dir():
                shutil.copytree(p, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(p, dst)
        except OSError as e:
            print(f"  [경고] 백업 실패(계속): {p} — {e}")
    print(f"[백업] 보존 위치: {backup_root}")

    # 2) 삭제
    for p in existing:
        try:
            if p.is_dir():
                shutil.rmtree(p)
            else:
                p.unlink()
            print(f"  ✓ 삭제: {p.name}")
        except OSError as e:
            print(f"  ✗ 삭제 실패: {p} — {e} (프로세스가 떠 있으면 먼저 멈추세요)")

    # 3) 빈 스키마 재생성(다음 시작 때 자동 생성되지만 즉시 보장)
    db.init_db()
    print(f"\n[완료] 초기화됨. 빈 DB 생성: {db.get_db_path()}")
    print(f"되돌리려면 {backup_root} 의 파일을 data/db/ 로 되돌리면 됩니다.")


if __name__ == "__main__":
    main()
