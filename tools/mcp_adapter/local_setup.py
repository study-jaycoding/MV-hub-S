"""Windows-user protected MCP profiles and conservative local client registration."""
from __future__ import annotations

import copy
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
import tomllib
from uuid import UUID

_LOCK = threading.RLock()


def _require_interactive_user() -> None:
    """DPAPI and client configuration must belong to the desktop's signed-in user."""
    message = "MV Hub와 LLM을 같은 Windows 로그인 사용자로 실행하세요. 서비스 계정에서는 자동 연결할 수 없습니다."
    if os.name != "nt":
        raise ValueError(message)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    wts = ctypes.WinDLL("wtsapi32", use_last_error=True)
    security = ctypes.WinDLL("secur32", use_last_error=True)
    session = wintypes.DWORD()
    kernel.ProcessIdToSessionId.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    kernel.ProcessIdToSessionId.restype = wintypes.BOOL
    if not kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)) or not session.value:
        raise ValueError(message)
    wts.WTSQuerySessionInformationW.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_int,
                                               ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(wintypes.DWORD)]
    wts.WTSQuerySessionInformationW.restype = wintypes.BOOL
    wts.WTSFreeMemory.argtypes = [ctypes.c_void_p]
    values = []
    for info in (7, 5):  # WTSDomainName, WTSUserName
        value, size = wintypes.LPWSTR(), wintypes.DWORD()
        if not wts.WTSQuerySessionInformationW(None, session.value, info, ctypes.byref(value), ctypes.byref(size)):
            raise ValueError(message)
        try:
            values.append(value.value or "")
        finally:
            wts.WTSFreeMemory(value)
    current, length = ctypes.create_unicode_buffer(512), wintypes.ULONG(512)
    security.GetUserNameExW.argtypes = [ctypes.c_int, wintypes.LPWSTR, ctypes.POINTER(wintypes.ULONG)]
    security.GetUserNameExW.restype = wintypes.BOOL
    if (not values[1] or not security.GetUserNameExW(2, current, ctypes.byref(length))
            or current.value.casefold() != "\\".join(values).casefold()):
        raise ValueError(message)


def _crypt(data: bytes, *, decrypt: bool = False) -> bytes:
    if os.name != "nt":
        raise ValueError("MCP 자동 연결은 Windows 사용자 계정에서 설정하세요.")
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    fn = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                   ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    fn.restype = wintypes.BOOL
    if not fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise ValueError("이 Windows 계정에서 MCP 연결 권한을 읽거나 저장할 수 없습니다.")
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel.LocalFree(output.data)


