"""설치 루트·데이터 경로·실행 환경·설치 보호 상태를 정한다. 판단만 하고 아무것도 바꾸지 않는다."""
from __future__ import annotations

import base64
import ctypes
import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import names
from .main import STAGES, first_line_path as _first_line_path

# 코드가 든 트리(루트 또는 관리 창 stage)와 서버 설치 루트는 다르다(2단계 설계 3판) — 기록·잠금·Python·데이터는
# 설치 루트, 관리 창 모듈·실행기는 코드 트리. 설치 루트는 시작할 때 configure() 로 정한다(루트 실행이면 같다).
CODE_ROOT = Path(__file__).resolve().parents[2]
ROOT = CODE_ROOT
CREATE_NO_WINDOW = 0x08000000


def configure(install_root: Path) -> None:
    """이 프로세스의 설치 루트를 정한다. stage 사본을 설치 루트로 쓰지 않는다."""
    global ROOT
    root = Path(install_root).resolve()
    if any(part.lower() in (STAGES, "server-stages") for part in root.parts):
        raise ValueError("설치 루트가 stage 사본입니다")
    ROOT = root

# (returncode or None on failure, decoded stdout). 시험은 이것을 바꿔 끼운다.
Runner = Callable[[list[str], float], tuple["int | None", str]]


def windows_dir() -> Path:
    # 환경변수 SystemRoot 는 바꿔치기될 수 있어 OS 에 직접 묻는다.
    buffer = ctypes.create_unicode_buffer(260)
    if ctypes.WinDLL("kernel32").GetWindowsDirectoryW(buffer, len(buffer)):
        return Path(buffer.value)
    return Path(r"C:\Windows")


def powershell_exe() -> Path:
    return windows_dir() / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"


def _hklm(subkey: str, name: str) -> str:
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, subkey) as key:
            value, kind = winreg.QueryValueEx(key, name)
        if kind == winreg.REG_EXPAND_SZ:
            value = winreg.ExpandEnvironmentStrings(value)
    except OSError:
        return ""
    return str(value).strip()


