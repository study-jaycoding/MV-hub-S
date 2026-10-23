"""이 PC 의 확인된 서버(127.0.0.1)에만 관리자로 로그인하고 API 를 부른다. 토큰은 메모리에만 둔다.

로그인 전에 포트를 듣는 프로세스가 이 설치의 서버인지 본다(2단계 설계 3판 (1)): 포트 주인 PID 의 실행 파일·
정확한 serve.py 경로·생성 시각, /api/ready 의 process_id·role·build_id·execution_nonce(= server-activation.json).
하나라도 확인하지 못하면 로그인하지 않는다. 서버가 TLS 로 설정돼 있으면 이 기능을 끈다(인증서 검증을 풀지 않는다).
"""
from __future__ import annotations

import ctypes
import json
import os
import re
import urllib.error
import urllib.request
from ctypes import wintypes
from dataclasses import dataclass, field
from pathlib import Path

from . import names, status
from .install import Installation, Runner, powershell_exe
from .jobs import process_alive, process_created, read_json, valid_token

_NONCE = re.compile(r"^[0-9a-f]{32}$")


class ServerError(RuntimeError):
    """로그인·API 호출을 하지 않은(또는 실패한) 이유 — 화면에 그대로 보인다."""


RELOGIN = "다시 로그인하세요"


class AuthExpired(ServerError):
    """서버가 토큰을 거절했다(만료·권한) — 화면은 로그인을 버리고 다시 묻는다. 문구는 늘 RELOGIN 으로 끝난다."""


@dataclass(frozen=True)
class Session:
    email: str
    server: dict
    token: str = field(repr=False)  # 오류 문구·기록에 찍히지 않게


# ---- 서버 확인 ----

_LISTENER_SCRIPT = r"""
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$ids = @(Get-NetTCPConnection -State Listen -LocalPort __PORT__ -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($i in $ids) {
  $p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$i) -ErrorAction Stop
  "PROC`t$([int]$i)`t$($p.ExecutablePath)`t$($p.CommandLine)"
}
"DONE"
"""


def listeners(port: int, runner: Runner) -> list[tuple[int, str, str]] | None:
    """(PID, 실행 파일, 명령줄) — 포트를 듣는 프로세스 전부. None = 조회 실패."""
    code, out = runner([str(powershell_exe()), "-NoProfile", "-NonInteractive", "-Command",
                        _LISTENER_SCRIPT.replace("__PORT__", str(int(port)))], 30)
    lines = [line.rstrip("\r") for line in out.splitlines()]
    if code != 0 or "DONE" not in lines:
        return None
    found = []
    for line in lines:
        parts = line.split("\t", 3)
        if parts[0] == "PROC" and len(parts) == 4 and parts[1].isdigit():
            found.append((int(parts[1]), parts[2], parts[3]))
    return found


def split_command_line(line: str) -> list[str]:
    """Windows 가 프로그램에 넘기는 방식(CommandLineToArgvW) 그대로 나눈다."""
    if not line.strip():
        return []  # 빈 문자열이면 OS 가 이 프로세스 경로를 돌려준다
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    shell32.CommandLineToArgvW.argtypes = (wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int))
    shell32.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = (ctypes.c_void_p,)
    count = ctypes.c_int()
    argv = shell32.CommandLineToArgvW(line, ctypes.byref(count))
    if not argv:
        return []
    try:
        return [argv[i] for i in range(count.value)]
    finally:
        kernel32.LocalFree(ctypes.cast(argv, ctypes.c_void_p))


def expected_server(inst: Installation) -> tuple[Path, str]:
    """돌고 있어야 할 serve.py 와 build_id(supervisor 가 띄운 그대로 — server_activation.spawn)."""
    code = status.running_code(inst)
    if code["source"] == "stage":
        script = status.plain_child(inst.logs, "server-stages", code["build_id"], "backend", "serve.py")
        if script is not None:
            return script, code["build_id"]
    elif code["source"] == "legacy" or not os.path.lexists(inst.logs / names.SERVER_CURRENT):
        return inst.root / "backend" / "serve.py", "legacy-source"
    raise ServerError("돌고 있어야 할 서버 코드(logs\\server-current.json)를 확인하지 못했습니다")


def activation_nonce(inst: Installation) -> str:
    path = status.plain_child(inst.logs, "server-activation.json")
    value = read_json(path) if path else None
    nonce = (value or {}).get("execution_nonce") if (value or {}).get("format_version") == 1 else None
    if not isinstance(nonce, str) or not _NONCE.fullmatch(nonce):
        raise ServerError("서버 실행 기록(logs\\server-activation.json)을 확인하지 못했습니다 — 자동시작으로 켠 서버만 씁니다")
    return nonce


def _same_path(a: str, b: Path) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(str(b)))


