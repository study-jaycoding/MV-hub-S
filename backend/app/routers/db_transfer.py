"""내 메타데이터(로컬 DB) 내보내기/가져오기 — 교차 PC 작업 연속성(로컬 우선).

서버와 무관하게 이 허브의 로컬 SQLite 파일을 통째로 주고받는다. 다른 PC에서 내보낸 .db 를
이 PC에 '통째 교체'로 넣으면 내 라이브러리·태그·컬러·계보·코멘트가 그대로 이어진다.
(미디어는 힉스필드 공개 URL 이라 파일 전송 불필요.) 병합이 아니라 교체 — 현재 DB는 자동 백업.
"""

from __future__ import annotations

import json
import secrets
import shutil
import sqlite3
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from . import _proxy
from .. import db, repo
from ..config import AUTH_ENABLED
from ..deps import require_admin
from ..repo import identity

router = APIRouter(prefix="/api/db", tags=["db-transfer"])

_SQLITE_MAGIC = b"SQLite format 3"

# 업로드 전/복원 후 비울 세션·보안·신원 키. 가져온 DB 가 남의 토큰으로 서버에 proxy 하거나 위장
# 로그인되는 것을 막고, 남의 .db 를 파일 가져오기 했을 때 그 사람의 로그인 신원·역할(admin 뱃지)이
# 남지 않게 한다(서버 주소 shared_server_url 만 무해해 남긴다). ★email/name/roles 도 비운다 —
# 안 그러면 가져온 DB 주인이 admin 이었으면 가져온 사람 화면에 admin 탭이 (재로그인 전까지) 뜬다.
_SESSION_KEYS = (
    "shared_server_token",
    "shared_server_email",
    "shared_server_name",
    "shared_server_roles",
    "shared_server_elev_token",
    "shared_server_elev_email",
    "shared_server_elev_name",
    "auth_secret",
)


def _strip_session(db_path: Path) -> None:
    """주어진 .db 의 세션·보안 설정을 비운다(업로드 사본/복원 대상에 적용)."""
    c = sqlite3.connect(str(db_path))
    try:
        c.execute("BEGIN")
        for k in _SESSION_KEYS:
            c.execute("DELETE FROM app_setting WHERE key=?", (k,))
        c.execute("COMMIT")
    except sqlite3.DatabaseError:
        pass
    finally:
        c.close()


def _install_db(tmp: Path) -> dict:
    """검증 끝난 .db(tmp)를 현재 활성 DB 로 통째 교체 + 보안 리셋. import/복원 공용.
    현재 DB 는 .bak 으로 백업, 스키마 마이그레이션, 신원 캐시 리셋, 세션 키 제거 + auth_secret 재발급."""
    path = db.get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        try:
            with db.get_connection() as conn:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:  # noqa: BLE001
            pass
        bak = path.with_name(f"{path.stem}.bak-{int(time.time())}.db")
        try:
            shutil.copy2(path, bak)
        except Exception:  # noqa: BLE001
            pass
    for suf in ("-wal", "-shm"):
        Path(str(path) + suf).unlink(missing_ok=True)
    shutil.move(str(tmp), str(path))
    db.init_db()
    identity._MY_UID_CACHE[0] = None
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


def _multipart_upload(url: str, token: str | None, data: bytes) -> tuple[int, object]:
    """stdlib 멀티파트 업로드(파일 필드명 'file') — 새 의존성 0."""
    boundary = "----mvhub" + secrets.token_hex(8)
    body = (
        f"--{boundary}\r\n".encode()
        + b'Content-Disposition: form-data; name="file"; filename="backup.db"\r\n'
        + b"Content-Type: application/octet-stream\r\n\r\n"
        + data
        + f"\r\n--{boundary}--\r\n".encode()
    )
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
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


@router.get("/export")
def export_db(request: Request):
    """내 로컬 DB 를 단일 .db 파일로 내려준다(일관 스냅샷). 다른 PC에서 '가져오기'로 넣으면 됨.
    AUTH on(공유 서버)에선 admin 만 — 전체 DB(비밀번호 해시 포함) 유출 방지. AUTH off(로컬)면 통과."""
    require_admin(request)
    path = db.get_db_path()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="로컬 DB가 아직 없습니다")
    # sqlite backup API 로 임시파일에 일관 복사 — WAL 상태와 무관하게 완전한 스냅샷.
    tmp = Path(tempfile.gettempdir()) / f"mvhub-export-{int(time.time())}.db"
    src = sqlite3.connect(str(path))
    try:
        dst = sqlite3.connect(str(tmp))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return FileResponse(
        tmp,
        filename="MV-hub-mydb.db",
        media_type="application/octet-stream",
        background=BackgroundTask(lambda: tmp.unlink(missing_ok=True)),
    )


