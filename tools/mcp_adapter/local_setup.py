"""Windows-user protected MCP profiles and conservative local client registration."""
from __future__ import annotations

import copy
import contextlib
import fnmatch
import hashlib
import hmac
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


def _atomic(path: Path, data: bytes, previous: bytes | None = None, *, compare: bool = False, exclusive: bool = False) -> None:
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
        if exclusive:
            os.link(temporary, path)  # Publish a complete first backup, atomically, without replacing an existing one.
        else:
            os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _desktop_app_running(folder: Path) -> bool:
    """켜진 Claude 앱은 자기 사용자 폴더의 lockfile 을 잠가 둔다(Chromium) — 만들지 않고 열어 보고 바로 닫는다."""
    try:
        fd = os.open(folder / "lockfile", os.O_RDWR)
    except FileNotFoundError:
        return False
    except OSError:  # 잠김(PermissionError) 또는 알 수 없음 — 켜진 것으로 본다
        return True
    os.close(fd)
    return False


def server_name(setup: dict) -> str:
    """설치본은 mvhub, 소스 실행(dev)은 mvhub-test — 한 PC 에 둘이 있어도 서로의 등록을 덮지 않는다."""
    return "mvhub" if setup.get("release") is True else "mvhub-test"


def _entry(setup: dict, profile: Path, client: str) -> dict:
    return {"command": setup["python"], "args": [*setup.get("python_args", []), setup["adapter"],
            "--url", setup["url"], *(["--display-mode", "conversation"] if client == "codex" else []),
            "--profile", str(profile)]}


def _known_entry(old: object, setup: dict) -> bool:
    if old is None:
        return True
    if not isinstance(old, dict) or not isinstance(old.get("args"), list):
        return False
    normalize = lambda s: _path_key(s) if isinstance(s, str) else ""
    return (normalize(old.get("command")) == normalize(setup["python"])
            and any(normalize(arg) == normalize(setup["adapter"]) for arg in old["args"])
            and "url" not in old)


def _path_key(path) -> str:
    value = str(Path(path).resolve())
    if value.upper().startswith("\\\\?\\UNC\\"):
        value = "\\\\" + value[8:]
    else:
        value = value.removeprefix("\\\\?\\")
    return os.path.normcase(os.path.normpath(value))


@contextlib.contextmanager
def _file_lock(path: Path):
    """Share the read/backup/replace boundary between installed and dev hubs."""
    with _LOCK:
        if os.name != "nt":
            raise ValueError("MCP 자동 연결은 Windows 사용자 계정에서 설정하세요.")
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        kernel.CreateMutexW.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        name = "Local\\MVHub-MCP-" + hashlib.sha256(_path_key(path).encode()).hexdigest()
        handle = kernel.CreateMutexW(None, False, name)
        if not handle:
            raise ValueError("MCP 설정 잠금을 얻지 못했습니다.")
        acquired = False
        try:
            acquired = kernel.WaitForSingleObject(handle, 15000) in (0, 0x80)
            if not acquired:
                raise ValueError("다른 MV Hub가 설정 중입니다. 잠시 뒤 다시 확인하세요.")
            yield
        finally:
            if acquired:
                kernel.ReleaseMutex(handle)
            kernel.CloseHandle(handle)


def _read_config(path: Path) -> bytes | None:
    try:
        with path.open("rb") as stream:
            data = stream.read(4 * 1024 * 1024 + 1)
    except FileNotFoundError:
        return None
    if len(data) > 4 * 1024 * 1024:
        raise ValueError("클라이언트 설정이 너무 커 자동 등록할 수 없습니다.")
    return data


def _save_config(path: Path, previous: bytes | None, updated: bytes):
    if previous == updated:
        return
    if previous is not None:
        original = path.with_name(path.name + ".mvhub-original")
        try:
            _atomic(original, previous, exclusive=True)
        except FileExistsError:
            pass
        _atomic(path.with_name(path.name + ".mvhub-backup"), previous)
    # shortcut: editors and older hubs do not share the mutex; compare narrows that race only.
    _atomic(path, updated, previous, compare=True)


def _json(text: str) -> dict:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("중복된 설정 키입니다.")
            result[key] = value
        return result
    def invalid(_):
        raise ValueError("표준 JSON 설정이 아닙니다.")
    value = json.loads(text, object_pairs_hook=pairs, parse_constant=invalid) if text.strip() else {}
    if not isinstance(value, dict):
        raise ValueError("설정 객체가 아닙니다.")
    return value


