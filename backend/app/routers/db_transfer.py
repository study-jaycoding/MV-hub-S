"""내 메타데이터(로컬 DB) 내보내기/가져오기 — 교차 PC 작업 연속성(로컬 우선).

서버와 무관하게 이 허브의 로컬 SQLite 파일을 통째로 주고받는다. 다른 PC에서 내보낸 .db 를
이 PC에 '통째 교체'로 넣으면 내 라이브러리·태그·컬러·계보·코멘트가 그대로 이어진다.
(미디어는 힉스필드 공개 URL 이라 파일 전송 불필요.) 병합이 아니라 교체 — 현재 DB는 자동 백업.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import stat
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from . import _proxy
from .. import active_account, config, db, repo
from ..config import AUTH_ENABLED, DATA_DIR
from ..deps import require_admin
from ..emailnorm import norm_email
from ..repo import identity
from ..services.db_scrub import SESSION_KEYS as _SESSION_KEYS
from ..services.db_scrub import strip_transfer_secrets as _strip_session
from ..services.db_scrub import scrub_slack_connection, scrub_hf_org_usage_connection, scrub_hf_balance_connection, _compact_scrubbed_copy
from ..services.async_tools import to_thread_non_abandon
from ..services.request_guards import require_loopback_request
from ..services.sqlite_db import HubDbValidationError, hub_db_validation_detail, validate_hub_db, validate_db_compatibility
from ..services import shared_transport, trash_transfer
from ..services import upload_limits
from ..services.backup import (
    POLICY_CHOICES,
    BackupPolicyError,
    backup_now,
    list_backups_info,
    policy_view,
    retention_status,
    update_policy,
)
from ..services.worker_backup import (
    _verify_transfer_secrets_removed as _verify_secrets_removed,
    adopt_restored_backup,
    account_key_digest,
    periodic_worker_backup,
    queue_backup_set,
    retry_pending,
    status_snapshot as worker_backup_status,
)
from ..services import backup_manifest
from ..services import asset_mounts, auth
from ..services.sqlite_db import read_only_uri
from ..services.test_snapshot import (
    SNAPSHOT_EXPORT_ENV,
    SNAPSHOT_TOKEN_ENV,
    SNAPSHOT_TOKEN_HEADER,
    TestSnapshotError,
    create_test_snapshot_archive,
)

router = APIRouter(prefix="/api/db", tags=["db-transfer"])
_BACKUP_SET_ID_RE = re.compile(r"[0-9a-f]{64}")
# Three SQLite members, one bounded JSON, manifest and ZIP framing.
_BACKUP_DOWNLOAD_MAX_BYTES = 3 * upload_limits.DB_UPLOAD_FILE_MAX_BYTES + 2 * 1024 * 1024
_BACKUP_UNPACKED_MAX_BYTES = 3 * upload_limits.DB_UPLOAD_FILE_MAX_BYTES + 1024 * 1024 + 64 * 1024

_snapshot_token_lock = threading.Lock()
_snapshot_token_in_progress: str | None = None
_snapshot_token_consumed: str | None = None


def _snapshot_token_marker(token: str) -> Path:
    """원문 코드를 저장하지 않고 재시작 후 재사용만 막는 격리 데이터 폴더 표식."""
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    return DATA_DIR / f".test-snapshot-token-{digest}.used"


def _claim_snapshot_download(request: Request) -> str:
    """전용 코드를 검증하고 이 프로세스에서 한 요청만 사용하도록 예약한다."""
    global _snapshot_token_in_progress

    expected = os.environ.get(SNAPSHOT_TOKEN_ENV, "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="일회용 스냅샷 코드가 설정되지 않았습니다. test_push-db.bat을 다시 실행하세요",
        )
    presented = request.headers.get(SNAPSHOT_TOKEN_HEADER, "").strip()
    if not presented or not secrets.compare_digest(
        presented.encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="일회용 스냅샷 코드가 올바르지 않습니다")

    with _snapshot_token_lock:
        if _snapshot_token_consumed == expected or _snapshot_token_marker(expected).is_file():
            raise HTTPException(
                status_code=410,
                detail="이 일회용 스냅샷 코드는 이미 사용됐습니다. test_push-db.bat을 다시 실행하세요",
            )
        if _snapshot_token_in_progress == expected:
            raise HTTPException(status_code=409, detail="스냅샷 다운로드가 이미 진행 중입니다")
        _snapshot_token_in_progress = expected
    return expected


def _finish_snapshot_download(token: str, *, consumed: bool) -> None:
    """생성 실패면 예약을 풀고, 성공이면 프로세스 재시작 후에도 재사용되지 않게 기록한다."""
    global _snapshot_token_consumed, _snapshot_token_in_progress

    with _snapshot_token_lock:
        if _snapshot_token_in_progress == token:
            _snapshot_token_in_progress = None
        if consumed:
            marker = _snapshot_token_marker(token)
            try:
                marker.touch(exist_ok=False)
            except FileExistsError as exc:
                _snapshot_token_consumed = token
                raise HTTPException(
                    status_code=410,
                    detail=(
                        "이 일회용 스냅샷 코드는 이미 사용됐습니다. "
                        "test_push-db.bat을 다시 실행하세요"
                    ),
                ) from exc
            except OSError as exc:
                raise HTTPException(
                    status_code=500,
                    detail="일회용 코드 사용 완료를 기록할 수 없어 다운로드를 중단했습니다",
                ) from exc
            _snapshot_token_consumed = token

def _require_local_when_open(request: Request) -> None:
    """AUTH off(차단 비활성) 상태에선 로컬(loopback) 접속만 허용 — 0.0.0.0 바인딩 + 무인증 조합에서
    LAN 의 누구나 DB 내보내기(해시 유출)·통째교체(파괴)를 호출하던 구멍을 막는다.
    공식 로컬 허브(MV_agent.bat)는 127.0.0.1 바인딩이라 통과. AUTH on 이면 require_admin 이 가드."""
    if AUTH_ENABLED:
        return
    require_loopback_request(request, "이 작업은 로컬에서만 가능합니다")

# 세션·보안 키 목록과 전송 프로파일 정제는 services/db_scrub.py 로 이동(테스트 스냅샷
# 프로파일과 정책을 한곳에서 관리). 이 모듈의 _SESSION_KEYS/_strip_session 이름은 유지.


def _post_install_security_init(path: Path, *, new_secret: str | None = None,
                                restore_id: str | None = None, email: str | None = None) -> None:
    """교체된 새 DB 의 보안 초기화(R7 0-B, 코덱스 P1) — 비밀 키 제거·auth_secret 재생성·
    전 계정 password_changed_at 회전을 '한 SQLite 트랜잭션'으로. 실패는 그대로 올려
    호출부의 파일 보상 롤백이 돌게 한다 — 종전 best-effort 는 가져온 사람의 토큰·서명키가
    남아도 relogin_required=True 성공을 반환했다.
    ★유지보수 게이트 안이므로 repo.set_setting 금지(게이트 대기/다른 DB 위험) — 명시
    경로 직접 연결만. ★CONTENT_HUB_AUTH_SECRET 환경변수 배포에선 DB auth_secret 교체가
    토큰을 무효화하지 못하므로 password_changed_at 회전이 필수 방어선.
    역할 제거=로컬 캐시(shared_server_roles)만 — account.global_role 은 복원 데이터라 불가침."""
    restore_id = restore_id or secrets.token_hex(16)
    if email is None:
        email = "" if AUTH_ENABLED else norm_email(active_account.account_key())
    conn = sqlite3.connect(str(path), timeout=10)
    try:
        trash_transfer.configure_connection(conn)
        conn.execute("BEGIN IMMEDIATE")
        scrub_slack_connection(conn)
        scrub_hf_org_usage_connection(conn)
        scrub_hf_balance_connection(conn)
        for key in _SESSION_KEYS:
            conn.execute("DELETE FROM app_setting WHERE key=?", (key,))
        conn.execute(
            "INSERT INTO app_setting(key, value) VALUES('auth_secret', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (new_secret or secrets.token_hex(32),),
        )
        # 전 계정 세션 스탬프 회전 — 이전 발급 토큰 전부 무효(account 는 직전 init_db 가 보장).
        conn.execute(
            "UPDATE account SET password_changed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')"
        )
        conn.execute("INSERT INTO app_setting(key,value) VALUES('share_db_generation',?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (secrets.token_hex(16),))
        conn.execute("UPDATE mcp_client SET revoked_at=COALESCE(revoked_at,datetime('now'))")
        conn.execute("INSERT INTO app_setting(key,value) VALUES(?,?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (asset_mounts.restore_key(email), json.dumps({"id": restore_id, "confirmed": []})))
        conn.execute("COMMIT")
        _compact_scrubbed_copy(conn)
    except BaseException:
        with contextlib.suppress(sqlite3.Error):
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def _strict_clear_active() -> None:
    """활성 계정 포인터를 '확실히' 제거(R7 0-B) — 종전 clear_active 는 OSError 를 삼켜
    실패해도 성공 응답이 나갔다. 실패는 올려서 파일 보상 롤백이 돌게 한다."""
    with active_account.transition_lock:  # RLock — _install_db 보유 중 재진입
        try:
            active_account._POINTER.unlink(missing_ok=True)
        except OSError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"가져오기 후 활성 계정 해제에 실패했습니다(교차 계정 보호를 위해 중단): {exc}",
            ) from exc
        active_account._cache[0], active_account._cache[1] = True, None
        active_account.bump_account_epoch()  # clear_active 를 거치지 않는 해제 — 세대값도 같이(클린 피드 세션)


@dataclass(frozen=True)
class _RestoreTarget:
    path: Path
    auth_enabled: bool
    account_auth_enabled: bool
    configured_db: str | None
    email: str
    uid: str | None
    full: bool = False
    secret_env_digest: str | None = None
    old_identity: object = None
    agent_path: Path | None = None
    mounts_path: Path | None = None
    agent_dir: Path | None = None
    agent_email: str = ""
    shared_server: bool = False
    db_epoch: int = 0
    account_epoch: int = 0


def _restore_target_changed() -> HTTPException:
    return HTTPException(
        status_code=409,
        detail="복원 준비 중 계정 또는 DB 설정이 변경되었습니다. 현재 계정을 확인하고 다시 시도하세요",
    )


def _pointer_fields_ok(pointer: object) -> bool:
    return isinstance(pointer, dict) and all(
        value is None or isinstance(value, str)
        for value in (pointer.get("email"), pointer.get("uid"))
    )


def _strict_read_pointer() -> dict:
    """복원 접수에서는 손상·읽기 실패를 로그아웃으로 해석하지 않는다."""
    try:
        pointer = json.loads(active_account._POINTER.read_text("utf-8"))
    except FileNotFoundError:
        return {}
    except (ValueError, UnicodeDecodeError) as exc:
        raise _restore_target_changed() from exc
    except OSError as exc:
        raise HTTPException(
            status_code=503,
            detail="활성 계정 정보를 읽을 수 없어 복원을 중단했습니다. 잠시 뒤에 다시 시도하세요",
        ) from exc
    if not _pointer_fields_ok(pointer):
        raise _restore_target_changed()
    return pointer


def _restore_file_exists(path: Path) -> bool:
    try:
        mode = path.stat().st_mode
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise HTTPException(503, "복원 대상 파일을 읽을 수 없습니다") from exc
    if not stat.S_ISREG(mode):
        raise HTTPException(409, "복원 대상이 일반 파일이 아닙니다")
    return True


def _capture_restore_target(*, path: Path | None = None, full: bool = False,
                            agent_email: str = "", pool_epoch: int | None = None) -> _RestoreTarget:
    """접수 목적지만 보관한다. 서버 주소·토큰은 이 스냅샷에 넣지 않는다."""
    with active_account.transition_lock:
        email, uid = "", None
        if not AUTH_ENABLED:
            pointer = _strict_read_pointer()
            email, uid = norm_email(pointer.get("email")), pointer.get("uid")
            raw = active_account._read_pointer()
            # 캐시 None은 미로그인이다. falsey 비문자열은 accessor가 None으로 접기 전에 거부.
            if raw is not None and not _pointer_fields_ok(raw):
                raise _restore_target_changed()
            # 복원은 머신 포인터를 해제하므로 요청 ContextVar만 고정해선 안 된다.
            # 고정 DB에서도 새 계정의 로그인 상태를 지우지 않도록 한 쌍을 대조한다.
            live_email = active_account.account_key()
            live_uid = active_account.active_uid()
            # uid 비교 자체는 안전하지만 파일 검사 순서와 무관하게 쌍의 형식을 보장한다.
            if any(value is not None and not isinstance(value, str) for value in (live_email, live_uid)):
                raise _restore_target_changed()
            if norm_email(live_email) != email or live_uid != uid:
                raise _restore_target_changed()
        resolved = (db.get_db_path() if path is None else path).resolve()
        shared_server = _proxy.is_shared_team_server()
        agent_email = "" if shared_server else norm_email(agent_email if AUTH_ENABLED else email)
        env_secret = os.environ.get("CONTENT_HUB_AUTH_SECRET") or ""
        env_digest = hashlib.sha256(env_secret.encode()).hexdigest()
        old_identity, agent_path = None, None
        if full and agent_email:
            from ..services.agent_chat import Identity
            secret = env_secret
            if not secret and _restore_file_exists(resolved):
                try:
                    with contextlib.closing(sqlite3.connect(read_only_uri(resolved), uri=True)) as conn:
                        row = conn.execute("SELECT value FROM app_setting WHERE key='auth_secret'").fetchone()
                        secret = row[0] if row else None
                except sqlite3.Error as exc:
                    raise HTTPException(503, "복원 전 허브 신원을 읽을 수 없습니다") from exc
            if secret:
                old_identity = Identity(auth.hub_id_for(secret, resolved), str(resolved), agent_email)
                agent_path = old_identity.file_path().resolve()
        return _RestoreTarget(
            path=resolved,
            auth_enabled=AUTH_ENABLED,
            account_auth_enabled=config.AUTH_ENABLED,
            configured_db=os.environ.get("CONTENT_HUB_DB"),
            email=email,
            uid=uid,
            full=full, secret_env_digest=env_digest, old_identity=old_identity,
            agent_path=agent_path, mounts_path=asset_mounts.mounts_file(email).resolve(),
            agent_dir=config.AGENT_CHAT_DIR.resolve(), agent_email=agent_email,
            shared_server=shared_server,
            db_epoch=db.pool_epoch() if pool_epoch is None else pool_epoch,
            account_epoch=active_account.account_epoch(),
        )


def _capture_restore_target_nowait(*, agent_email: str = "") -> _RestoreTarget:
    """async import의 첫 await 전 접수를 유지하되 전환 락을 기다리지는 않는다."""
    if not active_account.transition_lock.acquire(blocking=False):
        raise HTTPException(
            status_code=503,
            detail="다른 DB 요청이 진행 중이라 복원을 잠시 뒤에 다시 시도하세요",
        )
    try:
        state = db.pool_state_nowait()
        if state is None or state[1]:
            raise HTTPException(503, "다른 DB 요청이 진행 중이라 복원을 잠시 뒤에 다시 시도하세요")
        return _capture_restore_target(agent_email=agent_email, pool_epoch=state[0])
    finally:
        active_account.transition_lock.release()


def _check_restore_target(expected: _RestoreTarget | None, *, path: Path | None = None) -> None:
    if expected is not None and _capture_restore_target(
            path=path, full=expected.full, agent_email=expected.agent_email) != expected:
        raise _restore_target_changed()


def _complete_restore_target(expected: _RestoreTarget) -> _RestoreTarget:
    with active_account.transition_lock:
        _check_restore_target(expected)
        completed = _capture_restore_target(full=True, agent_email=expected.agent_email)
        _check_restore_target(expected)
        return completed


def _install_db(
    tmp: Path,
    *,
    trash_tmp: Path | None = None,
    restore_trash_set: bool = False,
    expected: _RestoreTarget | None = None,
    full_set: _FullBackupSet | None = None,
) -> dict:
    """검증 끝난 DB를 현재 활성 DB로 교체하고 재로그인을 강제한다.

    서버의 새 세트 복원은 ``restore_trash_set=True``로 content·trash를 같은 유지보수 게이트에서
    바꾼다. 두 번째 파일 교체가 실패하면 첫 파일도 기존 자동 보관본으로 되돌린다.
    """
    originals: list[tuple[Path, Path | None, bool]] = []
    staged: Path | None = None
    staged_trash: Path | None = None
    extra_stages: dict[str, Path] = {}
    extra_targets: dict[str, Path] = {}
    new_secret, restore_id, final_identity = None, None, None
    legacy_agent = None
    from ..services import agent_chat
    if full_set is not None:
        if expected is None or not expected.full or expected.auth_enabled or expected.account_auth_enabled or not expected.email:
            raise HTTPException(status_code=400, detail="전체 복원은 로그인된 로컬 허브에서만 가능합니다")
        _check_restore_target(expected)
        try:
            backup_manifest.verify_files_v3(full_set.manifest, full_set.paths,
                expected_account_digest=backup_manifest.account_digest(active_account.slug(expected.email)))
        except (ValueError, OSError, sqlite3.Error) as exc:
            raise HTTPException(status_code=400, detail="백업 구성원 또는 계정이 일치하지 않습니다") from exc
        new_secret, restore_id = secrets.token_hex(32), secrets.token_hex(16)
        final_identity = agent_chat.Identity(
            auth.hub_id_for(os.environ.get("CONTENT_HUB_AUTH_SECRET") or new_secret, expected.path),
            str(expected.path), expected.email)
        extra_targets = {"agent_chat": final_identity.file_path().resolve(), "asset_mounts": expected.mounts_path}
    elif expected is not None and expected.full and expected.agent_email:
        _check_restore_target(expected)
        new_secret, restore_id = secrets.token_hex(32), secrets.token_hex(16)
        final_identity = agent_chat.Identity(
            auth.hub_id_for(os.environ.get("CONTENT_HUB_AUTH_SECRET") or new_secret, expected.path),
            str(expected.path), expected.agent_email)
    try:
        # ★계정 전환과의 상호배제(코덱스 재확인 P1) — 게이트는 DB 연결만 막으므로
        # set_active 가 그 사이 끼면 경로·포인터 판정이 어긋난다. transition_lock 을
        # 게이트보다 먼저 잡는다(전환은 게이트를 안 잡아 락 순서 역전 없음).
        with contextlib.ExitStack() as gates:
            if final_identity is not None:
                identities = tuple(item for item in (expected.old_identity, final_identity) if item is not None)
                gates.enter_context(agent_chat.service.restore_guard(identities, timeout=5.0))
            gates.enter_context(active_account.transition_lock)
            _check_restore_target(expected)
            try:
                validate_db_compatibility(tmp, "content")
                if restore_trash_set and trash_tmp is not None:
                    validate_db_compatibility(trash_tmp, "trash")
                trash_transfer.validate_pair(tmp, trash_tmp if restore_trash_set else None)
            except trash_transfer.TransferRecoveryRequired as exc:
                raise HTTPException(status_code=400, detail="휴지통 이동 기록과 일치하는 DB 백업 세트가 필요합니다") from exc
            except HubDbValidationError as exc:
                _raise_validation_error(exc)
            gates.enter_context(db.maintenance_gate())
            if full_set is not None:
                gates.enter_context(asset_mounts._file_lock(expected.mounts_path))
            # ★대상 경로·포인터 스냅샷도 게이트 '안'에서 확정(R7 0-B, 코덱스 P1) —
            # 게이트 전에 읽으면 계정 전환(set_active — 게이트 비참여)이 겹칠 때 설치
            # 대상 path 와 이후 단계가 보는 활성 DB 가 달라질 수 있다.
            path = db.get_db_path()
            _check_restore_target(expected, path=path)
            if full_set is None and final_identity is not None:
                final_path = final_identity.file_path().resolve()
                old_path = expected.agent_path
                reserved = {path.resolve(), (path.parent / "content_hub_trash.db").resolve(), expected.mounts_path}
                if final_path in reserved or old_path in reserved:
                    raise HTTPException(409, "Agent 복원 경로가 다른 구성원과 겹칩니다")
                final_exists = _restore_file_exists(final_path)
                if final_exists and final_path != old_path:
                    raise HTTPException(409, "새 신원의 Agent 기록이 이미 존재합니다")
                if old_path is not None and _restore_file_exists(old_path):
                    legacy_agent = old_path
                    extra_targets["agent_chat"] = final_path
            path.parent.mkdir(parents=True, exist_ok=True)
            trash_path = path.parent / "content_hub_trash.db"
            if not restore_trash_set and trash_path.is_file():
                try:
                    # A legacy single-file import must not strand an enabled
                    # trash partner belonging to the previous content database.
                    trash_transfer.validate_pair(tmp, trash_path)
                except trash_transfer.TransferRecoveryRequired as exc:
                    raise HTTPException(status_code=400, detail="활성 휴지통 DB와 함께 백업 세트를 복원해야 합니다") from exc
            staged = path.with_name(f".{path.name}.restore-{secrets.token_hex(8)}.tmp")
            staged_trash = trash_path.with_name(
                f".{trash_path.name}.restore-{secrets.token_hex(8)}.tmp"
            )
            # active.json 원상 복구용 스냅샷 — 읽기 실패는 '파일 없음'과 구분해 중단
            # (원본 보호 원칙 — 복구 불능 상태로 교체를 진행하지 않는다).
            active_pointer_backup: bytes | None = None
            if not AUTH_ENABLED:
                try:
                    if active_account._POINTER.is_file():
                        active_pointer_backup = active_account._POINTER.read_bytes()
                except OSError as exc:
                    raise HTTPException(
                        status_code=500,
                        detail=f"활성 계정 포인터를 읽을 수 없어 가져오기를 중단했습니다: {exc}",
                    ) from exc
            # 게이트가 새 요청을 막고 기존 컨텍스트가 모두 끝난 뒤라, 여기서만 전 스레드 풀을
            # 닫아도 진행 중 요청의 커넥션을 끊지 않는다. 이 뒤 게이트 해제 전에는 옛 파일을
            # 다시 여는 요청도 없다.
            db.flush_pool()
            targets = [path]
            if restore_trash_set:
                targets.append(trash_path)
            if full_set is not None or legacy_agent is not None:
                targets.extend(extra_targets.values())
                if expected.agent_path is not None and expected.agent_path not in targets:
                    targets.append(expected.agent_path)
            for current in targets:
                current.parent.mkdir(parents=True, exist_ok=True)
                existed = current.is_file()
                if current.exists() and not existed:
                    raise HTTPException(status_code=409, detail="복원 대상이 일반 파일이 아닙니다")
                backup_copy: Path | None = None
                if not existed:
                    originals.append((current, None, False))
                    continue
                try:
                    if current != extra_targets.get("asset_mounts"):
                        conn = sqlite3.connect(str(current))
                        try:
                            checkpoint = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                            if checkpoint and checkpoint[0]:
                                raise sqlite3.OperationalError("database checkpoint busy")
                        finally:
                            conn.close()
                except Exception as exc:  # noqa: BLE001
                    raise HTTPException(
                        status_code=500,
                        detail=f"현재 DB WAL 정리 실패로 가져오기를 중단했습니다(원본 보호): {exc}",
                    ) from exc
                # ★백업이 실패하면 덮어쓰기를 '중단'한다 — 예전엔 except: pass 로 삼키고 그대로 move 해,
                # "현재 DB 를 .bak 으로 백업한다"는 약속이 거짓이 되고(백업 없음) 가져온 DB 가 불량이면 원본을
                # 복구할 길이 없었다. 디스크 가득·권한 등으로 백업 못 하면 원본을 지키려 교체를 안 한다.
                backup_copy = current.with_name(
                    f"{current.stem}.bak-{int(time.time())}-{secrets.token_hex(4)}{current.suffix}"
                )
                try:
                    shutil.copy2(current, backup_copy)
                except Exception as e:  # noqa: BLE001
                    raise HTTPException(
                        status_code=500,
                        detail=(
                            f"현재 DB 백업 실패로 가져오기를 중단했습니다(원본 보호): {e}. "
                            "디스크 여유·쓰기 권한을 확인하세요."
                        ),
                    ) from e
                originals.append((current, backup_copy, True))

            # 외부 임시 폴더와 DB 폴더가 다른 드라이브여도 최종 교체는 같은 볼륨의 staging에서 한다.
            shutil.copy2(tmp, staged)
            if restore_trash_set and trash_tmp is not None:
                shutil.copy2(trash_tmp, staged_trash)
            if full_set is not None:
                for role, target in extra_targets.items():
                    if role in full_set.paths:
                        extra_stages[role] = target.with_name(f".{target.name}.restore-{secrets.token_hex(8)}.tmp")
                        shutil.copy2(full_set.paths[role], extra_stages[role])
            elif legacy_agent is not None:
                original = next(backup for current, backup, existed in originals if current == legacy_agent)
                if original is None:
                    raise HTTPException(
                        status_code=409,
                        detail="복원 준비 중 Agent 기록 파일이 변경되었습니다. 다시 시도하세요",
                    )
                target = extra_targets["agent_chat"]
                extra_stages["agent_chat"] = target.with_name(f".{target.name}.restore-{secrets.token_hex(8)}.tmp")
                shutil.copy2(original, extra_stages["agent_chat"])
            # Recheck the actual local copies, not just the earlier source path.
            # A source replaced while waiting must never install a future schema.
            try:
                if legacy_agent is not None:
                    prepared = extra_stages["agent_chat"]
                    if (prepared.stat().st_size != original.stat().st_size
                            or backup_manifest.file_digest(prepared) != backup_manifest.file_digest(original)):
                        raise ValueError("Agent restore copy differs")
                    backup_manifest._verify_agent(prepared)
                if full_set is not None:
                    staged_paths = {"content": staged, **extra_stages}
                    if trash_tmp is not None:
                        staged_paths["trash"] = staged_trash
                    backup_manifest.verify_files_v3(full_set.manifest, staged_paths,
                        expected_account_digest=backup_manifest.account_digest(active_account.slug(expected.email)))
                validate_db_compatibility(staged, "content")
                if restore_trash_set and trash_tmp is not None:
                    validate_db_compatibility(staged_trash, "trash")
                trash_transfer.validate_pair(staged, staged_trash if restore_trash_set else None)
            except trash_transfer.TransferRecoveryRequired as exc:
                raise HTTPException(status_code=400, detail="휴지통 이동 기록과 일치하는 DB 백업 세트가 필요합니다") from exc
            except HubDbValidationError as exc:
                _raise_validation_error(exc)
            except (ValueError, OSError, sqlite3.Error) as exc:
                raise HTTPException(status_code=400, detail="설치 준비 파일의 원문 검증에 실패했습니다") from exc
            # checkpoint 뒤 모든 SQLite 핸들이 닫힌 상태에서만 sidecar 를 지운다. Windows 는 열린
            # -wal/-shm 을 unlink 하지 못하므로 파일 교체보다 먼저 이 순서를 지켜야 한다.
            for current in targets:
                if current == extra_targets.get("asset_mounts"):
                    continue
                for suf in ("-wal", "-shm"):
                    Path(str(current) + suf).unlink(missing_ok=True)
            try:
                os.replace(staged, path)
                if restore_trash_set:
                    if trash_tmp is None:
                        trash_path.unlink(missing_ok=True)
                    else:
                        os.replace(staged_trash, trash_path)
                for role, target in extra_targets.items():
                    if role in extra_stages:
                        os.replace(extra_stages[role], target)
                    else:
                        target.unlink(missing_ok=True)
                db.init_db(path, scene_restore=True)  # 복원 세대·공책 확정도 보상 롤백 경계 안
                # ★보안 초기화·활성 계정 해제도 이 보상 롤백 경계 안(R7 0-B, 코덱스 P1)
                # — 하나라도 실패하면 성공 응답 없이 기존 파일 세트로 되돌린다.
                if full_set is not None or final_identity is not None:
                    _post_install_security_init(path, new_secret=new_secret, restore_id=restore_id, email=expected.email)
                    if "agent_chat" in extra_stages:
                        from ..repo import agent_chat as agent_store
                        agent_store.adopt_restored(extra_targets["agent_chat"], restore_id)
                else:
                    _post_install_security_init(path)
                if not AUTH_ENABLED:
                    _strict_clear_active()
            except BaseException as original_error:
                # init_db가 풀 핸들을 만들었을 수 있으므로 원본 되돌리기 전에 다시 모두 닫는다.
                db.flush_pool()
                rollback_errors = []
                try:
                    for current, backup_copy, existed in originals:
                        try:
                            if current != extra_targets.get("asset_mounts"):
                                for suf in ("-wal", "-shm"):
                                    Path(str(current) + suf).unlink(missing_ok=True)
                            if existed and backup_copy is not None:
                                rollback_stage = current.with_name(
                                    f".{current.name}.rollback-{secrets.token_hex(8)}.tmp"
                                )
                                try:
                                    shutil.copy2(backup_copy, rollback_stage)
                                    os.replace(rollback_stage, current)
                                finally:
                                    rollback_stage.unlink(missing_ok=True)
                            else:
                                current.unlink(missing_ok=True)
                        except Exception as rollback_error:
                            rollback_errors.append(rollback_error)
                    if not AUTH_ENABLED:
                        # 포인터 원상 복구 — clear_active 가 지운 뒤의 실패에서도 원래
                        # 로그인 상태로 돌아간다(없었으면 없던 상태 유지).
                        if active_pointer_backup is not None:
                            active_account._POINTER.write_bytes(active_pointer_backup)
                        else:
                            active_account._POINTER.unlink(missing_ok=True)
                        active_account._cache[0] = False  # 다음 조회가 파일에서 재로드
                        active_account.bump_account_epoch()
                    if rollback_errors:
                        raise rollback_errors[0]
                except Exception as rollback_error:  # noqa: BLE001
                    logging.getLogger(__name__).error(
                        "DB 가져오기 실패 후 자동 롤백도 실패 — 수동 복구 필요(백업 .bak 파일 확인)",
                        exc_info=rollback_error,
                    )
                    raise HTTPException(
                        status_code=500,
                        detail="복원 실패 뒤 기존 DB를 자동으로 되돌리지 못했습니다. 운영 로그를 확인하세요",
                    ) from rollback_error
                raise original_error
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass  # 교체는 이미 끝났으므로 임시 원본 정리 실패가 복원 성공을 500으로 바꾸지 않게
            if restore_trash_set and trash_tmp is not None:
                with contextlib.suppress(OSError):
                    trash_tmp.unlink(missing_ok=True)
            # ★프로세스 캐시 초기화도 게이트 '안'(코덱스 P1) — 해제 후로 미루면 게이트를
            # 기다리던 요청이 교체 전 신원·FTS 캐시를 보고 새 DB 와 어긋난다.
            identity._MY_UID_CACHE[0] = None
            from ..repo import generations as _gens

            _gens._FTS_READY = None
            _gens._FTS_READY_PATH = None
    except db.DatabaseMaintenanceTimeout as exc:
        raise HTTPException(
            status_code=503,
            detail="다른 DB 요청이 진행 중이라 복원을 잠시 뒤에 다시 시도하세요",
        ) from exc
    finally:
        for extra_stage in extra_stages.values():
            with contextlib.suppress(OSError):
                extra_stage.unlink(missing_ok=True)
        if staged is not None:
            with contextlib.suppress(OSError):
                staged.unlink(missing_ok=True)
        if staged_trash is not None:
            with contextlib.suppress(OSError):
                staged_trash.unlink(missing_ok=True)
    # (보안 초기화·활성 계정 해제·캐시 초기화는 게이트 안에서 이미 완료 — R7 0-B)
    result = {"ok": True, "relogin_required": True}
    if full_set is not None:
        result.update(restored_roles={role: item["state"] for role, item in full_set.manifest["roles"].items()},
                      agent_history_restored="agent_chat" in full_set.paths, mounts_confirmation_required=True)
    return result


def _multipart_upload(url: str, token: str | None, source: Path) -> tuple[int, object]:
    """stdlib 멀티파트 스트리밍 업로드(파일 필드명 ``file``) — 새 의존성 0."""
    boundary = "----mvhub" + secrets.token_hex(8)
    prefix = (
        f"--{boundary}\r\n".encode()
        + b'Content-Disposition: form-data; name="file"; filename="backup.db"\r\n'
        + b"Content-Type: application/octet-stream\r\n\r\n"
    )
    suffix = f"\r\n--{boundary}--\r\n".encode()

    def body_chunks():
        yield prefix
        with source.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                yield chunk
        yield suffix

    req = urllib.request.Request(url, data=body_chunks(), method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Content-Length", str(len(prefix) + source.stat().st_size + len(suffix)))
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        req.full_url = shared_transport.transport_url(req.full_url)
        with shared_transport.cached_opener().open(req, timeout=180) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise HTTPException(status_code=502, detail=f"공유 서버 연결 실패: {e}")


def _download_to(url: str, token: str | None, dst: Path) -> int:
    """공유 서버에서 바이너리를 받아 dst 에 저장. 상태코드 반환(200 외엔 본문 무시)."""
    req = urllib.request.Request(url, method="GET")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        req.full_url = shared_transport.transport_url(req.full_url)
        with shared_transport.cached_opener().open(req, timeout=180) as r:
            with open(dst, "wb") as f:
                upload_limits.copy_stream_limited(r, f, max_bytes=_BACKUP_DOWNLOAD_MAX_BYTES)
            return r.status
    except upload_limits.UploadLimitExceeded as exc:
        dst.unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail="서버 백업 다운로드 크기 제한을 초과했습니다") from exc
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        with contextlib.suppress(OSError):
            dst.unlink(missing_ok=True)
        raise HTTPException(status_code=502, detail=f"공유 서버 연결 실패: {e}")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class _FullBackupSet:
    manifest: dict
    paths: dict[str, Path]


def _extract_backup_set(archive: Path, destination: Path) -> tuple[Path, Path | None] | _FullBackupSet:
    """서버 ZIP의 역할·크기·해시·SQLite 무결성을 확인하고 안전한 고정 이름만 푼다."""
    destination.mkdir(parents=True, exist_ok=True)
    try:
        if archive.stat().st_size > _BACKUP_DOWNLOAD_MAX_BYTES:
            raise ValueError("archive too large")
        with zipfile.ZipFile(archive, "r") as bundle:
            infos = bundle.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)) or "manifest.json" not in names:
                raise ValueError("invalid archive entries")
            if not set(names) <= {"manifest.json", *backup_manifest.WORKER_FILENAMES.values()}:
                raise ValueError("unexpected archive entry")
            if sum(info.file_size for info in infos) > _BACKUP_UNPACKED_MAX_BYTES:
                raise ValueError("archive expanded size too large")
            manifest_info = bundle.getinfo("manifest.json")
            if manifest_info.file_size > 64 * 1024:
                raise ValueError("manifest too large")
            manifest = backup_manifest.read_json_v3(bundle.read(manifest_info))
            full = isinstance(manifest, dict) and manifest.get("format_version") == 3
            if full:
                backup_manifest.validate_v3(manifest)
            else:
                backup_manifest.check_version(manifest)
                if manifest.get("format") != backup_manifest.WORKER_FORMAT:
                    raise ValueError("unsupported backup set")
                if manifest['format_version'] == backup_manifest.VERSION:
                    backup_manifest.validate(manifest)
            roles = manifest.get("roles")
            if not isinstance(roles, dict) or "content" not in roles or (not full and not set(roles) <= {"content", "trash"}):
                raise ValueError("invalid backup roles")
            present = {role: info for role, info in roles.items() if not full or info["state"] == "present"}
            if set(names) - {"manifest.json"} != {backup_manifest.WORKER_FILENAMES[role] for role in present}:
                raise ValueError("archive roles differ")
            extracted: dict[str, Path] = {}
            for role, expected in present.items():
                if not isinstance(expected, dict):
                    raise ValueError("invalid role metadata")
                info = bundle.getinfo(backup_manifest.WORKER_FILENAMES[role])
                limit = 1024 * 1024 if role == "asset_mounts" else upload_limits.DB_UPLOAD_FILE_MAX_BYTES
                expected_size = expected.get("size")
                if (
                    type(expected_size) is not int or expected_size <= 0
                    or expected_size > limit
                    or info.file_size != expected_size
                ):
                    raise ValueError("invalid role size")
                path = destination / info.filename
                with bundle.open(info, "r") as source, path.open("xb") as target:
                    actual_size = upload_limits.copy_stream_limited(
                        source,
                        target,
                        max_bytes=limit,
                    )
                digest = _file_sha256(path)
                if actual_size != expected_size or digest != expected.get("sha256"):
                    raise ValueError("role integrity mismatch")
                extracted[role] = path
            if full:
                backup_manifest.verify_files_v3(manifest, extracted)
            elif manifest['format_version'] == backup_manifest.VERSION:
                backup_manifest.verify_files(manifest, extracted)
    except (OSError, ValueError, KeyError, RuntimeError, sqlite3.Error, zipfile.BadZipFile,
            HubDbValidationError, upload_limits.UploadLimitExceeded) as exc:
        raise HTTPException(status_code=400, detail="서버 백업 세트가 손상되었거나 형식이 다릅니다") from exc

    try:
        validate_hub_db(extracted["content"], require_integrity=True)
        if "trash" in extracted:
            validate_db_compatibility(extracted["trash"], "trash")
            with contextlib.closing(sqlite3.connect(read_only_uri(extracted["trash"], immutable=True), uri=True)) as conn:
                result = conn.execute("PRAGMA quick_check").fetchone()
                table = conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='trashed'"
                ).fetchone()
                if not result or result[0] != "ok" or not table:
                    raise ValueError("invalid trash backup")
    except (ValueError, sqlite3.Error, OSError) as exc:
        raise HTTPException(status_code=400, detail="서버 백업 DB가 손상되었거나 형식이 다릅니다") from exc
    return _FullBackupSet(manifest, extracted) if full else (extracted["content"], extracted.get("trash"))


def _install_backup_set(bundle, expected: _RestoreTarget, *, backup_set_id: str | None = None) -> dict:
    if isinstance(bundle, _FullBackupSet):
        if backup_set_id is not None and bundle.manifest["backup_set_id"] != backup_set_id:
            raise HTTPException(status_code=400, detail="선택한 백업과 받은 백업이 일치하지 않습니다")
        return _install_db(bundle.paths["content"], trash_tmp=bundle.paths.get("trash"),
                           restore_trash_set=True, expected=expected, full_set=bundle)
    content, trash = bundle
    return _install_db(content, trash_tmp=trash, restore_trash_set=True, expected=expected)


def _raise_validation_error(exc: HubDbValidationError, *, downloaded: bool = False) -> None:
    raise HTTPException(status_code=400, detail=hub_db_validation_detail(exc, downloaded=downloaded))


@router.get("/export")
def export_db(request: Request):
    """내 로컬 DB 를 단일 .db 파일로 내려준다(일관 스냅샷). 다른 PC에서 '가져오기'로 넣으면 됨.
    AUTH on(공유 서버)에선 admin 만 — 전체 DB(비밀번호 해시 포함) 유출 방지. AUTH off(로컬)면 통과."""
    require_admin(request)
    _require_local_when_open(request)
    path = db.get_db_path()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="로컬 DB가 아직 없습니다")
    # sqlite backup API 로 임시파일에 일관 복사 — WAL 상태와 무관하게 완전한 스냅샷.
    # ★OS 고유 임시파일(R7 1-B) — 종전 초 단위 이름은 같은 초의 동시 요청이 같은 파일을
    # 복사·스트리밍·삭제해 한 응답의 정리가 다른 응답의 파일을 지울 수 있었다.
    fd, tmp_name = tempfile.mkstemp(prefix="mvhub-export-", suffix=".db")
    os.close(fd)  # Windows: 핸들을 닫아야 복사·교체 가능
    tmp = Path(tmp_name)
    try:
        db._copy_sqlite(path, tmp)
    except Exception:
        tmp.unlink(missing_ok=True)  # FileResponse 전 실패도 정리
        raise
    return FileResponse(
        tmp,
        filename="MV-hub-mydb.db",
        media_type="application/octet-stream",
        background=BackgroundTask(lambda: tmp.unlink(missing_ok=True)),
    )


@router.get("/export-test-snapshot")
def export_test_snapshot(request: Request):
    """test_push-db가 만든 격리 스냅샷의 모든 SQLite DB를 한 번에 내보낸다.

    일반 서버에서는 환경 플래그가 없어 404다. test_push-db가 명시적으로 켠 스냅샷 서버에서만,
    서버 창에 표시된 일회용 코드로 한 번만 받을 수 있다. 일반 로그인과 운영 비밀번호는 사용하지
    않으며 라이브 DB·미디어·에셋 파일은 번들에 포함하지 않는다.
    """
    if os.environ.get(SNAPSHOT_EXPORT_ENV, "").strip() != "1":
        raise HTTPException(status_code=404, detail="테스트 스냅샷 내보내기가 비활성화돼 있습니다")
    claimed_token = _claim_snapshot_download(request)
    archive: Path | None = None
    try:
        archive = create_test_snapshot_archive(DATA_DIR)
        response = FileResponse(
            archive,
            filename="MV-hub-test-dbs.zip",
            media_type="application/zip",
            background=BackgroundTask(lambda: archive.unlink(missing_ok=True)),
        )
    except TestSnapshotError as exc:
        _finish_snapshot_download(claimed_token, consumed=False)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except BaseException:
        if archive is not None:
            archive.unlink(missing_ok=True)
        _finish_snapshot_download(claimed_token, consumed=False)
        raise
    try:
        _finish_snapshot_download(claimed_token, consumed=True)
    except BaseException:
        archive.unlink(missing_ok=True)
        raise
    return response


@router.post("/import")
async def import_db(request: Request, file: UploadFile = File(...)):
    """업로드한 .db 로 내 로컬 DB 를 통째 교체(병합 아님). 현재 DB는 .bak 으로 자동 백업.
    가져온 DB는 현재 스키마로 마이그레이션하고 신원 캐시를 리셋한다.
    AUTH on(공유 서버)에선 admin 만 — 임의 DB 로 서버를 덮어쓰는 행위 차단. AUTH off(로컬)면 통과."""
    require_admin(request)
    _require_local_when_open(request)
    try:
        upload_limits.validate_upload_batch(
            [file],
            max_files=1,
            max_file_bytes=upload_limits.DB_UPLOAD_FILE_MAX_BYTES,
            max_total_bytes=upload_limits.DB_UPLOAD_FILE_MAX_BYTES,
        )
    except upload_limits.UploadLimitExceeded as exc:
        raise HTTPException(
            status_code=413,
            detail=(
                "가져올 DB가 너무 큽니다"
                f"(최대 {upload_limits.format_byte_limit(upload_limits.DB_UPLOAD_FILE_MAX_BYTES)})"
            ),
            headers=upload_limits.limit_headers(upload_limits.DB_UPLOAD_FILE_MAX_BYTES),
        ) from exc

    # 첫 await 전에 접수 계정을 확정한다. 경로/포인터만 읽고 DB 연결은 열지 않는다.
    account = getattr(getattr(request, "state", None), "account", None) or {}
    expected = _capture_restore_target_nowait(agent_email=norm_email(account.get("email")))
    expected = await to_thread_non_abandon(_complete_restore_target, expected)
    # 전체 파일을 bytes로 복제하지 않고 1MiB씩 임시파일로 옮긴 뒤 검증한다. 난수 이름으로
    # 동시 가져오기 충돌을 막고, 성공·실패 어느 경로에서도 finally로 정리한다.
    tmp = Path(tempfile.gettempdir()) / f"mvhub-import-{secrets.token_hex(8)}.db"
    try:
        try:
            await file.seek(0)
            with tmp.open("xb") as target:
                # 복사도 non-abandon — 취소 시 스레드가 아직 tmp 핸들을 쥐고 있으면 finally 의
                # unlink 가 실패해 최대 512MiB 임시파일이 %TEMP% 에 남는다.
                await to_thread_non_abandon(
                    upload_limits.copy_stream_limited,
                    file.file,
                    target,
                    max_bytes=upload_limits.DB_UPLOAD_FILE_MAX_BYTES,
                )
            # 검증(integrity 스캔)도 스레드로(R7 2-B) — DB 크기에 비례하는 동기 작업이
            # async 라우트의 이벤트 루프를 막았다. non-abandon(코덱스 P1) — 취소 시
            # finally 의 tmp 삭제가 검증 스레드보다 먼저 돌면 안 된다.
            await to_thread_non_abandon(validate_hub_db, tmp)
        except HubDbValidationError as exc:
            _raise_validation_error(exc)
        except upload_limits.UploadLimitExceeded as exc:
            raise HTTPException(
                status_code=413,
                detail=(
                    "가져올 DB가 너무 큽니다"
                    f"(최대 {upload_limits.format_byte_limit(upload_limits.DB_UPLOAD_FILE_MAX_BYTES)})"
                ),
                headers=upload_limits.limit_headers(upload_limits.DB_UPLOAD_FILE_MAX_BYTES),
            ) from exc
        except OSError as exc:
            raise HTTPException(
                status_code=507,
                detail=f"DB 가져오기 임시파일을 저장할 수 없습니다: {exc}",
            ) from exc

        # 검증 통과 → 현재 활성 DB 로 통째 교체 + 보안 리셋(import/복원 공용 헬퍼).
        # 교체 전체(백업 복사·WAL checkpoint·파일 교체·마이그레이션·drain 대기)를
        # 스레드로(R7 2-B) — 대형 DB 가져오기 중 다른 HTTP/WS 가 정지하지 않는다.
        # non-abandon(코덱스 P1): 취소돼도 설치 스레드 완료까지 기다린 뒤 취소를 올린다
        # (finally 의 tmp 삭제가 설치 도중의 원본을 지우지 않게).
        return await to_thread_non_abandon(_install_db, tmp, expected=expected)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass  # 원래 검증/설치 결과를 임시파일 정리 오류가 덮지 않게 한다.


# ── 서버 계정별 백업/복원 (로컬 허브 → 공유 서버) ──────────────────────────────
# 기존 '파일 다운로드→재업로드' 를 대체: 내 계정 DB 를 서버에 올리고(server-backup),
# 로그인해서 내려받아 그대로 작업(server-restore). 계정별 격리·관리는 서버가 세션 신원으로 강제.


def _legacy_server_backup(source: Path, *, server_url: str, token: str) -> tuple[int, object]:
    """세트 API가 없는 구버전 서버를 위한 콘텐츠 DB 1개 호환 업로드."""
    tmp = Path(tempfile.gettempdir()) / f"mvhub-srvbak-{secrets.token_hex(8)}.db"
    try:
        shutil.copyfile(source, tmp)
        _strip_session(tmp)
        # 정제 함수는 구형 DB 호환 때문에 SQLite 오류를 삼킨다 — 실제로 지워졌는지 확인하지 않으면
        # 미정제 DB(세션 토큰·auth_secret)가 그대로 서버로 올라간다. 실패면 업로드 중단.
        _verify_secrets_removed(tmp)
        validate_hub_db(tmp, require_integrity=True)
        return _multipart_upload(
            f"{server_url}/api/db-backup", token, tmp
        )
    finally:
        tmp.unlink(missing_ok=True)


def _capture_backup_admission() -> tuple[tuple[str, str | None], str, str]:
    """계정과 연결 쌍을 한 번만 읽는다. async 호출자는 워커 스레드에서 실행한다."""
    with active_account.transition_lock:
        return active_account.capture_account_pin(), _proxy.base_url(), _proxy.token()


@router.post("/server-backup")
async def server_backup(request: Request):
    """검증된 content·trash 세트를 outbox에 넣고 공유 서버 전송을 즉시 한 번 시도한다."""
    require_admin(request)  # AUTH off 로컬이면 통과(서버 직결 admin 가드는 유지)
    _require_local_when_open(request)
    if not _proxy.proxying():
        raise HTTPException(status_code=400, detail="공유 서버에 로그인된 로컬 허브에서만 가능합니다")

    pin, server_url, token = await asyncio.to_thread(_capture_backup_admission)
    with active_account.pinned_account_scope(pin):
        try:
            path = await asyncio.to_thread(backup_now)
            if path is None:
                raise HTTPException(status_code=404, detail="로컬 DB가 아직 없습니다")
            local_manifest = await asyncio.to_thread(backup_manifest.read_local, path, allow_v3=True)
            requested_version = local_manifest.get('format_version') if local_manifest is not None else None
            backup_set_id = await asyncio.to_thread(queue_backup_set, path, account_email=pin[0] or None)
            if not backup_set_id:
                raise HTTPException(
                    status_code=409,
                    detail="아직 서버에 백업할 개인 작업 데이터가 없습니다",
                )
            await asyncio.to_thread(retry_pending, account_email=pin[0] or None)
            result = await periodic_worker_backup.run_now(
                expected_account_key=account_key_digest(active_account.slug(pin[0])),
                expected_backup_set_id=backup_set_id,
            )
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 — 원문 경로·DB 내용은 브라우저로 보내지 않는다.
            raise HTTPException(status_code=500, detail="백업 세트를 준비하지 못했습니다") from exc

        if result.get("state") == "success":
            return {
                "ok": True,
                "state": "success",
                "count": int(result.get("server_count") or 0),
                "legacy_content_saved": False,
            }
        if result.get("state") == "idle":
            return {
                "ok": True,
                "state": "unchanged",
                "count": 0,
                "legacy_content_saved": False,
            }
        drained_version = result.get('format_version')
        if (result.get("state") == "server_update_required"
                and type(requested_version) is int and requested_version in {1, 2}
                and type(drained_version) is int and drained_version in {1, 2}):
            status, body = await asyncio.to_thread(
                _legacy_server_backup, path, server_url=server_url, token=token,
            )
            legacy_count = int(body.get("count") or 0) if isinstance(body, dict) else 0
            return {
                "ok": False,
                "state": "server_update_required",
                "count": legacy_count,
                "legacy_content_saved": status == 200,
            }
        return {
            "ok": False,
            "state": str(result.get("state") or "failed"),
            "error_code": str(result.get("error_code") or "delivery_failed"),
            "count": 0,
            "legacy_content_saved": False,
        }


@router.get("/backup-continuity")
def backup_continuity(request: Request):
    """작업자 설정 화면용 로컬·공유 서버 백업 상태(경로·이메일 제외)."""
    _require_local_when_open(request)
    local = list_backups_info()
    latest = local[0] if local else None
    return {
        "local": {
            "set_count": len(local),
            "latest_created_at": latest.get("mtime") if latest else None,
            "latest_file_count": len(latest.get("files") or []) if latest else 0,
            "retention": retention_status(),
        },
        "shared": worker_backup_status(),
    }


_POLICY_ERROR_MESSAGES = {
    "invalid_policy": "고를 수 없는 값입니다",
    "version_conflict": "다른 창에서 보관 설정이 바뀌었습니다 — 다시 읽었습니다",
    "confirm_required": "지울 백업이 있어 확인이 필요합니다",
    "clock_skew": "컴퓨터 시계가 맞지 않아 지금은 남기는 양을 줄일 수 없습니다",
    "local_hub_only": "공유 서버에서는 보관 양을 바꾸지 않습니다",
}


def _policy_http_error(exc: BackupPolicyError) -> HTTPException:
    # message 가 있으면 프런트 HttpError.info 로 code·preview 가 구조째 간다(lib/http.ts responseErrorDetail).
    return HTTPException(exc.status, {"code": exc.code, "message": _POLICY_ERROR_MESSAGES.get(exc.code, exc.code),
                                      "preview": exc.preview})


@router.get("/backup-policy")
def get_backup_policy(request: Request):
    """로컬 백업 보관 정책(허브·계정별) — 자료 관리 칸의 고르는 칸. AUTH(공유 서버)면 403."""
    require_admin(request)
    _require_local_when_open(request)
    try:
        return policy_view()
    except BackupPolicyError as exc:
        raise _policy_http_error(exc) from None


@router.put("/backup-policy")
async def put_backup_policy(request: Request):
    """정책 바꾸기. 지울 세트가 생기면 미리보기의 confirm_token 을 같이 보내야 저장·회전한다."""
    require_admin(request)
    _require_local_when_open(request)
    try:
        body = await request.json()
    except ValueError:
        raise _policy_http_error(BackupPolicyError("invalid_policy", 422)) from None
    if not isinstance(body, dict) or type(body.get("version")) is not int:
        raise _policy_http_error(BackupPolicyError("invalid_policy", 422))
    token = body.get("confirm_token")
    try:
        return await to_thread_non_abandon(
            update_policy,
            {key: body.get(key) for key in POLICY_CHOICES},
            version=body["version"],
            dry_run=body.get("dry_run") is True,
            confirm_token=token if isinstance(token, str) else None,
        )
    except BackupPolicyError as exc:
        raise _policy_http_error(exc) from None


@router.post("/backup-retry")
async def retry_server_backup(request: Request):
    """백오프 중인 활성 계정 백업을 사용자가 즉시 다시 시도한다."""
    require_admin(request)
    _require_local_when_open(request)
    pin = await asyncio.to_thread(active_account.capture_account_pin)
    with active_account.pinned_account_scope(pin):
        await asyncio.to_thread(retry_pending, account_email=pin[0] or None)
        result = await periodic_worker_backup.run_now(
            expected_account_key=account_key_digest(active_account.slug(pin[0])) if pin[0] else None,
        )
    return {"ok": result.get("state") in {"idle", "success"}, **result}


@router.get("/server-backups")
def server_backups(request: Request):
    """서버에 있는 내 계정 백업 버전 목록(없거나 미로그인이면 빈 목록)."""
    _require_local_when_open(request)
    if not _proxy.proxying():
        return {"backups": []}
    with active_account.transition_lock:
        server_url, token = _proxy.base_url(), _proxy.token()
    status, body = _proxy.raw_request("GET", f"{server_url}/api/db-backup", token=token)
    if status == 200 and isinstance(body, dict):
        return body
    if status == 401:
        raise HTTPException(status_code=401, detail="공유 서버 로그인이 만료되었습니다")
    raise HTTPException(
        status_code=502,
        detail=f"공유 서버 백업 목록을 확인하지 못했습니다(status={status})",
    )


@router.post("/server-restore/{backup_set_id}")
def server_restore_version(backup_set_id: str, request: Request):
    """사용자가 선택한 서버 버전만 검증·복원하고 이후 백업의 기준점으로 채택한다."""
    require_admin(request)
    _require_local_when_open(request)
    if not _BACKUP_SET_ID_RE.fullmatch(backup_set_id):
        raise HTTPException(status_code=400, detail="백업 식별자가 올바르지 않습니다")
    if not _proxy.proxying():
        raise HTTPException(status_code=400, detail="공유 서버에 로그인된 로컬 허브에서만 가능합니다")

    with active_account.transition_lock:
        expected = _capture_restore_target(full=True)
        account_email = active_account.account_key()
        server_url = _proxy.base_url()
        token = _proxy.token()
    archive = Path(tempfile.gettempdir()) / f"mvhub-srvrestore-{secrets.token_hex(8)}.zip"
    status = _download_to(
        f"{server_url}/api/db-backup/sets/{backup_set_id}", token, archive
    )
    if status == 404:
        archive.unlink(missing_ok=True)
        raise HTTPException(status_code=404, detail="선택한 서버 백업을 찾을 수 없습니다")
    if status != 200:
        archive.unlink(missing_ok=True)
        raise HTTPException(
            status_code=502,
            detail=f"선택한 서버 백업을 받지 못했습니다(status={status})",
        )
    try:
        with tempfile.TemporaryDirectory(prefix="mvhub-restore-set-") as temp_dir:
            result = _install_backup_set(_extract_backup_set(archive, Path(temp_dir)), expected,
                                         backup_set_id=backup_set_id)
    finally:
        archive.unlink(missing_ok=True)

    continuity_updated = False
    if account_email:
        try:
            adopt_restored_backup(backup_set_id, account_email=account_email)
            continuity_updated = True
        except (OSError, sqlite3.Error, ValueError):
            continuity_updated = False
    activation_synced = False
    try:
        activate_status, _body = _proxy.raw_request(
            "POST",
            f"{server_url}/api/db-backup/sets/{backup_set_id}/activate",
            token=token,
        )
        activation_synced = 200 <= activate_status < 300
    except (OSError, urllib.error.URLError, TimeoutError):
        activation_synced = False
    return {
        **result,
        "backup_set_id": backup_set_id,
        "continuity_updated": continuity_updated,
        "activation_synced": activation_synced,
    }


@router.post("/server-restore")
def server_restore(request: Request):
    """서버에 백업해둔 내 계정 DB 를 내려받아 활성 계정 DB 로 통째 교체. 복원 후 재로그인 강제."""
    require_admin(request)
    _require_local_when_open(request)
    if not _proxy.proxying():
        raise HTTPException(status_code=400, detail="공유 서버에 로그인된 로컬 허브에서만 가능합니다")
    with active_account.transition_lock:
        expected = _capture_restore_target(full=True)
        server_url = _proxy.base_url()
        token = _proxy.token()
    archive = Path(tempfile.gettempdir()) / f"mvhub-srvrestore-{secrets.token_hex(8)}.zip"
    status = _download_to(
        f"{server_url}/api/db-backup/latest-set", token, archive
    )
    if status == 200:
        try:
            with tempfile.TemporaryDirectory(prefix="mvhub-restore-set-") as temp_dir:
                return _install_backup_set(_extract_backup_set(archive, Path(temp_dir)), expected)
        finally:
            archive.unlink(missing_ok=True)
    archive.unlink(missing_ok=True)
    if status not in {404, 405}:
        raise HTTPException(
            status_code=502,
            detail=f"서버에서 백업 세트를 받지 못했습니다(status={status})",
        )
    # 혼합 버전 호환: 새 세트 API가 없거나 아직 세트가 없으면 기존 콘텐츠 단일 백업을 사용한다.
    tmp = Path(tempfile.gettempdir()) / f"mvhub-srvrestore-{secrets.token_hex(8)}.db"
    try:
        status = _download_to(f"{server_url}/api/db-backup/latest", token, tmp)
        if status == 404:
            raise HTTPException(status_code=404, detail="이 계정의 서버 백업이 없습니다")
        if status != 200:
            raise HTTPException(status_code=502, detail=f"서버에서 백업을 받지 못했습니다(status={status})")
        # 받은 파일 검증(SQLite + generation 테이블 + 무결성)
        try:
            validate_hub_db(tmp, require_integrity=True)
        except HubDbValidationError as exc:
            _raise_validation_error(exc, downloaded=True)
        return _install_db(tmp, expected=expected)
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)


# (구) /migrate-from-server 제거 — '서버 직결 시절' 서버에만 남은 개인 메타를 로컬로 1회 끌어오던
# 이행용 엔드포인트. 로컬 우선 전환 + 전체 DB 초기화로 더는 가져올 레거시 메타가 없어 폐기.
# 교차 PC/복원은 서버 계정별 백업(server-backup/server-restore)이 정식 경로다.
