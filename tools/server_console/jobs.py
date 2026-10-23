"""작업 실행기. 화면과 따로 도는 프로세스(job_main.py)가 작업 하나를 끝까지 실행하고 결과를 남긴다.

작업 폴더: <루트>\\logs\\console-jobs\\<작업 ID>\\{request.json, state.json, output.log}
- 상위 폴더는 처음 한 번 만들어 Administrators·SYSTEM 만 쓰게 하고, 이후엔 검증해서 재사용한다.
- 작업 ID 폴더는 매번 새로 만든다(이미 있으면 거절). 연결 지점(junction 등)은 따라가지 않는다.
- 결과를 잃었으면 성공·실패로 짐작하지 않고 'check_needed'.
"""
from __future__ import annotations

import ctypes
import json
import os
import re
import secrets
import subprocess
import time
from ctypes import wintypes
from pathlib import Path
from typing import Callable

from . import names
from .actions import Plan, Refusal, command_for, same_target
from .install import CODE_ROOT, Installation, Runner, acl_offenders, child_env, windows_dir

JOB_ID = re.compile(r"^[0-9a-f]{32}$")
STEP = re.compile(r"\[(\d)/6\]")
_REPARSE_POINT = 0x400
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000
STARTING_GRACE_SECONDS = 120


class JobError(RuntimeError):
    pass


def _is_reparse(path: Path) -> bool:
    return bool(getattr(os.lstat(path), "st_file_attributes", 0) & _REPARSE_POINT)


def jobs_root(inst: Installation) -> Path:
    return inst.logs / names.JOB_DIR


def _lock_down(path: Path, runner: Runner) -> bool:
    """소유자를 Administrators 로 두고, 상속을 끊어 Administrators·SYSTEM 만 남긴다."""
    icacls = windows_dir() / "System32" / "icacls.exe"
    code, _ = runner([str(icacls), str(path), "/setowner", "*S-1-5-32-544"], 30)
    if code != 0:
        return False
    code, _ = runner([str(icacls), str(path), "/inheritance:r", "/grant:r",
                      "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"], 30)
    return code == 0


def ensure_jobs_root(inst: Installation, runner: Runner, force: bool = False) -> Path:
    """작업 폴더를 관리자 전용으로 둔다. 권한이 흐트러져 있으면 관리자인 이 창이 다시 잠그고 진행한다
    (Jay 결정 2026-10-23: 권한 문제로 업데이트를 멈추지 않는다 — 잠그기 실패도 진행).
    force 는 목록을 못 읽은 뒤의 복구 — 남의 쓰기 권한이 없어도(관리자 읽기 권한이 빠진 경우) 한 번 잠근다."""
    if not inst.logs.is_dir() or _is_reparse(inst.logs):
        raise JobError("logs 폴더가 없거나 연결 지점입니다")
    root = jobs_root(inst)
    if root.exists():
        if _is_reparse(root) or not root.is_dir():
            raise JobError("작업 폴더가 연결 지점이거나 폴더가 아닙니다")
        if force or acl_offenders([root], [], runner) != []:
            _lock_down(root, runner)
        return root
    os.mkdir(root)
    _lock_down(root, runner)
    return root


def job_dir(inst: Installation, job_id: str) -> Path:
    if not JOB_ID.fullmatch(job_id or ""):
        raise JobError("작업 ID 형식이 아닙니다")
    return jobs_root(inst) / job_id


def write_json(path: Path, value: dict) -> None:
    temp = path.with_name(path.name + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(temp, path)


def read_json(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def new_job(inst: Installation, plan: Plan, runner: Runner) -> str:
    root = ensure_jobs_root(inst, runner)
    job_id = secrets.token_hex(16)
    job = root / job_id
    try:
        os.mkdir(job)
    except FileExistsError as exc:
        raise JobError("같은 작업 ID 폴더가 이미 있습니다") from exc
    if _is_reparse(job):
        raise JobError("작업 폴더가 연결 지점입니다")
    write_json(job / "request.json", {"kind": plan.kind, "plan": plan.to_json(), "requested_at": time.time()})
    return job_id


# ---- 프로세스 확인(PID 재사용 구분: 생성 시각까지 비교) ----

_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_STILL_ACTIVE = 259
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
# 핸들은 64비트라 기본(int) 반환형이면 잘린다.
_kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
_kernel32.OpenProcess.restype = wintypes.HANDLE
_kernel32.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
_kernel32.GetProcessTimes.restype = wintypes.BOOL
_kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
_kernel32.GetExitCodeProcess.restype = wintypes.BOOL
_kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)


def process_created(pid: int) -> int | None:
    kernel32 = _kernel32
    handle = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                        ctypes.byref(kernel), ctypes.byref(user)):
            return None
        return (created.dwHighDateTime << 32) | created.dwLowDateTime
    finally:
        kernel32.CloseHandle(handle)