def machine_env(name: str) -> str:
    """서버(SYSTEM 예약 작업)가 보는 기계 환경변수. 이 프로세스 환경은 믿지 않는다."""
    return _hklm(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment", name)


_DRIVE_PATH = re.compile(r"^([A-Za-z]):(?:[\\/]|$)")
_DRIVE_NO_ROOT_DIR, _DRIVE_REMOTE = 1, 4  # GetDriveTypeW


def _drive_type(letter: str) -> int:
    """이 프로세스에서 본 드라이브 종류 — 네트워크에 닿지 않는다(응답 없는 NAS 로 화면이 멈추지 않게)."""
    return int(ctypes.WinDLL("kernel32").GetDriveTypeW(f"{letter}:\\"))


def _connected_remote(letter: str) -> str:
    """이 프로세스에 지금 연결된 네트워크 드라이브의 주소(WNetGetConnectionW, 없으면 '')."""
    buffer = ctypes.create_unicode_buffer(1024)
    size = ctypes.c_ulong(len(buffer))
    try:
        code = ctypes.WinDLL("mpr").WNetGetConnectionW(f"{letter}:", buffer, ctypes.byref(size))
    except OSError:
        return ""
    return buffer.value.strip() if code == 0 else ""


def _mapped_remote(letter: str) -> str:
    """이 사용자가 기억해 둔 네트워크 드라이브의 실제 주소(HKCU\\Network\\<글자>\\RemotePath, 없으면 '')."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, rf"Network\{letter}") as key:
            value, _kind = winreg.QueryValueEx(key, "RemotePath")
    except OSError:
        return ""
    return str(value).strip()


def network_path(value: str) -> tuple[str, str]:
    """Z:\\… 처럼 연결 드라이브로 적은 NAS 경로를 실제 주소(\\\\서버\\공유\\…)로 바꾼다 → (경로, 못 바꾼 이유).

    연결 드라이브는 로그인한 보통 창에만 보인다 — 관리자 권한인 이 창과 SYSTEM 예약 작업에는 Z: 가 없다
    (10-27 서버: 릴리스 폴더 Z:\\… 가 오류 3). 이 창에 연결된 드라이브는 지금 연결을, 이 창에 없는 글자만
    이 계정이 기억해 둔 연결을 쓴다(지금 로컬 디스크인 글자에 남은 옛 기록을 쓰지 않게 — Codex 리뷰 P1).
    로컬 디스크 등은 그대로. 바꾼 주소는 사람이 보고 확인한 뒤에만 저장한다(호출하는 쪽).
    """
    text = value.strip()
    match = _DRIVE_PATH.match(text)
    if not match:
        return text, ""
    letter = match.group(1).upper()
    kind = _drive_type(letter)
    if kind == _DRIVE_REMOTE:
        remote = _connected_remote(letter)
    elif kind == _DRIVE_NO_ROOT_DIR:
        remote = _mapped_remote(letter)
    else:
        return text, ""
    if remote.startswith("\\\\"):
        rest = text[2:].strip("\\/").replace("/", "\\")
        return remote.rstrip("\\") + ("\\" + rest if rest else ""), ""
    return text, (f"{letter}: 드라이브는 관리자 권한인 이 창에서 보이지 않습니다 — 탐색기에서 {letter}: 의 실제 주소를 "
                  "확인해 \\\\서버\\공유\\… 로 적으세요")


@dataclass(frozen=True)
class Installation:
    root: Path
    data_dir: Path
    log_dir: Path
    content_db: Path
    port: int
    port_known: bool       # False = 기계 환경변수에 없어 기본값 8010 으로 추정
    python: Path | None    # .mvhub-runtime\python.txt 가 가리키는 검증된 Python
    problems: tuple[str, ...]
    tls: bool = False      # 기계 환경변수에 인증서가 있으면 https 로 묻는다

    @property
    def logs(self) -> Path:
        return self.root / "logs"

    @property
    def runtime_log(self) -> Path:
        return self.log_dir / names.RUNTIME_LOG


def resolve_installation(root: Path | None = None) -> Installation:
    root = (root or ROOT).resolve()
    problems = []
    if any(part.lower() in ("server-stages", STAGES) for part in root.parts):
        problems.append("stage_copy")          # 서버·관리 창 stage 사본을 설치 루트로 — 거절
    if not (root / ".git").exists():
        problems.append("not_git_clone")
    if not (root / "tools" / "run_update_git.ps1").is_file():
        problems.append("missing_updater")
    python = _first_line_path(root / ".mvhub-runtime" / "python.txt")
    if python is None or not python.is_file():
        python = None
        problems.append("no_runtime_python")
    data = Path(machine_env("CONTENT_HUB_DATA") or root / "backend" / "data")
    content_db = Path(machine_env("CONTENT_HUB_DB") or data / "db" / "content_hub.db")
    log_dir = Path(machine_env("CONTENT_HUB_LOG_DIR") or data / "logs")
    port_text = machine_env("PORT")
    port_known = port_text.isdigit() and 0 < int(port_text) < 65536
    return Installation(root=root, data_dir=data, log_dir=log_dir, content_db=content_db,
                        port=int(port_text) if port_known else names.DEFAULT_PORT,
                        port_known=port_known, python=python, problems=tuple(problems),
                        tls=bool(machine_env("CONTENT_HUB_SSL_CERTFILE")))


def trusted_git() -> Path | None:
    """설치된 Git for Windows 만 — 레지스트리(HKLM)로 찾고 상속 환경(PATH·ProgramW6432)은 쓰지 않는다."""
    bases = []
    install = _hklm(r"SOFTWARE\GitForWindows", "InstallPath")
    if install:
        bases.append(Path(install))
    program_files = _hklm(r"SOFTWARE\Microsoft\Windows\CurrentVersion", "ProgramFilesDir")
    if program_files:
        bases.append(Path(program_files) / "Git")
    for base in bases:
        if base.is_absolute() and (base / "cmd" / "git.exe").is_file():
            return base / "cmd" / "git.exe"
    return None


def node_dir(inst: Installation) -> Path | None:
    # .mvhub-runtime 는 보호 경로(ACL 검사 대상)라 그 안의 기록만 믿는다.
    path = _first_line_path(inst.root / ".mvhub-runtime" / "node_dir.txt")
    return path if path is not None and path.is_dir() else None


def child_env(inst: Installation) -> dict[str, str]:
    """관리자 자식 프로세스에 줄 환경을 새로 만든다. 넘겨받은 PATH·PYEXE·MVHUB_*·CONTENT_HUB_* 는 쓰지 않는다."""
    win = windows_dir()
    system32 = win / "System32"
    path = [system32, win, system32 / "Wbem", system32 / "WindowsPowerShell" / "v1.0"]
    git = trusted_git()
    if git:
        path.insert(0, git.parent)
    node = node_dir(inst)
    if node:
        path.insert(0, node)
    if inst.python:
        path.insert(0, inst.python.parent)
    env = {
        "SystemRoot": str(win), "windir": str(win), "SystemDrive": str(win)[:2],
        "ComSpec": str(system32 / "cmd.exe"),
        "PATH": os.pathsep.join(str(p) for p in path),
        "PATHEXT": ".COM;.EXE;.BAT;.CMD;.PS1",
        "PSModulePath": str(system32 / "WindowsPowerShell" / "v1.0" / "Modules"),
        "MVHUB_NO_PAUSE": "1", "CONTENT_HUB_NO_PAUSE": "1", "PYTHONUTF8": "1",
    }
    # 사용자 프로필 위치(git·npm 캐시)와 하드웨어 정보는 승격된 이 사용자 것 그대로 둔다.
    for key in ("USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "USERNAME",
                "USERDOMAIN", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
                "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData",
                "CommonProgramFiles", "CommonProgramW6432"):
        value = os.environ.get(key)
        if value:
            env[key] = value
    temp = os.environ.get("TEMP", "")
    env["TEMP"] = env["TMP"] = temp if temp and Path(temp).is_dir() else str(win / "Temp")
    if inst.python:
        env["PYEXE"] = str(inst.python)  # run_py.bat 이 사용자 PATH 대신 검증된 Python 을 쓰게
    return env


def run_command(argv: list[str], timeout: float, env: dict[str, str] | None = None) -> tuple[int | None, str]:
    try:
        done = subprocess.run(argv, capture_output=True, timeout=timeout, creationflags=CREATE_NO_WINDOW,
                              env=env, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None, ""
    return done.returncode, done.stdout.decode("utf-8", errors="replace")


def default_runner(inst: Installation) -> Runner:
    env = child_env(inst)
    return lambda argv, timeout: run_command(argv, timeout, env)


def ps_items(values) -> str:
    """PowerShell 식으로 문자열 목록을 넘긴다. 따옴표(유니코드 ’ 포함)로 빠져나갈 수 없게 base64 JSON 으로만."""
    data = base64.b64encode(json.dumps([str(v) for v in values], ensure_ascii=False).encode("utf-8")).decode("ascii")
    return f"(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{data}'))))"


# 쓰기·삭제·권한/소유자 변경으로 이어지는 권한 비트(숫자로만 판정 — 이름 문자열은 지역화·조합이 다양하다).
_WRITE_BITS = (0x2 | 0x4 | 0x10 | 0x40 | 0x100     # WriteData·AppendData·WriteEA·DeleteChild·WriteAttributes
               | 0x10000 | 0x40000 | 0x80000         # DELETE·WRITE_DAC·WRITE_OWNER
               | 0x10000000 | 0x40000000)             # GENERIC_ALL·GENERIC_WRITE


# 상위 폴더에서는 그 안의 우리 폴더를 지우거나 이름을 바꿔 바꿔치기할 수 있는 권한만 본다.
_REPLACE_BITS = (0x40 | 0x10000                       # DeleteChild·DELETE(상위 폴더 자체 이름 바꾸기)
                 | 0x40000 | 0x80000 | 0x10000000)     # WRITE_DAC·WRITE_OWNER·GENERIC_ALL


def _has_bits(rights: str, bits: int) -> bool:
    text = rights.strip()
    return text.lstrip("-").isdigit() and bool(int(text) & bits)


def _python_parts(python: Path) -> list[Path]:
    """볼 경로. venv 면 그 venv 와 pyvenv.cfg 의 home(실제로 표준 라이브러리를 읽는 Python)까지."""
    base = python.parent
    cfg = base.parent / "pyvenv.cfg"
    if cfg.is_file():
        venv = base.parent
        single = [venv, cfg, base, python, base / "pythonw.exe", venv / "Lib", venv / "Lib" / "site-packages"]
        try:
            home = next((line.split("=", 1)[1].strip() for line in cfg.read_text(encoding="utf-8").splitlines()
                         if line.split("=", 1)[0].strip().lower() == "home"), "")
        except OSError:
            home = ""
        if home and Path(home).is_absolute() and (Path(home) / "python.exe").is_file():
            single += _python_parts(Path(home) / "python.exe")
        return single
    single = [base, python, base / "pythonw.exe", base / "Lib", base / "DLLs", base / "Lib" / "site-packages"]
    single += list(base.glob("*.dll")) if base.is_dir() else []  # python3xx.dll·vcruntime 등 함께 로드되는 것
    return single


def protected_targets(inst: Installation) -> tuple[list[Path], list[Path], list[Path]]:
    """(그 자리만 볼 경로, 하위까지 볼 폴더, 상위 폴더). 관리자 권한으로 실행·import·설정으로 읽히는 것.

    shortcut: Python·Git·Node 는 설치 폴더 전체(이 PC 실측 Python 6만 개 175초·Git 1만 개 37초)를 훑지 않고
    실행 파일·DLL·핵심 폴더·설정 파일과 그 위 폴더만 본다. 하위 파일 하나하나의 별도 권한은 못 잡는다.
    """
    root = inst.root
    git_dir = root / ".git"
    single = [root, root / "backend", root / ".mvhub-runtime", inst.logs, git_dir, git_dir / "config",
              inst.logs / "console-current.json"]  # 관리 창 stage 포인터(2단계) — 포인터·목록·코드를 같이 바꾸면 해시로 못 막는다
    single += [p for p in root.iterdir() if p.is_file() and p.suffix.lower() in (".bat", ".cmd", ".ps1", ".py")] \
        if root.is_dir() else []
    single += [p for p in (root / "backend").glob("*.py")] if (root / "backend").is_dir() else []
    single += [p for p in (root / ".mvhub-runtime").glob("*") if p.is_file()] if (root / ".mvhub-runtime").is_dir() else []
    # 우리가 돌리는 코드·Git 이 실행하는 훅·업데이터가 돌리는 검증용 Python 은 하위까지 전부
    tree = [root / "tools", root / "backend" / "app", git_dir / "hooks", inst.logs / "server-verifier",
            inst.logs / STAGES]
    if inst.python:
        single += _python_parts(inst.python)
    node = node_dir(inst)
    if node:
        single += [node, node / "node.exe", node / "npm.cmd", node / "npx.cmd", node / "node_modules" / "npm"]
    git = trusted_git()
    if git:
        git_root = git.parent.parent
        single += [git_root, git.parent, git, git_root / "etc" / "gitconfig", git_root / "mingw64" / "bin" / "git.exe",
                   git_root / "mingw64" / "etc" / "gitconfig"]
    single = [p for p in dict.fromkeys(single) if p.exists()]
    tree = [p for p in tree if p.is_dir()]
    # 검사하는 모든 대상의 위 폴더 전부(예: mingw64\bin 에 DeleteChild 가 있으면 안전한 git.exe 도 바꿔치기된다).
    seen = set(single) | set(tree)
    parents = [p for p in dict.fromkeys(a for target in (*single, *tree) for a in target.parents) if p not in seen]
    return single, tree, [p for p in parents if p.exists()]


_ACL_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
function Show($item, $kind) {
  $acl = Get-Acl -LiteralPath $item.FullName
  try { $own = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $own = [string]$acl.Owner }
  "OWNER`t$kind`t$($item.FullName)`t$own"
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { "LINK`t$kind`t$($item.FullName)" }
  foreach ($a in $acl.Access) {
    if ([string]$a.AccessControlType -ne 'Allow') { continue }
    try { $sid = $a.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $sid = [string]$a.IdentityReference }
    $io = if ($a.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { 1 } else { 0 }
    "ACE`t$kind`t$($item.FullName)`t$sid`t$([int64]$a.FileSystemRights)`t$io"
  }
}
$single = __SINGLE__
$tree = __TREE__
$parents = __PARENTS__
foreach ($p in $parents) { Show (Get-Item -LiteralPath $p -Force) 'p' }
foreach ($p in $single) { Show (Get-Item -LiteralPath $p -Force) 'o' }
foreach ($p in $tree) {
  Show (Get-Item -LiteralPath $p -Force) 'o'
  Get-ChildItem -LiteralPath $p -Recurse -Force -Attributes !ReparsePoint | ForEach-Object { Show $_ 'o' }
  Get-ChildItem -LiteralPath $p -Recurse -Force -Attributes ReparsePoint | ForEach-Object { "LINK`to`t$($_.FullName)" }
}
"DONE"
"""

Offender = tuple[str, str, str]  # (경로, SID 또는 '-', 이유)


def acl_offenders(single: list[Path], tree: list[Path], runner: Runner,
                  parents: list[Path] = ()) -> list[Offender] | None:
    """Administrators·SYSTEM·TrustedInstaller 밖에서 쓰거나 소유한 항목, 연결 지점. None = 확인 실패.

    창을 연 관리자 자신도 예외가 아니다 — 같은 계정의 승격 안 된 프로그램이 소유자 권한으로 권한을 바꿀 수 있다.
    상위 폴더(parents)는 그 폴더에 실제로 걸린 권한(상속 전용 제외) 중 바꿔치기 권한만 본다.
    """
    if not single and not tree and not parents:
        return []
    script = (_ACL_SCRIPT.replace("__SINGLE__", ps_items(single)).replace("__TREE__", ps_items(tree))
              .replace("__PARENTS__", ps_items(parents)))
    code, out = runner([str(powershell_exe()), "-NoProfile", "-NonInteractive", "-Command", script], 180)
    lines = out.splitlines()
    if code != 0 or not lines or lines[-1].strip() != "DONE":
        return None
    offenders: list[Offender] = []
    for line in lines:
        parts = line.rstrip("\r").split("\t")
        if parts[0] == "ACE" and len(parts) == 6 and parts[3] not in names.TRUSTED_WRITERS:
            _tag, kind, path, sid, rights, inherit_only = parts
            if kind == "p":
                if inherit_only != "1" and _has_bits(rights, _REPLACE_BITS):
                    offenders.append((path, sid, "상위 폴더 바꿔치기 권한"))
            elif _has_bits(rights, _WRITE_BITS):
                offenders.append((path, sid, "쓰기 권한"))
        elif parts[0] == "OWNER" and len(parts) == 4 and parts[3] not in names.TRUSTED_WRITERS:
            offenders.append((parts[2], parts[3], "소유자"))
        elif parts[0] == "LINK" and len(parts) == 3:
            offenders.append((parts[2], "-", "연결 지점"))
    return offenders


def untrusted_writers(inst: Installation, runner: Runner) -> list[Offender] | None:
    """관리자 권한으로 돌릴 설치 코드·Python·Git·Node 가 보호돼 있는지. None = 확인 실패.

    알림 전용이라(actions.acl_warnings) 어떤 실패도 업데이트를 막지 않게 None 으로 돌려준다.
    """
    try:
        single, tree, parents = protected_targets(inst)
        return acl_offenders(single, tree, runner, parents)
    except Exception:  # noqa: BLE001 — 대상 목록을 못 읽는 등(PermissionError) — 알림 '확인하지 못했습니다'로
        return None


_TASK_SCRIPT = r"""
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
foreach ($n in __ITEMS__) {
  try {
    $t = Get-ScheduledTask -TaskName $n -ErrorAction Stop
    $act = ($t.Actions | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments }) -join ' ;; '
    "TASK`t$n`t$($t.State)`t$act"
  } catch {
    if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { "TASK`t$n`tMissing`t" } else { "TASK`t$n`tError`t" }
  }
}
"DONE"
"""


def task_states(runner: Runner) -> dict[str, dict[str, str]] | None:
    """예약 작업 3개의 상태(Ready·Running·Disabled·Missing·Error)와 실행 명령. None = 조회 실패."""
    code, out = runner([str(powershell_exe()), "-NoProfile", "-NonInteractive", "-Command",
                        _TASK_SCRIPT.replace("__ITEMS__", ps_items(names.TASKS))], 30)
    if code != 0 or "DONE" not in (line.strip() for line in out.splitlines()):
        return None
    states = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 4 and parts[0] == "TASK":
            states[parts[1]] = {"state": parts[2], "action": parts[3]}
    return states if set(states) == set(names.TASKS) else None


def task_root(action: str) -> Path | None:
    """예약 작업 실행 명령에서 task_launch.bat 이 있는 설치 루트를 꺼낸다."""
    match = re.search(r'"?([A-Za-z]:\\[^"]*?)\\task_launch\.bat"?', action, re.IGNORECASE)
    return Path(match.group(1)) if match else None


def server_task_matches(inst: Installation, tasks: dict[str, dict[str, str]] | None) -> str:
    """'match' | 'missing' | 'other' | 'unknown' — 이 설치가 실제 서버 예약 작업의 루트인지."""
    if tasks is None:
        return "unknown"
    server = tasks.get(names.TASK_SERVER) or {}
    if server.get("state") == "Missing":
        return "missing"
    if server.get("state") in (None, "", "Error"):
        return "unknown"
    root = task_root(server.get("action", ""))
    if root is None:
        return "unknown"
    try:
        return "match" if os.path.normcase(str(root.resolve())) == os.path.normcase(str(inst.root)) else "other"
    except OSError:
        return "unknown"


_NIC_SCRIPT = r"""
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { "NIC`t$($_.InterfaceAlias)`t$($_.IPAddress)" }
"DONE"
"""


def addresses(runner: Runner) -> list[tuple[str, str]] | None:
    """(네트워크 이름, IPv4) 목록. None = 조회 실패."""
    code, out = runner([str(powershell_exe()), "-NoProfile", "-NonInteractive", "-Command", _NIC_SCRIPT], 30)
    lines = out.splitlines()
    if code != 0 or "DONE" not in (line.strip() for line in lines):
        return None
    result = []
    for line in lines:
        parts = line.rstrip("\r").split("\t")
        if len(parts) == 3 and parts[0] == "NIC":
            result.append((parts[1], parts[2]))
    return result