def _replaceable(old, client):
    allowed = ({"command", "args", "tool_timeout_sec", "default_tools_approval_mode"}
               if client == "codex" else {"command", "args", "type"})
    if old is not None and (not isinstance(old, dict) or set(old) - allowed):
        raise ValueError("사용자가 추가한 서버 설정은 수동으로 유지하세요.")
    if client != "codex" and old is not None and old.get("type", "stdio") != "stdio":
        raise ValueError("기존 서버 형식을 유지합니다.")
    if client == "codex" and old is not None and old.get("default_tools_approval_mode", "approve") != "approve":
        raise ValueError("사용자가 지정한 도구 승인 방식을 유지합니다.")


def config_path(client: str, *, home: Path | None = None) -> Path:
    user_home = Path(home) if home is not None else Path.home()
    codex_home = Path(os.environ["CODEX_HOME"]) if home is None and os.environ.get("CODEX_HOME") else user_home / ".codex"
    return codex_home / "config.toml" if client == "codex" else user_home / ".claude.json"


def connection_lock(client: str, *, home: Path | None = None):
    return _file_lock(config_path(client, home=home))


def registration(client, setup, candidates=(), *, home=None, local_appdata=None) -> dict:
    """Inspect only; candidates are already authorized DB rows. Never return profile secrets."""
    if client == "claude" and home is None and os.environ.get("CLAUDE_CONFIG_DIR"):
        return {"status": "manual"}
    path = config_path(client, home=home)
    with _file_lock(path):
        try:
            raw = _read_config(path)
            parsed = tomllib.loads(raw.decode("utf-8-sig")) if client == "codex" and raw else _json(raw.decode("utf-8-sig") if raw else "")
            servers = parsed.get("mcp_servers" if client == "codex" else "mcpServers", {})
            if not isinstance(servers, dict):
                raise ValueError()
            entry = servers.get(server_name(setup))
            if entry is None:
                legacy = servers.get("mvhub")
                if server_name(setup) != "mvhub" and legacy is not None and _known_entry(legacy, setup):
                    return {"status": "reconnect"}
                return {"status": "missing"}
            if not _known_entry(entry, setup):
                raise ValueError()
            args = entry["args"]
            if args.count("--profile") != 1:
                raise ValueError()
            profile_path = Path(args[args.index("--profile") + 1])
            profile = read_profile(profile_path)
            local = Path(local_appdata) if local_appdata is not None else Path(os.environ["LOCALAPPDATA"])
            expected_path = local / "MVHub-MCP" / "connections" / profile["hub_id"] / (profile["client_id"] + ".bin")
            expected = _entry(setup, expected_path, client)
            # Exact argument sequence also rejects duplicate flags, alternate scripts and --panel.
            normalized = [str(arg) for arg in args]
            normalized[normalized.index("--profile") + 1] = str(expected_path)
            adapter_index = len(setup.get("python_args", []))
            if _path_key(normalized[adapter_index]) == _path_key(setup["adapter"]):
                normalized[adapter_index] = setup["adapter"]
            if (_path_key(profile_path) != _path_key(expected_path) or normalized != expected["args"]
                    or profile["url"] != setup["url"]):
                raise ValueError()
            for row in candidates:
                if (row["id"] == profile["client_id"] and row["hub_id"] == profile["hub_id"]
                        and hmac.compare_digest(row["secret_hash"], hashlib.sha256(profile["secret"].encode()).hexdigest())):
                    return {"status": "matched", "id": row["id"]}
        except (OSError, ValueError, KeyError, IndexError, TypeError):
            pass
        return {"status": "reconnect"}


def _claude_access(home, name):
    path = (Path(home) if home is not None else Path.home()) / ".claude" / "settings.json"
    try:
        with _file_lock(path):
            previous = _read_config(path)
            if previous is not None and not previous.strip():
                raise ValueError("빈 사용자 설정입니다.")
            value = _json(previous.decode("utf-8-sig") if previous else "")
            permissions = value.setdefault("permissions", {})
            if not isinstance(permissions, dict):
                raise ValueError()
            for key in ("allow", "deny", "ask"):
                if key in permissions and (not isinstance(permissions[key], list)
                        or any(not isinstance(rule, str) for rule in permissions[key])):
                    raise ValueError()
            prefix = "mcp__" + name
            for rule in permissions.get("deny", []) + permissions.get("ask", []):
                tool = rule.split("(", 1)[0].strip()
                # Unknown wildcard patterns fail closed; ordinary tool rules do not interfere.
                if (tool in ("*", prefix) or tool.startswith(prefix + "__")
                        or fnmatch.fnmatchcase(prefix, tool) or fnmatch.fnmatchcase(prefix + "__connect", tool)
                        or any(c in tool for c in "*?[]")):
                    return "conflict"
            allow = permissions.get("allow", [])
            if prefix in allow or prefix + "__*" in allow:
                return "present"
            permissions["allow"] = [*allow, prefix]
            _save_config(path, previous, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())
            return "allowed"
    except (OSError, ValueError, TypeError):
        return "failed"


