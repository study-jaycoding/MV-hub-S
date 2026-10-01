r"""쉬운 서버 이사 — 옛 서버 OUT · 새 서버 IN · 옛 서버 UNDO (Windows 공유 서버 전용).

  server_move_OUT.bat   옛 서버에서: 생성 접수 멈춤 → 진행 중 0 대기 → 정지 → 최종 확인 → 바탕화면에 이사 폴더
  server_move_IN.bat    새 서버에서: 바탕화면 이사 폴더 → 점검 → 검증·설치 → 설정 → 자동시작 → ready
  server_move_UNDO.bat  옛 서버에서: OUT 전 상태로 되돌리기 (새 PC 가 옛 IP 를 받기 전까지만)

저수준 export·드릴·설치는 server_move.py 를 그대로 쓴다. 이 파일은 그 앞뒤에서 사람이 손으로 하던 일을
묶는다. 설계와 Codex 검토 조건: docs/SERVER_MIGRATION.md 의 '쉬운 이사'.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import server_move as sm  # noqa: E402 — backend 경로도 여기서 잡힌다
from app.services.sqlite_db import read_only_uri  # noqa: E402
from deploy_fence_check import PAUSE_SETTING_KEY, inspect_fence  # noqa: E402

MoveError = sm.MoveError

# 끄는 순서 — 워치독이 서버가 사라지는 것을 장애로 보지 않게 먼저.
TASKS = ("MVHub Watchdog", "MVHub Server", "MVHub BackupCopy")
RESTART_TASKS = ("MVHub Server", "MVHub Watchdog")  # UNDO 가 다시 켜는 것(BackupCopy 는 임의로 안 돌린다)
STATE_NAME = "server_move_out_state.json"  # 옛 서버: 되돌리기에 쓰는 원래 상태
IN_STATE_NAME = "server_move_in_state.json"  # 새 서버: 설치까지 마쳤는지(이어서 하기)
SETTINGS_NAME = "machine_settings.json"
PACKAGE_PREFIX = "MVHub_server_move_"
UNDO_SHORTCUT = "MVHub_server_UNDO.bat"
REPLICA_PATH = TOOLS / "backup_replica_target.txt"  # NAS 백업 복제 대상(옮기는 txt 는 이것 하나)
RUNTIME_PYTHON_FILE = ROOT / ".mvhub-runtime" / "python.txt"  # register_autostart 가 기록한 예약 서버 파이썬
BOOTSTRAP_FILE = "bootstrap_admin_password.txt"
KST_ZONE = "Korea Standard Time"
FENCE_WAIT_SECONDS = 15 * 60
FENCE_POLL_SECONDS = 15

# 새 서버에 자동으로 적용하는 기계 환경변수 — 이름으로만 고른다(나머지는 담아만 두고 화면에 이름을 알린다).
APPLY_ENV = (
    "CONTENT_HUB_ASSET_REGISTRY",
    "CONTENT_HUB_ASSET_REGISTRY_DRIVES",
    "CONTENT_HUB_ASSET_REGISTRY_INTERVAL_MIN",
    "CONTENT_HUB_ASSET_REGISTRY_MIBPS",
    "CONTENT_HUB_MEDIA_PRESERVATION",
    "CONTENT_HUB_MEDIA_PRESERVATION_INTERVAL_SECONDS",
    "CONTENT_HUB_MEDIA_PRESERVATION_MAX_ATTEMPTS",
    "CONTENT_HUB_MEDIA_PRESERVATION_STARTUP_DELAY_SECONDS",
)
# 옛 서버에 이것이 있었다면 표준 배치가 아니다 — 이 도구로 옮기지 않고 수동 절차로(경로·TLS 를 새 PC 에서 다시 정해야 한다).
REFUSE_ENV = ("CONTENT_HUB_DATA", "CONTENT_HUB_DB", "CONTENT_HUB_SSL_CERTFILE", "CONTENT_HUB_SSL_KEYFILE")

_say = sm._say


# ---------------------------------------------------------------- 공통


def _ask(question: str) -> bool:
    """Y 를 입력해야만 진행한다. 시험은 이 함수를 바꿔 끼운다."""
    return input(f"{question} [Y/N] ").strip().lower() in ("y", "yes")


def _ask_word(question: str, word: str) -> bool:
    return input(f"{question} ").strip() == word


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    """복구 표식 — 전원이 꺼져도 반쪽 파일이 남지 않게 디스크까지 쓴 뒤 이름을 바꾼다(설치 journal 과 같은 원칙)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, indent=2))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _read_json(path: Path, what: str) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise MoveError(f"{what}을 읽지 못했습니다: {path} ({exc}) — 수동 확인이 필요합니다") from exc
    if not isinstance(data, dict):
        raise MoveError(f"{what} 형식이 올바르지 않습니다: {path} — 수동 확인이 필요합니다")
    return data


def _require_windows_admin() -> None:
    if os.name != "nt":
        raise MoveError("이 도구는 Windows 공유 서버 전용입니다")
    import ctypes  # noqa: PLC0415

    if not ctypes.windll.shell32.IsUserAnAdmin():
        raise MoveError("관리자 권한이 필요합니다 — bat 을 두 번 눌러 실행하세요(스스로 권한을 요청합니다)")


def desktop_dir() -> Path:
    """이 사용자의 바탕화면(OneDrive 로 옮겨진 경우 포함) — Windows 셸 폴더 API."""
    import ctypes  # noqa: PLC0415
    import uuid  # noqa: PLC0415

    class _Guid(ctypes.Structure):
        _fields_ = [
            ("data1", ctypes.c_ulong),
            ("data2", ctypes.c_ushort),
            ("data3", ctypes.c_ushort),
            ("data4", ctypes.c_ubyte * 8),
        ]

    folder = uuid.UUID("{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}")  # FOLDERID_Desktop
    guid = _Guid(
        folder.time_low,
        folder.time_mid,
        folder.time_hi_version,
        (ctypes.c_ubyte * 8).from_buffer_copy(folder.bytes[8:]),
    )
    out = ctypes.c_wchar_p()
    if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(out)) != 0:
        raise MoveError("바탕화면 위치를 찾지 못했습니다")
    try:
        return Path(out.value)
    finally:
        ctypes.windll.ole32.CoTaskMemFree(out)


