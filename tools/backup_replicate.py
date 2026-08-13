# -*- coding: utf-8 -*-
r"""DB 백업 원격 복제 — 서버 PC 디스크 밖(NAS/예비 PC)으로 백업을 매일 복사한다.

왜: 앱의 자동 백업(services/backup.py — SQLite 온라인 백업 API, 일관 스냅샷)은
    서버 PC 디스크에만 쌓인다. 디스크 고장·랜섬웨어면 원본과 백업이 함께
    사라지므로, 이 스크립트가 다른 장비로 복제한다(작업 스케줄러 매일 실행).

복제 원본 2곳(코덱스 리뷰 반영):
  · 서버 자동 백업: CONTENT_HUB_BACKUP_DIR(앱과 같은 env) 또는 backend/data/backups
  · 팀원 업로드 백업: backend/data/db-backups/<계정슬러그>/ (로컬 허브가 올린 DB 백업)

대상 설정(둘 중 하나, 환경변수가 우선):
  · 환경변수 CONTENT_HUB_BACKUP_REPLICA_DIR
  · tools/backup_replica_target.txt 첫 줄에 경로
  ★ 작업 스케줄러(SYSTEM 계정)에서 돌므로 Z: 같은 사용자 매핑 드라이브는 안 보인다.
    UNC 경로(\\NAS\share\mvhub_backup)를 쓰고, NAS 가 이 PC(컴퓨터 계정)의 접근을
    허용해야 한다. 설정 후 반드시 schtasks /Run 으로 1회 실행해 로그를 확인할 것.
설정이 없으면 아무것도 하지 않고 정상 종료한다(등록만 해두고 나중에 설정 가능).

복사 규칙: *.db 만, 하위 폴더 유지, 크기+수정시각 같으면 건너뜀(멱등),
스트리밍 복사(.part 에 쓴 뒤 교체 — 전송 중 끊겨도 반쪽 파일이 남지 않음),
시작 시 지난 실행이 남긴 .part 잔재 정리, 복제본은 폴더당 최신 30개만 유지.
복사 실패가 1건이라도 있으면 "복제 실패" 로그 + 종료코드 1 (성공 위장 금지).
"""
from __future__ import annotations

import contextlib
import os
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "backend" / "data"
TARGET_FILE = Path(__file__).resolve().parent / "backup_replica_target.txt"
LOG = ROOT / "logs" / "backup_replicate.log"
KEEP_PER_DIR = 30


def _sources() -> list[tuple[str, Path]]:
    """(복제본 하위 폴더명, 원본 경로). 앱이 CONTENT_HUB_BACKUP_DIR 로 백업 위치를
    옮겼으면 여기도 같은 env 를 따라간다(기본 폴더만 보면 빈 폴더를 복제하게 됨)."""
    auto = Path(os.environ.get("CONTENT_HUB_BACKUP_DIR", "").strip() or (DATA_DIR / "backups"))
    return [("backups", auto), ("db-backups", DATA_DIR / "db-backups")]


def log(msg: str) -> None:
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def replica_root() -> Path | None:
    env = os.environ.get("CONTENT_HUB_BACKUP_REPLICA_DIR", "").strip()
    if env:
        return Path(env)
    if TARGET_FILE.is_file():
        for line in TARGET_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                return Path(line)
    return None


def _sqlite_valid(path: Path) -> bool:
    try:
        with contextlib.closing(sqlite3.connect(str(path))) as conn:
            conn.execute("PRAGMA query_only=ON")
            result = conn.execute("PRAGMA quick_check").fetchone()
            return bool(result and result[0] == "ok")
    except (OSError, sqlite3.Error):
        return False