def verify_server(inst: Installation, runner: Runner) -> dict:
    """확인한 서버 대상(port·pid·created·nonce·build_id). 확인 대상(Plan.params)에 그대로 넣고 실행 직전에 다시 비교한다."""
    if inst.tls:
        raise ServerError("서버가 https(인증서)로 설정돼 있어 관리 창 로그인을 쓰지 않습니다 — 웹 관리자 창을 쓰세요")
    script, build_id = expected_server(inst)
    nonce = activation_nonce(inst)
    found = listeners(inst.port, runner)
    if found is None:
        raise ServerError(f"{inst.port} 포트를 듣는 프로세스를 확인하지 못했습니다")
    if len(found) != 1:
        raise ServerError(f"{inst.port} 포트를 듣는 프로세스가 {'없습니다(서버가 꺼져 있을 수 있음)' if not found else '여럿입니다'}")
    pid, exe, command_line = found[0]
    created = process_created(pid)
    argv = split_command_line(command_line)
    if (created is None or Path(exe).name.lower() not in ("python.exe", "pythonw.exe")
            or len(argv) < 2 or not _same_path(argv[1], script)):
        raise ServerError(f"{inst.port} 포트를 듣는 프로세스(PID {pid})가 이 설치의 서버(serve.py)가 아닙니다")
    ready = status.read_ready(inst.port)
    payload = ready.payload if isinstance(ready.payload, dict) else {}
    runtime = payload.get("runtime") if isinstance(payload.get("runtime"), dict) else {}
    if not (ready.code == 200 and payload.get("status") == "ready" and runtime.get("process_id") == pid
            and runtime.get("role") == "server" and runtime.get("build_id") == build_id
            and runtime.get("execution_nonce") == nonce):
        raise ServerError("서버 응답(/api/ready)이 확인한 프로세스·실행 기록과 맞지 않습니다")
    if not process_alive(pid, created):
        raise ServerError("확인하는 사이 서버 프로세스가 바뀌었습니다 — 다시 시도하세요")
    return {"port": inst.port, "pid": pid, "created": created, "nonce": nonce, "build_id": build_id}


# ---- 요청 ----

def _json(raw: bytes) -> dict | None:
    try:
        value = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def call(server: dict, method: str, path: str, token: str = "", body: dict | None = None,
         timeout: float = 15.0) -> tuple[int | None, dict | None]:
    """(HTTP 코드 또는 응답 없음 None, JSON). 프록시·리다이렉트를 쓰지 않고 127.0.0.1 로만."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), status._NoRedirect)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(f"http://127.0.0.1:{int(server['port'])}{path}", data=data, method=method)
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, _json(response.read(1_000_000))
    except urllib.error.HTTPError as exc:
        return exc.code, _json(exc.read(65536))
    except (urllib.error.URLError, OSError):
        return None, None


def detail(payload: dict | None) -> str:
    text = (payload or {}).get("detail")
    return text[:300] if isinstance(text, str) else ""


def login(inst: Installation, runner: Runner, email: str, password: str) -> Session:
    """서버를 확인한 뒤에만 비밀번호를 보낸다. admin 이 아니면 토큰을 버린다."""
    server = verify_server(inst, runner)
    code, payload = call(server, "POST", "/api/auth/login", body={"email": email, "password": password})
    if code != 200 or payload is None:
        raise ServerError(detail(payload) or f"로그인하지 못했습니다({code or '응답 없음'})")
    account = payload.get("account") if isinstance(payload.get("account"), dict) else {}
    token = payload.get("token")
    if not valid_token(token):
        raise ServerError("로그인 응답 형식을 알 수 없습니다")
    roles = account.get("global_roles")
    if account.get("status") != "approved" or not isinstance(roles, list) or "admin" not in roles:
        raise ServerError("관리자(admin) 계정만 쓸 수 있습니다")
    return Session(email=str(account.get("email") or email), server=server, token=token)


# ---- 생성 접수(서버 DB app_setting['generation_deployment_paused'] — 실행 중인 서버가 자기 DB 에 쓴다) ----

INTAKE_PATH = "/api/gen-requests/deployment-pause"


def _answer(code: int | None, payload: dict | None, what: str) -> dict:
    if code in (401, 403):
        raise AuthExpired(f"서버가 로그인을 받지 않았습니다({detail(payload) or code}) — {RELOGIN}")
    if code is None:
        raise ServerError(f"{what}: 서버에서 응답을 받지 못했습니다(꺼져 있거나 바쁠 수 있음)")
    if code != 200 or payload is None:
        raise ServerError(f"{what}: {detail(payload) or f'HTTP {code}'}")
    return payload


def read_intake(server: dict, token: str) -> bool:
    """True = 멈춤. 서버 API 값(관리 창의 DB 경로 짐작에 기대지 않는다)."""
    paused = _answer(*call(server, "GET", INTAKE_PATH, token), "생성 접수 읽기").get("paused")
    if not isinstance(paused, bool):
        raise ServerError("생성 접수 응답 형식을 알 수 없습니다")
    return paused


def set_intake(server: dict, token: str, paused: bool) -> bool:
    """바꾸고 다시 읽어 확인한 값. 응답만 잃었으면(서버는 바꿨을 수 있다) 다시 읽어 판정한다."""
    code, payload = call(server, "PUT", INTAKE_PATH, token, {"paused": paused})
    if code is not None and _answer(code, payload, "생성 접수 바꾸기").get("paused") is not paused:
        raise ServerError("서버가 요청과 다른 값을 돌려줬습니다")
    after = read_intake(server, token)
    if after is not paused:
        raise ServerError("바꾼 뒤 다시 읽은 값이 요청과 다릅니다" if code is not None
                          else "생성 접수 바꾸기: 서버에서 응답을 받지 못했고 값도 바뀌지 않았습니다")
    return after
