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

복사 규칙: 기존 *.db와 작업자 content·trash 세트를 함께 복제한다. 단일 DB는 .part,
세트는 숨은 임시 폴더에 쓴 뒤 검증하고 한 번에 교체한다. 시작 시 지난 실행 잔재를
정리하고 복제본은 폴더당 최신 30개를 유지한다.
복사 실패가 1건이라도 있으면 "복제 실패" 로그 + 종료코드 1 (성공 위장 금지).
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
from rotate_text_log import rotate_text_log

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "backend" / "data"
TARGET_FILE = Path(__file__).resolve().parent / "backup_replica_target.txt"
LOG = ROOT / "logs" / "backup_replicate.log"
STATUS_FILE = DATA_DIR / "backup_replica_status.json"
KEEP_PER_DIR = 30
LOG_MAX_BYTES = 2 * 1024 * 1024
LOG_KEEP = 3
_SET_ID_RE = re.compile(r"[0-9a-f]{64}")


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
        rotate_text_log(LOG, max_bytes=LOG_MAX_BYTES, keep=LOG_KEEP)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_status() -> dict:
    try:
        value = json.loads(STATUS_FILE.read_text("utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_status(
    state: str,
    *,
    error_code: str | None = None,
    **counts: int | bool | str | None,
) -> bool:
    """관리 화면이 읽는 안전한 결과. 경로·계정·예외 원문은 기록하지 않는다."""
    previous = _read_status()
    payload = {
        "format": "mvhub-backup-replica-status",
        "format_version": 1,
        "state": state,
        "configured": state != "disabled",
        "last_attempt_at": _utc_now(),
        "last_success_at": previous.get("last_success_at"),
        "error_code": error_code,
        **counts,
    }
    if state == "success":
        payload["last_success_at"] = payload["last_attempt_at"]
    temp = STATUS_FILE.with_name(f".{STATUS_FILE.name}.tmp-{uuid.uuid4().hex[:8]}")
    try:
        STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
        temp.write_text(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(temp, STATUS_FILE)
        return True
    except OSError:
        # 예약 작업의 콘솔·로그에 실제 사용자 경로나 UNC 경로가 포함된 예외 원문을 남기지 않는다.
        log("복제 상태 기록 실패: status_write_failed")
        return False
    finally:
        with contextlib.suppress(OSError):
            temp.unlink()


def replica_root() -> Path | None:
    env = os.environ.get("CONTENT_HUB_BACKUP_REPLICA_DIR", "").strip()
    if env:
        return Path(env)
    try:
        if TARGET_FILE.is_file():
            for line in TARGET_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    return Path(line)
    except OSError:
        return None
    return None


def _sqlite_valid(path: Path) -> bool:
    try:
        with contextlib.closing(sqlite3.connect(str(path))) as conn:
            conn.execute("PRAGMA query_only=ON")
            result = conn.execute("PRAGMA quick_check").fetchone()
            return bool(result and result[0] == "ok")
    except (OSError, sqlite3.Error):
        return False


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _set_manifest(folder: Path, *, expected_id: str | None = None) -> dict | None:
    try:
        value = json.loads((folder / "manifest.json").read_text("utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(value, dict) or value.get("format") != "mvhub-worker-backup-set":
        return None
    backup_set_id = expected_id or folder.name
    if value.get("backup_set_id") != backup_set_id or not _SET_ID_RE.fullmatch(backup_set_id):
        return None
    roles = value.get("roles")
    if not isinstance(roles, dict) or "content" not in roles or not set(roles) <= {"content", "trash"}:
        return None
    for role, info in roles.items():
        if not isinstance(info, dict):
            return None
        path = folder / f"{role}.db"
        try:
            if (
                not path.is_file()
                or path.stat().st_size != int(info.get("size") or -1)
                or _sha256(path) != info.get("sha256")
                or not _sqlite_valid(path)
            ):
                return None
        except (OSError, TypeError, ValueError):
            return None
    return value


def copy_set(src: Path, dest: Path) -> str:
    """완성된 작업자 세트를 숨은 임시 디렉터리에서 검증한 뒤 한 번에 공개한다."""
    manifest = _set_manifest(src)
    if manifest is None:
        log("복제 검증 실패: invalid_source_set")
        return "fail"
    if dest.is_dir() and _set_manifest(dest) == manifest:
        return "skip"
    dest.parent.mkdir(parents=True, exist_ok=True)
    staged = dest.parent / f".setpart-{uuid.uuid4().hex}"
    previous: Path | None = None
    try:
        staged.mkdir()
        for role in manifest["roles"]:
            shutil.copyfile(src / f"{role}.db", staged / f"{role}.db")
        shutil.copyfile(src / "manifest.json", staged / "manifest.json")
        if _set_manifest(staged, expected_id=manifest["backup_set_id"]) != manifest:
            raise OSError("staged set validation failed")
        if dest.exists():
            previous = dest.parent / f".setold-{uuid.uuid4().hex}"
            os.replace(dest, previous)
        try:
            os.replace(staged, dest)
        except BaseException:
            if previous is not None and previous.exists() and not dest.exists():
                os.replace(previous, dest)
            raise
        if previous is not None:
            shutil.rmtree(previous, ignore_errors=True)
        return "copied"
    except OSError:
        log("복사 실패: set_copy_failed")
        return "fail"
    finally:
        shutil.rmtree(staged, ignore_errors=True)


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
    except OSError:
        log(f"복사 실패 {src.name}: file_copy_failed")
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
        if sub == "db-backups":
            for pattern in (".setpart-*", ".setold-*"):
                try:
                    for folder in root.rglob(pattern):
                        if folder.is_dir():
                            shutil.rmtree(folder, ignore_errors=True)
                            removed += 1
                except OSError:
                    pass
    return removed


def prune_dir(d: Path, protected: set[str]) -> int:
    """복제본 폴더당 최신 KEEP_PER_DIR 개만 유지. 반환: 삭제 수.

    protected = 원본에 아직 존재하는 파일명 — 지우면 다음 실행이 도로 복사해
    '매일 지웠다 복사' 진동이 생기므로(적대 리뷰 P2) 개수와 무관하게 남긴다."""
    stamped: list[tuple[float, Path]] = []
    try:
        candidates = list(d.glob("*.db"))
    except OSError:
        return 0
    for path in candidates:
        try:
            stamped.append((path.stat().st_mtime, path))
        except OSError:
            continue
    files = [path for _, path in sorted(stamped, key=lambda item: item[0], reverse=True)]
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


def prune_set_root(root: Path, protected: set[str]) -> int:
    folders: list[Path] = []
    try:
        if root.is_dir():
            for path in root.iterdir():
                if path.is_dir() and _SET_ID_RE.fullmatch(path.name) and _set_manifest(path):
                    folders.append(path)
    except OSError:
        return 0
    stamped: list[tuple[float, Path]] = []
    for path in folders:
        try:
            stamped.append((path.stat().st_mtime, path))
        except OSError:
            continue
    folders = [path for _, path in sorted(stamped, key=lambda item: item[0], reverse=True)]
    removed = 0
    for old in folders[KEEP_PER_DIR:]:
        if old.name in protected:
            continue
        shutil.rmtree(old, ignore_errors=True)
        if not old.exists():
            removed += 1
    return removed


def main() -> int:
    target = replica_root()
    if not target:
        log("복제 대상 미설정 — 건너뜀 (CONTENT_HUB_BACKUP_REPLICA_DIR "
            "또는 tools/backup_replica_target.txt 에 UNC 경로를 넣으세요)")
        return 0 if _write_status("disabled", error_code="target_not_configured") else 1
    if not str(target).startswith("\\\\"):
        # 작업 스케줄러(SYSTEM)에선 매핑 드라이브가 안 보인다 — 실패 원인 안내만 하고 시도는 한다.
        log("경고: 대상이 UNC가 아님 — SYSTEM 예약작업에서 접근 실패할 수 있음")
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError:
        log("복제 실패 — 대상 접근 불가: target_unavailable")
        _write_status("failed", error_code="target_unavailable")
        return 1

    stale = cleanup_parts(target)
    copied = skipped = failed = 0
    dirs: set[Path] = set()
    protected_by_dir: dict[Path, set[str]] = {}  # 원본에 아직 있는 파일명(진동 방지)
    set_roots: set[Path] = set()
    protected_sets: dict[Path, set[str]] = {}
    seen_any_source = False
    try:
        for sub, source in _sources():
            if not source.is_dir():
                continue
            seen_any_source = True
            for src in source.rglob("*.db"):
                # 새 작업자 백업은 manifest와 함께 디렉터리 단위로 아래에서 복제한다.
                if sub == "db-backups" and "sets" in src.relative_to(source).parts:
                    continue
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
            if sub == "db-backups":
                for sets_dir in source.rglob("sets"):
                    if not sets_dir.is_dir():
                        continue
                    dest_root = target / sub / sets_dir.relative_to(source)
                    set_roots.add(dest_root)
                    for src_set in sets_dir.iterdir():
                        if not src_set.is_dir() or not _SET_ID_RE.fullmatch(src_set.name):
                            continue
                        result = copy_set(src_set, dest_root / src_set.name)
                        if result == "copied":
                            copied += 1
                        elif result == "skip":
                            skipped += 1
                        else:
                            failed += 1
                        protected_sets.setdefault(dest_root, set()).add(src_set.name)
    except OSError:
        log("복제 실패 — 원본 목록 접근 불가: source_unavailable")
        _write_status("failed", error_code="source_unavailable", failed=max(1, failed))
        return 1
    if not seen_any_source:
        log("원본 백업 폴더 없음 — 건너뜀")
        return 0 if _write_status("no_source", error_code="source_not_ready") else 1
    removed = sum(prune_dir(d, protected_by_dir.get(d, set())) for d in dirs if d.is_dir())
    removed += sum(
        prune_set_root(root, protected_sets.get(root, set()))
        for root in set_roots
        if root.is_dir()
    )
    summary = (f"신규 {copied} · 최신유지 {skipped} · 실패 {failed}"
               f" · 정리 {removed}+part {stale}")
    if failed:
        log("복제 실패 " + summary)
        _write_status(
            "failed",
            error_code="copy_failed",
            copied=copied,
            skipped=skipped,
            failed=failed,
            removed=removed,
            stale_parts=stale,
        )
        return 1
    log("복제 완료 " + summary)
    status_saved = _write_status(
        "success",
        copied=copied,
        skipped=skipped,
        failed=0,
        removed=removed,
        stale_parts=stale,
    )
    return 0 if status_saved else 1


if __name__ == "__main__":
    sys.exit(main())
