"""DB·백업 화면과 백업 작업(backup-save·backup-run) — 서버 밖(NAS) 복사 위치를 정하고 예약 작업으로 시험 복사한다.

지원하는 것은 표준 경로뿐(2단계 설계 3판 (3)): 기계 설정값(HKLM) CONTENT_HUB_DATA 가 없거나 <루트>\\backend\\data,
CONTENT_HUB_BACKUP_DIR 가 없거나 <루트>\\backend\\data\\backups — 복사기는 원본을 <루트>\\backend\\data 로 고정한다.
위치 판정·지문·확인은 도우미 자식(backup_helper.py)이 루트 복사기 코드로 하고, 실제 복사는 예약 작업(SYSTEM)이 한다.
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import names
from .install import CODE_ROOT, Installation, Runner, child_env, machine_env, powershell_exe, run_command, windows_dir
from .status import plain_child

HELPER = CODE_ROOT / "tools" / "server_console" / "backup_helper.py"
PROBE_TIMEOUT = 20.0
COPY_TIMEOUT = 1800.0       # 새 위치의 첫 복사는 모든 백업을 옮긴다 — 넘기면 '결과 미확인'(복사는 계속될 수 있다)
STALE_RESULT_SECONDS = 60.0  # 작업은 끝났는데 결과 파일이 이번 실행 것으로 바뀌지 않은 채 이만큼 지나면 미확인
PROBE_MESSAGES = {  # routers/backup_replica.py 와 같은 안내(복사기 probe 종료 코드)
    10: "NAS 주소 형식이 아닙니다 — \\\\서버\\공유폴더\\… 처럼 적어 주세요",
    11: "이 서버 PC 자신을 가리키는 주소입니다 — 다른 장비(NAS)를 지정하세요",
    12: "그 폴더에 MV Hub 백업이 아닌 파일이 있습니다 — 빈 하위 폴더를 지정하세요",
    13: "복사 위치가 원본 백업 폴더와 겹칩니다 — 다른 위치를 지정하세요",
    14: "그 위치에 쓸 수 없습니다 — NAS 에서 쓰기를 허용하세요",
    15: "그 위치를 열 수 없습니다 — 주소와 네트워크를 확인하세요",
}
_SYSTEM = {"system", "nt authority\\system", "s-1-5-18"}
_SET_DB = re.compile(r"^(content_hub|content_trash|manage_hub)_(\d{8}_\d{6}(?:_\d{6})?)\.db$")  # 복사기와 같은 이름 규칙
_ROLES = {"content_hub": "content", "content_trash": "trash", "manage_hub": "manage"}


class BackupError(RuntimeError):
    pass


def _same(value: str, path: Path) -> bool:
    return Path(value).is_absolute() and \
        os.path.normcase(os.path.normpath(value)) == os.path.normcase(os.path.normpath(str(path)))


def unsupported_paths(inst: Installation) -> str:
    data, backups = machine_env("CONTENT_HUB_DATA"), machine_env("CONTENT_HUB_BACKUP_DIR")
    if (data and not _same(data, inst.root / "backend" / "data")) or \
            (backups and not _same(backups, inst.root / "backend" / "data" / "backups")):
        return ("지원하지 않는 데이터·백업 경로입니다(기계 설정값 CONTENT_HUB_DATA·CONTENT_HUB_BACKUP_DIR) — "
                "복사기가 다른 원본을 복사할 수 있어 여기서 하지 않습니다")
    return ""


def helper_env(inst: Installation) -> dict[str, str]:
    """예약 작업(SYSTEM)이 task_launch.bat 으로 상속받는 기계 설정값을 그대로 넣는다."""
    env = dict(child_env(inst), PYTHONDONTWRITEBYTECODE="1")
    for key in ("CONTENT_HUB_BACKUP_REPLICA_DIR", "CONTENT_HUB_BACKUP_DIR"):
        value = machine_env(key)
        if value:
            env[key] = value
    return env


def _helper(inst: Installation, *args: str) -> list[str]:
    if inst.python is None:
        raise BackupError("등록된 Python 이 없습니다")
    return [str(inst.python), "-I", "-B", str(HELPER), str(inst.root), *args]


def read_setting(inst: Installation) -> dict:
    """루트 복사기 코드로 읽은 {target, source(env|file|none), target_id, unc_error, result}."""
    code, out = run_command(_helper(inst, "status"), 30, helper_env(inst))
    try:
        value = json.loads(out.strip().splitlines()[-1]) if code == 0 else None
    except (ValueError, IndexError):
        value = None
    if not isinstance(value, dict) or not isinstance(value.get("result"), dict):
        raise BackupError("백업 복사 설정을 읽지 못했습니다(도우미 실패)")
    return value


def probe(inst: Installation, target: str) -> int | None:
    """그 위치에 이 관리자 계정으로 쓰기 시험(복사기 probe). None = 20초 넘김(끊음)."""
    code, _ = run_command(_helper(inst, "probe", target), PROBE_TIMEOUT, helper_env(inst))
    return code


_TASK_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$t = Get-ScheduledTask | Where-Object { $_.TaskName -eq 'MVHub BackupCopy' }
if (-not $t) { '{"exists":false}'; exit 0 }
$i = $t | Get-ScheduledTaskInfo
$a = @($t.Actions)
[pscustomobject]@{ exists = $true; state = $t.State.ToString(); user = [string]$t.Principal.UserId;
  action_count = $a.Count; execute = [string]$a[0].Execute; arguments = [string]$a[0].Arguments;
  multi = $t.Settings.MultipleInstances.ToString();
  last_run = $i.LastRunTime.ToUniversalTime().ToString('o'); last_result = $i.LastTaskResult;
  next_run = $(if ($i.NextRunTime) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { '' }) } | ConvertTo-Json -Compress
"""