def _profile(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"secret", "hub_id", "client_id", "url"}:
        raise ValueError("MCP 연결 파일이 올바르지 않습니다. 앱에서 다시 연결하세요.")
    if (not isinstance(value["secret"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", value["secret"])
            or not isinstance(value["hub_id"], str) or not re.fullmatch(r"[a-f0-9]{32,64}", value["hub_id"])
            or not isinstance(value["url"], str)):
        raise ValueError("MCP 연결 파일이 올바르지 않습니다. 앱에서 다시 연결하세요.")
    try:
        UUID(value["client_id"])
    except (ValueError, TypeError, AttributeError):
        raise ValueError("MCP 연결 식별자가 올바르지 않습니다.") from None
    return value


def read_profile(path: str | Path) -> dict:
    try:
        with Path(path).open("rb") as stream:
            data = stream.read(8193)
        if len(data) > 8192:
            raise ValueError()
        return _profile(json.loads(_crypt(data, decrypt=True)))
    except (OSError, ValueError, UnicodeError):
        raise ValueError("MCP 연결 권한을 읽지 못했습니다. MV Hub에서 다시 연결하세요.") from None


def _atomic(path: Path, data: bytes, previous: bytes | None = None, *, compare: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".mvhub-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if compare and (path.read_bytes() if path.exists() else None) != previous:
            raise ValueError("설정이 다른 프로그램에서 바뀌었습니다. 다시 연결하세요.")
        # External editors do not share our lock; compare immediately before atomic replacement.
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _entry(setup: dict, profile: Path) -> dict:
    return {"command": setup["python"], "args": [*setup.get("python_args", []), setup["adapter"],
            "--url", setup["url"], "--profile", str(profile)]}


def _known_entry(old: object, setup: dict) -> bool:
    if old is None:
        return True
    if not isinstance(old, dict) or not isinstance(old.get("args"), list):
        return False
    normalize = lambda s: os.path.normcase(os.path.abspath(s)) if isinstance(s, str) else ""
    return (normalize(old.get("command")) == normalize(setup["python"])
            and any(normalize(arg) == normalize(setup["adapter"]) for arg in old["args"])
            and "url" not in old)


def _toml_entry(entry: dict) -> str:
    return ("[mcp_servers.mvhub]\ncommand = " + json.dumps(entry["command"], ensure_ascii=False)
            + "\nargs = " + json.dumps(entry["args"], ensure_ascii=False) + "\ntool_timeout_sec = 150\n")


def _without_server(value: dict, key: str) -> dict:
    result = copy.deepcopy(value)
    servers = result.get(key, {})
    if not isinstance(servers, dict):
        raise ValueError("기존 MCP 설정 형식을 확인하세요.")
    servers.pop("mvhub", None)
    if not servers:
        result.pop(key, None)
    return result


def update_codex(text: str, entry: dict, setup: dict) -> str:
    before = tomllib.loads(text)
    if not _known_entry(before.get("mcp_servers", {}).get("mvhub"), setup):
        raise ValueError("다른 mvhub 등록이 있습니다. 기존 등록을 확인한 뒤 수동으로 연결하세요.")
    lines = text.splitlines(keepends=True)
    remove = set()
    in_target = False
    for index, line in enumerate(lines):
        if re.match(r"^\s*\[", line):
            try:
                header = tomllib.loads(line.strip())
                in_target = isinstance(header.get("mcp_servers"), dict) and "mvhub" in header["mcp_servers"]
            except tomllib.TOMLDecodeError:
                # Do not guess exotic/multiline table syntax; semantic comparison below fails closed.
                pass
        if in_target:
            remove.add(index)
    result = "".join(line for index, line in enumerate(lines) if index not in remove).rstrip() + "\n\n" + _toml_entry(entry)
    after = tomllib.loads(result)
    if _without_server(before, "mcp_servers") != _without_server(after, "mcp_servers"):
        raise ValueError("기존 설정을 보존할 수 없어 자동 등록을 중단했습니다.")
    if after.get("mcp_servers", {}).get("mvhub") != {**entry, "tool_timeout_sec": 150}:
        raise ValueError("MCP 등록 설정 검증에 실패했습니다.")
    return result


def update_claude(text: str, entry: dict, setup: dict) -> str:
    before = json.loads(text) if text.strip() else {}
    if not isinstance(before, dict) or not isinstance(before.get("mcpServers", {}), dict):
        raise ValueError("기존 Claude 설정 형식을 확인하세요.")
    if not _known_entry(before.get("mcpServers", {}).get("mvhub"), setup):
        raise ValueError("다른 mvhub 등록이 있습니다. 기존 등록을 확인한 뒤 수동으로 연결하세요.")
    after = copy.deepcopy(before)
    after.setdefault("mcpServers", {})["mvhub"] = {"type": "stdio", **entry}
    return json.dumps(after, ensure_ascii=False, indent=2) + "\n"


def remove_profiles(hub_id: str, client_ids: list[str], *, local_appdata: Path | None = None) -> int:
    """다시 등록하며 실제로 회수한 연결의 프로필 파일만 지운다(Codex 리뷰 P2 ⑤) — 폴더를 통째로 훑지 않는다
    (수동 등록·다른 클라이언트·지금 쓰는 프로필은 그대로). 이름 형식이 아니면 건너뛴다 — 경로 밖을 가리키지 못하게."""
    if not isinstance(hub_id, str) or not re.fullmatch(r"[a-f0-9]{32,64}", hub_id):
        return 0
    local = Path(local_appdata) if local_appdata is not None else Path(os.environ.get("LOCALAPPDATA", ""))
    if local_appdata is None and not os.environ.get("LOCALAPPDATA"):
        return 0
    removed = 0
    with _LOCK:
        for client_id in client_ids:
            try:
                if str(UUID(client_id)) != client_id:
                    continue
            except (TypeError, ValueError, AttributeError):
                continue
            try:
                (local / "MVHub-MCP" / "connections" / hub_id / (client_id + ".bin")).unlink()
                removed += 1
            except FileNotFoundError:
                pass
    return removed


def configure_client(client: str, setup: dict, credential: dict, *, home: Path | None = None,
                     local_appdata: Path | None = None) -> dict:
    """Called only after app-side account/scope consent. Never returns credential contents."""
    if client not in {"codex", "claude", "other"}:
        raise ValueError("지원하지 않는 클라이언트입니다.")
    credential = _profile(credential)
    if credential["url"] != setup.get("url"):
        raise ValueError("허브 주소가 일치하지 않습니다.")
    if not all(isinstance(setup.get(key), str) and Path(setup[key]).is_file() for key in ("python", "adapter")):
        raise ValueError("MCP 실행 파일이 없습니다. 앱 설치 상태를 확인하세요.")
    _require_interactive_user()
    user_home = Path(home) if home is not None else Path.home()
    local = Path(local_appdata) if local_appdata is not None else Path(os.environ.get("LOCALAPPDATA", ""))
    if local_appdata is None and not os.environ.get("LOCALAPPDATA"):
        raise ValueError("Windows 사용자 저장 폴더를 확인할 수 없습니다.")
    profile = local / "MVHub-MCP" / "connections" / credential["hub_id"] / (credential["client_id"] + ".bin")
    entry = _entry(setup, profile)
    config = _toml_entry(entry) if client == "codex" else json.dumps({"mcpServers": {"mvhub": entry}}, ensure_ascii=False, indent=2)
    with _LOCK:
        _atomic(profile, _crypt(json.dumps(credential).encode("utf-8")))
        if client == "other":
            return {"client": client, "status": "manual", "message": "사용할 MCP 앱에 이 설정을 한 번 등록하세요.", "config": config}
        if client == "claude" and home is None and os.environ.get("CLAUDE_CONFIG_DIR"):
            return {"client": client, "status": "manual", "message": "Claude가 별도 설정 폴더를 사용합니다. 해당 프로그램에 이 설정을 등록하세요.", "config": config}
        codex_home = Path(os.environ["CODEX_HOME"]) if home is None and os.environ.get("CODEX_HOME") else user_home / ".codex"
        path = (codex_home / "config.toml") if client == "codex" else (user_home / ".claude.json")
        installed = path.exists() or bool(shutil.which("codex" if client == "codex" else "claude"))
        if not installed:
            return {"client": client, "status": "manual", "message": "프로그램 설치를 확인하지 못했습니다. 설치 후 설정을 등록하세요.", "config": config}
        previous = path.read_bytes() if path.exists() else None
        if previous is not None and len(previous) > 4 * 1024 * 1024:
            raise ValueError("클라이언트 설정이 너무 커 자동 등록할 수 없습니다.")
        try:
            text = previous.decode("utf-8-sig") if previous else ""
            updated = update_codex(text, entry, setup) if client == "codex" else update_claude(text, entry, setup)
        except (ValueError, UnicodeError, AttributeError):
            return {"client": client, "status": "manual", "message": "기존 mvhub 설정과 충돌하거나 형식을 확인하지 못했습니다. 설정을 확인한 뒤 아래 내용을 수동 등록하세요.", "config": config}
        if previous is not None:
            # 설정 파일마다 직전 사본 한 개만(원자 교체) — 등록할 때마다 새 이름으로 쌓였다(Codex 리뷰 P2 ⑤). 예전 이름(…-<uuid>)은 지우지 않는다.
            _atomic(path.with_name(path.name + ".mvhub-backup"), previous)
        _atomic(path, updated.encode("utf-8"), previous, compare=True)
    return {"client": client, "status": "configured", "message": "등록했습니다. 실행 중인 LLM에서 MCP를 새로고침하거나 프로그램을 다시 시작하세요."}
