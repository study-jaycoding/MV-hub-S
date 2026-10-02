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
import socket
import sqlite3
import sys
import time
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
# 우리가 만드는 단일 DB 이름(2026-10-02) — 정리는 이 이름만 지운다(남의 DB 는 세지도 지우지도 않는다).
#  서버 자동 백업 services/backup.py `{content_hub|content_trash|manage_hub}_YYYYMMDD_HHMMSS(_ffffff).db`,
#  팀원 업로드 routers/db_backup.py `YYYYMMDD_HHMMSS_<8hex>.db`. 세트(sets/<64hex>/)는 manifest 로 따로 본다.
_OWNED_SINGLE_DB_RE = re.compile(
    r"^(?:(?:content_hub|content_trash|manage_hub)_\d{8}_\d{6}(?:_\d{6})?|\d{8}_\d{6}_[0-9a-f]{8})\.db$"
)
MARKER_NAME = ".mvhub-backup-replica"  # 관리자 창 [저장] 때 쓰는 설정 이력(소유 증거로 쓰지 않는다)
MAX_TARGET_LEN = 180  # 감사 기록이 200자에서 자르므로 그 안쪽


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
    target_id: str | None = None,
    started_at: str | None = None,
    **counts: int | bool | str | None,
) -> bool:
    """관리 화면이 읽는 안전한 결과. 경로·계정·예외 원문은 기록하지 않는다.
    target_id(위치 지문)·started_at 을 함께 남긴다 — 위치를 바꾼 뒤 옛 위치의 성공이 새 위치의 성공처럼 보이지 않게,
    마지막 성공은 **같은 위치일 때만** 이어받는다(2026-10-02)."""
    previous = _read_status()
    same_target = target_id is not None and previous.get("target_id") == target_id
    payload = {
        "format": "mvhub-backup-replica-status",
        "format_version": 2,
        "state": state,
        "configured": state != "disabled",
        "target_id": target_id,
        "started_at": started_at,
        "last_attempt_at": _utc_now(),
        "last_success_at": previous.get("last_success_at") if same_target else None,
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


def configured_target() -> tuple[str | None, str]:
    """(대상 문자열, 출처 env|file|none). 환경변수가 txt 보다 우선 — 관리자 창도 같은 판정을 쓴다."""
    env = os.environ.get("CONTENT_HUB_BACKUP_REPLICA_DIR", "").strip()
    if env:
        return env, "env"
    try:
        if TARGET_FILE.is_file():
            for line in TARGET_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip().lstrip("﻿")
                if line and not line.startswith("#"):
                    return line, "file"
    except OSError:
        return None, "none"
    return None, "none"


def replica_root() -> Path | None:
    target, _source = configured_target()
    return Path(target) if target else None


def target_id(value: str) -> str:
    """위치 지문 — 결과가 어느 위치 것인지 가린다. 네트워크를 건드리지 않는 문자열 정규화만."""
    # Path 를 한 번 거쳐(파일 접근 없음) 관리자 창의 원문과 복사기의 Path 표기(끝 \\·/ 등)가 같은 지문이 되게 한다.
    normal = str(Path(str(value).strip())).rstrip("\\/").casefold()
    return hashlib.sha256(normal.encode("utf-8")).hexdigest()[:16]


def unc_format_error(value: str) -> int | None:
    """관리자 창 [저장]이 받는 형식: \\\\서버\\공유\\… (UNC). 형식이 틀리면 10, 맞으면 None. 문자열만 본다."""
    v = (value or "").strip()
    if not v or len(v) > MAX_TARGET_LEN or "/" in v:
        return 10
    if any(ord(ch) < 32 for ch in v) or any(ch in '"<>|?*' for ch in v):
        return 10
    if not v.startswith("\\\\") or v.startswith(("\\\\?\\", "\\\\.\\")):
        return 10
    parts = v[2:].split("\\")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        return 10
    inner = parts[:-1] if parts[-1] == "" else parts  # 끝의 \ 하나는 허용
    if any(not p or p.endswith((".", " ")) for p in inner):
        return 10
    return None


def _self_host(server: str) -> bool:
    """UNC 의 서버 이름이 이 PC 자신인가(같은 디스크로 되돌아오는 복사 방지)."""
    name = server.strip().lower()
    if name in {"localhost", "127.0.0.1", "::1", "."}:
        return True
    host = socket.gethostname().lower()
    if name == host or name.split(".")[0] == host.split(".")[0]:
        return True
    try:
        addresses = set(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        addresses = set()
    return name in addresses


def _real(path: Path) -> str:
    return os.path.normcase(os.path.realpath(str(path)))


def target_overlaps(target: Path) -> bool:
    """최종 복사 폴더(target\\backups·target\\db-backups)가 원본·저장소·데이터 폴더와 같거나 안/밖이면 True.
    복사본이 다시 원본이 되거나 원본을 정리하는 사고를 막는다 — 모든 설정 경로(txt·env·이사)에 적용."""
    finals = [_real(target / sub) for sub, _ in _sources()]
    guarded = [_real(source) for _, source in _sources()] + [_real(ROOT), _real(DATA_DIR)]
    for final in finals:
        for guard in guarded:
            if final == guard or final.startswith(guard + os.sep) or guard.startswith(final + os.sep):
                return True
    return False


def _accepts_existing(target: Path, entries: list[Path]) -> bool:
    """[저장] 수용 규칙 — 비어 있거나 우리 구조(backups·db-backups·설정 이력)뿐이고 그 아래 DB 가 전부 우리 이름·세트."""
    for entry in entries:
        name = entry.name
        if name in {"backups", "db-backups", MARKER_NAME} or name.startswith(MARKER_NAME + ".tmp-"):
            continue
        return False
    for sub in ("backups", "db-backups"):
        root = target / sub
        if not root.is_dir():
            continue
        for path in root.rglob("*.db"):
            if _OWNED_SINGLE_DB_RE.match(path.name):
                continue
            if sub == "db-backups" and _is_our_set_file(root, path):
                continue
            return False
    return True


def _is_our_set_file(root: Path, path: Path) -> bool:
    """세트 파일 구조 검사(해시는 안 함 — [저장] 20초 안에 NAS 를 훑어야 한다): 정확히
    db-backups/<slug>/sets/<64hex|.setpart-*|.setold-*>/{content|trash}.db 이고, 완성 세트면 manifest 의 형식·ID·역할이 맞는다."""
    parts = path.relative_to(root).parts
    if len(parts) != 4 or parts[1] != "sets" or path.name not in ("content.db", "trash.db"):
        return False
    folder = parts[2]
    if folder.startswith((".setpart-", ".setold-")):
        return True  # 복사 중 끊긴 잔재 — cleanup_parts 가 지운다
    if not _SET_ID_RE.fullmatch(folder):
        return False
    try:
        manifest = json.loads((path.parent / "manifest.json").read_text("utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(manifest, dict):  # [] · null 도 남의 것으로(오류 대신)
        return False
    roles = manifest.get("roles")
    return (
        manifest.get("format") == "mvhub-worker-backup-set"
        and manifest.get("backup_set_id") == folder
        and isinstance(roles, dict)
        and "content" in roles
        and set(roles) <= {"content", "trash"}
        and path.stem in roles
    )


def probe(value: str) -> int:
    """관리자 창 [저장] 전 위치 확인 — 서버가 자식 프로세스로 부른다(20초 제한). 종료코드만 돌려준다.
    0 성공 · 10 형식 · 11 자기 PC · 12 남의 파일 · 13 원본과 겹침 · 14 못 씀 · 15 못 엶. 경로·예외 원문은 남기지 않는다."""
    code = unc_format_error(value)
    if code is not None:
        return code
    text = value.strip()
    if _self_host(text[2:].split("\\")[0]):
        return 11
    target = Path(text)
    try:
        if target.exists():
            if not _accepts_existing(target, list(target.iterdir())):
                return 12
    except OSError:
        return 15
    try:
        if target_overlaps(target):
            return 13
    except OSError:
        return 15
    try:
        target.mkdir(parents=True, exist_ok=True)
        marker = target / MARKER_NAME
        temp = target / f"{MARKER_NAME}.tmp-{uuid.uuid4().hex[:8]}"
        payload = {"format": "mvhub-backup-replica-target", "written_at": _utc_now(), "server": socket.gethostname()}
        with temp.open("w", encoding="utf-8") as stream:
            stream.write(json.dumps(payload))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, marker)
        if json.loads(marker.read_text("utf-8")).get("format") != payload["format"]:
            return 14
    except (OSError, ValueError):
        return 14
    return 0


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
    # 관리자 창 위치 확인이 끊기며 남긴 설정 이력 임시 파일(우리 이름만, 1시간 지난 것)
    with contextlib.suppress(OSError):
        for leftover in target.glob(MARKER_NAME + ".tmp-*"):
            with contextlib.suppress(OSError):
                if time.time() - leftover.stat().st_mtime > 3600:
                    leftover.unlink()
                    removed += 1
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
        # 우리 이름 규칙의 DB 만 세고 지운다 — 같은 폴더의 남의 *.db 는 건드리지 않는다(2026-10-02).
        candidates = [path for path in d.glob("*.db") if _OWNED_SINGLE_DB_RE.match(path.name)]
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
    started = _utc_now()
    target = replica_root()
    tid = target_id(str(target)) if target else None

    def _status(state: str, **fields: int | bool | str | None) -> bool:
        return _write_status(state, target_id=tid, started_at=started, **fields)

    if not target:
        log("복제 대상 미설정 — 건너뜀 (CONTENT_HUB_BACKUP_REPLICA_DIR "
            "또는 tools/backup_replica_target.txt 에 UNC 경로를 넣으세요)")
        return 0 if _status("disabled", error_code="target_not_configured") else 1
    if not str(target).startswith("\\\\"):
        # 작업 스케줄러(SYSTEM)에선 매핑 드라이브가 안 보인다 — 실패 원인 안내만 하고 시도는 한다.
        log("경고: 대상이 UNC가 아님 — SYSTEM 예약작업에서 접근 실패할 수 있음")
    try:
        overlaps = target_overlaps(target)
    except OSError:
        overlaps = False  # 경로 해석 실패는 아래 mkdir 이 target_unavailable 로 잡는다
    if overlaps:
        # 어느 경로로 정해졌든(txt 손편집·env·이사) 원본과 겹치면 복사·정리하지 않는다(2026-10-02).
        log("복제 실패 — 대상이 원본 백업과 겹침: target_unsafe")
        _status("failed", error_code="target_unsafe")
        return 1
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError:
        log("복제 실패 — 대상 접근 불가: target_unavailable")
        _status("failed", error_code="target_unavailable")
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
        _status("failed", error_code="source_unavailable", failed=max(1, failed))
        return 1
    if not seen_any_source:
        log("원본 백업 폴더 없음 — 건너뜀")
        return 0 if _status("no_source", error_code="source_not_ready") else 1
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
        _status(
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
    status_saved = _status(
        "success",
        copied=copied,
        skipped=skipped,
        failed=0,
        removed=removed,
        stale_parts=stale,
    )
    return 0 if status_saved else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--probe":
        sys.exit(probe(sys.argv[2]))  # 관리자 창 [저장] 전 위치 확인(서버가 자식으로 부른다)
    sys.exit(main())