def task_snapshot() -> dict[str, dict[str, bool]]:
    """세 예약 작업 각각의 존재·사용·실행 여부. 조회가 실패하면 진행하지 않는다."""
    names = ",".join("'" + name + "'" for name in TASKS)
    rows, ok = sm._ps_json(
        "Get-ScheduledTask -ErrorAction Stop"
        " | Where-Object { $_.TaskName -in @(" + names + ") }"
        " | Select-Object TaskName, @{n='State';e={$_.State.ToString()}}"
    )
    if not ok:
        raise MoveError("예약 작업 상태를 읽지 못했습니다 — 관리자 권한으로 실행하세요")
    states = {
        row["TaskName"]: row["State"]
        for row in rows
        if isinstance(row, dict) and isinstance(row.get("TaskName"), str) and isinstance(row.get("State"), str)
    }
    return {
        name: {
            "exists": name in states,
            "enabled": states.get(name) not in (None, "Disabled"),
            "running": states.get(name) == "Running",
        }
        for name in TASKS
    }


def _schtasks(*args: str, check: bool = True) -> int:
    code = subprocess.run(["schtasks", *args], capture_output=True).returncode
    if check and code != 0:
        raise MoveError(f"schtasks {' '.join(args)} 실패(코드 {code})")
    return code


def read_pause(db: Path) -> str | None:
    with closing(sqlite3.connect(read_only_uri(db, immutable=False), uri=True)) as conn:
        row = conn.execute("SELECT value FROM app_setting WHERE key=?", (PAUSE_SETTING_KEY,)).fetchone()
    return None if row is None else row[0]


def write_pause(db: Path, value: str | None, *, attempts: int = 20) -> None:
    """생성 접수 멈춤 값을 DB 에 직접 쓴다 — 서버는 요청마다 DB 에서 읽는다(gen_requests._generation_deployment_paused).
    켜진 서버와 잠금을 다툴 수 있어 짧게 여러 번 시도한다. None 은 '원래 값 없음'으로 되돌리기."""
    for attempt in range(attempts):
        try:
            with closing(sqlite3.connect(str(db), timeout=5)) as conn:
                if value is None:
                    conn.execute("DELETE FROM app_setting WHERE key=?", (PAUSE_SETTING_KEY,))
                else:
                    conn.execute(
                        "INSERT INTO app_setting(key, value) VALUES(?,?) "
                        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (PAUSE_SETTING_KEY, value),
                    )
                conn.commit()
            return
        except sqlite3.OperationalError as exc:
            if "locked" not in str(exc).lower() or attempt == attempts - 1:
                raise
            time.sleep(0.5)


def wait_ready(port: int, timeout: float = 180.0) -> bool:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with opener.open(f"http://127.0.0.1:{port}/api/ready", timeout=5) as response:
                if response.status == 200:
                    return True
        except OSError:
            pass
        time.sleep(2)
    return False


def our_processes() -> list[dict[str, Any]]:
    """이 저장소의 서버·감독기·워치독(server_move 와 같은 판별) + 백업 복제 프로세스."""
    procs, ok = sm.running_server_processes()
    if not ok:
        raise MoveError("프로세스 목록을 읽지 못했습니다")
    rows, ok = sm._ps_json("Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, CommandLine")
    if not ok:
        raise MoveError("프로세스 목록을 읽지 못했습니다")
    root_key = os.path.normcase(str(ROOT))
    for row in rows:
        command_line = row.get("CommandLine") if isinstance(row, dict) else None
        if isinstance(command_line, str) and "backup_replicate.py" in command_line and root_key in os.path.normcase(command_line):
            procs.append({"pid": int(row.get("ProcessId") or 0), "why": "backup_replicate", "command_line": command_line})
    return [proc for proc in procs if proc["pid"] > 0]


def _stop_our_processes(procs: list[dict[str, Any]]) -> None:
    _say("  아래 프로세스를 끝냅니다(이 저장소 서버 프로그램만):")
    for proc in procs:
        _say(f"    PID {proc['pid']} ({proc['why']}) {proc['command_line'][:120]}")
    if not _ask("  끝낼까요?"):
        raise MoveError("프로세스 정리를 취소했습니다")
    # 감독기·워치독을 먼저 — serve.py 를 먼저 끄면 감독기가 곧바로 다시 띄운다. /T 는 자식(serve.py)까지.
    for proc in sorted(procs, key=lambda item: item["why"] != "supervisor/watchdog"):
        subprocess.run(["taskkill", "/PID", str(proc["pid"]), "/T", "/F"], capture_output=True)


# ---------------------------------------------------------------- 기계 설정


def machine_env() -> dict[str, str]:
    """기계(Machine) 범위의 CONTENT_HUB_* 환경변수 전부 — 예약 작업(SYSTEM)이 보는 값."""
    import winreg  # noqa: PLC0415

    values: dict[str, str] = {}
    with winreg.OpenKey(
        winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
    ) as key:
        index = 0
        while True:
            try:
                name, value, _kind = winreg.EnumValue(key, index)
            except OSError:
                break
            if name.upper().startswith("CONTENT_HUB_"):
                values[name.upper()] = str(value)
            index += 1
    return values


def set_machine_env(name: str, value: str) -> None:
    """[Environment]::SetEnvironmentVariable(…, 'Machine') — 값은 환경변수로 넘겨 따옴표 문제를 피한다."""
    env = dict(os.environ, MVHUB_SET_NAME=name, MVHUB_SET_VALUE=value)
    code = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            "[Environment]::SetEnvironmentVariable($env:MVHUB_SET_NAME, $env:MVHUB_SET_VALUE, 'Machine')",
        ],
        capture_output=True,
        env=env,
    ).returncode
    if code != 0:
        raise MoveError(f"기계 환경변수 {name} 를 쓰지 못했습니다")


