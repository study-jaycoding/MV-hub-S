"""이 PC 의 확인된 서버(127.0.0.1)에만 관리자로 로그인하고 API 를 부른다. 토큰은 메모리에만 둔다.

로그인 전에 포트를 듣는 프로세스가 이 설치의 서버인지 본다(2단계 설계 3판 (1)): 포트 주인 PID 의 실행 파일·
정확한 serve.py 경로·생성 시각(모두 WMI — 서버 프로세스를 열지 않는다), /api/ready 의 process_id·role·build_id·
execution_nonce(= server-activation.json), 그리고 다시 조회해 같은 프로세스인지(두 관측의 일치).
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
from typing import Callable

from . import names, status
from .install import Installation, Runner, powershell_exe
from .jobs import read_json, valid_token

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

# 생성 시각도 WMI 에서 읽는다 — UAC 로 띄운 관리 창은 예약 작업이 띄운 서버를 OpenProcess 로 열지 못한다
# (10-24 서버 실측: 오류 5). 값은 FILETIME(100ns 단위, WMI 표현 정밀도는 마이크로초)이라 WMI 값끼리만 비교한다.
_LISTENER_SCRIPT = r"""
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$ids = @(Get-NetTCPConnection -State Listen -LocalPort __PORT__ -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($i in $ids) {
  $p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$i) -ErrorAction Stop
  $created = if ($p -and $p.CreationDate) { $p.CreationDate.ToFileTimeUtc() } else { '' }
  "PROC`t$([int]$i)`t$created`t$($p.ExecutablePath)`t$($p.CommandLine)"
}
"DONE"
"""


def listeners(port: int, runner: Runner) -> list[tuple[int, int | None, str, str]] | None:
    """(PID, 생성 시각 또는 None, 실행 파일, 명령줄) — 포트를 듣는 프로세스 전부. None = 조회 실패
    (형식이 깨진 PROC 줄이 하나라도 있으면 — 그 줄을 버리고 나머지 하나만 믿지 않게)."""
    code, out = runner([str(powershell_exe()), "-NoProfile", "-NonInteractive", "-Command",
                        _LISTENER_SCRIPT.replace("__PORT__", str(int(port)))], 30)
    lines = [line.rstrip("\r") for line in out.splitlines()]
    if code != 0 or "DONE" not in lines:
        return None
    found = []
    for line in lines:
        if not line.startswith("PROC\t"):
            continue
        parts = line.split("\t", 4)  # 명령줄 안의 탭은 그대로
        if len(parts) != 5 or not parts[1].isdigit() or not (parts[2] == "" or parts[2].isdigit()):
            return None
        found.append((int(parts[1]), int(parts[2]) if parts[2] else None, parts[3], parts[4]))
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


def expected_pythons(inst: Installation) -> list[Path]:
    """서버를 띄운 Python 실행 파일 — 포인터의 python(없으면 등록된 Python)과, venv 면 supervisor 가 대신 띄우는
    기본 Python(pyvenv.cfg 의 home — server_activation.spawn 의 venv → 기본 Python 전환)."""
    path = status.plain_child(inst.logs, names.SERVER_CURRENT)
    pointer = (read_json(path) if path else None) or {}
    python = pointer.get("python") if isinstance(pointer.get("python"), str) else None
    if python is None and inst.python is not None and not os.path.lexists(inst.logs / names.SERVER_CURRENT):
        python = str(inst.python)  # 포인터 없는 소스 실행: supervisor = 등록된 Python(task_launch.bat)
    if not python:
        return []
    found = [Path(python)]
    cfg = found[0].parent.parent / "pyvenv.cfg"
    if found[0].parent.name.lower() == "scripts" and cfg.is_file():
        try:
            home = next((line.split("=", 1)[1].strip() for line in cfg.read_text(encoding="utf-8").splitlines()
                         if line.split("=", 1)[0].strip().lower() == "home"), "")
        except OSError:
            home = ""
        if home and Path(home).is_absolute():
            found.append(Path(home) / found[0].name)
    return found


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
    pid, created, exe, command_line = found[0]
    if created is None:
        raise ServerError(f"{inst.port} 포트를 듣는 프로세스(PID {pid})의 시작 시각을 읽지 못했습니다")
    if not command_line.strip():
        raise ServerError(f"{inst.port} 포트를 듣는 프로세스(PID {pid})의 명령줄을 읽지 못했습니다")
    argv = split_command_line(command_line)
    if len(argv) < 2:
        raise ServerError(f"{inst.port} 포트를 듣는 프로세스(PID {pid})의 명령줄에 실행 파일이 없습니다")
    if not _same_path(argv[1], script):
        raise ServerError(f"{inst.port} 포트를 듣는 프로세스(PID {pid})가 이 설치의 서버(serve.py)가 아닙니다"
                          f"({_shown(argv[1])})")
    if not exe or not any(_same_path(exe, python) for python in expected_pythons(inst)):
        raise ServerError(f"{inst.port} 포트를 듣는 프로세스(PID {pid})의 실행 파일이 이 서버의 Python 이 아닙니다({exe or '확인 불가'})")
    ready = status.read_ready(inst.port)
    payload = ready.payload if isinstance(ready.payload, dict) else {}
    runtime = payload.get("runtime") if isinstance(payload.get("runtime"), dict) else {}
    if not (ready.code == 200 and payload.get("status") == "ready" and runtime.get("process_id") == pid
            and runtime.get("role") == "server" and runtime.get("build_id") == build_id
            and runtime.get("execution_nonce") == nonce):
        raise ServerError("서버 응답(/api/ready)이 확인한 프로세스·실행 기록과 맞지 않습니다")
    # 두 관측(앞의 조회·지금 조회)에서 같은 서버인지 — 같은 PID 의 재사용·포트 주인 교체를 이 사이에서 잡는다.
    if listeners(inst.port, runner) != [found[0]]:
        raise ServerError("확인하는 사이 서버 프로세스가 바뀌었습니다 — 다시 시도하세요")
    return {"port": inst.port, "pid": pid, "created": created, "nonce": nonce, "build_id": build_id}


def _shown(value: str, limit: int = 160) -> str:
    """거절 문구에 보이는 실제 경로 — 제어 문자 없이, 짧게."""
    value = re.sub(r"[\x00-\x1f\x7f]", "?", value)
    return value if len(value) <= limit else value[:limit] + "…"


# ---- 요청 ----

def _json(raw: bytes) -> dict | list | None:
    try:
        value = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        return None
    return value if isinstance(value, (dict, list)) else None


_recheck: Callable[[], dict] | None = None


def bind(inst: Installation, runner: Runner) -> None:
    """이 프로세스에서 토큰을 실은 요청은 보내기 **바로 전에** 서버를 다시 확인한다 — 확인한 뒤 NAS 읽기·지문 계산처럼
    오래 걸린 사이에 서버가 꺼지고 다른 프로세스가 포트를 차지했으면 보내지 않는다(화면·실행기가 시작할 때 부른다)."""
    global _recheck
    _recheck = lambda: verify_server(inst, runner)  # noqa: E731


def call(server: dict, method: str, path: str, token: str = "", body: dict | None = None,
         timeout: float = 15.0) -> tuple[int | None, dict | list | None]:
    """(HTTP 코드 또는 응답 없음 None, JSON 객체·배열). 프록시·리다이렉트를 쓰지 않고 127.0.0.1 로만.
    token 이 있으면 먼저 bind 한 확인으로 지금 서버가 server 와 같은지 본다(다르거나 확인 수단이 없으면 보내지 않음)."""
    if token:
        if _recheck is None:
            raise ServerError("서버를 다시 확인할 수 없어 로그인 정보를 보내지 않았습니다")
        if _recheck() != server:
            raise ServerError("확인했던 서버와 지금 포트의 서버가 다릅니다 — 로그인 정보를 보내지 않았습니다. 다시 시도하세요")
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


def detail(payload) -> str:
    text = payload.get("detail") if isinstance(payload, dict) else None
    return text[:300] if isinstance(text, str) else ""


def login(inst: Installation, runner: Runner, email: str, password: str) -> Session:
    """서버를 확인한 뒤에만 비밀번호를 보낸다. admin 이 아니면 토큰을 버린다."""
    server = verify_server(inst, runner)
    code, payload = call(server, "POST", "/api/auth/login", body={"email": email, "password": password})
    if code != 200 or not isinstance(payload, dict):
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


def expect_ok(code: int | None, payload, what: str, shape: type = dict):
    """200 과 기대한 모양(객체·배열)만 통과. 401·403 = AuthExpired, 응답 없음·그 밖 = ServerError(단계 이름과 함께)."""
    if code in (401, 403):
        raise AuthExpired(f"서버가 로그인을 받지 않았습니다({detail(payload) or code}) — {RELOGIN}")
    if code is None:
        raise ServerError(f"{what}: 서버에서 응답을 받지 못했습니다(꺼져 있거나 바쁠 수 있음)")
    if code != 200 or not isinstance(payload, shape):
        raise ServerError(f"{what}: {detail(payload) or f'HTTP {code}'}")
    return payload


def read_intake(server: dict, token: str) -> bool:
    """True = 멈춤. 서버 API 값(관리 창의 DB 경로 짐작에 기대지 않는다)."""
    paused = expect_ok(*call(server, "GET", INTAKE_PATH, token), "생성 접수 읽기").get("paused")
    if not isinstance(paused, bool):
        raise ServerError("생성 접수 응답 형식을 알 수 없습니다")
    return paused


def set_intake(server: dict, token: str, paused: bool) -> bool:
    """바꾸고 다시 읽어 확인한 값. 응답만 잃었으면(서버는 바꿨을 수 있다) 다시 읽어 판정한다."""
    code, payload = call(server, "PUT", INTAKE_PATH, token, {"paused": paused})
    if code is not None and expect_ok(code, payload, "생성 접수 바꾸기").get("paused") is not paused:
        raise ServerError("서버가 요청과 다른 값을 돌려줬습니다")
    after = read_intake(server, token)
    if after is not paused:
        raise ServerError("바꾼 뒤 다시 읽은 값이 요청과 다릅니다" if code is not None
                          else "생성 접수 바꾸기: 서버에서 응답을 받지 못했고 값도 바뀌지 않았습니다")
    return after