def _iso(value) -> str | None:
    text = str(value or "").strip()
    return None if not text or text.startswith(("0001", "1999")) else text  # 한 번도 안 돈 작업의 날짜


def parse_time(value) -> datetime | None:
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def our_action(inst: Installation, raw: dict) -> bool:
    """register_autostart.bat 이 만든 그대로 — 동작 하나 · cmd · /c call "<이 설치>\\task_launch.bat" backup."""
    if raw.get("action_count") != 1:
        return False
    if Path(str(raw.get("execute") or "").strip().strip('"')).name.lower() not in ("cmd", "cmd.exe"):
        return False
    expected = f'/c call "{inst.root / "task_launch.bat"}" backup'
    return " ".join(str(raw.get("arguments") or "").split()).casefold() == " ".join(expected.split()).casefold()


def task_info(inst: Installation, runner: Runner) -> dict | None:
    """예약 작업 MVHub BackupCopy. None = 조회 실패('없음'이 아니다)."""
    code, out = runner([str(powershell_exe()), "-NoProfile", "-NonInteractive", "-Command", _TASK_SCRIPT], 30)
    try:
        raw = json.loads(out.strip().splitlines()[-1]) if code == 0 else None
    except (ValueError, IndexError):
        raw = None
    if not isinstance(raw, dict):
        return None
    if not raw.get("exists"):
        return {"exists": False}
    state = str(raw.get("state") or "")
    result = raw.get("last_result")
    return {"exists": True, "enabled": state != "Disabled", "running": state == "Running",
            "system": str(raw.get("user") or "").strip().lower() in _SYSTEM, "ours": our_action(inst, raw),
            "ignore_new": raw.get("multi") == "IgnoreNew", "last_run": _iso(raw.get("last_run")),
            "last_result": result if type(result) is int else None, "next_run": _iso(raw.get("next_run"))}


def task_problems(task: dict | None) -> list[str]:
    """라우터 backup_replica.run 과 같은 조건 — 이 설치의 SYSTEM 작업·켜짐·겹침 금지·실행 중 아님."""
    if task is None:
        return ["예약 작업(MVHub BackupCopy) 상태를 읽지 못했습니다"]
    if not task.get("exists"):
        return ["예약 작업(MVHub BackupCopy)이 없습니다 — 서버 PC 에서 register_autostart.bat 으로 등록하세요"]
    reasons = []
    if not task.get("enabled"):
        reasons.append("예약 작업(MVHub BackupCopy)이 꺼져 있습니다")
    if not (task.get("system") and task.get("ours") and task.get("ignore_new")):
        reasons.append("예약 작업 설정이 이 서버 설치와 다릅니다(SYSTEM·task_launch.bat backup·겹쳐 실행 안 함) — 다시 등록하세요")
    if task.get("running"):
        reasons.append("지금 복사 중입니다 — 끝난 뒤 하세요")
    return reasons