def network_snapshot() -> list[dict[str, Any]]:
    rows, ok = sm._ps_json(
        "Get-NetIPConfiguration -ErrorAction Stop"
        " | Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' }"
        " | ForEach-Object { $ip = @($_.IPv4Address)[0]; [pscustomobject]@{"
        " InterfaceAlias = $_.InterfaceAlias; IPv4 = $ip.IPAddress; Prefix = $ip.PrefixLength;"
        " Gateway = @($_.IPv4DefaultGateway)[0].NextHop;"
        " Dns = @($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses });"
        " Dhcp = (Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4).Dhcp.ToString() } }"
    )
    return [row for row in rows if isinstance(row, dict)] if ok else []


def time_zone() -> str:
    return subprocess.run(["tzutil", "/g"], capture_output=True, text=True).stdout.strip()


def firewall_allows(port: int) -> bool:
    rows, ok = sm._ps_json(
        "@(Get-NetFirewallPortFilter -ErrorAction Stop"
        " | Where-Object { $_.Protocol -eq 'TCP' -and @($_.LocalPort) -contains '" + str(int(port)) + "' }"
        " | Get-NetFirewallRule -ErrorAction SilentlyContinue"
        " | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }).Count"
    )
    return ok and bool(rows) and isinstance(rows[0], int) and rows[0] > 0


# ---------------------------------------------------------------- OUT


def _undo_launcher_text() -> str:
    target = ROOT / "server_move_UNDO.bat"
    return f'@echo off\r\nREM MV Hub server move UNDO - valid only before the new PC takes this server IP.\r\ncall "{target}"\r\n'


def _state_path(data_dir: Path) -> Path:
    return data_dir / STATE_NAME


def _save_state(path: Path, state: dict[str, Any], phase: str) -> None:
    state["phase"] = phase
    state["updated_at"] = _utc_now()
    _atomic_json(path, state)


def cmd_out(args: argparse.Namespace) -> int:
    _require_windows_admin()
    if not str(ROOT).isascii():
        raise MoveError(f"저장소 경로에 영문 외 글자가 있어 되돌리기 bat 을 만들 수 없습니다: {ROOT}")
    # 예약 서버(SYSTEM)는 기계 변수, 이 창은 사용자 변수까지 본다 — 어느 쪽이든 경로·TLS 를 바꿨으면 이 창이 고르는 DB 가
    # 실제 서버 DB 와 다를 수 있다. 표준 배치만 이 길로 옮긴다.
    refused = [name for name in REFUSE_ENV if machine_env().get(name) or os.environ.get(name)]
    if refused:
        raise MoveError(
            "이 서버(또는 이 창)에 " + ", ".join(refused) + " 가 설정돼 있습니다 — 표준 배치가 아니라 수동 절차로 옮기세요"
        )
    data_dir = sm.resolve_data_dir(args.data_dir)
    live = sm.role_live_paths(data_dir)
    if len({path.parent for path in live.values()}) != 1 or not live["content"].is_file():
        raise MoveError(f"표준 배치(세 DB 가 한 폴더)가 아닙니다 — 수동 절차(docs/SERVER_MIGRATION.md)로 하세요: {data_dir}")
    state_path = _state_path(data_dir)
    if state_path.is_file():
        previous = _read_json(state_path, "이전 OUT 기록")
        if previous.get("phase") != "undone":
            # 다시 기록하면 '원래 상태'가 이미 멈춘·꺼진 값으로 바뀌어 되돌리기가 틀린 곳으로 돌아간다.
            raise MoveError(
                f"끝나지 않은 이전 OUT 기록이 있습니다(단계: {previous.get('phase')}) — 처음 상태를 지키려고 덮어쓰지 않습니다.\n"
                f"  바탕화면 {UNDO_SHORTCUT} 로 되돌린 뒤 OUT 을 다시 실행하세요."
            )
    desktop = desktop_dir()
    stamp = sm._now_stamp()[:15]
    package = desktop / f"{PACKAGE_PREFIX}{stamp}"
    if package.exists():
        raise MoveError(f"이미 있는 폴더입니다: {package}")

    _say("=" * 68)
    _say("  서버 이사 — 옛 서버에서 내보내기")
    _say("=" * 68)
    _say(f"  데이터 폴더 : {data_dir}")
    _say(f"  이사 폴더   : {package}")
    _say("  순서: 생성 접수 멈춤 → 진행 중 0 대기 → 서버 정지 → 최종 확인 → 내보내기 (팀 공유 약 30분 중단)")
    _say()
    if not args.yes and not _ask("진행할까요?"):
        return 1

    # ★첫 변경 전에: 되돌리기에 필요한 원래 상태와 되돌리기 bat 을 먼저 만든다(중간에 창·전원이 끊겨도 되돌릴 수 있게).
    state: dict[str, Any] = {
        "format": 1,
        "created_at": _utc_now(),
        "data_dir": str(data_dir),
        "content_db": str(live["content"]),
        "package_dir": str(package),
        "port": args.port,
        "tasks": task_snapshot(),
        "pause_original": read_pause(live["content"]),
    }
    _save_state(state_path, state, "prepared")
    (desktop / UNDO_SHORTCUT).write_text(_undo_launcher_text(), encoding="ascii")
    _say(f"  되돌리기 준비: 바탕화면 {UNDO_SHORTCUT} (새 PC 가 이 서버 IP 를 받기 전까지만 쓰세요)")

    _say("[1/6] 생성 접수 멈춤")
    write_pause(live["content"], "1")
    _save_state(state_path, state, "paused")

    _say("[2/6] 진행 중인 생성이 끝나기를 기다림(15초마다, 최대 15분)")
    deadline = time.monotonic() + args.fence_wait
    while True:
        fence = inspect_fence(live["content"])
        _say(f"      남은 요청 {fence['non_terminal_request_total']} · 진행 중 생성 {fence['active_generation_total']}")
        if fence["safe"]:
            break
        if time.monotonic() >= deadline:
            raise MoveError(
                "진행 중인 생성이 끝나지 않았습니다 — 서버는 아직 켜져 있고 생성 접수만 멈춘 상태입니다.\n"
                f"  요청: {fence['non_terminal_request_counts']}  생성: {fence['active_generation_counts']}\n"
                f"  바탕화면 {UNDO_SHORTCUT} 로 되돌린 뒤, 생성이 끝나면 OUT 을 다시 실행하세요."
            )
        time.sleep(FENCE_POLL_SECONDS)

    _say("[3/6] 서버 정지(예약 작업 사용 안 함 → 끝내기)")
    for name in TASKS:
        if state["tasks"][name]["exists"]:
            _schtasks("/Change", "/TN", name, "/DISABLE")
    for name in TASKS:
        if state["tasks"][name]["exists"]:
            _schtasks("/End", "/TN", name, check=False)  # 이미 멈춘 작업이면 실패해도 된다
    time.sleep(2)
    leftovers = our_processes()
    if leftovers:
        _stop_our_processes(leftovers)
    _confirm_stopped(args.port)
    _save_state(state_path, state, "stopped")

    _say("[4/6] 정지 상태에서 최종 확인")
    sm.checkpoint_live_dbs(live)
    final = inspect_fence(live["content"])
    if not final["safe"]:
        raise MoveError(
            "정지 직전에 들어온 생성 기록이 있습니다 — 내보내지 않습니다.\n"
            f"  요청: {final['non_terminal_request_counts']}  생성: {final['active_generation_counts']}\n"
            f"  바탕화면 {UNDO_SHORTCUT} 로 서버를 되돌린 뒤 원인을 확인하세요."
        )

    _say("[5/6] 내보내기")
    media = machine_env().get("CONTENT_HUB_MEDIA_PRESERVATION", "0").strip().lower() in ("1", "true", "yes", "on")
    sm.cmd_export(
        argparse.Namespace(
            dest=str(package),
            data_dir=str(data_dir),
            content_db=None,
            port=args.port,
            with_worker_backups=True,
            with_media=media,
        ),
        next_steps=False,
    )

    _say("[6/6] 이 PC 설정 담기")
    write_machine_settings(package, data_dir, args.port, state["pause_original"])
    _save_state(state_path, state, "exported")
    _print_out_done(package)
    return 0