@router.post("/import")
async def import_db(request: Request, file: UploadFile = File(...)):
    """업로드한 .db 로 내 로컬 DB 를 통째 교체(병합 아님). 현재 DB는 .bak 으로 자동 백업.
    가져온 DB는 현재 스키마로 마이그레이션하고 신원 캐시를 리셋한다.
    AUTH on(공유 서버)에선 admin 만 — 임의 DB 로 서버를 덮어쓰는 행위 차단. AUTH off(로컬)면 통과."""
    require_admin(request)
    data = await file.read()
    if data[: len(_SQLITE_MAGIC)] != _SQLITE_MAGIC:
        raise HTTPException(status_code=400, detail="SQLite DB 파일이 아닙니다")
    # 임시파일에 받아 유효성(generation 테이블 존재) 검증.
    tmp = Path(tempfile.gettempdir()) / f"mvhub-import-{int(time.time())}.db"
    tmp.write_bytes(data)
    ok = None
    try:
        c = sqlite3.connect(str(tmp))
        try:
            ok = c.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation'"
            ).fetchone()
        finally:
            c.close()
    except sqlite3.DatabaseError:
        ok = None
    if not ok:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="허브 DB 형식이 아닙니다(generation 테이블 없음)")

    # 검증 통과 → 현재 활성 DB 로 통째 교체 + 보안 리셋(import/복원 공용 헬퍼).
    return _install_db(tmp)


# ── 서버 계정별 백업/복원 (로컬 허브 → 공유 서버) ──────────────────────────────
# 기존 '파일 다운로드→재업로드' 를 대체: 내 계정 DB 를 서버에 올리고(server-backup),
# 로그인해서 내려받아 그대로 작업(server-restore). 계정별 격리·관리는 서버가 세션 신원으로 강제.


@router.post("/server-backup")
def server_backup(request: Request):
    """내 활성 계정 DB 를 공유 서버에 백업. 일관 스냅샷 → 민감정보 제거 → 멀티파트 업로드."""
    require_admin(request)  # AUTH off 로컬이면 통과(서버 직결 admin 가드는 유지)
    if not _proxy.proxying():
        raise HTTPException(status_code=400, detail="공유 서버에 로그인된 로컬 허브에서만 가능합니다")
    path = db.get_db_path()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="로컬 DB가 아직 없습니다")
    tmp = Path(tempfile.gettempdir()) / f"mvhub-srvbak-{int(time.time())}.db"
    try:
        db._copy_sqlite(path, tmp)  # WAL 무관 일관 스냅샷
        _strip_session(tmp)  # 토큰·서명키 제거(서버엔 메타데이터만 올라감)
        status, body = _multipart_upload(
            f"{_proxy.base_url()}/api/db-backup", _proxy.token(), tmp.read_bytes()
        )
        if status != 200:
            raise HTTPException(status_code=502, detail=f"서버 백업 실패: {body}")
        return body  # {ok, name, size, count}
    finally:
        tmp.unlink(missing_ok=True)


@router.get("/server-backups")
def server_backups(request: Request):
    """서버에 있는 내 계정 백업 버전 목록(없거나 미로그인이면 빈 목록)."""
    if not _proxy.proxying():
        return {"backups": []}
    status, body = _proxy.raw_request(
        "GET", f"{_proxy.base_url()}/api/db-backup", token=_proxy.token()
    )
    return body if status == 200 and isinstance(body, dict) else {"backups": []}


@router.post("/server-restore")
def server_restore(request: Request):
    """서버에 백업해둔 내 계정 DB 를 내려받아 활성 계정 DB 로 통째 교체. 복원 후 재로그인 강제."""
    require_admin(request)
    if not _proxy.proxying():
        raise HTTPException(status_code=400, detail="공유 서버에 로그인된 로컬 허브에서만 가능합니다")
    tmp = Path(tempfile.gettempdir()) / f"mvhub-srvrestore-{int(time.time())}.db"
    status = _download_to(f"{_proxy.base_url()}/api/db-backup/latest", _proxy.token(), tmp)
    if status == 404:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=404, detail="이 계정의 서버 백업이 없습니다")
    if status != 200:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=502, detail=f"서버에서 백업을 받지 못했습니다(status={status})")
    # 받은 파일 검증(SQLite + generation 테이블)
    if tmp.read_bytes()[: len(_SQLITE_MAGIC)] != _SQLITE_MAGIC:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="받은 파일이 SQLite DB 가 아닙니다")
    ok = None
    integrity = None
    try:
        c = sqlite3.connect(str(tmp))
        try:
            ok = c.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation'"
            ).fetchone()
            # 라이브 DB 를 덮어쓰는 경로라 데이터 페이지 무결성까지 확인(다운로드 중 손상 방지).
            integrity = c.execute("PRAGMA quick_check").fetchone()
        finally:
            c.close()
    except sqlite3.DatabaseError:
        ok = None
    if not ok:
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="허브 DB 형식이 아닙니다(generation 테이블 없음)")
    if not integrity or integrity[0] != "ok":
        tmp.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="받은 백업이 손상되었습니다(무결성 검사 실패)")
    return _install_db(tmp)


# (구) /migrate-from-server 제거 — '서버 직결 시절' 서버에만 남은 개인 메타를 로컬로 1회 끌어오던
# 이행용 엔드포인트. 로컬 우선 전환 + 전체 DB 초기화로 더는 가져올 레거시 메타가 없어 폐기.
# 교차 PC/복원은 서버 계정별 백업(server-backup/server-restore)이 정식 경로다.