def recent_sets(inst: Installation, limit: int = 5) -> list[dict] | None:
    """서버 디스크의 자동 백업(시각·구성·크기) 최근 것부터. None = 못 읽음. 내용 검증은 하지 않는다."""
    folder = Path(machine_env("CONTENT_HUB_BACKUP_DIR") or inst.data_dir / "backups")
    groups: dict[tuple[Path, str], dict] = {}
    try:
        for path in folder.rglob("*.db"):
            match = _SET_DB.match(path.name)
            if not match or "pre-dev2-baseline" in path.parts:
                continue
            row = groups.setdefault((path.parent, match.group(2)), {"stamp": match.group(2), "roles": [], "bytes": 0})
            row["roles"].append(_ROLES[match.group(1)])
            row["bytes"] += path.stat().st_size
    except OSError:
        return None
    rows = [row for row in groups.values() if "content" in row["roles"]]
    return sorted(rows, key=lambda r: r["stamp"], reverse=True)[:limit]


def read_view(inst: Installation, runner: Runner, with_sets: bool = True) -> dict:
    view = {"unsupported": unsupported_paths(inst), "task": task_info(inst, runner), "setting": None, "error": ""}
    if with_sets:
        view["sets"] = recent_sets(inst)
    try:
        view["setting"] = read_setting(inst)
    except BackupError as exc:
        view["error"] = str(exc)
    return view


def write_target(inst: Installation, target: str) -> None:
    """tools\\backup_replica_target.txt 원자 교체 — 라우터·복사기·이사 도구와 같은 형식(UTF-8, BOM 없음, 한 줄)."""
    tools = plain_child(inst.root, "tools")
    if tools is None:
        raise BackupError("tools 폴더가 없거나 연결 지점입니다")
    path = tools / "backup_replica_target.txt"
    temp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temp.write_bytes((target + "\n").encode("utf-8"))
    os.replace(temp, path)


def ran_again(task: dict | None, requested: datetime, baseline: str | None) -> bool:
    """예약 작업이 요청 뒤에 새로 돌아 끝났나(직전 실행·요청 전 실행은 아니다)."""
    if not task or not task.get("exists") or task.get("running"):
        return False
    last_run, before = parse_time(task.get("last_run")), parse_time(baseline)
    return last_run is not None and last_run >= requested and (before is None or last_run > before)


def copy_verdict(task: dict | None, result: dict, expected_id: str, requested: datetime,
                 baseline: str | None) -> str | None:
    """이번 실행의 결과일 때만 'success'|'failed' — 작업이 요청 뒤에 새로 돌아 끝났고, 결과 파일도 이번 시작·이 위치 것.
    disabled·no_source 는 작업 종료 코드가 0 이어도 성공이 아니다. 아직이면 None."""
    if not ran_again(task, requested, baseline):
        return None
    started = parse_time(result.get("started_at"))
    if started is None or started < requested or result.get("target_id") != expected_id:
        return None
    return "success" if task.get("last_result") == 0 and result.get("state") == "success" else "failed"