def _confirm_stopped(port: int) -> None:
    last: Exception | None = None
    for _ in range(10):
        try:
            sm.ensure_server_stopped(port)
            backup = task_snapshot()["MVHub BackupCopy"]
            if backup["exists"] and (backup["enabled"] or backup["running"]):
                raise sm.ServerActive("  - MVHub BackupCopy 가 아직 사용 중이거나 실행 중입니다")
            if any(proc["why"] == "backup_replicate" for proc in our_processes()):
                raise sm.ServerActive("  - 백업 복제(backup_replicate.py)가 아직 실행 중입니다")
            return
        except sm.ServerActive as exc:
            last = exc
            time.sleep(2)
    raise MoveError(f"서버가 멈췄음을 확인하지 못했습니다:\n{last}")


def write_machine_settings(package: Path, data_dir: Path, port: int, pause_original: str | None) -> None:
    """옛 서버 PC 의 설정을 담고, manifest 에 넣어 새 PC 가 크기·SHA 로 대조하게 한다."""
    networks = network_snapshot()
    replica = REPLICA_PATH
    settings = {
        "format": 1,
        "created_at": _utc_now(),
        "machine_env": machine_env(),
        "backup_replica_target": replica.read_text(encoding="utf-8").strip() if replica.is_file() else None,
        "network": networks,
        "server_url": f"http://{networks[0]['IPv4']}:{port}" if networks else None,
        "port": port,
        "time_zone": time_zone(),
        "python": sys.version.split()[0],
        "sqlite": sqlite3.sqlite_version,
        "git_commit": sm._git_commit(),
        "data_dir": str(data_dir),
        "pause_original": pause_original,
    }
    target = package / SETTINGS_NAME
    _atomic_json(target, settings)
    manifest = sm.read_manifest(package)
    manifest["files"][SETTINGS_NAME] = {
        "role": "settings",
        "bytes": target.stat().st_size,
        "sha256": sm._sha256(target),
    }
    sm.write_manifest(package, manifest)


def _print_out_done(package: Path) -> None:
    _say()
    _say("=" * 68)
    _say("  내보내기 완료 — 이 서버는 꺼진 상태입니다")
    _say("=" * 68)
    _say(f"  1. 바탕화면의 {package.name} 폴더를 새 서버 바탕화면으로 옮기세요(USB·NAS).")
    _say("  2. 새 서버에서 E:\\MV-hub-S\\server_move_IN.bat 을 실행하세요.")
    _say("  3. 새 서버에 이 PC 의 IP 를 주기 전에 이 PC 를 끄거나 랜선을 빼세요.")
    _say(f"  4. 문제가 있으면 바탕화면 {UNDO_SHORTCUT} — 새 PC 가 이 IP 를 받기 전까지만.")
    _say("  5. 이사가 확인되면 이사 폴더(여기·USB·NAS·새 서버)를 지우세요 — 계정·비밀번호 해시가 들어 있습니다.")
    _say()


# ---------------------------------------------------------------- UNDO


def cmd_undo_out(args: argparse.Namespace) -> int:
    _require_windows_admin()
    data_dir = sm.resolve_data_dir(args.data_dir)
    state_path = Path(args.state) if args.state else _state_path(data_dir)
    if not state_path.is_file():
        raise MoveError(f"되돌릴 기록이 없습니다: {state_path}")
    state = _read_json(state_path, "OUT 기록")
    if not _valid_out_state(state) or not _same_path(state["content_db"], sm.role_live_paths(data_dir)["content"]):
        # 무엇이든 바꾸기 전에 멈춘다 — 멈춤 값만 되돌리고 작업 복구에서 깨지거나, 기록이 다른 DB 를 가리키면
        # 실제 서버 DB 는 멈춘 채로 예약 작업만 다시 켜진다.
        raise MoveError(f"OUT 기록이 완전하지 않거나 이 서버의 DB 와 다릅니다: {state_path} — 수동 확인이 필요합니다")
    if state.get("phase") == "undone":
        _say("이미 되돌렸습니다.")
        return 0
    _say("=" * 68)
    _say("  옛 서버를 이사 전 상태로 되돌립니다")
    _say("=" * 68)
    _say("  ★새 PC 에 이 서버의 IP 를 이미 줬다면 하지 마세요 — 두 서버의 자료가 갈라집니다.")
    if not args.yes and not _ask_word("  되돌리려면 UNDO 를 입력하세요:", "UNDO"):
        return 1
    undo_out(state)
    _save_state(state_path, state, "undone")
    _say("  되돌렸습니다.")
    return 0


