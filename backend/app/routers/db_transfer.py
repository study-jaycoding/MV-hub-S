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
import os
import re
import secrets
import shutil
import sqlite3
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from . import _proxy
from .. import active_account, db, repo
from ..config import AUTH_ENABLED, DATA_DIR
from ..deps import require_admin
from ..repo import identity
from ..services.db_scrub import SESSION_KEYS as _SESSION_KEYS
from ..services.db_scrub import strip_transfer_secrets as _strip_session
from ..services.request_guards import require_loopback_request
from ..services.sqlite_db import HubDbValidationError, hub_db_validation_detail, validate_hub_db
from ..services import upload_limits
from ..services.backup import backup_now, list_backups_info
from ..services.worker_backup import (
    adopt_restored_backup,
    periodic_worker_backup,
    queue_backup_set,
    retry_pending,
    status_snapshot as worker_backup_status,
)
from ..services.test_snapshot import (
    SNAPSHOT_EXPORT_ENV,
    SNAPSHOT_TOKEN_ENV,
    SNAPSHOT_TOKEN_HEADER,
    TestSnapshotError,
    create_test_snapshot_archive,
)

router = APIRouter(prefix="/api/db", tags=["db-transfer"])
_BACKUP_SET_ID_RE = re.compile(r"[0-9a-f]{64}")

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