def process_alive(pid: int, created: int | None) -> bool:
    if pid <= 0:
        return False
    kernel32 = _kernel32
    handle = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != _STILL_ACTIVE:
            return False
    finally:
        kernel32.CloseHandle(handle)
    return created is None or process_created(pid) == created


# ---- 실행기 쪽(job_main.py 가 부른다) ----

Work = Callable[[Path, Callable[[str], None]], "tuple[int, dict]"]


def run_job(inst: Installation, job_id: str, recompute: Callable[[], "Plan | Refusal"],
            command: list[str] | None = None, env: dict[str, str] | None = None,
            before: Callable[[], object] | None = None,
            observe: Callable[[object], dict] | None = None, work: Work | None = None) -> int:
    """확인한 대상과 지금 대상을 다시 비교한 뒤 실행하고 결과를 남긴다. command·env 는 시험용.

    before() 는 실행 직전 상태(이미 있던 준비 실행 목록)를 재고, observe(그 값)는 끝난 뒤 이 실행이 설치한
    커밋을 찾아 code_after 에 남긴다(status.prepare_runs·run_outcome). work 가 있으면 외부 명령 대신
    work(작업 폴더, 한 줄 출력)를 부르고 그 (종료 코드, 덧붙일 결과)를 남긴다(관리 도구 갱신 등).
    """
    job = job_dir(inst, job_id)
    request = read_json(job / "request.json")
    if request is None:
        raise JobError("작업 요청을 읽지 못했습니다")
    # code_root = 이 실행기가 도는 관리 창 코드(루트 또는 stage) — 쓰는 중인 stage 를 지우지 않게 남긴다.
    me = {"pid": os.getpid(), "created": process_created(os.getpid()), "code_root": str(CODE_ROOT)}
    write_json(job / "state.json", {"status": "checking", **me, "started_at": time.time()})
    confirmed = Plan.from_json(request["plan"])
    current = recompute()
    if isinstance(current, Refusal):
        write_json(job / "state.json", {"status": "refused", **me, "reasons": list(current.reasons),
                                         "finished_at": time.time()})
        return 2
    if not same_target(confirmed, current):
        write_json(job / "state.json", {"status": "refused", **me, "finished_at": time.time(),
                                         "reasons": ["확인한 대상과 실행 직전 대상이 다릅니다 — 다시 확인하세요"]})
        return 2
    if work is not None:
        return _run_work(job, me, work)
    argv = command or command_for(current, inst)
    try:
        prior = before() if before is not None else None
    except Exception:  # noqa: BLE001 — 못 쟀으면 결과를 잇지 않을 뿐(observe 가 None 으로 받는다)
        prior = None
    with (job / "output.log").open("ab") as output:
        child = subprocess.Popen(argv, stdout=output, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                 cwd=str(inst.root), env=env or child_env(inst), creationflags=CREATE_NO_WINDOW)
        write_json(job / "state.json", {"status": "running", **me, "child_pid": child.pid,
                                         "started_at": time.time()})
        code = child.wait()
    after: dict = {"linked": False} if code == 0 else {"linked": False, "reason": "failed"}
    # 실패한 실행은 준비 기록을 만들기 전에 끝났을 수 있다(예: 잠금 충돌) — 그 사이 다른 실행이 만든 기록을
    # 제 것으로 잇지 않게 성공했을 때만 잇는다.
    if observe is not None and code == 0:
        try:
            after = observe(prior)
        except Exception:  # noqa: BLE001 — 관찰 실패가 결과를 지우면 안 된다
            after = {"linked": False, "reason": "observe_failed"}
    write_json(job / "state.json", {"status": "finished", **me, "exit_code": code, "code_after": after,
                                    "result": "success" if code == 0 else "failed", "finished_at": time.time()})
    return code