def _valid_out_state(state: dict[str, Any]) -> bool:
    tasks = state.get("tasks")
    pause = state.get("pause_original")
    port = state.get("port")
    return (
        isinstance(state.get("content_db"), str)
        and bool(state["content_db"])
        and (pause is None or isinstance(pause, str))
        and (port is None or (isinstance(port, int) and not isinstance(port, bool)))
        and isinstance(tasks, dict)
        and all(
            isinstance(tasks.get(name), dict)
            and all(isinstance(tasks[name].get(key), bool) for key in ("exists", "enabled", "running"))
            for name in TASKS
        )
    )


def undo_out(state: dict[str, Any]) -> None:
    """원래 상태로만 되돌린다 — 원래 켜져 있던 작업만 켜고, 원래 돌던 서버·워치독만 다시 돌린다(BackupCopy 는 안 돌림).
    지금 이미 그 상태면 건너뛴다(OUT 이 아무것도 못 바꾸고 멈춘 뒤에도 안전하게 다시 부를 수 있게)."""
    content_db = Path(state["content_db"])
    if read_pause(content_db) != state.get("pause_original"):
        write_pause(content_db, state.get("pause_original"))
    tasks = state["tasks"]
    now = task_snapshot()
    for name in TASKS:
        if tasks[name]["exists"] and tasks[name]["enabled"] and not now[name]["enabled"]:
            _schtasks("/Change", "/TN", name, "/ENABLE")
    started_server = False
    for name in RESTART_TASKS:
        if tasks[name]["exists"] and tasks[name]["running"] and not now[name]["running"]:
            _schtasks("/Run", "/TN", name)
            started_server = started_server or name == "MVHub Server"
    if started_server and not wait_ready(int(state.get("port") or sm.DEFAULT_PORT)):
        raise MoveError("서버를 다시 켰지만 ready 응답이 없습니다 — logs 폴더를 확인하세요")


# ---------------------------------------------------------------- IN


def find_packages(desktop: Path) -> list[Path]:
    found = []
    for path in sorted(desktop.glob(PACKAGE_PREFIX + "*")):
        if (path / sm.MANIFEST_NAME).is_file() and (path / SETTINGS_NAME).is_file():
            found.append(path)
    return found


def _choose_package(args: argparse.Namespace) -> Path:
    if args.package:
        return Path(args.package)
    packages = find_packages(desktop_dir())
    if not packages:
        raise MoveError(f"바탕화면에 이사 폴더({PACKAGE_PREFIX}…)가 없습니다")
    if len(packages) == 1 or args.yes:
        return packages[-1]
    for number, path in enumerate(packages, 1):
        _say(f"  {number}. {path.name}")
    picked = input("  몇 번을 쓸까요? ").strip()
    if not picked.isdigit() or not 1 <= int(picked) <= len(packages):
        raise MoveError("번호를 고르지 않았습니다")
    return packages[int(picked) - 1]


def precheck_in(
    package: Path, settings: dict[str, Any], data_dir: Path, port: int, *, resume: bool = False
) -> list[str]:
    """새 PC 에서 설치 전에 막아야 할 것. 하나라도 있으면 아무것도 바꾸지 않고 멈춘다.
    resume: 이 이사 폴더로 설치까지 마친 뒤 멈췄던 재실행 — 설치 쪽 점검(지난 기록·예약 작업·폴더 충돌)은 건너뛴다."""
    problems: list[str] = []
    old_env = settings.get("machine_env") or {}
    here_env = machine_env()
    for name in REFUSE_ENV:
        if old_env.get(name):
            problems.append(f"옛 서버에 {name} 가 설정돼 있었습니다 — 표준 배치가 아니라 수동 절차로 옮기세요")
        if here_env.get(name) or os.environ.get(name):
            # 기본 위치에 설치해도 예약 서버(SYSTEM)가 이 변수를 따라 다른 DB 를 열거나 HTTPS 로 뜬다.
            problems.append(
                f"이 PC 에 {name} 가 설정돼 있습니다 — 지우고 다시(관리자 PowerShell: "
                f"[Environment]::SetEnvironmentVariable('{name}', $null, 'Machine'))"
            )
    if not resume:
        db_dir = sm.role_live_paths(data_dir)["content"].parent
        if (db_dir / sm.JOURNAL_NAME).exists():
            problems.append(f"지난 설치 기록이 남아 있습니다: {db_dir / sm.JOURNAL_NAME} — 수동 확인 필요")
        for name, info in task_snapshot().items():
            if info["exists"] and info["enabled"]:
                problems.append(f"이 PC 에 이미 예약 작업 {name} 가 켜져 있습니다 — 이미 서버로 쓰는 PC 인지 확인하세요")
    pids, ok = sm.port_listener_pids(port)
    ours = {proc["pid"] for proc in our_processes()}
    if not ok:
        problems.append(f"포트 {port} 상태를 읽지 못했습니다")
    elif set(pids) - ours:
        problems.append(f"포트 {port} 를 다른 프로그램(팀원 앱 등)이 쓰고 있습니다 — 닫고 다시 실행하세요")
    if not firewall_allows(port):
        problems.append(
            f"방화벽에 {port} 들어오는 허용 규칙이 없습니다 — 관리자 PowerShell 에서: "
            f'netsh advfirewall firewall add rule name="MVHub {port}" dir=in action=allow protocol=TCP localport={port}'
        )
    zone = time_zone()
    if zone != KST_ZONE:
        problems.append(f'시간대가 {zone or "알 수 없음"} 입니다 — 관리자 PowerShell 에서: tzutil /s "{KST_ZONE}"')
    if not resume:
        for name in ("db-backups", "media"):
            target = data_dir / name
            if (package / name).is_dir() and target.is_dir() and any(target.iterdir()):
                problems.append(f"새 PC 에 {target} 가 이미 있습니다 — 합칠지 사람이 정해야 합니다")
    return problems


