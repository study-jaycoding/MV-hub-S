"""서버 백업 복사 위치 — 관리자 창 '공유 서버' 탭(2026-10-02 설계 r5, Codex 승인 · Jay 모의 화면 승인).

공유 서버가 매일 만드는 DB 백업을 다른 저장소(NAS)로 한 번 더 복사하는 예약 작업(`MVHub BackupCopy` →
`tools/backup_replicate.py`)의 **위치·결과**를 보이고 바꾼다. 위치의 원천은 지금처럼 `tools/backup_replica_target.txt`
하나(이사 도구·등록 bat·복사기가 모두 이 파일을 본다).

- 공유 서버: `GET /api/admin/backup-replica`(admin) · `PUT`(admin + **매번 비밀번호**) · `POST …/run`(admin).
  백업에는 계정 비밀번호 해시·세션 비밀이 들어 있어 위치를 바꾸는 것 = 반출 경로를 정하는 것 → 저장마다 재인증.
- 로컬 허브: `/api/shared-server/backup-replica[/run]` — 이 PC 브라우저 전용·계정 고정 후 공유 서버로 중계.
- 복사기 코드(검증·probe)는 서버 체크아웃의 tools 에만 있다 — 작업자 릴리스엔 tools 가 없으므로 **공유 서버 런타임
  확인 뒤에만** 지연 로드한다(모듈 맨 위 import 금지).
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Request
from pydantic import BaseModel

from .. import active_account, repo
from ..config import AUTH_ENABLED, BACKEND_DIR
from ..deps import account_actor_uid, require_admin
from ..services.async_tools import to_thread_non_abandon
from ..services.event_journal import journal_audit_event
from ..services.request_guards import require_loopback_browser_request
from . import _proxy
from .auth import _rl_fail, _rl_key, _rl_ok, _rl_release, _rl_reserve, _run_login_work

router = APIRouter(prefix="/api")

ROOT = BACKEND_DIR.parent
TOOL = ROOT / "tools" / "backup_replicate.py"
TASK_NAME = "MVHub BackupCopy"
PROBE_TIMEOUT = 20.0
_SYSTEM_PRINCIPALS = {"system", "nt authority\\system", "s-1-5-18"}

_SAVE_LOCK = threading.Lock()  # 저장·지금 복사 직렬화(같은 서버 프로세스 안)
_PROBE_STATE = threading.Lock()
_probe_proc: Optional[subprocess.Popen] = None

_PROBE_MESSAGES = {
    10: "NAS 주소 형식이 아닙니다 — \\\\서버\\공유폴더\\… 처럼 적어 주세요",
    11: "이 서버 PC 자신을 가리키는 주소입니다 — 다른 장비(NAS)를 지정하세요",
    12: "그 폴더에 MV Hub 백업이 아닌 파일이 있습니다 — 빈 하위 폴더를 지정하세요",
    13: "복사 위치가 원본 백업 폴더와 겹칩니다 — 다른 위치를 지정하세요",
    14: "그 위치에 쓸 수 없습니다 — NAS 에서 서버 PC 의 쓰기를 허용하세요",
    15: "그 위치를 열 수 없습니다 — 주소와 네트워크를 확인하세요",
}


def _shared_server_runtime() -> bool:
    no_proxy = os.environ.get("CONTENT_HUB_NO_PROXY", "").strip().lower()
    return AUTH_ENABLED and no_proxy not in {"1", "true", "yes", "on"}


@lru_cache(maxsize=1)
def _replicator() -> Any:
    """서버 체크아웃의 tools/backup_replicate.py — 공유 서버 런타임에서만 부른다."""
    if not TOOL.is_file():
        raise HTTPException(status_code=503, detail="서버에 tools 폴더가 없습니다 — 서버 PC 에서 update_git 을 실행하세요")
    spec = importlib.util.spec_from_file_location("mvhub_backup_replicate", TOOL)
    if spec is None or spec.loader is None:
        raise HTTPException(status_code=503, detail="백업 복사 도구를 읽지 못했습니다")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def _server_is_system() -> bool:
    """서버 프로세스가 LocalSystem(S-1-5-18)으로 도나 — 예약 작업(SYSTEM)과 같은 계정이어야 저장 때 확인이 실제와 같다."""
    try:
        out = subprocess.run(
            ["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True, timeout=10
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "S-1-5-18" in out


def _iso(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text or text.startswith(("0001", "1999")):  # 한 번도 안 돈 작업의 날짜
        return None
    return text


def _is_our_backup_action(raw: dict[str, Any]) -> bool:
    """register_autostart.bat 이 만든 그대로인가: 동작 하나 · cmd · `/c call "<이 설치>\\task_launch.bat" backup`.
    부분 문자열로 보면 `… server backup` 같은 다른 모드도 통과한다(task_launch 는 첫 인자를 모드로 쓴다, Codex P2)."""
    if raw.get("action_count") != 1:
        return False
    execute = Path(str(raw.get("execute") or "").strip().strip('"')).name.lower()
    if execute not in ("cmd", "cmd.exe"):
        return False
    expected = f'/c call "{ROOT / "task_launch.bat"}" backup'
    return " ".join(str(raw.get("arguments") or "").split()).casefold() == " ".join(expected.split()).casefold()


def _task_info() -> Optional[dict[str, Any]]:
    """예약 작업 상태. 조회 자체가 실패하면 None(호출자가 '모름' 으로 다룬다)."""
    script = (
        "$t = Get-ScheduledTask -TaskName '" + TASK_NAME + "' -ErrorAction SilentlyContinue; "
        "if (-not $t) { '{\"exists\":false}'; exit 0 }; "
        "$i = $t | Get-ScheduledTaskInfo; "
        "$a = @($t.Actions); "
        "[pscustomobject]@{ exists = $true; state = $t.State.ToString(); user = [string]$t.Principal.UserId; "
        "action_count = $a.Count; execute = [string]$a[0].Execute; arguments = [string]$a[0].Arguments; "
        "multi = $t.Settings.MultipleInstances.ToString(); "
        "last_run = $i.LastRunTime.ToUniversalTime().ToString('o'); last_result = $i.LastTaskResult; "
        "next_run = $(if ($i.NextRunTime) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { '' }) "
        "} | ConvertTo-Json -Compress"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=20,
        )
        raw = json.loads(out.stdout.strip() or "null")
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    if not raw.get("exists"):
        return {"exists": False, "enabled": False, "running": False, "matches_install": False,
                "ignore_new": False, "last_run_at": None, "last_result": None, "next_run_at": None,
                "system": False}
    state = str(raw.get("state") or "")
    return {
        "exists": True,
        "enabled": state != "Disabled",
        "running": state == "Running",
        "matches_install": _is_our_backup_action(raw),
        "ignore_new": raw.get("multi") == "IgnoreNew",
        "system": str(raw.get("user") or "").strip().lower() in _SYSTEM_PRINCIPALS,
        "last_run_at": _iso(raw.get("last_run")),
        "last_result": raw.get("last_result") if isinstance(raw.get("last_result"), int) else None,
        "next_run_at": _iso(raw.get("next_run")),
    }


def _lock_reason(env_target: Optional[str]) -> Optional[str]:
    if env_target:
        return "서버의 환경변수 CONTENT_HUB_BACKUP_REPLICA_DIR 로 정해져 있어 여기서 바꿀 수 없습니다"
    if os.environ.get("CONTENT_HUB_DATA", "").strip():
        return "비표준 데이터 경로(CONTENT_HUB_DATA)를 쓰는 서버라 여기서 바꾸지 않습니다 — 서버 PC 에서 직접 설정하세요"
    return None


def _result(mod: Any) -> dict[str, Any]:
    try:
        value = json.loads(Path(mod.STATUS_FILE).read_text("utf-8"))
        if not isinstance(value, dict) or value.get("format") != "mvhub-backup-replica-status":
            raise ValueError("invalid")
    except FileNotFoundError:
        value = {"state": "never_run"}
    except (OSError, ValueError, TypeError):
        value = {"state": "state_unavailable"}
    number = lambda key: int(value.get(key) or 0)  # noqa: E731
    return {
        "state": str(value.get("state") or "unknown")[:64],
        "error_code": (str(value.get("error_code") or "")[:64] or None),
        "target_id": value.get("target_id") if isinstance(value.get("target_id"), str) else None,
        "started_at": value.get("started_at"),
        "last_attempt_at": value.get("last_attempt_at"),
        "last_success_at": value.get("last_success_at"),
        "copied": number("copied"),
        "skipped": number("skipped"),
        "failed": number("failed"),
    }


def _snapshot(task: Optional[dict[str, Any]] = None, *, with_task: bool = True) -> dict[str, Any]:
    mod = _replicator()
    target, source = mod.configured_target()
    env_target = target if source == "env" else None
    task = task if task is not None or not with_task else _task_info()
    public_task = None if task is None else {k: v for k, v in task.items() if k != "system"}
    if public_task is not None and not task.get("system"):
        public_task["matches_install"] = False  # SYSTEM 이 아닌 작업은 이 설치의 정상 복사 작업이 아니다
    lock = _lock_reason(env_target)
    return {
        "applicable": True,
        "target": target,
        "target_id": mod.target_id(target) if target else None,
        "source": source,
        "editable": lock is None,
        "lock_reason": lock,
        "target_garbled": bool(target and "�" in target),
        "target_is_unc": bool(target and mod.unc_format_error(target) is None),
        "server_account_system": _server_is_system(),
        "task": public_task,
        "result": _result(mod),
    }


def _run_probe(target: str) -> int:
    """자식 프로세스로 그 위치를 검사·쓰기 시험한다(네트워크를 건드리는 일은 전부 자식 안). 20초 넘으면 끊는다.
    한 번에 하나 — 끊은 자식이 끝났음을 확인하기 전엔 슬롯을 돌려주지 않는다."""
    global _probe_proc
    with _PROBE_STATE:
        if _probe_proc is not None and _probe_proc.poll() is None:
            raise HTTPException(status_code=409, detail="앞선 위치 확인이 아직 끝나지 않았습니다 — 잠시 뒤 다시 시도하세요")
        proc = subprocess.Popen(
            [sys.executable, str(TOOL), "--probe", target],
            cwd=str(ROOT),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        _probe_proc = proc
    try:
        return proc.wait(timeout=PROBE_TIMEOUT)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass  # 끝난 것을 확인 못 했다 — 슬롯은 붙잡아 두고 다음 요청이 409 를 받는다
        raise HTTPException(status_code=400, detail="20초 안에 그 위치에 쓰지 못했습니다 — NAS 가 응답하는지 확인하세요")
    finally:
        with _PROBE_STATE:
            if _probe_proc is proc and proc.poll() is not None:
                _probe_proc = None


def stop_probe() -> None:
    """서버 종료 때 남은 위치 확인 자식을 끊는다(main 의 종료 처리에서 부른다)."""
    with _PROBE_STATE:
        proc = _probe_proc
    if proc is not None and proc.poll() is None:
        proc.kill()


def _write_target(mod: Any, target: str) -> None:
    path = Path(mod.TARGET_FILE)
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temp.write_bytes((target + "\n").encode("utf-8"))  # BOM·줄바꿈 변환 없음 — 복사기·이사 도구가 utf-8 로 읽는다
    os.replace(temp, path)


def _save_locked(target: str, expected_target_id: Optional[str], actor_uid: Optional[str]) -> dict[str, Any]:
    """저장 잠금 안: 재확인 → 의도 감사 → txt 원자 교체 → 결과 감사. 감사가 실패하면 바꾸지 않는다."""
    with _SAVE_LOCK:
        mod = _replicator()
        current, source = mod.configured_target()
        if _lock_reason(current if source == "env" else None):
            raise HTTPException(status_code=409, detail=_lock_reason(current if source == "env" else None))
        current_id = mod.target_id(current) if current else None
        if current_id != expected_target_id:
            raise HTTPException(status_code=409, detail="그 사이 다른 관리자가 위치를 바꿨습니다 — 창을 다시 열어 확인하세요")
        task = _task_info()
        if task is None:
            raise HTTPException(status_code=503, detail="예약 작업 상태를 읽지 못했습니다 — 잠시 뒤 다시 시도하세요")
        if task.get("running"):
            raise HTTPException(status_code=409, detail="지금 복사 중입니다 — 끝난 뒤 바꾸세요")
        new_id = mod.target_id(target)
        details = {"old": current, "new": target, "old_id": current_id, "new_id": new_id}
        audit = dict(actor_uid=actor_uid, target_type="server_setting", target_id="backup_replica_target",
                     fields=["target"], details=details)
        if not journal_audit_event("server.backup_replica_target_change_requested", **audit):
            raise HTTPException(status_code=503, detail="감사 기록에 실패해 바꾸지 않았습니다")
        try:
            _write_target(mod, target)
        except OSError:
            journal_audit_event("server.backup_replica_target_change_failed", **audit)
            raise HTTPException(status_code=500, detail="위치 파일을 쓰지 못했습니다")
        recorded = journal_audit_event("server.backup_replica_target_changed", **audit)
        snapshot = _snapshot(task)
        snapshot["audit_warning"] = None if recorded else "result_not_recorded"
        return snapshot


# ── 공유 서버 ──────────────────────────────────────────────────────────────────


@router.get("/admin/backup-replica")
def backup_replica_status(request: Request):
    require_admin(request)
    if not _shared_server_runtime():
        return {"applicable": False}
    return _snapshot()


class BackupReplicaSaveIn(BaseModel):
    target: str
    expected_target_id: Optional[str] = None
    password: str


def _parse_save(payload: Any) -> BackupReplicaSaveIn:
    """본문을 손으로 검사한다 — 모델을 라우트 인자로 받으면 형식 오류(422) 응답이 입력 본문(비밀번호)을 되돌려준다(Codex P2)."""
    if isinstance(payload, dict):
        target, expected, password = payload.get("target"), payload.get("expected_target_id"), payload.get("password")
        if isinstance(target, str) and isinstance(password, str) and (expected is None or isinstance(expected, str)):
            return BackupReplicaSaveIn(target=target, expected_target_id=expected, password=password)
    raise HTTPException(status_code=400, detail="요청 형식이 올바르지 않습니다")


@router.put("/admin/backup-replica")
async def save_backup_replica(request: Request, payload: Any = Body(None)):
    require_admin(request)
    body = _parse_save(payload)
    if not _shared_server_runtime():
        raise HTTPException(status_code=404, detail="공유 서버에서만 쓸 수 있습니다")
    mod = await asyncio.to_thread(_replicator)
    target = body.target.strip()
    code = mod.unc_format_error(target)
    if code is not None:
        raise HTTPException(status_code=400, detail=_PROBE_MESSAGES.get(code, _PROBE_MESSAGES[10]))
    account = getattr(request.state, "account", None) or {}
    email = str(account.get("email") or "")
    if not email:
        raise HTTPException(status_code=403, detail="로그인 계정이 필요합니다")
    # ① 비밀번호 — 로그인·10분 권한과 같은 실패 제한, 이벤트 루프 위에서. 틀려도 401 이 아니라 400(앱이 로그아웃하지 않게).
    key = _rl_key(request, email)
    _rl_reserve(key)
    try:
        verified = await _run_login_work(repo.authenticate, email, body.password)
        if not verified:
            _rl_fail(key)
            raise HTTPException(status_code=400, detail="현재 비밀번호가 올바르지 않습니다")
        if verified.get("status") != "approved" or "admin" not in (verified.get("global_roles") or []):
            raise HTTPException(status_code=403, detail="영구 Admin 역할이 있는 계정만 바꿀 수 있습니다")
        _rl_ok(key)
    finally:
        _rl_release(key)
    stamp = verified.get("password_changed_at")
    # ② 위치 확인(자식 프로세스, 20초)
    code = await asyncio.to_thread(_run_probe, target)
    if code != 0:
        raise HTTPException(status_code=400, detail=_PROBE_MESSAGES.get(code, f"위치 확인 실패(코드 {code})"))
    # ③ 확인하는 동안 권한·비밀번호가 바뀌지 않았나(PBKDF2 를 다시 돌리지 않고 계정 행으로)
    again = await asyncio.to_thread(repo.get_account, email)
    if (
        not again or again.get("status") != "approved" or "admin" not in (again.get("global_roles") or [])
        or again.get("password_changed_at") != stamp
    ):
        raise HTTPException(status_code=409, detail="확인하는 동안 권한이나 비밀번호가 바뀌었습니다 — 다시 시도하세요")
    # ④ 잠금 안 재확인·감사·교체
    return await to_thread_non_abandon(_save_locked, target, body.expected_target_id, account_actor_uid(request))


@router.post("/admin/backup-replica/run")
def run_backup_replica(request: Request):
    require_admin(request)
    if not _shared_server_runtime():
        raise HTTPException(status_code=404, detail="공유 서버에서만 쓸 수 있습니다")
    with _SAVE_LOCK:
        mod = _replicator()
        target, _source = mod.configured_target()
        if os.environ.get("CONTENT_HUB_DATA", "").strip():
            # 복사기는 기본 backend\data 를 본다 — 다른 데이터 폴더를 쓰는 서버에서 돌리면 엉뚱한 백업을 복사한다(Codex P2).
            raise HTTPException(status_code=409, detail="비표준 데이터 경로(CONTENT_HUB_DATA)를 쓰는 서버라 여기서 실행하지 않습니다")
        if not target:
            raise HTTPException(status_code=409, detail="복사 위치가 없습니다 — 먼저 위치를 저장하세요")
        task = _task_info()
        if task is None:
            raise HTTPException(status_code=503, detail="예약 작업 상태를 읽지 못했습니다 — 잠시 뒤 다시 시도하세요")
        if not task["exists"]:
            raise HTTPException(status_code=409, detail="예약 작업(MVHub BackupCopy)이 없습니다 — 서버 PC 에서 register_autostart.bat 을 실행하세요")
        if not task["enabled"]:
            raise HTTPException(status_code=409, detail="예약 작업이 꺼져 있습니다")
        if not task["system"] or not task["matches_install"] or not task["ignore_new"]:
            raise HTTPException(status_code=409, detail="예약 작업 설정이 이 서버 설치와 달라 실행하지 않았습니다 — 서버 PC 에서 다시 등록하세요")
        if task["running"]:
            raise HTTPException(status_code=409, detail="이미 복사 중입니다")
        requested_at = datetime.now(timezone.utc).isoformat()
        try:
            done = subprocess.run(["schtasks", "/Run", "/TN", TASK_NAME], capture_output=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            raise HTTPException(status_code=500, detail="예약 작업을 실행하지 못했습니다")
        if done.returncode != 0:
            raise HTTPException(status_code=500, detail="예약 작업을 실행하지 못했습니다")
        return {"requested_at": requested_at, "baseline_last_run_at": task["last_run_at"]}


# ── 로컬 허브 중계(이 PC 브라우저 전용 · 계정 고정) ────────────────────────────────


def _local_relay(request: Request) -> None:
    require_loopback_browser_request(request, "서버 백업 복사 설정은 이 PC 브라우저에서만 사용할 수 있습니다")
    if not _proxy.proxying():
        raise HTTPException(status_code=404, detail="공유 서버에 로그인한 로컬 허브에서만 쓸 수 있습니다")


@router.get("/shared-server/backup-replica")
def relay_backup_replica_status(request: Request):
    _local_relay(request)
    with active_account.pinned_account_scope():
        return _proxy.proxy_json("GET", "/api/admin/backup-replica", timeout=40)


@router.put("/shared-server/backup-replica")
def relay_save_backup_replica(request: Request, payload: Any = Body(None)):
    _local_relay(request)
    body = _parse_save(payload)
    with active_account.pinned_account_scope():
        return _proxy.proxy_json("PUT", "/api/admin/backup-replica", body=body.model_dump(), timeout=90)


@router.post("/shared-server/backup-replica/run")
def relay_run_backup_replica(request: Request):
    _local_relay(request)
    with active_account.pinned_account_scope():
        return _proxy.proxy_json("POST", "/api/admin/backup-replica/run", body={}, timeout=40)