def _run_work(job: Path, me: dict, work: Work) -> int:
    write_json(job / "state.json", {"status": "running", **me, "started_at": time.time()})
    with (job / "output.log").open("ab") as output:
        def say(line: str) -> None:
            output.write((time.strftime("[%H:%M:%S] ") + line + "\n").encode("utf-8"))
            output.flush()
        try:
            code, extra = work(job, say)
        except Exception as exc:  # noqa: BLE001 — 실패 이유를 결과에 남긴다(판정은 종료 코드)
            say(f"실패: {exc}")
            code, extra = 1, {"error": f"{type(exc).__name__}: {exc}"[:500]}
    write_json(job / "state.json", {"status": "finished", **me, "exit_code": code, **extra,
                                    "result": "success" if code == 0 else "failed", "finished_at": time.time()})
    return code


def spawn_detached(argv: list[str], cwd: str, env: dict[str, str]) -> int:
    """부모(화면)가 끝나거나 죽어도 계속 도는 프로세스."""
    child = subprocess.Popen(argv, cwd=cwd, env=env, close_fds=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
    return child.pid


def launch_runner(inst: Installation, job_id: str) -> int:
    """화면과 따로 도는 실행기를 띄운다(화면이 꺼져도 계속). 같은 관리자 권한."""
    job_dir(inst, job_id)
    if inst.python is None:
        raise JobError("등록된 Python 이 없습니다")
    pythonw = inst.python.with_name("pythonw.exe")
    exe = pythonw if pythonw.is_file() else inst.python
    # 실행기는 화면이 시작한 관리 창 코드(CODE_ROOT)에서 돈다 — 그사이 포인터가 바뀌어도 이 사본은 그대로.
    return spawn_detached([str(exe), "-I", "-B", str(CODE_ROOT / "tools" / "server_console" / "job_main.py"),
                           "--install-root", str(inst.root), job_id],
                          str(inst.root), dict(child_env(inst), PYTHONDONTWRITEBYTECODE="1"))


# ---- 화면 쪽 읽기 ----

def decode_line(raw: bytes) -> str:
    """PowerShell 은 콘솔 코드 페이지(서버는 CP949), 파이썬은 UTF-8 로 쓴다 — 줄마다 고른다."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp949", errors="replace")


def _whole_chars(data: bytes) -> int:
    """긴 줄을 자를 자리 — 한글 글자 중간(UTF-8·CP949)에서 자르지 않는다."""
    for codec in ("utf-8", "cp949"):  # decode_line 과 같은 순서 — UTF-8 로 맞는 자리를 먼저 찾는다
        for cut in range(len(data), max(0, len(data) - 4), -1):
            try:
                data[:cut].decode(codec)
                return cut
            except UnicodeDecodeError:
                continue
    return len(data)


def read_output(inst: Installation, job_id: str, start: int = 0, limit: int = 256_000,
                final: bool = False) -> tuple[list[str], int]:
    """start 부터 끝난 줄만. final(작업이 끝남)이면 줄바꿈 없는 마지막 꼬리도 내보낸다."""
    path = job_dir(inst, job_id) / "output.log"
    try:
        with path.open("rb") as handle:
            handle.seek(start)
            data = handle.read(limit)
    except OSError:
        return [], start
    cut = data.rfind(b"\n")
    if cut < 0:
        if not data or (len(data) < limit and not final):
            return [], start  # 아직 줄이 끝나지 않았다
        if len(data) < limit:  # 끝난 작업의 마지막 꼬리
            return [decode_line(data.rstrip(b"\r"))], start + len(data)
        cut = _whole_chars(data)  # 줄바꿈 없는 아주 긴 줄도 읽기 위치는 나아간다
        return [decode_line(data[:cut])], start + cut
    lines = [decode_line(line.rstrip(b"\r")) for line in data[:cut].split(b"\n")]
    return lines, start + cut + 1


def read_job(inst: Installation, job_id: str, now: float | None = None,
             alive: Callable[[int, int | None], bool] = process_alive) -> dict:
    """화면에 보일 상태. 실행기가 사라졌는데 결과가 없으면 'check_needed'."""
    now = time.time() if now is None else now
    job = job_dir(inst, job_id)
    request = read_json(job / "request.json")
    state = read_json(job / "state.json")
    acked = (job / "ack.json").exists()
    kind = (request or {}).get("kind")  # 화면 문구·[관리 창 다시 열기] 는 작업 종류에 따라 다르다
    if state is None:
        started = (request or {}).get("requested_at") or 0
        try:
            young = bool(request) and now - float(started) < STARTING_GRACE_SECONDS
        except (TypeError, ValueError):
            young = False
        return {"status": "starting" if young else "check_needed", "job_id": job_id, "acknowledged": acked,
                "kind": kind}
    try:
        pid = int(state.get("pid") or 0)
    except (TypeError, ValueError):
        pid = 0
    status = state.get("status")
    valid = (status in ("checking", "running", "refused", "runner_error")
             or (status == "finished" and type(state.get("exit_code")) is int))
    if not valid or (status in ("checking", "running") and not alive(pid, state.get("created"))):
        # 모르는 상태·종료 코드 없는 완료·사라진 실행기는 짐작하지 않는다.
        return {**state, "status": "check_needed", "job_id": job_id, "acknowledged": acked, "kind": kind}
    return {**state, "job_id": job_id, "acknowledged": acked, "kind": kind}


UNRESOLVED = ("starting", "checking", "running", "check_needed", "runner_error")


def unresolved_jobs(inst: Installation, exclude: str = "", now: float | None = None) -> list[str] | None:
    """진행 중이거나 결과를 잃고 아직 사람이 확인하지 않은 작업(전부 — 표시 개수와 무관). None = 목록을 못 읽음."""
    dirs = _job_dirs(inst)
    if dirs is None:
        return None
    found = []
    for path in dirs:
        if path.name == exclude:
            continue
        state = read_job(inst, path.name, now=now)
        if state.get("status") in UNRESOLVED and not state.get("acknowledged"):
            found.append(path.name)
    return found


def unresolved_jobs_or_repair(inst: Installation, runner: Runner) -> list[str] | None:
    """unresolved_jobs 와 같되, 작업 기록 폴더를 못 읽으면 권한을 다시 잠가 보고 한 번 더 읽는다
    (Jay 결정: 권한 문제로 멈추지 않는다). 그래도 못 읽으면 None — 기록을 모르면 거절하는 안전장치는 그대로."""
    found = unresolved_jobs(inst)
    if found is not None:
        return found
    try:
        ensure_jobs_root(inst, runner, force=True)
    except (JobError, OSError):
        return None
    return unresolved_jobs(inst)


def mark_launch_failed(inst: Installation, job_id: str, error: str) -> None:
    """실행기를 못 띄운 작업도 기록을 남겨 '결과 확인 필요'로 보이게 한다."""
    write_json(job_dir(inst, job_id) / "state.json", {"status": "runner_error", "error": error[:500],
                                                       "finished_at": time.time()})


def acknowledge(inst: Installation, job_id: str) -> None:
    """'결과 확인 필요' 작업을 사람이 확인했다고 남긴다. 진행 중인 작업은 확인 처리하지 않는다."""
    state = read_job(inst, job_id)
    if state.get("status") not in ("check_needed", "runner_error"):
        raise JobError("결과 확인 필요 상태가 아닙니다")
    write_json(job_dir(inst, job_id) / "ack.json", {"acknowledged_at": time.time()})


def _job_dirs(inst: Installation) -> list[Path] | None:
    """작업 폴더 전부, 최근 요청부터. 상위 폴더가 아직 없으면 []. 못 읽으면 None."""
    root = jobs_root(inst)
    try:
        if not root.exists():
            return []
        dirs = [p for p in root.iterdir() if JOB_ID.fullmatch(p.name) and p.is_dir() and not _is_reparse(p)]
    except OSError:
        return None

    def requested(path: Path) -> float:
        try:
            return (path / "request.json").stat().st_mtime
        except OSError:
            return 0.0
    return sorted(dirs, key=requested, reverse=True)


def recent_jobs(inst: Installation, limit: int = 5) -> list[str]:
    return [p.name for p in (_job_dirs(inst) or [])[:limit]]


def step_of(lines: list[str]) -> int:
    """진행 줄([n/6])에서 지금 단계. 표시용이지 판정이 아니다."""
    step = 0
    for line in lines:
        match = STEP.search(line)
        if match:
            step = max(step, int(match.group(1)))
    return step