def _codex_access(path, name) -> tuple[str, bool]:
    try:
        previous = _read_config(path)
        if previous is None:
            return "missing", False
        text = previous.decode("utf-8-sig")
        before = tomllib.loads(text)
        server = before.get("mcp_servers", {}).get(name)
        if not isinstance(server, dict):
            return "missing", False
        mode = server.get("default_tools_approval_mode")
        if mode is not None and mode != "approve":
            return "conflict", False
        limited = server.get("enabled") is False or any(k in server for k in ("enabled_tools", "disabled_tools", "tools"))
        if mode == "approve":
            return "present", limited
        # Multiline TOML strings can contain fake headers. Leave such files to the user.
        if '"""' in text or "'''" in text:
            return "manual", False
        lines = text.splitlines(keepends=True)
        positions = []
        for index, line in enumerate(lines):
            if not line.lstrip().startswith("["):
                continue
            try:
                header = tomllib.loads(line)
            except ValueError:
                continue
            if header == {"mcp_servers": {name: {}}}:
                positions.append(index)
        if len(positions) != 1:
            return "manual", False
        index = positions[0]
        newline = "\r\n" if "\r\n" in text else "\n"
        lines[index] = lines[index].rstrip("\r\n") + newline + 'default_tools_approval_mode = "approve"' + newline
        updated = "".join(lines)
        expected = copy.deepcopy(before)
        expected["mcp_servers"][name]["default_tools_approval_mode"] = "approve"
        if tomllib.loads(updated) != expected:
            return "manual", False
        bom = b"\xef\xbb\xbf" if previous.startswith(b"\xef\xbb\xbf") else b""
        _save_config(path, previous, bom + updated.encode())
        return "allowed", limited
    except (OSError, ValueError, TypeError, AttributeError):
        return "failed", False


def ensure_access(client, setup, expected_client, *, home=None, local_appdata=None) -> dict:
    _require_interactive_user()
    with connection_lock(client, home=home):
        found = registration(client, setup, [expected_client], home=home, local_appdata=local_appdata)
        if found["status"] != "matched":
            return {"client": client, "status": found["status"], "access": "manual"}
        access, host_limited = ((_claude_access(home, server_name(setup)), False) if client == "claude"
                                else _codex_access(config_path(client, home=home), server_name(setup)))
        workspace = expected_client["workspace"]
        if isinstance(workspace, str):
            workspace = json.loads(workspace)
        limited = not expected_client["can_execute"] or workspace.get("scope") != "account" or host_limited
        return {"client": client, "id": expected_client["id"], "status": "limited" if limited else "configured", "access": access}


def _toml_entry(entry: dict, name: str = "mvhub") -> str:
    return (f"[mcp_servers.{name}]\ncommand = " + json.dumps(entry["command"], ensure_ascii=False)
            + "\nargs = " + json.dumps(entry["args"], ensure_ascii=False) + "\ntool_timeout_sec = 150\ndefault_tools_approval_mode = \"approve\"\n")


def _without_server(value: dict, key: str, name: str = "mvhub") -> dict:
    result = copy.deepcopy(value)
    servers = result.get(key, {})
    if not isinstance(servers, dict):
        raise ValueError("기존 MCP 설정 형식을 확인하세요.")
    servers.pop(name, None)
    if not servers:
        result.pop(key, None)
    return result


def _toml_without_server(text: str, name: str) -> str:
    lines = text.splitlines(keepends=True)
    remove = set()
    in_target = False
    for index, line in enumerate(lines):
        if re.match(r"^\s*\[", line):
            try:
                header = tomllib.loads(line.strip())
                in_target = isinstance(header.get("mcp_servers"), dict) and name in header["mcp_servers"]
            except tomllib.TOMLDecodeError:
                # Do not guess exotic/multiline table syntax; semantic comparison below fails closed.
                pass
        if in_target:
            remove.add(index)
    return "".join(line for index, line in enumerate(lines) if index not in remove).rstrip()


