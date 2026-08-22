"""계정별 DB 백업 (공유 서버측).

각 팀원이 자기 로컬 허브의 **계정별 메타데이터 DB** 를 서버에 올리고(POST) 나중에 다시
내려받아(GET) 그대로 작업을 이어간다. 기존 '파일 다운로드→재업로드' 를 '서버에 백업→서버에서
가져오기' 로 바꾸는 서버 입구다.

- 저장: data/db-backups/<email-slug>/<ts>.db — **계정별 폴더**. 세션 신원(creator 계정)으로만 접근,
  남의 백업은 못 본다(목록·다운로드·업로드 모두 본인 것).
- 보안: 민감정보(공유서버 토큰·auth_secret·세션)는 **로컬 허브가 업로드 전에 비워** 보낸다(plan 결정).
  서버는 받은 바이트를 그대로 저장만 한다. 복원 시 로컬이 auth_secret 재발급·재로그인을 강제한다.
- AUTH on(공유 서버)에서만 의미가 있다 — 미들웨어가 세션을 요구하므로 current_account 가 채워진다.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import BinaryIO

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from ..active_account import slug
from ..config import DATA_DIR
from ..deps import current_account
from ..services.sqlite_db import HubDbValidationError, hub_db_validation_detail, validate_hub_db
from ..services import upload_limits
from ..services.async_tools import to_thread_non_abandon
from ..services.atomic_io import atomic_write_text

router = APIRouter(prefix="/api/db-backup", tags=["db-backup"])

_KEEP = 10  # 계정별 보관 버전 수(오래된 것부터 정리)
_MAX_BYTES = upload_limits.DB_UPLOAD_FILE_MAX_BYTES  # 메타 DB는 보통 수 MB, 기본 상한 512MB
_CHUNK_BYTES = 1024 * 1024  # 파일 전체를 메모리에 올리지 않고 1MiB씩 복사
_MAX_CONCURRENT_STORES = 4  # 디스크 쓰기·quick_check 동시 실행 상한
_store_slots = asyncio.Semaphore(_MAX_CONCURRENT_STORES)
_SET_FORMAT = "mvhub-worker-backup-set"
_SET_FORMAT_VERSION = 1
_SET_ID_RE = re.compile(r"[0-9a-f]{64}")
_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_SET_KEEP = 10
_MANIFEST_MAX_CHARS = 64 * 1024
_HEAD_NAME = "head.json"
_SERVER_META_NAME = "server.json"
_DEVICE_ID_RE = re.compile(r"[0-9a-f]{32}")
_SUMMARY_KEYS = frozenset(
    {"generations", "tags", "canvases", "assets", "projects", "trash", "meaningful_records"}
)


class BackupTooLargeError(ValueError):
    """업로드 스트림이 서버 백업 상한을 넘었다."""


class BackupSetValidationError(ValueError):
    """세트 manifest·파일 역할·해시가 계약과 다르다."""


def _acct(request: Request) -> dict:
    acc = current_account(request)
    if not acc:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    return acc


def _dir(email: str) -> Path:
    return DATA_DIR / "db-backups" / slug(email)


# 계정 폴더별 저장 직렬화 — to_thread 전환으로 같은 계정의 동시 업로드가 실제로 겹칠 수 있어,
# 저장·정리·개수 계산이 섞이지 않게 폴더 단위로 잠근다(계정 수만큼만 생기니 크기 걱정 없음).
_dir_locks: dict[str, threading.Lock] = {}
_dir_locks_guard = threading.Lock()


def _dir_lock(d: Path) -> threading.Lock:
    key = str(d)
    with _dir_locks_guard:
        lock = _dir_locks.get(key)
        if lock is None:
            lock = _dir_locks[key] = threading.Lock()
    return lock


def _store_backup(d: Path, name: str, source: BinaryIO) -> tuple[int, int]:
    """스트림 복사·무결성 검증·백업 정리(전부 동기 I/O).

    반환은 ``(저장 크기, 남은 백업 개수)``. 호출부가 스레드에서 실행하므로 이벤트 루프를
    막지 않으며, 한 번에 _CHUNK_BYTES 만큼만 메모리에 둔다.
    """
    with _dir_lock(d):
        d.mkdir(parents=True, exist_ok=True)
        path = d / name
        tmp = d / f".upload-{uuid.uuid4().hex}.tmp"
        try:
            total = 0
            with tmp.open("xb") as out:
                while True:
                    chunk = source.read(_CHUNK_BYTES)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > _MAX_BYTES:
                        raise BackupTooLargeError
                    out.write(chunk)
            # 백업 보관본은 복원의 마지막 보루 — 깨진 파일을 받아두면 복원 시점에야 터진다.
            # quick_check 까지 통과해야 저장(수 MB 메타 DB 라 비용 미미).
            validate_hub_db(tmp, require_integrity=True)
            tmp.replace(path)
            # 오래된 백업 정리(이름=타임스탬프라 정렬이 곧 시간순)
            backups = sorted(d.glob("*.db"))
            for old in backups[:-_KEEP]:
                try:
                    old.unlink()
                except OSError:
                    pass
            return total, len(sorted(d.glob("*.db")))
        finally:
            # 용량 초과·무결성 실패·디스크 오류 모두 임시파일을 남기지 않는다.
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)


async def _store_backup_limited(
    d: Path, name: str, source: BinaryIO
) -> tuple[int, int]:
    """저장 슬롯을 실제 스레드 종료까지 점유한다.

    ``asyncio.to_thread``는 HTTP 요청 task가 취소돼도 실행 중인 스레드를 중단하지 못한다. shield 없이
    바로 await하면 클라이언트 연결 취소 때 semaphore만 먼저 풀려, 취소 요청을 반복해 동시 검증 상한을
    우회할 수 있다.

    ★대기는 to_thread_non_abandon 에 맡긴다(R11 A4) — 여기 있던 수제 판(``suppress(Exception)``
    + 맨 await)은 BaseException 인 CancelledError 를 못 잡아, 취소를 두 번 보내면 스레드가
    _dir_lock 과 .tmp 를 쥔 채로 슬롯이 먼저 풀렸다.
    """
    async with _store_slots:
        return await to_thread_non_abandon(_store_backup, d, name, source)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_trash_db(path: Path) -> None:
    with contextlib.closing(sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)) as conn:
        conn.execute("PRAGMA query_only=ON")
        result = conn.execute("PRAGMA quick_check").fetchone()
        if not result or result[0] != "ok":
            raise BackupSetValidationError("trash quick_check failed")
        if not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='trashed'"
        ).fetchone():
            raise BackupSetValidationError("trash table missing")


def _normalise_set_manifest(raw: str) -> dict:
    if len(raw) > _MANIFEST_MAX_CHARS:
        raise BackupSetValidationError("manifest too large")
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise BackupSetValidationError("invalid manifest json") from exc
    if not isinstance(value, dict):
        raise BackupSetValidationError("manifest must be object")
    backup_set_id = str(value.get("backup_set_id") or "")
    if (
        value.get("format") != _SET_FORMAT
        or value.get("format_version") != _SET_FORMAT_VERSION
        or not _SET_ID_RE.fullmatch(backup_set_id)
    ):
        raise BackupSetValidationError("unsupported manifest")
    roles = value.get("roles")
    if not isinstance(roles, dict) or "content" not in roles or not set(roles) <= {"content", "trash"}:
        raise BackupSetValidationError("invalid roles")
    normal_roles: dict[str, dict[str, object]] = {}
    for role, info in roles.items():
        if not isinstance(info, dict):
            raise BackupSetValidationError("invalid role info")
        try:
            size = int(info.get("size"))
        except (TypeError, ValueError) as exc:
            raise BackupSetValidationError("invalid role size") from exc
        digest = str(info.get("sha256") or "")
        if size < 0 or size > _MAX_BYTES or not _SHA256_RE.fullmatch(digest):
            raise BackupSetValidationError("invalid role integrity")
        normal_roles[role] = {"size": size, "sha256": digest}
    created_at = str(value.get("created_at") or "")[:64]
    local_stamp = str(value.get("local_stamp") or "")[:64]
    app_version = str(value.get("app_version") or "")[:64]
    try:
        schema_version = int(value.get("schema_version") or 0)
    except (TypeError, ValueError):
        schema_version = 0
    parent_backup_set_id = str(value.get("parent_backup_set_id") or "")
    if parent_backup_set_id and not _SET_ID_RE.fullmatch(parent_backup_set_id):
        raise BackupSetValidationError("invalid parent backup set id")
    raw_device = value.get("device")
    device: dict[str, str] = {}
    if isinstance(raw_device, dict):
        device_id = str(raw_device.get("device_id") or "")
        device_name = str(raw_device.get("device_name") or "").strip()[:80]
        if device_id and not _DEVICE_ID_RE.fullmatch(device_id):
            raise BackupSetValidationError("invalid device id")
        if device_id:
            device["device_id"] = device_id
        if device_name:
            device["device_name"] = device_name
    raw_summary = value.get("summary")
    summary: dict[str, int] = {}
    if isinstance(raw_summary, dict):
        for key in _SUMMARY_KEYS:
            try:
                count = int(raw_summary.get(key) or 0)
            except (TypeError, ValueError) as exc:
                raise BackupSetValidationError("invalid backup summary") from exc
            if count < 0 or count > 1_000_000_000:
                raise BackupSetValidationError("invalid backup summary")
            summary[key] = count
    return {
        "format": _SET_FORMAT,
        "format_version": _SET_FORMAT_VERSION,
        "backup_set_id": backup_set_id,
        "created_at": created_at,
        "local_stamp": local_stamp,
        "schema_version": max(0, schema_version),
        "app_version": app_version,
        "device": device,
        "parent_backup_set_id": parent_backup_set_id or None,
        "summary": summary,
        "roles": normal_roles,
    }


def _set_root(d: Path) -> Path:
    return d / "sets"


def _read_stored_manifest(folder: Path) -> dict | None:
    try:
        value = json.loads((folder / "manifest.json").read_text("utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _read_json_object(path: Path) -> dict:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _read_head(root: Path) -> str | None:
    backup_set_id = str(_read_json_object(root / _HEAD_NAME).get("backup_set_id") or "")
    if not _SET_ID_RE.fullmatch(backup_set_id):
        return None
    if not (root / backup_set_id / "manifest.json").is_file():
        return None
    return backup_set_id


def _write_head(root: Path, backup_set_id: str) -> None:
    if not _SET_ID_RE.fullmatch(backup_set_id):
        raise ValueError("invalid backup set id")
    atomic_write_text(
        root / _HEAD_NAME,
        json.dumps(
            {"backup_set_id": backup_set_id, "updated_at": time.time()},
            sort_keys=True,
            separators=(",", ":"),
        ),
    )


def _server_meta(folder: Path) -> dict:
    return _read_json_object(folder / _SERVER_META_NAME)


def _ack_for_stored_set(folder: Path, manifest: dict, *, duplicate: bool, count: int) -> dict | None:
    stored = _read_stored_manifest(folder)
    if stored != manifest:
        return None
    files: dict[str, dict[str, object]] = {}
    for role, expected in manifest["roles"].items():
        path = folder / f"{role}.db"
        try:
            size = path.stat().st_size
        except OSError:
            return None
        digest = _sha256(path)
        if size != expected["size"] or digest != expected["sha256"]:
            return None
        files[role] = {"size": size, "sha256": digest}
    server_meta = _server_meta(folder)
    return {
        "accepted": True,
        "backup_set_id": manifest["backup_set_id"],
        "files": files,
        "duplicate": duplicate,
        "count": count,
        "conflict": bool(server_meta.get("conflict")),
        "is_current": _read_head(folder.parent) == manifest["backup_set_id"],
    }


def _valid_set_dirs(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    result: list[Path] = []
    for path in root.iterdir():
        if path.is_dir() and _SET_ID_RE.fullmatch(path.name) and (path / "manifest.json").is_file():
            result.append(path)
    stamped: list[tuple[float, Path]] = []
    for path in result:
        try:
            stamped.append((path.stat().st_mtime, path))
        except OSError:
            continue
    return [path for _, path in sorted(stamped, key=lambda item: item[0])]


def _rotate_sets(root: Path) -> int:
    folders = _valid_set_dirs(root)
    head = _read_head(root)
    removable = [folder for folder in folders if folder.name != head]
    excess = max(0, len(folders) - _SET_KEEP)
    for old in removable[:excess]:
        shutil.rmtree(old)
    return len(_valid_set_dirs(root))


def _store_backup_set(
    d: Path,
    manifest: dict,
    sources: dict[str, BinaryIO],
) -> dict:
    """한 계정의 DB 세트를 임시 폴더에서 모두 검증한 뒤 디렉터리 단위로 공개한다."""
    with _dir_lock(d):
        root = _set_root(d)
        root.mkdir(parents=True, exist_ok=True)
        head_before = _read_head(root)
        if head_before is None:
            previous_folders = _valid_set_dirs(root)
            if previous_folders:
                head_before = previous_folders[-1].name
                _write_head(root, head_before)
        final = root / manifest["backup_set_id"]
        existing_count = len(_valid_set_dirs(root))
        if final.is_dir():
            ack = _ack_for_stored_set(final, manifest, duplicate=True, count=existing_count)
            if ack is not None:
                return ack
            # backup_set_id는 manifest 전체 계보를 포함한 불변 객체의 식별자다. 같은 ID로
            # 다른 manifest가 오면 기존 정상 버전을 교체하지 않는다. 저장 파일만 손상되고
            # manifest가 같은 경우에는 아래 원자 교체 경로로 자가 복구를 허용한다.
            stored_manifest = _read_stored_manifest(final)
            if stored_manifest is not None and stored_manifest != manifest:
                raise BackupSetValidationError("backup set id collision")

        staged = root / f".upload-{uuid.uuid4().hex}"
        staged.mkdir(exist_ok=False)
        previous: Path | None = None
        try:
            for role, source in sources.items():
                path = staged / f"{role}.db"
                with path.open("xb") as target:
                    size = upload_limits.copy_stream_limited(
                        source,
                        target,
                        max_bytes=_MAX_BYTES,
                        chunk_bytes=_CHUNK_BYTES,
                    )
                expected = manifest["roles"][role]
                if size != expected["size"] or _sha256(path) != expected["sha256"]:
                    raise BackupSetValidationError("uploaded file integrity mismatch")
                if role == "content":
                    validate_hub_db(path, require_integrity=True)
                else:
                    _validate_trash_db(path)
            atomic_write_text(
                staged / "manifest.json",
                json.dumps(manifest, sort_keys=True, separators=(",", ":")),
            )
            if final.exists():
                previous = root / f".replace-{uuid.uuid4().hex}"
                os.replace(final, previous)
            try:
                os.replace(staged, final)
            except BaseException:
                if previous is not None and previous.exists() and not final.exists():
                    os.replace(previous, final)
                raise
            if previous is not None:
                shutil.rmtree(previous, ignore_errors=True)
            parent = manifest.get("parent_backup_set_id")
            conflict = bool(head_before and parent != head_before)
            is_current = head_before is None or not conflict
            atomic_write_text(
                final / _SERVER_META_NAME,
                json.dumps(
                    {
                        "received_at": time.time(),
                        "conflict": conflict,
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                ),
            )
            if is_current:
                _write_head(root, manifest["backup_set_id"])
            count = _rotate_sets(root)
            ack = _ack_for_stored_set(final, manifest, duplicate=False, count=count)
            if ack is None:
                raise BackupSetValidationError("stored set verification failed")
            return ack
        finally:
            shutil.rmtree(staged, ignore_errors=True)


async def _store_backup_set_limited(
    d: Path,
    manifest: dict,
    sources: dict[str, BinaryIO],
) -> dict:
    async with _store_slots:
        # 반복 취소에도 staging 폴더·슬롯을 스레드보다 먼저 놓지 않는다(R11 A4).
        return await to_thread_non_abandon(_store_backup_set, d, manifest, sources)


@router.post("")
async def upload_backup(request: Request, file: UploadFile = File(...)):
    """내 계정 DB 백업 1건 저장. 같은 계정 폴더에 타임스탬프로 누적, 오래된 건 _KEEP 넘으면 정리."""
    acc = _acct(request)
    d = _dir(acc["email"])
    # 같은 초 동시 업로드 충돌 방지 — 앞부분 타임스탬프로 시간순 정렬 유지, 뒤 uuid 로 유일성 보장.
    name = f"{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.db"
    try:
        # UploadFile.file 은 Starlette 가 디스크로 spool 한 동기 스트림이다. 제한된 슬롯 안에서
        # 통째로 스레드에 넘겨 읽기·쓰기·quick_check 를 모두 이벤트 루프 밖에서 실행한다.
        size, count = await _store_backup_limited(d, name, file.file)
    except BackupTooLargeError:
        raise HTTPException(
            status_code=413,
            detail=(
                "백업 파일이 너무 큽니다"
                f"({upload_limits.format_byte_limit(_MAX_BYTES)} 초과)"
            ),
            headers=upload_limits.limit_headers(_MAX_BYTES),
        )
    except HubDbValidationError as exc:
        raise HTTPException(status_code=400, detail=hub_db_validation_detail(exc))
    return {"ok": True, "name": name, "size": size, "count": count}


@router.post("/sets")
async def upload_backup_set(
    request: Request,
    manifest: str = Form(...),
    content: UploadFile = File(...),
    trash: UploadFile | None = File(None),
):
    """작업자 개인 content·trash 세트를 계정별로 멱등 저장하고 명시적 ACK를 반환한다."""
    acc = _acct(request)
    try:
        parsed = _normalise_set_manifest(manifest)
    except BackupSetValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    uploads: dict[str, UploadFile] = {"content": content}
    if trash is not None:
        uploads["trash"] = trash
    if set(uploads) != set(parsed["roles"]):
        raise HTTPException(status_code=400, detail="manifest와 업로드 파일 역할이 다릅니다")
    try:
        upload_limits.validate_upload_batch(
            uploads.values(),
            max_files=2,
            max_file_bytes=_MAX_BYTES,
            max_total_bytes=_MAX_BYTES * 2,
        )
    except upload_limits.UploadLimitExceeded as exc:
        raise HTTPException(
            status_code=413,
            detail="백업 세트가 허용 용량을 초과했습니다",
            headers=upload_limits.limit_headers(_MAX_BYTES * 2),
        ) from exc
    for role, upload in uploads.items():
        actual = upload.size
        expected = int(parsed["roles"][role]["size"])
        if isinstance(actual, int) and actual >= 0 and actual != expected:
            raise HTTPException(status_code=400, detail="manifest와 업로드 파일 크기가 다릅니다")
        await upload.seek(0)
    try:
        return await _store_backup_set_limited(
            _dir(acc["email"]),
            parsed,
            {role: upload.file for role, upload in uploads.items()},
        )
    except (BackupTooLargeError, upload_limits.UploadLimitExceeded) as exc:
        raise HTTPException(status_code=413, detail="백업 파일이 허용 용량을 초과했습니다") from exc
    except (BackupSetValidationError, HubDbValidationError) as exc:
        raise HTTPException(status_code=400, detail="백업 세트 무결성 검증에 실패했습니다") from exc


@router.get("")
def list_backups(request: Request):
    """내 계정 백업 버전 목록(최신순)."""
    acc = _acct(request)
    d = _dir(acc["email"])
    out = []
    for p in sorted(d.glob("*.db"), reverse=True):
        try:
            st = p.stat()
        except OSError:
            continue
        out.append({"name": p.name, "size": st.st_size, "mtime": int(st.st_mtime)})
    root = _set_root(d)
    folders = _valid_set_dirs(root)
    manifests = {
        folder.name: manifest
        for folder in folders
        if (manifest := _read_stored_manifest(folder)) is not None
    }
    head = _read_head(root)
    history: set[str] = set()
    cursor = head
    while cursor and cursor not in history and cursor in manifests:
        history.add(cursor)
        parent = str(manifests[cursor].get("parent_backup_set_id") or "")
        cursor = parent if _SET_ID_RE.fullmatch(parent) else None
    for folder in reversed(folders):
        manifest = _read_stored_manifest(folder)
        content = folder / "content.db"
        if manifest is None or not content.is_file():
            continue
        try:
            st = content.stat()
            total = sum(
                (folder / f"{role}.db").stat().st_size
                for role in manifest.get("roles", {})
            )
        except OSError:
            continue
        out.append(
            {
                "name": folder.name,
                "backup_set_id": folder.name,
                "size": total,
                "mtime": int(_server_meta(folder).get("received_at") or st.st_mtime),
                "kind": "set",
                "roles": sorted(manifest.get("roles", {})),
                "created_at": manifest.get("created_at"),
                "app_version": manifest.get("app_version"),
                "schema_version": manifest.get("schema_version"),
                "device": manifest.get("device") or {},
                "summary": manifest.get("summary") or {},
                "parent_backup_set_id": manifest.get("parent_backup_set_id"),
                "is_current": folder.name == head,
                "branch_status": (
                    "current" if folder.name == head else "history" if folder.name in history else "conflict"
                ),
            }
        )
    out.sort(key=lambda item: int(item.get("mtime") or 0), reverse=True)
    return {"backups": out}


def _select_valid_set(d: Path, backup_set_id: str | None = None) -> tuple[Path, dict, int]:
    root = _set_root(d)
    folders = _valid_set_dirs(root)
    candidates: list[Path]
    if backup_set_id is not None:
        if not _SET_ID_RE.fullmatch(backup_set_id):
            raise HTTPException(status_code=400, detail="백업 식별자가 올바르지 않습니다")
        candidates = [root / backup_set_id]
    else:
        head = _read_head(root)
        candidates = ([root / head] if head else []) + list(reversed(folders))
    seen: set[str] = set()
    for folder in candidates:
        if folder.name in seen:
            continue
        seen.add(folder.name)
        manifest = _read_stored_manifest(folder)
        if manifest and _ack_for_stored_set(
            folder, manifest, duplicate=True, count=len(folders)
        ):
            return folder, manifest, len(folders)
    raise HTTPException(status_code=404, detail="이 계정의 백업 세트가 없습니다")


def _download_set_response(d: Path, backup_set_id: str | None = None) -> FileResponse:
    archive: Path | None = None
    with _dir_lock(d):
        folder, manifest, _count = _select_valid_set(d, backup_set_id)
        handle, raw_path = tempfile.mkstemp(
            prefix="mvhub-restore-set-", suffix=".zip", dir=str(DATA_DIR)
        )
        os.close(handle)
        archive = Path(raw_path)
        try:
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
                bundle.write(folder / "manifest.json", "manifest.json")
                for role in sorted(manifest["roles"]):
                    bundle.write(folder / f"{role}.db", f"{role}.db")
        except BaseException:
            archive.unlink(missing_ok=True)
            raise
    return FileResponse(
        archive,
        filename=f"MV-hub-restore-{folder.name[:12]}.zip",
        media_type="application/zip",
        background=BackgroundTask(lambda: archive.unlink(missing_ok=True)),
    )


@router.get("/latest")
def download_latest(request: Request):
    """내 계정의 가장 최근 백업을 내려준다(복원용)."""
    acc = _acct(request)
    d = _dir(acc["email"])
    candidates: list[Path] = list(d.glob("*.db"))
    candidates.extend(
        folder / "content.db"
        for folder in _valid_set_dirs(_set_root(d))
        if (folder / "content.db").is_file()
    )
    stamped: list[tuple[float, Path]] = []
    for path in candidates:
        try:
            stamped.append((path.stat().st_mtime, path))
        except OSError:
            continue
    if not stamped:
        raise HTTPException(status_code=404, detail="이 계정의 서버 백업이 없습니다")
    latest = max(stamped, key=lambda item: item[0])[1]
    return FileResponse(
        latest,
        filename="MV-hub-restore.db",
        media_type="application/octet-stream",
    )


@router.get("/latest-set")
def download_latest_set(request: Request):
    """서버가 가리키는 현재 검증 content·trash 세트를 복원용 ZIP으로 내려준다."""
    acc = _acct(request)
    return _download_set_response(_dir(acc["email"]))


@router.get("/sets/{backup_set_id}")
def download_backup_set(backup_set_id: str, request: Request):
    """사용자가 고른 특정 계정 백업 버전을 내려준다."""
    acc = _acct(request)
    return _download_set_response(_dir(acc["email"]), backup_set_id)


@router.post("/sets/{backup_set_id}/activate")
def activate_backup_set(backup_set_id: str, request: Request):
    """명시적으로 복원한 버전을 이 계정의 새 작업 기준점으로 지정한다."""
    acc = _acct(request)
    d = _dir(acc["email"])
    with _dir_lock(d):
        folder, _manifest, count = _select_valid_set(d, backup_set_id)
        _write_head(folder.parent, folder.name)
    return {"ok": True, "backup_set_id": backup_set_id, "count": count}
