"""Resolve 검사·가져오기를 별도 프로세스에서 실행하는 부모 계층.

fusionscript(C 확장)는 Resolve 버전에 따라 호환되는 파이썬이 다르고, 비호환이면
예외 없이 프로세스가 즉시 죽을 수 있다(0xC0000005 — Resolve 21 + Python 3.14
실측). 그래서 ①fusionscript 를 쓰는 모든 작업을 자식 프로세스로 격리해 백엔드가
함께 죽지 않게 하고 ②내장 런타임이 실패하면 PC에 설치된 다른 64비트 Python으로
자동 재시도한 뒤 성공한 인터프리터를 기억한다.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from .resolve_bridge import resolve_process_running
from .resolve_import_worker import INSPECT_MODE, MODE_KEY
from .resolve_import_worker import RESULT_PREFIX as IMPORT_RESULT_PREFIX
from .resolve_probe import RESULT_PREFIX
from .resolve_python_registry import parse_python_version, registry_python_installations


_BACKEND_DIR = Path(__file__).resolve().parents[2]
_STATUS_TIMEOUT_SECONDS = max(
    1.0, float(os.environ.get("CONTENT_HUB_RESOLVE_STATUS_TIMEOUT_SECONDS", "8"))
)
# 실사 조회(읽기 전용)의 제한 시간. 가져오기와 달리 제한을 두는 이유는 아래 함수 주석에.
_INSPECT_TIMEOUT_SECONDS = max(
    1.0, float(os.environ.get("CONTENT_HUB_RESOLVE_INSPECT_TIMEOUT_SECONDS", "30"))
)
# 폴백 인터프리터가 우리 코드(resolve_bridge)를 실행할 수 있는 최소 버전.
# Resolve 메뉴 스크립트 하한(3.6)과는 다른 기준이다.
_FALLBACK_MIN_VERSION = (3, 9)
# 같은 검사가 짧은 간격으로 몰리면(상태 폴링 등) 직전 결과를 재사용해
# 인터프리터 선택 직렬화로 요청이 밀리는 것을 막는다.
_SELECT_REUSE_SECONDS = 1.0

_SELECT_LOCK = threading.Lock()
_IMPORT_LOCK = threading.Lock()
# 마지막으로 fusionscript 로드에 성공한 인터프리터 경로 (프로세스 수명 캐시).
_working_interpreter: str | None = None
# 직전 선택 결과: (monotonic 시각, 인터프리터, 검사 결과, 실패 설명)
_last_selection: tuple[float, str | None, dict[str, Any] | None, str] | None = None


def _unavailable(
    message: str, *, process_running: bool = True, status: str | None = None
) -> dict[str, Any]:
    return {
        "status": status or ("api_unavailable" if process_running else "not_running"),
        "connected": False,
        "process_running": process_running,
        "project_open": False,
        "project_id": "",
        "project_name": "",
        "resolve_version": "",
        "resolve_product": "",
        "message": message,
    }


def _no_interpreter_message(failure: str) -> str:
    return (
        "DaVinci Resolve 연결 부품(fusionscript)을 실행할 수 있는 Python을 찾지 못했습니다. "
        "64비트 Python(3.9 이상)을 '모든 사용자'용으로 설치한 뒤 다시 확인하세요. "
        f"(시도한 결과: {failure})"
    )


def _timeout_message() -> str:
    return (
        f"DaVinci Resolve가 {_STATUS_TIMEOUT_SECONDS:g}초 안에 응답하지 않았습니다. "
        "작업을 저장하고 Resolve를 다시 실행하세요"
    )


def _fallback_interpreters() -> list[str]:
    """내장 런타임이 fusionscript와 비호환일 때 시도할 시스템 Python 목록."""
    rows: list[tuple[bool, tuple[int, int], str]] = []
    for item in registry_python_installations():
        version = parse_python_version(str(item.get("version") or ""))
        if item.get("bits") != 64 or version is None or version < _FALLBACK_MIN_VERSION:
            continue
        rows.append((item.get("scope") != "all_users", version, str(item.get("path") or "")))
    # 모든 사용자 설치 우선, 같은 범위면 높은 버전 우선.
    rows.sort(key=lambda row: (row[0], (-row[1][0], -row[1][1]), row[2]))
    return [path for _current_user, _version, path in rows if path]


def _candidate_interpreters() -> list[str]:
    candidates = [sys.executable, *_fallback_interpreters()]
    unique: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = os.path.normcase(os.path.normpath(candidate))
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    cached = _working_interpreter
    if cached and cached in unique:
        unique.remove(cached)
        unique.insert(0, cached)
    return unique


def _run_child(
    interpreter: str, module: str, *, timeout: float | None, input_text: str | None = None
) -> subprocess.CompletedProcess[str]:
    # 레지스트리에 등록된 Python 만 실행하며 환경은 기존 probe 와 동일하게 상속한다.
    # 같은 Windows 사용자 계정 안이 신뢰 경계라 레지스트리 조작 방어는 하지 않는다.
    child_env = os.environ.copy()
    child_env["PYTHONIOENCODING"] = "utf-8"
    # 폴백 인터프리터가 앱 폴더에 다른 버전 바이트코드 캐시를 쌓지 않게 한다.
    child_env["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        [interpreter, "-m", module],
        cwd=_BACKEND_DIR,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        input=input_text,
        env=child_env,
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def _parse_result(stdout: str, prefix: str) -> dict[str, Any] | None:
    for line in reversed(stdout.splitlines()):
        if not line.startswith(prefix):
            continue
        try:
            result = json.loads(line.removeprefix(prefix))
        except json.JSONDecodeError:
            return None
        return result if isinstance(result, dict) else None
    return None


def _tail_text(value: str, limit: int = 2000) -> str:
    """오류 결과에 박아 넣는 자식 출력이 응답·manifest를 부풀리지 않게 꼬리만 남긴다."""
    text = value.strip()
    if len(text) <= limit:
        return text
    return "…" + text[-limit:]


def _failure_detail(completed: subprocess.CompletedProcess[str]) -> str:
    stderr_lines = [line for line in completed.stderr.strip().splitlines() if line.strip()]
    if stderr_lines:
        return stderr_lines[-1].strip()
    return f"검사 프로세스 종료 코드 {completed.returncode}"


def _probe_with(interpreter: str) -> tuple[dict[str, Any] | None, str]:
    """(검사 결과, 실패 설명). 결과가 None이면 이 인터프리터로는 연결이 불가능하다.

    시간 초과(TimeoutExpired)는 인터프리터 문제가 아니라 Resolve 응답 문제이므로
    잡지 않고 올려보내 호출자가 그대로 사용자에게 보고하게 한다. 비호환 크래시는
    1초 안팎으로 빨리 죽으므로, 8초 벽에 닿는 건 사실상 Resolve API 멈춤뿐이다
    (여기서 다음 후보로 회전하면 진짜 멈춤을 'Python 없음'으로 오진하게 된다).
    """
    try:
        completed = _run_child(
            interpreter, "app.services.resolve_probe", timeout=_STATUS_TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired:
        raise
    except (OSError, subprocess.SubprocessError) as exc:
        return None, f"{interpreter}: 실행 실패({exc})"
    result = _parse_result(completed.stdout, RESULT_PREFIX)
    if result is None:
        # fusionscript 비호환 크래시(0xC0000005 등)는 JSON 결과 없이 죽는다.
        return None, f"{interpreter}: {_failure_detail(completed)}"
    if result.get("status") == "python_incompatible":
        return None, f"{interpreter}: {result.get('message') or 'fusionscript 비호환'}"
    return result, ""


def _select_interpreter() -> tuple[str | None, dict[str, Any] | None, str]:
    """fusionscript 로드에 성공하는 인터프리터를 골라 (경로, 검사 결과, 실패 설명)을 반환한다."""
    global _working_interpreter, _last_selection
    failures: list[str] = []
    with _SELECT_LOCK:
        last = _last_selection
        if last is not None and time.monotonic() - last[0] < _SELECT_REUSE_SECONDS:
            _stamp, interpreter, result, failure = last
            # 호출자가 결과를 변형해도 캐시가 오염되지 않게 복사본을 준다.
            return interpreter, (dict(result) if result is not None else None), failure
        for candidate in _candidate_interpreters():
            result, failure = _probe_with(candidate)
            if result is not None:
                _working_interpreter = candidate
                result.setdefault("python_executable", candidate)
                _last_selection = (time.monotonic(), candidate, dict(result), "")
                return candidate, result, ""
            failures.append(failure)
            if candidate == _working_interpreter:
                _working_interpreter = None
        joined = "; ".join(failures)
        _last_selection = (time.monotonic(), None, None, joined)
    return None, None, joined


def resolve_connection_status_bounded() -> dict[str, Any]:
    """별도 검사 프로세스를 실행하고 제한 시간 초과 시 안전한 상태를 반환한다."""
    running = resolve_process_running()
    if running is False:
        return _unavailable(
            "DaVinci Resolve가 실행 중이지 않습니다", process_running=False
        )
    try:
        _interpreter, result, failure = _select_interpreter()
    except subprocess.TimeoutExpired:
        return _unavailable(_timeout_message())
    if result is not None:
        return result
    return _unavailable(_no_interpreter_message(failure), status="python_incompatible")


def _import_unavailable(message: str, *, error_code: str) -> dict[str, Any]:
    """부모 계층 실패도 error_code 를 반드시 싣는다(명세 §C 전달 경로)."""
    return {
        "status": "unavailable",
        "error_code": error_code,
        "project_name": "",
        "target_root": "",
        "total": 0,
        "imported": 0,
        "skipped": 0,
        "error_count": 0,
        "error": message,
        "items": [],
    }


def run_resolve_import_isolated(manifest: dict[str, Any]) -> dict[str, Any]:
    """가져오기를 호환 인터프리터의 자식 프로세스로 실행한다 (fusionscript 크래시 격리).

    가져오기 자체에는 시간 제한을 두지 않는다. 강제 종료가 Media Pool 재정렬
    (임시 Bin 이동·재생성) 도중을 끊으면 워커 안의 복구 코드가 실행되지 못해
    프로젝트 구조가 중간 상태로 남을 수 있기 때문이다. 이는 기존 in-process
    실행과 같은 동작이다. 인터프리터 선택 검사만 8초 제한을 갖는다.
    """
    with _IMPORT_LOCK:
        try:
            interpreter, _status, failure = _select_interpreter()
        except subprocess.TimeoutExpired:
            return _import_unavailable(_timeout_message(), error_code="api_unavailable")
        if interpreter is None:
            return _import_unavailable(
                _no_interpreter_message(failure), error_code="python_incompatible"
            )
        try:
            completed = _run_child(
                interpreter,
                "app.services.resolve_import_worker",
                timeout=None,
                input_text=json.dumps(manifest, ensure_ascii=True),
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return _import_unavailable(
                f"Resolve 가져오기 프로세스를 실행할 수 없습니다: {exc}",
                error_code="spawn_failed",
            )
        result = _parse_result(completed.stdout, IMPORT_RESULT_PREFIX)
        if result is None:
            detail = (
                _tail_text(completed.stderr)
                or f"가져오기 프로세스 종료 코드 {completed.returncode}"
            )
            # 자식이 결과 없이 죽었으면 부수효과 발생 여부를 알 수 없다 — 상위가
            # 자동 재실행하지 않도록 child_crashed 로 구분한다.
            return _import_unavailable(
                f"Resolve 가져오기 결과를 읽을 수 없습니다: {detail}",
                error_code="child_crashed" if completed.returncode else "invalid_child_result",
            )
        # 자식 결과는 브리지가 항상 error_code 를 실어 보낸다. 여기서 키를 덧붙이지 않는다
        # (부모가 결과를 그대로 전달한다는 기존 계약 유지).
        return result


def _inspect_unavailable(message: str, *, error_code: str) -> dict[str, Any]:
    return {
        "status": "unavailable",
        "error_code": error_code,
        "project_name": "",
        "bins": {},
        "error": message,
    }


def run_resolve_bin_inspection_isolated(manifest: dict[str, Any]) -> dict[str, Any]:
    """대상 Bin 실사 조회를 호환 인터프리터의 자식 프로세스로 실행한다(읽기 전용).

    ★가져오기와 달리 **시간 제한을 둔다.** 가져오기에 제한을 두지 않는 이유는 Media Pool
    재정렬 도중을 끊으면 프로젝트가 중간 구조로 남기 때문인데, 이 경로는 클립 목록을 읽기만
    해서 언제 끊겨도 남는 게 없다. 반대로 제한이 없으면 Resolve 모달 하나에 사용자의
    '다시 시도' 버튼이 영영 돌아오지 않는다. 시간 초과·실패는 모두 ``unavailable`` 이고,
    호출자는 기존 manifest 기반 판정으로 폴백한다(동작 저하 없음).
    """
    if resolve_process_running() is False:
        # Resolve 가 꺼져 있으면 자식을 띄울 이유가 없다(상태 조회와 같은 빠른 길).
        return _inspect_unavailable(
            "DaVinci Resolve가 실행 중이지 않습니다", error_code="not_running"
        )
    # ★가져오기와 같은 잠금을 쓰되 **기다리는 시간에 상한**을 둔다. 가져오기는 제한이
    # 없으므로 그냥 `with` 로 잡으면 다른 전송의 import 가 끝날 때까지 사용자의 '다시 시도'
    # 요청이 무한정 붙잡힌다. 못 잡으면 폴백이다(정확도만 잃고 기능은 그대로 동작한다).
    if not _IMPORT_LOCK.acquire(timeout=_INSPECT_TIMEOUT_SECONDS):
        return _inspect_unavailable(
            "다른 Resolve 작업이 진행 중이라 Bin 을 확인하지 못했습니다",
            error_code="api_unavailable",
        )
    try:
        try:
            interpreter, _status, failure = _select_interpreter()
        except subprocess.TimeoutExpired:
            return _inspect_unavailable(_timeout_message(), error_code="api_unavailable")
        if interpreter is None:
            return _inspect_unavailable(
                _no_interpreter_message(failure), error_code="python_incompatible"
            )
        try:
            completed = _run_child(
                interpreter,
                "app.services.resolve_import_worker",
                timeout=_INSPECT_TIMEOUT_SECONDS,
                input_text=json.dumps(
                    {MODE_KEY: INSPECT_MODE, "manifest": manifest}, ensure_ascii=True
                ),
            )
        except subprocess.TimeoutExpired:
            return _inspect_unavailable(
                f"Resolve Bin 확인이 {_INSPECT_TIMEOUT_SECONDS:g}초 안에 끝나지 않았습니다",
                error_code="api_unavailable",
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return _inspect_unavailable(
                f"Resolve Bin 확인 프로세스를 실행할 수 없습니다: {exc}",
                error_code="spawn_failed",
            )
        result = _parse_result(completed.stdout, IMPORT_RESULT_PREFIX)
        if result is None:
            detail = (
                _tail_text(completed.stderr)
                or f"Bin 확인 프로세스 종료 코드 {completed.returncode}"
            )
            return _inspect_unavailable(
                f"Resolve Bin 확인 결과를 읽을 수 없습니다: {detail}",
                error_code="invalid_child_result",
            )
        return result
    finally:
        _IMPORT_LOCK.release()