def run_copy(inst: Installation, runner: Runner, expected_id: str, say: Callable[[str], None],
             timeout: float = COPY_TIMEOUT, poll: float = 5.0,
             sleep: Callable[[float], None] = time.sleep) -> tuple[int, dict]:
    """예약 작업(SYSTEM)으로 한 번 복사하고 이번 결과만 채택한다. (0 성공 · 1 실패 · 3 결과 미확인, 덧붙일 결과)."""
    task = task_info(inst, runner)
    problems = task_problems(task)
    if problems:
        say("실패: " + problems[0])
        return 1, {"copy": "not_started", "error": problems[0]}
    baseline = task["last_run"]
    requested = datetime.now(timezone.utc).replace(microsecond=0)  # 작업 시각은 초 단위
    code, _ = runner([str(windows_dir() / "System32" / "schtasks.exe"), "/Run", "/TN", names.TASK_BACKUP], 20)
    if code != 0:
        say("실패: 예약 작업을 실행하지 못했습니다")
        return 1, {"copy": "not_started", "error": "예약 작업을 실행하지 못했습니다"}
    say("예약 작업(SYSTEM)으로 복사를 시작했습니다 — 끝날 때까지 기다립니다(창을 닫아도 계속)")
    deadline = time.monotonic() + timeout
    finished_at = None
    while time.monotonic() < deadline:
        sleep(poll)
        task = task_info(inst, runner)
        try:
            result = read_setting(inst)["result"]
        except BackupError:
            continue
        verdict = copy_verdict(task, result, expected_id, requested, baseline)
        if verdict == "success":
            counts = {k: result.get(k) for k in ("copied", "skipped", "failed")}
            say(f"완료: 복사 성공 — 새로 {counts['copied']} · 그대로 {counts['skipped']}")
            return 0, {"copy": "success", "counts": counts}
        if verdict == "failed":
            why = str(result.get("error_code") or result.get("state") or f"작업 결과 {task.get('last_result')}")[:64]
            say(f"실패: 복사 실패({why})")
            return 1, {"copy": "failed", "error_code": why}
        if ran_again(task, requested, baseline):  # 작업은 이번에 돌아 끝났는데 결과 파일이 이번 것이 아니다
            finished_at = finished_at or time.monotonic()
            if time.monotonic() - finished_at > STALE_RESULT_SECONDS:
                say(f"결과 미확인: 작업은 끝났지만(결과 {task.get('last_result')}) 결과 파일이 이번 실행 것으로 바뀌지 않았습니다")
                return 3, {"copy": "unconfirmed", "error": "결과 파일이 이번 실행 것으로 바뀌지 않았습니다"}
    say("결과 미확인: 제한 시간 안에 이번 복사 결과를 확인하지 못했습니다(복사는 계속될 수 있음)")
    return 3, {"copy": "unconfirmed", "error": "제한 시간 안에 결과를 확인하지 못했습니다"}


def save_work(inst: Installation, runner: Runner, params: dict, say: Callable[[str], None]) -> tuple[int, dict]:
    """위치 확인(이 관리자 계정) → 저장 직전 재확인 → 위치 저장 → 예약 작업으로 시험 복사."""
    target = str(params["target"])
    say("새 위치에 이 관리자 계정으로 쓸 수 있는지 확인합니다(20초 안)…")
    code = probe(inst, target)
    if code != 0:
        why = ("20초 안에 그 위치에 쓰지 못했습니다 — NAS 가 응답하는지 확인하세요" if code is None
               else PROBE_MESSAGES.get(code, f"위치 확인 실패(코드 {code})"))
        say("실패: " + why)
        return 1, {"saved": False, "error": why}
    now = read_view(inst, runner, with_sets=False)
    setting = now["setting"] or {}
    reasons = [r for r in (now["unsupported"], now["error"]) if r] + task_problems(now["task"])
    if setting.get("source") == "env":
        reasons.append("기계 설정값 CONTENT_HUB_BACKUP_REPLICA_DIR 가 생겨 여기서 바꾸지 않습니다")
    elif setting.get("target_id") != params.get("old_id"):
        reasons.append("그 사이 다른 곳에서 위치를 바꿨습니다 — 화면을 다시 확인하세요")
    if reasons:
        say("실패: " + reasons[0])
        return 1, {"saved": False, "error": reasons[0]}
    write_target(inst, target)
    saved = read_setting(inst)
    if saved.get("target") != target or not saved.get("target_id"):
        say("실패: 저장한 뒤 다시 읽은 위치가 다릅니다")
        return 1, {"saved": True, "error": "저장한 뒤 다시 읽은 위치가 다릅니다"}
    say(f"설정 저장됨: 백업 복사 위치 = {target}")
    code, extra = run_copy(inst, runner, saved["target_id"], say)
    return code, {"saved": True, "old_target": params.get("old_target"), **extra}  # 실패하면 화면이 되돌리기를 보인다


def run_work(inst: Installation, runner: Runner, params: dict, say: Callable[[str], None]) -> tuple[int, dict]:
    return run_copy(inst, runner, str(params["target_id"]), say)