def _in_state(data_dir: Path, manifest_sha: str) -> dict[str, Any] | None:
    """이 이사 폴더로 설치까지 마치고 멈춘 기록이면 그것(이어서 한다). 다른 폴더의 미완료 기록이면 멈춘다."""
    path = data_dir / IN_STATE_NAME
    if not path.is_file():
        return None
    previous = _read_json(path, "들여오기 기록")
    if previous.get("manifest_sha") != manifest_sha:
        if previous.get("phase") != "done":
            raise MoveError(f"다른 이사 폴더의 들여오기가 중간에 멈춘 기록이 있습니다: {path} — 수동 확인 필요")
        return None
    live = sm.role_live_paths(data_dir)
    targets = previous.get("targets")
    archive = previous.get("archive_dir")
    complete = (
        previous.get("phase") in ("installed", "done")
        and isinstance(previous.get("python"), str)
        and isinstance(previous.get("sqlite"), str)
        and isinstance(targets, dict)
        # 이어서 손대는 DB 는 이 PC 의 표준 위치여야 한다 — 기록이 다른 DB 를 가리키면 그 DB 를 바꾸게 된다.
        and all(
            isinstance(targets.get(role), str) and _same_path(targets[role], live[role]) for role in sm.SET_ROLES
        )
        and isinstance(archive, str)
        and _same_path(Path(archive).parent, live["content"].parent)
    )
    if not complete:
        raise MoveError(f"들여오기 기록이 완전하지 않습니다: {path} — 수동 확인이 필요합니다")
    return previous


def _same_path(a: str | Path, b: str | Path) -> bool:
    """같은 파일·폴더인지 — 둘 다 있으면 연결 폴더(junction)까지 따라간 실제 대상으로, 하나라도 없으면 글자로 비교한다.
    조회가 실패하면 같다고 보지 않는다(이어하기·되돌리기가 엉뚱한 DB 를 만지지 않게)."""
    try:
        if os.path.exists(a) and os.path.exists(b):
            return os.path.samefile(a, b)
    except OSError:
        return False
    return os.path.normcase(os.path.abspath(str(a))) == os.path.normcase(os.path.abspath(str(b)))


def _tree_signature(root: Path) -> list[tuple[str, int]]:
    """폴더의 (상대 경로, 크기) 목록 — 지난번에 넣은 것인지 가리는 용도(내용 해시는 아님, 문서의 '최선 노력').
    링크·연결 폴더가 섞였거나 읽기 오류가 나면 비교할 수 없으니 멈춘다."""
    signature: list[tuple[str, int]] = []
    try:
        for current, dirs, files in os.walk(root, followlinks=False):
            for name in dirs + files:
                full = os.path.join(current, name)
                if os.path.islink(full) or getattr(os.path, "isjunction", lambda _p: False)(full):
                    raise MoveError(f"{full} 가 링크라 비교할 수 없습니다 — 합칠지 사람이 정한 뒤 다시 실행하세요")
            for name in files:
                full = os.path.join(current, name)
                signature.append((os.path.relpath(full, root), os.path.getsize(full)))
    except OSError as exc:
        raise MoveError(f"{root} 를 읽지 못했습니다({exc}) — 사람이 확인한 뒤 다시 실행하세요") from exc
    return sorted(signature)


def _resume_extras(package: Path, data_dir: Path) -> None:
    """이어하기: 지난번에 원자적으로 다 넣은 폴더(내용 같음)는 건너뛰고, 아직 없는 것만 넣는다.
    같은 이름인데 내용이 다르면 지난번 것이 아니다 — 합칠지 사람이 정하도록 멈춘다."""
    missing: list[str] = []
    for name in ("db-backups", "media"):
        source, target = package / name, data_dir / name
        if not source.is_dir():
            continue
        if not target.exists():
            missing.append(name)
        elif _tree_signature(source) != _tree_signature(target):
            raise MoveError(f"{target} 가 이사 폴더의 것과 다릅니다 — 합칠지 사람이 정한 뒤 다시 실행하세요")
    if missing:
        sm._install_extras(package, data_dir, True, tuple(missing))