def copy_one(src: Path, dest: Path) -> str:
    """'copied' | 'skip' | 'fail'. 실패를 skip 으로 뭉개면 성공 위장이 된다(코덱스 P1)."""
    try:
        st = src.stat()
        if dest.exists():
            d = dest.stat()
            if (
                st.st_size == d.st_size
                and int(st.st_mtime) == int(d.st_mtime)
                and _sqlite_valid(dest)
            ):
                return "skip"
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_suffix(dest.suffix + ".part")
        shutil.copyfile(src, part)  # 스트리밍 — DB 크기만큼 메모리를 쓰지 않는다
        if not _sqlite_valid(part):
            with contextlib.suppress(OSError):
                part.unlink()
            log(f"복제 검증 실패 {src.name}: destination quick_check failed")
            return "fail"
        os.utime(part, (st.st_atime, st.st_mtime))
        os.replace(part, dest)
        return "copied"
    except OSError as e:
        log(f"복사 실패 {src.name}: {e}")
        return "fail"


def cleanup_parts(target: Path) -> int:
    """지난 실행이 끊기며 남긴 .part 잔재 제거.

    ★범위 한정(적대 리뷰 P1): 대상이 NAS 공용 폴더일 수 있다 — 전체를 rglob 하면
    남의 전송 중 파일(video.zip.part 등)까지 지운다. 우리가 만드는 하위 폴더
    (backups/·db-backups/)의, 우리가 만드는 이름(*.db.part)만 지운다."""
    removed = 0
    for sub, _ in _sources():
        root = target / sub
        if not root.is_dir():
            continue
        try:
            for p in root.rglob("*.db.part"):
                try:
                    p.unlink()
                    removed += 1
                except OSError:
                    pass
        except OSError:
            pass
    return removed


def prune_dir(d: Path, protected: set[str]) -> int:
    """복제본 폴더당 최신 KEEP_PER_DIR 개만 유지. 반환: 삭제 수.

    protected = 원본에 아직 존재하는 파일명 — 지우면 다음 실행이 도로 복사해
    '매일 지웠다 복사' 진동이 생기므로(적대 리뷰 P2) 개수와 무관하게 남긴다."""
    files = sorted(d.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    removed = 0
    for old in files[KEEP_PER_DIR:]:
        if old.name in protected:
            continue
        try:
            old.unlink()
            removed += 1
        except OSError:
            pass
    return removed


def main() -> int:
    target = replica_root()
    if not target:
        log("복제 대상 미설정 — 건너뜀 (CONTENT_HUB_BACKUP_REPLICA_DIR "
            "또는 tools/backup_replica_target.txt 에 UNC 경로를 넣으세요)")
        return 0
    if not str(target).startswith("\\\\"):
        # 작업 스케줄러(SYSTEM)에선 매핑 드라이브가 안 보인다 — 실패 원인 안내만 하고 시도는 한다.
        log(f"경고: 대상이 UNC 가 아님({target}) — SYSTEM 예약작업에선 Z: 등이 안 보여 실패할 수 있음")
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        log(f"복제 실패 — 대상 접근 불가: {target} — {e}")
        return 1

    stale = cleanup_parts(target)
    copied = skipped = failed = 0
    dirs: set[Path] = set()
    protected_by_dir: dict[Path, set[str]] = {}  # 원본에 아직 있는 파일명(진동 방지)
    seen_any_source = False
    for sub, source in _sources():
        if not source.is_dir():
            continue
        seen_any_source = True
        for src in source.rglob("*.db"):
            dest = target / sub / src.relative_to(source)
            result = copy_one(src, dest)
            if result == "copied":
                copied += 1
            elif result == "skip":
                skipped += 1
            else:
                failed += 1
            dirs.add(dest.parent)
            protected_by_dir.setdefault(dest.parent, set()).add(dest.name)
    if not seen_any_source:
        log(f"원본 백업 폴더 없음({[str(s) for _, s in _sources()]}) — 건너뜀")
        return 0
    removed = sum(prune_dir(d, protected_by_dir.get(d, set())) for d in dirs if d.is_dir())
    summary = (f"→ {target} (신규 {copied} · 최신유지 {skipped} · 실패 {failed}"
               f" · 정리 {removed}+part {stale})")
    if failed:
        log("복제 실패 " + summary)
        return 1
    log("복제 완료 " + summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