def _install_db(
    tmp: Path,
    *,
    trash_tmp: Path | None = None,
    restore_trash_set: bool = False,
) -> dict:
    """검증 끝난 DB를 현재 활성 DB로 교체하고 재로그인을 강제한다.

    서버의 새 세트 복원은 ``restore_trash_set=True``로 content·trash를 같은 유지보수 게이트에서
    바꾼다. 두 번째 파일 교체가 실패하면 첫 파일도 기존 자동 보관본으로 되돌린다.
    """
    path = db.get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    trash_path = path.parent / "content_hub_trash.db"
    staged = path.with_name(f".{path.name}.restore-{secrets.token_hex(8)}.tmp")
    staged_trash = trash_path.with_name(
        f".{trash_path.name}.restore-{secrets.token_hex(8)}.tmp"
    )
    originals: list[tuple[Path, Path | None, bool]] = []
    try:
        with db.maintenance_gate():
            # 게이트가 새 요청을 막고 기존 컨텍스트가 모두 끝난 뒤라, 여기서만 전 스레드 풀을
            # 닫아도 진행 중 요청의 커넥션을 끊지 않는다. 이 뒤 게이트 해제 전에는 옛 파일을
            # 다시 여는 요청도 없다.
            db.flush_pool()
            targets = [path]
            if restore_trash_set:
                targets.append(trash_path)
            for current in targets:
                existed = current.is_file()
                backup_copy: Path | None = None
                if not existed:
                    originals.append((current, None, False))
                    continue
                try:
                    conn = sqlite3.connect(str(current))
                    try:
                        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
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
                    f"{current.stem}.bak-{int(time.time())}-{secrets.token_hex(4)}.db"
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
            # checkpoint 뒤 모든 SQLite 핸들이 닫힌 상태에서만 sidecar 를 지운다. Windows 는 열린
            # -wal/-shm 을 unlink 하지 못하므로 파일 교체보다 먼저 이 순서를 지켜야 한다.
            for current in targets:
                for suf in ("-wal", "-shm"):
                    Path(str(current) + suf).unlink(missing_ok=True)
            try:
                os.replace(staged, path)
                if restore_trash_set:
                    if trash_tmp is None:
                        trash_path.unlink(missing_ok=True)
                    else:
                        os.replace(staged_trash, trash_path)
                db.init_db()
            except BaseException as original_error:
                # init_db가 풀 핸들을 만들었을 수 있으므로 원본 되돌리기 전에 다시 모두 닫는다.
                db.flush_pool()
                try:
                    for current, backup_copy, existed in originals:
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
                except Exception as rollback_error:  # noqa: BLE001
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
    except db.DatabaseMaintenanceTimeout as exc:
        raise HTTPException(
            status_code=503,
            detail="다른 DB 요청이 진행 중이라 복원을 잠시 뒤에 다시 시도하세요",
        ) from exc
    finally:
        with contextlib.suppress(OSError):
            staged.unlink(missing_ok=True)
        with contextlib.suppress(OSError):
            staged_trash.unlink(missing_ok=True)
    identity._MY_UID_CACHE[0] = None
    # FTS 존재 여부도 새 DB 기준으로 재확인(경로 동일이라 자동 재검출 안 됨 → 명시 리셋).
    from ..repo import generations as _gens

    _gens._FTS_READY = None
    _gens._FTS_READY_PATH = None
    # 활성 계정 포인터 해제 — 가져온 DB 의 실제 소유자를 신뢰할 수 없으므로(다른 계정 export 본일 수
    # 있음), 옛 계정으로 '로그인된 것처럼' 그 데이터를 보는 교차계정 오염을 막는다. 재로그인이 올바른
    # 계정→DB 매핑을 다시 세운다(_switch_account_db). 공유 서버(AUTH on)는 active.json 미사용이라 무관.
    if not AUTH_ENABLED:
        try:
            from ..active_account import clear_active

            clear_active()
        except Exception:  # noqa: BLE001
            pass
    # 보안: 가져온 DB 의 세션·서명키 제거 → 재로그인 강제(proxying()=False).
    for k in _SESSION_KEYS:
        try:
            repo.set_setting(k, None)
        except Exception:  # noqa: BLE001
            pass
    try:
        repo.set_setting("auth_secret", secrets.token_hex(32))
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "relogin_required": True}


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
        with urllib.request.urlopen(req, timeout=180) as r:
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
        with urllib.request.urlopen(req, timeout=180) as r:
            with open(dst, "wb") as f:
                shutil.copyfileobj(r, f)
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise HTTPException(status_code=502, detail=f"공유 서버 연결 실패: {e}")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _extract_backup_set(archive: Path, destination: Path) -> tuple[Path, Path | None]:
    """서버 ZIP의 역할·크기·해시·SQLite 무결성을 확인하고 안전한 고정 이름만 푼다."""
    destination.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive, "r") as bundle:
            infos = bundle.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)) or "manifest.json" not in names:
                raise ValueError("invalid archive entries")
            if not set(names) <= {"manifest.json", "content.db", "trash.db"}:
                raise ValueError("unexpected archive entry")
            manifest_info = bundle.getinfo("manifest.json")
            if manifest_info.file_size > 64 * 1024:
                raise ValueError("manifest too large")
            manifest = json.loads(bundle.read(manifest_info).decode("utf-8"))
            if (
                not isinstance(manifest, dict)
                or manifest.get("format") != "mvhub-worker-backup-set"
                or manifest.get("format_version") != 1
            ):
                raise ValueError("unsupported backup set")
            roles = manifest.get("roles")
            if not isinstance(roles, dict) or "content" not in roles or not set(roles) <= {
                "content",
                "trash",
            }:
                raise ValueError("invalid backup roles")
            if set(names) - {"manifest.json"} != {f"{role}.db" for role in roles}:
                raise ValueError("archive roles differ")
            extracted: dict[str, Path] = {}
            for role, expected in roles.items():
                if not isinstance(expected, dict):
                    raise ValueError("invalid role metadata")
                info = bundle.getinfo(f"{role}.db")
                expected_size = int(expected.get("size") or -1)
                if (
                    expected_size < 0
                    or expected_size > upload_limits.DB_UPLOAD_FILE_MAX_BYTES
                    or info.file_size != expected_size
                ):
                    raise ValueError("invalid role size")
                path = destination / f"{role}.db"
                with bundle.open(info, "r") as source, path.open("xb") as target:
                    actual_size = upload_limits.copy_stream_limited(
                        source,
                        target,
                        max_bytes=upload_limits.DB_UPLOAD_FILE_MAX_BYTES,
                    )
                digest = _file_sha256(path)
                if actual_size != expected_size or digest != expected.get("sha256"):
                    raise ValueError("role integrity mismatch")
                extracted[role] = path
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, upload_limits.UploadLimitExceeded) as exc:
        raise HTTPException(status_code=400, detail="서버 백업 세트가 손상되었거나 형식이 다릅니다") from exc

    validate_hub_db(extracted["content"], require_integrity=True)
    if "trash" in extracted:
        with contextlib.closing(sqlite3.connect(str(extracted["trash"]))) as conn:
            result = conn.execute("PRAGMA quick_check").fetchone()
            table = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='trashed'"
            ).fetchone()
            if not result or result[0] != "ok" or not table:
                raise HTTPException(status_code=400, detail="서버 휴지통 백업이 손상되었습니다")
    return extracted["content"], extracted.get("trash")


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

    # 전체 파일을 bytes로 복제하지 않고 1MiB씩 임시파일로 옮긴 뒤 검증한다. 난수 이름으로
    # 동시 가져오기 충돌을 막고, 성공·실패 어느 경로에서도 finally로 정리한다.
    tmp = Path(tempfile.gettempdir()) / f"mvhub-import-{secrets.token_hex(8)}.db"
    try:
        try:
            await file.seek(0)
            with tmp.open("xb") as target:
                await asyncio.to_thread(
                    upload_limits.copy_stream_limited,
                    file.file,
                    target,
                    max_bytes=upload_limits.DB_UPLOAD_FILE_MAX_BYTES,
                )
            validate_hub_db(tmp)
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
        return _install_db(tmp)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass  # 원래 검증/설치 결과를 임시파일 정리 오류가 덮지 않게 한다.