def update_codex(text: str, entry: dict, setup: dict, name: str = "mvhub") -> str:
    before = tomllib.loads(text)
    old = before.get("mcp_servers", {}).get(name)
    _replaceable(old, "codex")
    if not _known_entry(old, setup):
        raise ValueError("다른 mvhub 등록이 있습니다. 기존 등록을 확인한 뒤 수동으로 연결하세요.")
    result = _toml_without_server(text, name) + "\n\n" + _toml_entry(entry, name)
    timeout = (old or {}).get("tool_timeout_sec", 150)
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 0 < timeout < float("inf"):
        raise ValueError("기존 제한 시간을 확인하세요.")
    result = result.rsplit("tool_timeout_sec = 150", 1)
    result = ("tool_timeout_sec = " + str(timeout)).join(result)
    after = tomllib.loads(result)
    if _without_server(before, "mcp_servers", name) != _without_server(after, "mcp_servers", name):
        raise ValueError("기존 설정을 보존할 수 없어 자동 등록을 중단했습니다.")
    if after.get("mcp_servers", {}).get(name) != {**entry, "tool_timeout_sec": timeout, "default_tools_approval_mode": "approve"}:
        raise ValueError("MCP 등록 설정 검증에 실패했습니다.")
    return result


def _update_mcp_json(text: str, value: dict, setup: dict, name: str) -> str:
    """Claude Code(~/.claude.json)와 Claude 데스크톱 설정은 같은 mcpServers 꼴 — 그 키 하나만 바꾸고 나머지는 그대로."""
    before = _json(text)
    if not isinstance(before, dict) or not isinstance(before.get("mcpServers", {}), dict):
        raise ValueError("기존 Claude 설정 형식을 확인하세요.")
    _replaceable(before.get("mcpServers", {}).get(name), "claude")
    if not _known_entry(before.get("mcpServers", {}).get(name), setup):
        raise ValueError("다른 mvhub 등록이 있습니다. 기존 등록을 확인한 뒤 수동으로 연결하세요.")
    after = copy.deepcopy(before)
    after.setdefault("mcpServers", {})[name] = value
    return json.dumps(after, ensure_ascii=False, indent=2) + "\n"


def update_claude(text: str, entry: dict, setup: dict, name: str = "mvhub") -> str:
    return _update_mcp_json(text, {"type": "stdio", **entry}, setup, name)


def update_claude_desktop(text: str, entry: dict, setup: dict, name: str = "mvhub") -> str:
    return _update_mcp_json(text, entry, setup, name)  # 데스크톱 형식은 command·args 만(type 없음)


def drop_old_dev_entry(text: str, client: str, setup: dict) -> str:
    """소스 실행이 mvhub-test 로 옮겨 오기 전에 mvhub 로 남긴 등록 — 프로필이 회수돼 어차피 깨진다. 같은 파이썬·어댑터를 가리킬 때만 지운다(설치본 등록은 경로가 달라 남는다)."""
    if client == "codex":
        before = tomllib.loads(text)
        old = before.get("mcp_servers", {}).get("mvhub")
        if old is None or not _known_entry(old, setup):
            return text
        _replaceable(old, "codex")
        result = _toml_without_server(text, "mvhub") + "\n"
        if _without_server(before, "mcp_servers") != _without_server(tomllib.loads(result), "mcp_servers"):
            raise ValueError("기존 설정을 보존할 수 없어 자동 등록을 중단했습니다.")
        return result
    before = _json(text)
    old = before.get("mcpServers", {}).get("mvhub")
    if old is None or not _known_entry(old, setup):
        return text
    _replaceable(old, "claude")
    return json.dumps(_without_server(before, "mcpServers"), ensure_ascii=False, indent=2) + "\n"


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


def write_panel_profile(setup: dict, credential: dict, *, local_appdata: Path | None = None) -> dict:
    """Ask Agent 칸 전용 — 전역 LLM 설정 파일은 건드리지 않고 칸 폴더에 암호화 프로필만 쓴다.
    반환 = 어댑터 실행 entry(--panel). 비밀값은 프로필 파일 안에만 있고 entry·명령줄에는 경로만 있다."""
    credential = _profile(credential)
    if credential["url"] != setup.get("url"):
        raise ValueError("허브 주소가 일치하지 않습니다.")
    if not all(isinstance(setup.get(key), str) and Path(setup[key]).is_file() for key in ("python", "adapter")):
        raise ValueError("MCP 실행 파일이 없습니다. 앱 설치 상태를 확인하세요.")
    _require_interactive_user()
    local = Path(local_appdata) if local_appdata is not None else Path(os.environ.get("LOCALAPPDATA", ""))
    if local_appdata is None and not os.environ.get("LOCALAPPDATA"):
        raise ValueError("Windows 사용자 저장 폴더를 확인할 수 없습니다.")
    profile = local / "MVHub" / "agent_chat" / "profiles" / credential["hub_id"] / (credential["client_id"] + ".bin")
    with _LOCK:
        _atomic(profile, _crypt(json.dumps(credential).encode("utf-8")))
    entry = _entry(setup, profile, "panel")
    entry["args"].append("--panel")
    return entry