def cmd_in(args: argparse.Namespace) -> int:
    _require_windows_admin()
    package = _choose_package(args)
    manifest = sm.read_manifest(package)
    if ((manifest.get("files") or {}).get(SETTINGS_NAME) or {}).get("role") != "settings":
        # OUT 이 설정 파일을 쓴 뒤 manifest 를 다시 쓰기 전에 끊긴 폴더 — 설정을 대조할 수 없다.
        raise MoveError("이사 폴더가 완전하지 않습니다(설정 파일이 manifest 에 없음) — 옛 서버에서 UNDO 후 OUT 을 다시 하세요")
    files = sm.verify_manifest_files(package, manifest)  # machine_settings.json 도 크기·SHA 대조
    settings = _read_json(package / SETTINGS_NAME, "이사 폴더의 설정 파일")
    data_dir = sm.resolve_data_dir(args.data_dir)
    manifest_sha = sm._sha256(package / sm.MANIFEST_NAME)
    previous = _in_state(data_dir, manifest_sha)
    if previous and previous.get("phase") == "done":
        _say(f"  이 이사 폴더는 이미 들여오기를 마쳤습니다: {package}")
        return 0
    resume = previous is not None

    _say("=" * 68)
    _say("  서버 이사 — 새 서버에 들여오기" + (" (설치까지 마친 뒤 멈춘 것을 이어서)" if resume else ""))
    _say("=" * 68)
    _say(f"  이사 폴더   : {package}")
    _say(f"  옛 서버     : {settings.get('server_url')}  (Python {settings.get('python')} · SQLite {settings.get('sqlite')})")
    _say(f"  이 PC       : Python {sys.version.split()[0]} · SQLite {sqlite3.sqlite_version}")
    _say(f"  데이터 폴더 : {data_dir}")
    problems = precheck_in(package, settings, data_dir, args.port, resume=resume)
    if problems:
        _say()
        _say("  아래를 먼저 해결하세요(아무것도 바꾸지 않았습니다):")
        for problem in problems:
            _say(f"  - {problem}")
        return 1
    if not args.yes and not _ask("진행할까요?"):
        return 1

    if resume:
        if (
            os.path.normcase(previous["python"]) != os.path.normcase(sys.executable)
            or previous.get("sqlite") != sqlite3.sqlite_version
        ):
            # 색인은 처음 파이썬의 SQLite 로 다시 만들었다 — 다른 파이썬이 예약 서버가 되면 다시 어긋날 수 있다.
            raise MoveError(
                f"처음 설치에 쓴 파이썬({previous['python']}, SQLite {previous.get('sqlite')})과 지금 파이썬"
                f"({sys.executable}, SQLite {sqlite3.sqlite_version})이 다릅니다 — 같은 파이썬으로 이어야 합니다. 수동 확인 필요"
            )
        _say("[1/5] 설치는 이미 끝났습니다 — 작업자 백업·media 만 다시 확인(지난번에 넣은 폴더는 건너뜀)")
        _resume_extras(package, data_dir)
        result = {"archive_dir": previous["archive_dir"], "targets": previous["targets"]}
    else:
        leftovers = our_processes()
        if leftovers:  # 이 저장소로 띄운 시험 서버 창
            _stop_our_processes(leftovers)
        _say("[1/5] 검증(격리 복원·로그인) → 설치")
        expected = {role: sm._sha256(path) for role, path in files.items()}
        sm.check_drill_runtime()
        report = sm.run_drill(files, args.server_timeout)
        if not sm._drill_ok(report):
            raise MoveError("검증(드릴)을 통과하지 못했습니다 — 설치하지 않았습니다")
        result = sm.install_set(files, data_dir, args.port, expected)
        # DB 설치 직후에 먼저 남긴다 — 뒤의 작업자 백업·media 복사가 실패해도 다시 누르면 이어진다.
        _atomic_json(
            data_dir / IN_STATE_NAME,
            {
                "format": 1,
                "phase": "installed",
                "package": str(package),
                "manifest_sha": manifest_sha,
                "archive_dir": result["archive_dir"],
                "targets": result["targets"],
                "python": sys.executable,
                "sqlite": sqlite3.sqlite_version,
                "updated_at": _utc_now(),
            },
        )
        sm._install_extras(package, data_dir, True)
    content_db = Path(result["targets"]["content"])

    _say("[2/5] 첫 시작 전 정리 — 임시 관리자 비밀번호 파일 삭제, 생성 접수 원래대로")
    (data_dir / BOOTSTRAP_FILE).unlink(missing_ok=True)
    write_pause(content_db, settings.get("pause_original"))

    _say("[3/5] 이 PC 설정")
    old_env = settings.get("machine_env") or {}
    for name in APPLY_ENV:
        if name in old_env:
            set_machine_env(name, old_env[name])
            _say(f"      {name} 적용")
    others = sorted(set(old_env) - set(APPLY_ENV))
    if others:
        _say("      옛 서버에 있던 다른 설정(자동 적용 안 함 — 필요하면 수동): " + ", ".join(others))
    _write_replica_target(settings.get("backup_replica_target"))

    _say("[4/5] 자동시작 등록 + 서버 시작")
    baseline_run, _result = backup_task_run()  # 등록 전 마지막 BackupCopy 실행(새 PC 면 없음)
    started = datetime.now(timezone.utc)
    register_autostart()
    if not wait_ready(args.port):
        raise MoveError("서버가 ready 응답을 하지 않습니다 — logs 폴더를 확인하세요")
    recorded = RUNTIME_PYTHON_FILE.read_text(encoding="utf-8").strip()
    if os.path.normcase(recorded) != os.path.normcase(sys.executable):
        raise MoveError(
            f"예약 서버 파이썬({recorded})이 설치에 쓴 파이썬({sys.executable})과 다릅니다 — "
            "SQLite 버전이 달라 색인이 다시 어긋날 수 있습니다. server_move_IN.bat 으로 실행했는지 확인하세요."
        )

    _say("[5/5] NAS 백업 복제 1회 확인")
    _say("      " + backup_copy_result(data_dir, started, baseline_run))
    in_state = _read_json(data_dir / IN_STATE_NAME, "들여오기 기록")
    in_state.update(phase="done", updated_at=_utc_now())
    _atomic_json(data_dir / IN_STATE_NAME, in_state)
    _print_in_done(package, settings, result)
    return 0


def _write_replica_target(value: str | None) -> None:
    if not value:
        return
    target = REPLICA_PATH
    if target.is_file():
        current = target.read_text(encoding="utf-8").strip()
        if current == value:
            return
        if not _ask(f"      NAS 백업 복제 경로를 '{current}' → '{value}' 로 바꿀까요?"):
            return
    target.write_text(value + "\n", encoding="utf-8")
    _say("      NAS 백업 복제 경로 설정")


def register_autostart() -> None:
    """같은 파이썬을 예약 서버에 고정(MVHUB_SERVER_PYEXE)하고, 확인 창(pause) 없이 등록·시작한다."""
    env = dict(os.environ, MVHUB_SERVER_PYEXE=sys.executable, CONTENT_HUB_NO_PAUSE="1")
    code = subprocess.run(["cmd", "/c", str(ROOT / "register_autostart.bat")], cwd=str(ROOT), env=env).returncode
    if code != 0:
        raise MoveError(f"register_autostart.bat 이 실패했습니다(코드 {code}) — 위 메시지를 확인하세요")