# ── 서버 계정별 백업/복원 (로컬 허브 → 공유 서버) ──────────────────────────────
# 기존 '파일 다운로드→재업로드' 를 대체: 내 계정 DB 를 서버에 올리고(server-backup),
# 로그인해서 내려받아 그대로 작업(server-restore). 계정별 격리·관리는 서버가 세션 신원으로 강제.


def _legacy_server_backup(source: Path) -> tuple[int, object]:
    """세트 API가 없는 구버전 서버를 위한 콘텐츠 DB 1개 호환 업로드."""
    tmp = Path(tempfile.gettempdir()) / f"mvhub-srvbak-{secrets.token_hex(8)}.db"
    try:
        shutil.copyfile(source, tmp)
        _strip_session(tmp)
        validate_hub_db(tmp, require_integrity=True)
        return _multipart_upload(
            f"{_proxy.base_url()}/api/db-backup", _proxy.token(), tmp
        )
    finally:
        tmp.unlink(missing_ok=True)


@router.post("/server-backup")
async def server_backup(request: Request):
    """검증된 content·trash 세트를 outbox에 넣고 공유 서버 전송을 즉시 한 번 시도한다."""
    require_admin(request)  # AUTH off 로컬이면 통과(서버 직결 admin 가드는 유지)
    _require_local_when_open(request)
    if not _proxy.proxying():
        raise HTTPException(status_code=400, detail="공유 서버에 로그인된 로컬 허브에서만 가능합니다")

    try:
        path = await asyncio.to_thread(backup_now)
        if path is None:
            raise HTTPException(status_code=404, detail="로컬 DB가 아직 없습니다")
        backup_set_id = await asyncio.to_thread(queue_backup_set, path)
        if not backup_set_id:
            raise HTTPException(
                status_code=409,
                detail="아직 서버에 백업할 개인 작업 데이터가 없습니다",
            )
        await asyncio.to_thread(retry_pending)
        result = await periodic_worker_backup.run_now()
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
    if result.get("state") == "server_update_required":
        status, body = await asyncio.to_thread(_legacy_server_backup, path)
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
        },
        "shared": worker_backup_status(),
    }


@router.post("/backup-retry")
async def retry_server_backup(request: Request):
    """백오프 중인 활성 계정 백업을 사용자가 즉시 다시 시도한다."""
    require_admin(request)
    _require_local_when_open(request)
    await asyncio.to_thread(retry_pending)
    result = await periodic_worker_backup.run_now()
    return {"ok": result.get("state") in {"idle", "success"}, **result}


@router.get("/server-backups")
def server_backups(request: Request):
    """서버에 있는 내 계정 백업 버전 목록(없거나 미로그인이면 빈 목록)."""
    _require_local_when_open(request)
    if not _proxy.proxying():
        return {"backups": []}
    status, body = _proxy.raw_request(
        "GET", f"{_proxy.base_url()}/api/db-backup", token=_proxy.token()
    )
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
            content, trash = _extract_backup_set(archive, Path(temp_dir))
            result = _install_db(content, trash_tmp=trash, restore_trash_set=True)
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
    archive = Path(tempfile.gettempdir()) / f"mvhub-srvrestore-{secrets.token_hex(8)}.zip"
    status = _download_to(
        f"{_proxy.base_url()}/api/db-backup/latest-set", _proxy.token(), archive
    )
    if status == 200:
        try:
            with tempfile.TemporaryDirectory(prefix="mvhub-restore-set-") as temp_dir:
                content, trash = _extract_backup_set(archive, Path(temp_dir))
                return _install_db(
                    content,
                    trash_tmp=trash,
                    restore_trash_set=True,
                )
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
    status = _download_to(f"{_proxy.base_url()}/api/db-backup/latest", _proxy.token(), tmp)
    if status == 404:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=404, detail="이 계정의 서버 백업이 없습니다")
    if status != 200:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=502, detail=f"서버에서 백업을 받지 못했습니다(status={status})")
    # 받은 파일 검증(SQLite + generation 테이블 + 무결성)
    try:
        validate_hub_db(tmp, require_integrity=True)
    except HubDbValidationError as exc:
        tmp.unlink(missing_ok=True)
        _raise_validation_error(exc, downloaded=True)
    return _install_db(tmp)


# (구) /migrate-from-server 제거 — '서버 직결 시절' 서버에만 남은 개인 메타를 로컬로 1회 끌어오던
# 이행용 엔드포인트. 로컬 우선 전환 + 전체 DB 초기화로 더는 가져올 레거시 메타가 없어 폐기.
# 교차 PC/복원은 서버 계정별 백업(server-backup/server-restore)이 정식 경로다.