def configure_client(client: str, setup: dict, credential: dict, *, home: Path | None = None,
                     local_appdata: Path | None = None, appdata: Path | None = None) -> dict:
    """Called only after app-side account/scope consent. Never returns credential contents."""
    if client not in {"codex", "claude", "claude_desktop", "other"}:
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
    desktop = None
    if client == "claude_desktop":
        if appdata is None and not os.environ.get("APPDATA"):
            raise ValueError("Windows 사용자 저장 폴더를 확인할 수 없습니다.")
        # shortcut: MSIX 가상화 경로(%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude)는 보지 않는다 — 그 판을 쓰는 PC 가 나오면 더한다
        desktop = Path(appdata if appdata is not None else os.environ["APPDATA"]) / "Claude" / "claude_desktop_config.json"
        if not desktop.parent.is_dir():  # 데스크톱 앱이 없으면 프로필도 만들지 않는다
            return {"client": client, "status": "skipped", "message": "Claude 데스크톱 앱이 없어 건너뛰었습니다."}
        if _desktop_app_running(desktop.parent):  # 켜진 앱은 옛 내용으로 설정 파일 전체를 다시 써 넣은 항목을 지운다(10-29 실측)
            return {"client": client, "status": "skipped",
                    "message": "Claude 앱이 켜져 있어 데스크톱 채팅 등록을 건너뛰었습니다. 앱을 트레이에서 완전히 종료한 뒤 다시 누르세요."}
    name = server_name(setup)
    profile = local / "MVHub-MCP" / "connections" / credential["hub_id"] / (credential["client_id"] + ".bin")
    entry = _entry(setup, profile, client)
    config = _toml_entry(entry, name) if client == "codex" else json.dumps({"mcpServers": {name: entry}}, ensure_ascii=False, indent=2)
    with _LOCK:
        _atomic(profile, _crypt(json.dumps(credential).encode("utf-8")))
        if client == "other":
            return {"client": client, "status": "manual", "message": "사용할 MCP 앱에 이 설정을 한 번 등록하세요.", "config": config}
        if client == "claude" and home is None and os.environ.get("CLAUDE_CONFIG_DIR"):
            return {"client": client, "status": "manual", "message": "Claude가 별도 설정 폴더를 사용합니다. 해당 프로그램에 이 설정을 등록하세요.", "config": config}
        if desktop is not None:
            path = desktop
        else:
            codex_home = Path(os.environ["CODEX_HOME"]) if home is None and os.environ.get("CODEX_HOME") else user_home / ".codex"
            path = (codex_home / "config.toml") if client == "codex" else (user_home / ".claude.json")
            installed = path.exists() or bool(shutil.which("codex" if client == "codex" else "claude"))
            if not installed:
                return {"client": client, "status": "manual", "message": "프로그램 설치를 확인하지 못했습니다. 설치 후 설정을 등록하세요.", "config": config}
        with _file_lock(path):
            previous = _read_config(path)
            try:
                text = previous.decode("utf-8-sig") if previous else ""
                update = {"codex": update_codex, "claude": update_claude, "claude_desktop": update_claude_desktop}[client]
                updated = update(text, entry, setup, name)
                if name != "mvhub":
                    updated = drop_old_dev_entry(updated, client, setup)
            except (ValueError, UnicodeError, AttributeError):
                return {"client": client, "status": "manual", "access": "conflict", "message": "기존 설정과 충돌합니다. 사용자 설정을 유지하고 수동으로 연결하세요.", "config": config}
            _save_config(path, previous, updated.encode("utf-8"))
    if desktop is not None:
        return {"client": client, "status": "configured", "message": "등록했습니다. Claude 앱을 켜면 채팅에 나타납니다."}
    access = _claude_access(home, name) if client == "claude" else "allowed"
    return {"client": client, "status": "configured", "access": access,
            "message": "등록했습니다. 실행 중인 LLM에서 MCP를 새로고침하거나 프로그램을 다시 시작하세요."}