def backup_task_run() -> tuple[datetime | None, int | None]:
    """MVHub BackupCopy 예약 작업의 마지막 실행 시각(UTC)과 결과 코드 — 같은 PC 의 수동 실행과 가르기 위해."""
    rows, ok = sm._ps_json(
        "Get-ScheduledTaskInfo -TaskName 'MVHub BackupCopy' -ErrorAction Stop"
        " | Select-Object @{n='LastRun';e={$_.LastRunTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')}},"
        " LastTaskResult"
    )
    if not ok or not rows or not isinstance(rows[0], dict):
        return None, None
    try:
        last_run = datetime.fromisoformat(str(rows[0].get("LastRun")).replace("Z", "+00:00"))
    except ValueError:
        last_run = None
    result = rows[0].get("LastTaskResult")
    return last_run, result if isinstance(result, int) else None


def backup_copy_result(
    data_dir: Path, started: datetime, baseline: datetime | None = None, timeout: float = 300.0
) -> str:
    """등록이 돌린 BackupCopy 의 이번 결과. 예약 작업이 시작 시각 뒤에 새로 돌아 끝났고(SYSTEM 실행, 등록 전
    마지막 실행 baseline 과 다름), 상태 파일도 그 뒤에 쓰였을 때만 판정한다 — 예전 성공·같은 초의 직전 실행·
    같은 PC 의 수동 실행을 이번 성공으로 보지 않는다."""
    if not REPLICA_PATH.is_file() and not os.environ.get("CONTENT_HUB_BACKUP_REPLICA_DIR"):
        return "NAS 백업 복제 경로가 없어 건너뜀"
    status_path = data_dir / "backup_replica_status.json"
    since = started.replace(microsecond=0)  # 작업 시각은 초 단위
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        last_run, task_result = backup_task_run()
        finished = (
            last_run is not None
            and last_run >= since
            and (baseline is None or last_run > baseline)
            and not task_snapshot()["MVHub BackupCopy"]["running"]
        )
        try:
            status = json.loads(status_path.read_text(encoding="utf-8"))
            attempted = datetime.fromisoformat(str(status.get("last_attempt_at")))
        except (OSError, ValueError, TypeError):
            status, attempted = {}, None
        if finished and attempted is not None and attempted >= since:
            if task_result == 0 and status.get("state") == "success":
                return "성공"
            reason = status.get("error_code") or status.get("state") or f"작업 결과 {task_result}"
            return f"실패({reason}) — 새 PC 의 SYSTEM 계정이 NAS 에 쓸 수 있는지 확인하세요(이사 자체는 완료)"
        time.sleep(5)
    return "결과를 확인하지 못했습니다(시간 초과) — 관리자 창의 백업 상태를 확인하세요"


def _print_in_done(package: Path, settings: dict[str, Any], result: dict[str, Any]) -> None:
    _say()
    _say("=" * 68)
    _say("  들여오기 완료 — 새 서버가 켜졌습니다(아직 이 PC 의 IP 그대로)")
    _say("=" * 68)
    networks = settings.get("network") or []
    old = networks[0] if networks else {}
    _say("  1. 옛 서버 PC 를 끄거나 랜선을 뺀 것을 확인한 뒤, 이 PC 의 IP 를 옛 값으로 바꾸세요:")
    _say("     설정 → 네트워크 및 인터넷 → 이더넷 → 어댑터 옵션 변경 → 이더넷 속성 → IPv4 → '다음 IP 주소 사용'")
    _say(f"       IP {old.get('IPv4')} · 접두 {old.get('Prefix')} · 게이트웨이 {old.get('Gateway')} · DNS {', '.join(old.get('Dns') or [])}")
    _say(f"  2. 다른 PC 에서 {settings.get('server_url')}/api/ready 가 열리는지 확인하세요(같은 주소여야 팀원 PC 의 남은 보고가 이어집니다).")
    _say("  3. 팀원 한 명에게 접속·생성 1건을 부탁하세요.")
    _say("  4. IP 를 바꾼 뒤에는 옛 서버의 되돌리기(UNDO)를 쓰지 마세요 — 자료가 갈라집니다.")
    _say(f"  5. 기존 DB 보존 위치: {result['archive_dir']}")
    _say(f"  6. 이사가 확인되면 이사 폴더({package})와 옛 PC·USB·NAS 의 사본을 지우세요.")
    rows = sm._old_machine_paths(Path(result["targets"]["content"]))
    if rows:
        _say("  ※ DB 안에 옛 PC 경로가 있습니다 — 이 PC 에서 열리는지 확인하세요:")
        for name, path in rows[:10]:
            _say(f"     {name}: {path}")
    _say()


# ---------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="쉬운 서버 이사(OUT·IN·UNDO)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    out = sub.add_parser("out", help="옛 서버: 멈추고 바탕화면에 이사 폴더")
    out.add_argument("--data-dir")
    out.add_argument("--port", type=int, default=sm.DEFAULT_PORT)
    out.add_argument("--fence-wait", type=float, default=FENCE_WAIT_SECONDS)
    out.add_argument("--yes", action="store_true", help="확인 질문 건너뛰기(시험용)")
    in_ = sub.add_parser("in", help="새 서버: 바탕화면 이사 폴더를 들여오기")
    in_.add_argument("--package")
    in_.add_argument("--data-dir")
    in_.add_argument("--port", type=int, default=sm.DEFAULT_PORT)
    in_.add_argument("--server-timeout", type=float, default=90.0)
    in_.add_argument("--yes", action="store_true", help="확인 질문 건너뛰기(시험용)")
    undo = sub.add_parser("undo-out", help="옛 서버: OUT 전 상태로 되돌리기")
    undo.add_argument("--state")
    undo.add_argument("--data-dir")
    undo.add_argument("--yes", action="store_true", help="확인 질문 건너뛰기(시험용)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    handler = {"out": cmd_out, "in": cmd_in, "undo-out": cmd_undo_out}[args.cmd]
    try:
        return handler(args)
    except (MoveError, sm.ServerActive) as exc:
        _say()
        _say("  [중단] " + str(exc))
        return 2


if __name__ == "__main__":
    sys.exit(main())
