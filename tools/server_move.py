r"""공유 서버 이전·재해복구 패키지 도구 (Windows 공유 서버 전용).

사용:
  server_move_export.bat  D:\move                     옛 서버에서 이전 패키지 만들기
  server_move_import.bat  D:\move                     새 PC에서 검증만 (기본)
  server_move_import.bat  D:\move --install           새 PC에 실제 설치
  server_move_import.bat  --backup-set "<...>\content_hub_<stamp>.db" --install
                                                      manifest 없는 NAS 자동백업에서 복구

★ export 와 --install 은 서버가 완전히 멈춘 상태에서만 동작한다. 가동 중 export 는 두 가지를
  깨뜨린다 — ① export 이후 옛 서버가 받은 쓰기(댓글·공유·계정 변경)가 새 서버에 없다.
  generation_deployment_paused 는 생성 접수만 막지 다른 쓰기는 막지 않는다.
  ② content 스냅샷과 trash 스냅샷 사이에 휴지통 '복원'이 끼면 그 행이 content 스냅샷에도
  trash 스냅샷에도 없다. 중복은 부팅 정합기가 정리하지만 이 누락은 감지·복구가 불가능하다.
  서버를 먼저 멈추면 두 문제가 함께 사라진다.

이 도구가 옮기는 것은 DB 세트뿐이다. 머신 전용 상태(device_identity.json, active.json,
worker-backup-outbox, resolve/, .mvhub-runtime/ 등)는 새 PC 의 신원과 충돌하므로 옮기지 않는다.
자세한 판정은 docs/SERVER_MIGRATION.md 의 표를 따른다.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
TOOLS = ROOT / "tools"
for _p in (str(BACKEND), str(TOOLS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from app.services.backup_verify import (  # noqa: E402
    BACKUP_SET_MEMBERS,
    create_sqlite_snapshot,
    discover_backup_set,
    inspect_sqlite_database,
    verify_restore_set,
)
from app.services.restore_runtime_verify import verify_restored_set_runtime  # noqa: E402

SET_ROLES = ("content", "trash", "manage")
MANIFEST_NAME = "manifest.json"
JOURNAL_NAME = ".server_move_journal.json"
PACKAGE_KIND = "mvhub-server-move"
PACKAGE_FORMAT = 1
DEFAULT_PORT = 8010
SERVER_TASKS = ("MVHub Server", "MVHub Watchdog")
STAGED_PREFIX = ".server_move_staged-"
ARCHIVE_PREFIX = "_before_move_"
SIDECARS = ("-wal", "-shm")

# 새 PC 의 신원·경로와 충돌해 옮기면 안 되는 것. export 가 화면에 이유와 함께 알린다.
MACHINE_ONLY = {
    "device_identity.json": "이 PC 식별자 — 새 PC 는 새 ID 여야 한다",
    "active.json": "로컬 허브 계정 포인터 — AUTH-on 서버는 무시하고, 남기면 나중에 충돌",
    "worker_backup_state.db": "작업자 PC 의 업로드 상태",
    "worker-backup-outbox": "옛 PC 경로와 전송 상태",
    "cost_cache.json": "로컬 CLI 비용 캐시 — 재생성된다",
    "resolve": "Resolve host-id·기기 lock",
    "bootstrap_admin_password.txt": "일회용 평문 — 비밀번호 해시는 DB 안에 있다",
    "backup_replica_status.json": "옛 PC 복제 작업 상태",
}


class ServerActive(RuntimeError):
    """서버가 아직 살아 있어 안전하게 진행할 수 없다."""


class MoveError(RuntimeError):
    """이전 작업을 중단해야 하는 조건."""


def _now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S_%f")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _say(line: str = "") -> None:
    print(line, flush=True)


def _human(n: int) -> str:
    step = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if step < 1024 or unit == "GB":
            return f"{step:,.0f} {unit}" if unit == "B" else f"{step:,.1f} {unit}"
        step /= 1024
    return f"{n} B"


# ---------------------------------------------------------------- 경로 해석


def resolve_data_dir(explicit: str | Path | None) -> Path:
    """운영 데이터 폴더. 예약 작업(SYSTEM)과 사용자 콘솔은 환경변수가 다를 수 있어
    최종 경로를 항상 화면에 크게 찍고 진행한다."""
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = os.environ.get("CONTENT_HUB_DATA")
    if env:
        return Path(env).expanduser().resolve()
    return (BACKEND / "data").resolve()


def role_live_paths(data_dir: Path, content_db: str | Path | None = None) -> dict[str, Path]:
    """운영 중인 DB 3종의 실제 파일 경로 — 앱과 같은 규칙으로 유도한다.

    파일명은 BACKUP_SET_MEMBERS 가 단일 출처다. 세 파일이 같은 규칙을 따르지 않는다:

    - content : CONTENT_HUB_DB 가 있으면 그것, 없으면 <data>/db/content_hub.db
    - trash   : **content DB 와 같은 폴더**(app/repo/trash.py `_trash_path`)
    - manage  : DATA_DIR 기준으로 고정(app/manage_db.py `MANAGE_DB_PATH`)

    trash 를 data_dir 기준으로 잡으면 CONTENT_HUB_DB 를 쓰는 설치에서 엉뚱한(또는 없는)
    휴지통을 집어 content 와 짝이 맞지 않는 세트를 만든다.
    """
    db_dir = data_dir / "db"
    override = content_db or os.environ.get("CONTENT_HUB_DB")
    content = (
        Path(override).expanduser().resolve()
        if override
        else db_dir / str(BACKUP_SET_MEMBERS["content"]["restored_name"])
    )
    return {
        "content": content,
        "trash": content.parent / str(BACKUP_SET_MEMBERS["trash"]["restored_name"]),
        "manage": db_dir / str(BACKUP_SET_MEMBERS["manage"]["restored_name"]),
    }


def _required_tables(role: str) -> set[str]:
    """역할별 필수 테이블. inspect_sqlite_database 의 기본값은 content 전용이라 그대로 쓰면
    trash·manage 를 잘못 판정한다."""
    return set(BACKUP_SET_MEMBERS[role]["required_tables"])


def _overlaps(a: Path, b: Path) -> bool:
    a, b = a.resolve(), b.resolve()
    if a == b:
        return True
    for child, parent in ((a, b), (b, a)):
        try:
            child.relative_to(parent)
            return True
        except ValueError:
            continue
    return False


# ------------------------------------------------- 서버가 멈췄는지 판정 (Windows)


def _ps_json(script: str) -> tuple[list[object], bool]:
    """PowerShell 조회 결과와 성공 여부. 워치독과 같은 헬퍼를 재사용한다."""
    from server_watchdog import _powershell_json  # noqa: PLC0415

    return _powershell_json(script)


def scheduled_task_states() -> tuple[dict[str, str], bool]:
    """예약 작업 상태.

    schtasks 의 출력은 OS 언어에 따라 번역되므로(한국어 Windows 는 '사용 안 함') 쓰지 않고,
    열거값이 영어로 고정인 Get-ScheduledTask 의 State 를 문자열로 강제해 읽는다.

    ★ -TaskName 으로 직접 조회하면 안 된다. 일치하는 작업이 하나도 없을 때
    -ErrorAction SilentlyContinue 를 줘도 $? 가 False 가 되어 '조회 실패'로 보인다.
    자동시작을 등록한 적 없는 새 PC(=import 의 주 사용처)가 바로 그 경우라, 정상 상황이
    안전 검사에 걸려 도구가 아예 진행하지 못한다. 전체를 나열하고 여기서 걸러
    '해당 작업 없음'이 빈 결과로 오게 한다.
    """
    names = ",".join("'" + name + "'" for name in SERVER_TASKS)
    script = (
        "Get-ScheduledTask -ErrorAction Stop"
        " | Where-Object { $_.TaskName -in @(" + names + ") }"
        " | Select-Object TaskName, @{n='State';e={$_.State.ToString()}}"
    )
    rows, ok = _ps_json(script)
    if not ok:
        return {}, False
    states: dict[str, str] = {}
    for row in rows:
        if isinstance(row, dict):
            name, state = row.get("TaskName"), row.get("State")
            if isinstance(name, str) and isinstance(state, str):
                states[name] = state
    return states, True


def running_server_processes() -> tuple[list[dict[str, Any]], bool]:
    """이 설치본의 serve.py / server_supervisor.py / server_watchdog.py 프로세스를 찾는다."""
    from server_watchdog import command_line_matches_server  # noqa: PLC0415

    rows, ok = _ps_json(
        "Get-CimInstance Win32_Process -ErrorAction Stop"
        " | Select-Object ProcessId, CommandLine"
    )
    if not ok:
        return [], False
    self_pid = os.getpid()
    root_key = os.path.normcase(str(ROOT))
    serve_path = (BACKEND / "serve.py").resolve()
    hits: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        command_line = row.get("CommandLine")
        try:
            pid = int(row.get("ProcessId") or 0)
        except (TypeError, ValueError):
            continue
        if pid == self_pid or not isinstance(command_line, str) or not command_line:
            continue
        why = None
        if command_line_matches_server(command_line, serve_path):
            why = "serve.py"
        elif root_key in os.path.normcase(command_line) and any(
            script in command_line for script in ("server_supervisor.py", "server_watchdog.py")
        ):
            why = "supervisor/watchdog"
        if why:
            hits.append({"pid": pid, "why": why, "command_line": command_line})
    return hits, True


def port_listener_pids(port: int) -> tuple[list[int], bool]:
    rows, ok = _ps_json(
        "Get-NetTCPConnection -State Listen -ErrorAction Stop"
        " | Where-Object { $_.LocalPort -eq " + str(int(port)) + " }"
        " | Select-Object -ExpandProperty OwningProcess -Unique"
    )
    if not ok:
        return [], False
    pids: list[int] = []
    for row in rows:
        value = row if isinstance(row, int) else (row.get("value") if isinstance(row, dict) else None)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            pids.append(value)
    return sorted(set(pids)), True


def ensure_server_stopped(port: int = DEFAULT_PORT) -> dict[str, Any]:
    """서버가 확실히 멈췄음을 입증한다. 조회 자체가 실패하면 '멈췄다'로 보지 않는다.

    이 검사와 실제 파일 교체 사이의 경쟁을 완전히 없애지는 못한다 — 서버와 도구가 공유하는
    배타적 운영 lease 가 코드에 없기 때문이다. 그래서 예약 작업이 Disabled 인 것까지 요구해
    '검사 직후 스케줄러가 되살리는' 가장 현실적인 경로를 막는다.
    """
    if platform.system() != "Windows":
        raise MoveError("이 도구는 Windows 공유 서버 전용입니다")

    problems: list[str] = []
    report: dict[str, Any] = {}

    states, ok = scheduled_task_states()
    report["scheduled_tasks"] = states if ok else None
    if not ok:
        problems.append("예약 작업 상태를 조회하지 못했습니다(관리자 PowerShell 로 실행하세요)")
    else:
        for name, state in sorted(states.items()):
            if state != "Disabled":
                problems.append(
                    '예약 작업 "' + name + '" 이 ' + state + " 입니다 — "
                    'schtasks /Change /TN "' + name + '" /DISABLE 로 먼저 끄세요'
                )

    procs, ok = running_server_processes()
    report["processes"] = procs if ok else None
    if not ok:
        problems.append("프로세스 목록을 조회하지 못했습니다")
    else:
        for proc in procs:
            problems.append(
                f"서버 프로세스가 살아 있습니다 (PID {proc['pid']}, {proc['why']})"
            )

    pids, ok = port_listener_pids(port)
    report["port_listeners"] = pids if ok else None
    if not ok:
        problems.append(f"포트 {port} 점유 상태를 조회하지 못했습니다")
    elif pids:
        # 우리 프로세스는 위에서 이미 잡혔다. 여기 남은 것은 정체를 모르는 점유자 —
        # 같은 데이터 폴더를 쓰는 다른 설치본일 수 있어 사람이 확인해야 한다.
        problems.append(
            f"포트 {port} 를 다른 프로세스가 쓰고 있습니다 "
            f"(PID {', '.join(map(str, pids))}) — 정체를 확인하세요"
        )

    if problems:
        raise ServerActive("\n".join("  - " + p for p in problems))
    return report


def checkpoint_live_dbs(paths: dict[str, Path]) -> dict[str, Any]:
    """운영 DB 의 WAL 을 본체로 밀어 넣는다. busy 가 남으면 아직 누가 쓰고 있다는 뜻이다."""
    result: dict[str, Any] = {}
    for role, path in paths.items():
        if not path.is_file():
            result[role] = {"present": False}
            continue
        with closing(sqlite3.connect(str(path))) as conn:
            busy, log, checkpointed = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            if busy != 0:
                raise ServerActive(
                    f"  - {path.name} 의 WAL 정리에 실패했습니다(busy={busy}) — "
                    "아직 이 DB 를 쓰는 프로세스가 있습니다"
                )
            # 쓰기 잠금을 실제로 잡아 본다. 잡히면 활성 writer 가 없다.
            conn.execute("BEGIN IMMEDIATE")
            conn.rollback()
            result[role] = {"present": True, "wal_pages": log, "checkpointed_pages": checkpointed}
    return result


def _drop_sidecars(path: Path) -> None:
    """Windows 는 열린 -wal/-shm 을 지우지 못한다. checkpoint 후 핸들이 닫힌 뒤에만 부른다."""
    for suffix in SIDECARS:
        Path(str(path) + suffix).unlink(missing_ok=True)


# ---------------------------------------------------------------- manifest


def _git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if out.returncode == 0:
            return (out.stdout or "").strip() or None
    except Exception:  # noqa: BLE001 — 커밋 해시는 참고 정보다
        return None
    return None


def write_manifest(package_dir: Path, payload: dict[str, Any]) -> Path:
    target = package_dir / MANIFEST_NAME
    tmp = package_dir / (MANIFEST_NAME + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, target)
    return target


def read_manifest(package_dir: Path) -> dict[str, Any]:
    path = package_dir / MANIFEST_NAME
    if not path.is_file():
        raise MoveError(
            f"{path} 가 없습니다 — 이전 패키지 폴더가 맞는지 확인하세요.\n"
            "  NAS 자동백업에서 바로 복구하려면 --backup-set 을 쓰세요."
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise MoveError(f"manifest 를 읽지 못했습니다: {exc}") from exc
    if not isinstance(data, dict) or data.get("kind") != PACKAGE_KIND:
        raise MoveError("이 폴더의 manifest 는 서버 이전 패키지가 아닙니다")
    if data.get("format") != PACKAGE_FORMAT:
        raise MoveError(
            f"패키지 형식 {data.get('format')} 은 이 버전이 읽지 못합니다(기대 {PACKAGE_FORMAT})"
        )
    return data


def verify_manifest_files(package_dir: Path, manifest: dict[str, Any]) -> dict[str, Path]:
    """manifest 의 크기·SHA-256 을 전량 대조한다. 하나라도 어긋나면 중단한다.

    이것은 '전송 중 깨지지 않았다'는 확인이지 진위 인증이 아니다. manifest 와 파일을 함께
    바꾸는 변조는 이것으로 잡지 못한다.
    """
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        raise MoveError("manifest 에 파일 목록이 없습니다")
    resolved: dict[str, Path] = {}
    for rel, info in sorted(files.items()):
        path = package_dir / rel
        if not path.is_file():
            raise MoveError(f"패키지에 파일이 없습니다: {rel}")
        actual = path.stat().st_size
        if actual != info.get("bytes"):
            raise MoveError(
                f"{rel} 의 크기가 manifest 와 다릅니다 (기록 {info.get('bytes')}, 실제 {actual})"
            )
        digest = _sha256(path)
        if digest != info.get("sha256"):
            raise MoveError(f"{rel} 의 SHA-256 이 manifest 와 다릅니다 — 전송 중 손상되었습니다")
        role = info.get("role")
        if role in SET_ROLES:
            resolved[role] = path
    missing = [role for role in SET_ROLES if role not in resolved]
    if missing:
        raise MoveError("패키지에 DB 역할이 빠졌습니다: " + ", ".join(missing))
    return resolved


# ---------------------------------------------------------------- export


def cmd_export(args: argparse.Namespace) -> int:
    data_dir = resolve_data_dir(args.data_dir)
    dest = Path(args.dest).expanduser().resolve()
    live = role_live_paths(data_dir, args.content_db)

    _say("=" * 68)
    _say("  서버 이전 패키지 만들기 (export)")
    _say("=" * 68)
    _say(f"  데이터 폴더 : {data_dir}")
    for role in SET_ROLES:
        _say(f"  {role:<8}   : {live[role]}")
    _say(f"  패키지 대상 : {dest}")
    _say()
    _say("  위 경로가 이 서버가 실제로 쓰던 DB 가 맞는지 반드시 확인하세요.")
    _say("  예약 작업은 SYSTEM 계정으로 돌아 콘솔과 환경변수가 다를 수 있습니다.")
    _say()

    if _overlaps(dest, data_dir):
        raise MoveError("패키지 대상 폴더가 데이터 폴더와 겹칩니다 — 다른 위치를 지정하세요")
    missing = [role for role in SET_ROLES if not live[role].is_file()]
    if missing:
        raise MoveError(
            "DB 파일을 찾지 못했습니다: "
            + ", ".join(f"{role}({live[role]})" for role in missing)
            + "\n  --data-dir 로 실제 데이터 폴더를 지정하세요."
        )
    if dest.exists() and any(dest.iterdir()):
        raise MoveError(f"패키지 대상 폴더가 비어 있지 않습니다: {dest}")

    _say("[1/5] 서버가 멈췄는지 확인")
    ensure_server_stopped(args.port)
    _say("      OK — 예약 작업 Disabled, 서버 프로세스 없음, 포트 비어 있음")

    _say("[2/5] 운영 DB WAL 정리")
    checkpoint_live_dbs(live)
    _say("      OK — 세 DB 모두 미반영 WAL 없음, 활성 writer 없음")

    stamp = _now_stamp()
    package_db = dest / "db"
    package_db.mkdir(parents=True, exist_ok=True)

    _say(f"[3/5] 스냅샷 (stamp {stamp})")
    files: dict[str, Any] = {}
    for role in SET_ROLES:
        name = f"{BACKUP_SET_MEMBERS[role]['prefix']}{stamp}.db"
        target = package_db / name
        create_sqlite_snapshot(live[role], target)
        info = inspect_sqlite_database(target, required_tables=_required_tables(role))
        rel = f"db/{name}"
        files[rel] = {
            "role": role,
            "bytes": target.stat().st_size,
            "sha256": _sha256(target),
            "schema_sha256": info["schema_sha256"],
            "user_version": info["user_version"],
            "table_counts": info["table_counts"],
            "source": str(live[role]),
        }
        counts = info["table_counts"]
        head = ", ".join(
            f"{t}={counts[t]:,}" for t in sorted(counts) if t in _required_tables(role)
        )
        _say(f"      {name}  {_human(files[rel]['bytes'])}  {head}")

    _say("[4/5] 함께 가져갈 것 정리")
    extras: list[str] = []
    if args.with_worker_backups:
        extras.append(_copy_extra(data_dir / "db-backups", dest / "db-backups", "db-backups"))
    if args.with_media:
        extras.append(_copy_extra(data_dir / "media", dest / "media", "media"))
    extras = [e for e in extras if e]

    _say("[5/5] manifest 기록")
    manifest = {
        "kind": PACKAGE_KIND,
        "format": PACKAGE_FORMAT,
        "stamp": stamp,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "source": {
            "host": platform.node(),
            "data_dir": str(data_dir),
            "install_root": str(ROOT),
            "git_commit": _git_commit(),
        },
        "files": files,
        "extras": extras,
    }
    write_manifest(dest, manifest)
    _say(f"      {dest / MANIFEST_NAME}")
    _say()

    _report_left_behind(data_dir, args)
    _print_export_next_steps(dest)
    return 0


def _copy_extra(source: Path, target: Path, label: str) -> str | None:
    if not source.is_dir():
        _say(f"      {label} — 없음, 건너뜀")
        return None
    shutil.copytree(source, target, dirs_exist_ok=False)
    total = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())
    _say(f"      {label} — 복사 완료 ({_human(total)})")
    return label


def _report_left_behind(data_dir: Path, args: argparse.Namespace) -> None:
    _say("-" * 68)
    _say("  가져가지 않은 것")
    _say("-" * 68)
    for name, reason in sorted(MACHINE_ONLY.items()):
        if (data_dir / name).exists():
            _say(f"  x {name:<28} {reason}")
    for name, flag, reason in (
        ("db-backups", args.with_worker_backups, "팀원이 서버 백업에서 복원하는 이력 — --with-worker-backups"),
        ("media", args.with_media, "URL-only 정책이면 캐시 — --with-media"),
        ("assets", False, "작업자 로컬 파일. 서버를 작업자로도 썼을 때만 수동 이전"),
        ("backups", False, "과거 백업 이력. NAS 원본을 그대로 두면 된다"),
    ):
        path = data_dir / name
        if path.is_dir() and not flag:
            try:
                size = sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
                _say(f"  - {name:<28} {_human(size)} — {reason}")
            except OSError:
                _say(f"  - {name:<28} {reason}")
    acct = data_dir / "db" / "acct"
    if acct.is_dir() and any(acct.iterdir()):
        _say()
        _say("  ! db/acct 에 계정별 DB 가 있습니다. AUTH=1 공유 서버는 이것을 읽지 않습니다")
        _say("    (로컬 허브로 쓰던 흔적). 개인 데이터일 수 있어 패키지에 넣지 않았습니다.")
    _say()


def _print_export_next_steps(dest: Path) -> None:
    _say("=" * 68)
    _say("  다음 할 일")
    _say("=" * 68)
    _say(f"  1. {dest} 를 새 PC 로 옮긴다 (USB·NAS)")
    _say("  2. 새 PC 에서 검증만 먼저:  server_move_import.bat <폴더>")
    _say("  3. 이상 없으면 설치:        server_move_import.bat <폴더> --install")
    _say()
    _say("  ! 옛 서버는 다시 켜지 마세요. 지금부터 받는 쓰기는 새 서버로 가지 않습니다.")
    _say("    되돌릴 수 있게 1~2주는 지우지 말고 그대로 보관하세요.")
    _say()


# ---------------------------------------------------------------- 검증 (드릴)


def check_drill_runtime() -> None:
    """드릴이 띄울 격리 서버의 의존성이 이 파이썬에 있는지 먼저 본다.

    드릴은 현재 인터프리터(sys.executable)로 serve.py 를 띄운다. 배치는 서버와 같은 규칙으로
    파이썬을 고르므로(runtime\\python → release staging → where python) 보통은 맞지만,
    준비되지 않은 파이썬으로 실행하면 드릴이 ModuleNotFoundError 로 죽는다. 그때 화면에
    뜨는 것은 서버 로그 꼬리라 원인을 알기 어렵다 — 먼저 확인해 분명히 알린다.
    """
    missing = []
    for name in ("fastapi", "uvicorn"):
        try:
            __import__(name)
        except ImportError:
            missing.append(name)
    if missing:
        raise MoveError(
            "이 파이썬에는 서버 의존성이 없어 검증 드릴을 돌릴 수 없습니다: "
            + ", ".join(missing)
            + f"\n  지금 파이썬: {sys.executable}"
            "\n  서버를 실제로 띄우는 파이썬으로 실행하세요"
            "\n  (릴리스 설치본은 runtime\\python, git 클론은 requirements 를 설치한 환경)."
        )


def run_drill(package_files: dict[str, Path], timeout: float) -> dict[str, Any]:
    """복원 드릴 — 격리 폴더에 실제로 복원하고 격리 서버를 띄워 로그인까지 확인한다.

    verify_restored_set_runtime 이 CONTENT_HUB_EXTERNAL_RECOVERY=0 등 외부 부수효과 차단을
    이미 강제한다. 여기서는 부모 환경에 켜져 있을 수 있는 원본 보존만 추가로 끈다 —
    켜져 있으면 격리 서버가 원격 미디어를 실제로 내려받는다.
    """
    previous = os.environ.get("CONTENT_HUB_MEDIA_PRESERVATION")
    os.environ["CONTENT_HUB_MEDIA_PRESERVATION"] = "0"
    tmp_root = Path(tempfile.mkdtemp(prefix="mvhub-server-move-drill-"))
    try:
        restored = tmp_root / "restored-data"
        report = verify_restore_set(package_files["content"], restored)
        report["isolated_server"] = verify_restored_set_runtime(
            restored, timeout_seconds=timeout
        )
        return report
    finally:
        if previous is None:
            os.environ.pop("CONTENT_HUB_MEDIA_PRESERVATION", None)
        else:
            os.environ["CONTENT_HUB_MEDIA_PRESERVATION"] = previous
        _remove_tree_with_retry(tmp_root)


def _remove_tree_with_retry(path: Path, attempts: int = 5) -> None:
    """드릴 임시 폴더를 지운다.

    격리 서버를 막 종료한 직후라 Windows 가 아직 DB 핸들을 놓지 않아 삭제가
    WinError 5 로 실패할 수 있다. 검증은 이미 끝났으므로 이 실패로 결과를 버리지 않는다.
    끝내 못 지우면 사본이 남았다는 사실을 사람에게 알린다 — DB 사본이므로 방치하면 안 된다.
    """
    for attempt in range(attempts):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            if attempt == attempts - 1:
                _say()
                _say(f"  [주의] 드릴 임시 폴더를 지우지 못했습니다: {path}")
                _say("         DB 사본이 남아 있으니 확인 후 직접 지우세요.")
                return
            time.sleep(0.5 * (attempt + 1))


def _drill_ok(report: dict[str, Any]) -> bool:
    if not report.get("ok"):
        return False
    server = report.get("isolated_server") or {}
    checks = server.get("ready_checks") or {}
    return (
        all(checks.get(role) == "ok" for role in SET_ROLES)
        and server.get("login") == "ok"
        and server.get("process_stopped") is True
    )


# ---------------------------------------------------------------- 설치


def _journal_write(path: Path, payload: dict[str, Any]) -> None:
    """설치 상태 기록. 전원이 끊겨도 남아야 하므로 rename 전에 디스크까지 내린다.

    임시 이름에 stamp 를 넣어 두 실행이 같은 임시 파일을 밟지 않게 한다.
    """
    tmp = path.with_name(f"{path.name}.{os.getpid()}-{payload.get('stamp', 'x')}.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _claim_journal(journal: Path, payload: dict[str, Any]) -> None:
    """journal 을 원자적으로 '만들면서' 선점한다.

    존재 확인과 생성이 따로면 두 설치가 동시에 검사를 통과한다. O_EXCL 은 그 틈을 없앤다 —
    파일이 이미 있으면 만들기 자체가 실패하므로, 선점에 성공한 쪽만 진행한다.
    """
    try:
        fd = os.open(journal, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        raise MoveError(
            f"이전 설치가 끝나지 않았거나 다른 설치가 진행 중입니다: {journal}\n"
            "  내용을 확인하고, 어느 DB 가 최신인지 판단한 뒤 사람이 정리해야 합니다."
        ) from exc
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())


def _verify_expected_sha(package_files: dict[str, Path], expected: dict[str, str]) -> None:
    """드릴한 바로 그 바이트를 설치하는지 다시 확인한다.

    검증(드릴)과 설치 사이에 시간이 흐른다. 그 사이 NAS 동기화·다른 사람·다른 프로세스가
    패키지 파일을 바꾸면, 통과한 세트가 아니라 다른 세트가 설치된다. 설치 후 검사는
    새 staging 과 설치본만 비교하므로 그 바꿔치기를 잡지 못한다.
    """
    for role, path in sorted(package_files.items()):
        if _sha256(path) != expected.get(role):
            raise MoveError(
                f"{path.name} 이 검증 이후에 바뀌었습니다 — 설치를 중단합니다.\n"
                "  검증한 것과 다른 데이터를 설치할 수 없습니다. 처음부터 다시 하세요."
            )


def _rollback(
    targets: dict[str, Path],
    archive_dir: Path,
    staged: dict[str, Path],
    present_before: dict[str, bool],
) -> bool:
    """실패한 설치를 되돌리고, 정말 원래대로 됐는지 확인해서 알려준다.

    진행 중 어디까지 갔는지를 메모리 목록으로 판단하지 않는다 — os.replace 성공과 그
    기록 사이에 Ctrl+C 가 들어오면 목록이 사실과 어긋난다. 대신 '움직이기 전에 적어 둔'
    present_before 를 기준으로, 디스크의 실제 상태를 보고 맞춘다.
    """
    for role, target in targets.items():
        kept = archive_dir / target.name
        try:
            _drop_sidecars(target)
            if present_before[role]:
                if kept.is_file():
                    target.unlink(missing_ok=True)
                    os.replace(kept, target)
            else:
                # 원래 없던 파일이면 설치본을 치운다.
                target.unlink(missing_ok=True)
        except OSError as exc:
            _say(f"     {target.name} 되돌리기 실패: {exc}")

    for path in staged.values():
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass

    # 되돌아왔는지 확인한다. 하나라도 어긋나면 성공이라고 말하지 않는다.
    for role, target in targets.items():
        if present_before[role] != target.is_file():
            return False
        if present_before[role] and (archive_dir / target.name).is_file():
            return False
    return True


def install_set(
    package_files: dict[str, Path],
    data_dir: Path,
    port: int,
    expected_sha: dict[str, str],
) -> dict[str, Any]:
    """검증된 DB 세트를 운영 위치에 설치한다.

    순서가 안전성의 전부다 — ① 같은 볼륨에 staging 을 다 만들고 검사까지 끝낸 뒤에야
    ② 기존 파일을 archive 로 rename 하고 ③ staging 을 최종 이름으로 rename 한다.
    rename 은 같은 볼륨이라 원자적이고, staging 이 완성되기 전까지 기존 운영 파일은
    손대지 않는다. 디스크가 가득 차거나 검사가 실패하면 기존 DB 는 그대로다.
    """
    targets = role_live_paths(data_dir)
    parents = {p.parent for p in targets.values()}
    if len(parents) != 1:
        raise MoveError(
            "DB 3종이 서로 다른 폴더를 가리킵니다(CONTENT_HUB_DB 가 설정돼 있습니까?).\n"
            + "\n".join(f"  {role}: {targets[role]}" for role in SET_ROLES)
            + "\n  이 도구는 세 파일이 같은 폴더에 있는 표준 배치만 설치합니다."
            "\n  CONTENT_HUB_DB 를 해제하거나 --data-dir 를 실제 폴더로 맞추세요."
        )
    db_dir = parents.pop()
    db_dir.mkdir(parents=True, exist_ok=True)
    journal = db_dir / JOURNAL_NAME

    stamp = _now_stamp()
    staged = {role: db_dir / f"{STAGED_PREFIX}{stamp}-{role}.db" for role in SET_ROLES}
    archive_dir = db_dir / f"{ARCHIVE_PREFIX}{stamp}"

    need = sum(p.stat().st_size for p in package_files.values())
    free = shutil.disk_usage(db_dir).free
    if free < need * 2 + (256 << 20):
        raise MoveError(
            f"디스크 여유가 부족합니다 — 필요 약 {_human(need * 2)}, 남은 {_human(free)}"
        )

    # 여기서부터 이 폴더의 설치를 선점한다. 실패해도 journal 은 함부로 지우지 않는다.
    _claim_journal(
        journal,
        {
            "state": "claimed",
            "stamp": stamp,
            "archive_dir": str(archive_dir),
            "targets": {r: str(p) for r, p in targets.items()},
            "started_at": datetime.now().isoformat(timespec="seconds"),
        },
    )

    def _cleanup_staged() -> None:
        for path in staged.values():
            path.unlink(missing_ok=True)

    try:
        _say("[1/6] staging 만들기 (기존 DB 는 아직 손대지 않음)")
        _verify_expected_sha(package_files, expected_sha)
        staged_info: dict[str, Any] = {}
        for role in SET_ROLES:
            create_sqlite_snapshot(package_files[role], staged[role])
            staged_info[role] = inspect_sqlite_database(
                staged[role], required_tables=_required_tables(role)
            )
            _say(f"      {staged[role].name}  OK")
        # 읽는 동안 바뀌지 않았는지 한 번 더 — verify_restore_set 과 같은 원리.
        _verify_expected_sha(package_files, expected_sha)

        _say("[2/6] 서버가 멈췄는지 재확인 (교체 직전)")
        ensure_server_stopped(port)
        checkpoint_live_dbs(targets)
        _say("      OK")
    except BaseException:
        _cleanup_staged()
        journal.unlink(missing_ok=True)  # 아직 기존 DB 를 건드리기 전이라 안전하다
        raise

    # ★ 어떤 파일이 원래 있었는지를 '움직이기 전에' 기록한다. Ctrl+C 가 rename 직후에
    #   들어와도 메모리 목록이 아니라 이 기록으로 되돌릴 수 있다.
    present_before = {role: targets[role].is_file() for role in SET_ROLES}
    _journal_write(
        journal,
        {
            "state": "archiving",
            "stamp": stamp,
            "archive_dir": str(archive_dir),
            "targets": {r: str(p) for r, p in targets.items()},
            "staged": {r: str(p) for r, p in staged.items()},
            "present_before": present_before,
        },
    )

    try:
        _say("[3/6] 기존 DB 를 보존 폴더로 이동")
        archive_dir.mkdir(parents=True, exist_ok=False)
        for role, target in targets.items():
            if present_before[role]:
                _drop_sidecars(target)
                os.replace(target, archive_dir / target.name)
                _say(f"      {target.name} -> {archive_dir.name}\\{target.name}")
            else:
                _say(f"      {target.name} — 없음(새 설치)")

        _say("[4/6] 새 DB 를 제자리에 놓기")
        for role, target in targets.items():
            _drop_sidecars(target)
            os.replace(staged[role], target)
            _say(f"      {target.name}  OK")

        _say("[5/6] 설치 결과 재검증")
        for role, target in targets.items():
            info = inspect_sqlite_database(target, required_tables=_required_tables(role))
            if info["schema_sha256"] != staged_info[role]["schema_sha256"]:
                raise MoveError(f"{target.name} 설치 전후 스키마가 다릅니다")
            if info["table_counts"] != staged_info[role]["table_counts"]:
                raise MoveError(f"{target.name} 설치 전후 행 수가 다릅니다")
            _say(f"      {target.name}  OK")
    except BaseException as original:
        _say()
        _say("  !! 설치 중 실패 — 기존 DB 로 되돌립니다")
        restored = _rollback(targets, archive_dir, staged, present_before)
        if restored:
            journal.unlink(missing_ok=True)
            if archive_dir.is_dir() and not any(archive_dir.iterdir()):
                archive_dir.rmdir()
            _say("  롤백 완료 — 기존 DB 가 제자리에 있습니다")
        else:
            _journal_write(
                journal,
                {
                    "state": "rollback_failed",
                    "stamp": stamp,
                    "archive_dir": str(archive_dir),
                    "targets": {r: str(p) for r, p in targets.items()},
                    "present_before": present_before,
                    "error": str(original),
                },
            )
            _say("  !! 롤백을 확인하지 못했습니다. 자동 복구를 멈춥니다.")
            _say(f"     기존 DB 는 {archive_dir} 안에 있습니다.")
            _say(f"     상태 기록: {journal}  (이 파일이 있으면 다음 실행은 거부됩니다)")
        raise original

    _say("[6/6] 기록 정리")
    installed_at = datetime.now().isoformat(timespec="seconds")
    _journal_write(
        journal,
        {
            "state": "committed",
            "stamp": stamp,
            "archive_dir": str(archive_dir),
            "present_before": present_before,
            "targets": {r: str(p) for r, p in targets.items()},
            "installed_at": installed_at,
        },
    )
    # 완료 기록은 보존 폴더 안으로 옮긴다 — db/ 에 남으면 다음 실행을 막는다.
    os.replace(journal, archive_dir / "server_move.json")
    _say(f"      기존 DB 보존: {archive_dir}")
    return {
        "stamp": stamp,
        "archive_dir": str(archive_dir),
        "installed_at": installed_at,
        "targets": {r: str(p) for r, p in targets.items()},
    }


# ---------------------------------------------------------------- import


def cmd_import(args: argparse.Namespace) -> int:
    data_dir = resolve_data_dir(args.data_dir)

    if args.backup_set and args.package:
        raise MoveError("패키지 폴더와 --backup-set 은 함께 쓸 수 없습니다")

    if args.backup_set:
        content = Path(args.backup_set).expanduser().resolve()
        _stamp, members = discover_backup_set(content)
        package_files = dict(members)
        package_dir = content.parent
        manifest_verified = False
    else:
        if not args.package:
            raise MoveError("이전 패키지 폴더를 지정하거나 --backup-set 을 쓰세요")
        package_dir = Path(args.package).expanduser().resolve()
        manifest = read_manifest(package_dir)
        package_files = verify_manifest_files(package_dir, manifest)
        manifest_verified = True

    _say("=" * 68)
    _say("  서버 이전 패키지 " + ("설치" if args.install else "검증"))
    _say("=" * 68)
    _say(f"  패키지     : {package_dir}")
    _say(f"  설치 대상  : {data_dir / 'db'}")
    for role in SET_ROLES:
        _say(f"  {role:<8}  : {package_files[role].name}")
    _say()

    if _overlaps(package_dir, data_dir):
        raise MoveError("패키지 폴더가 설치 대상 데이터 폴더와 겹칩니다")

    if manifest_verified:
        _say("  [확인] manifest 의 크기·SHA-256 전량 일치")
        _say("         (전송 중 손상은 잡지만, 진위 인증은 아닙니다)")
    else:
        _say("  [주의] manifest 가 없는 세트입니다 (NAS 자동백업 직접 복구).")
        _say("         무결성과 세트 구성은 확인하지만, 원래 export 시점의")
        _say("         SHA 진위는 확인할 수 없습니다.")
    _say()

    # 드릴 '직전'의 바이트를 기억해 둔다. 설치 직전에 다시 대조해, 검증한 것과 다른
    # 데이터가 설치되는 일을 막는다(manifest 유무와 무관하게 성립한다).
    expected_sha = {role: _sha256(path) for role, path in package_files.items()}

    check_drill_runtime()
    _say("복원 드릴 — 격리 폴더에 실제 복원하고 격리 서버로 로그인까지 확인합니다")
    report = run_drill(package_files, args.server_timeout)
    server = report.get("isolated_server") or {}
    checks = server.get("ready_checks") or {}
    for role in SET_ROLES:
        _say(f"  ready.{role:<8} {checks.get(role)}")
    _say(f"  login          {server.get('login')}")
    _say(f"  process_stopped {server.get('process_stopped')}")
    for role, info in sorted((report.get("files") or {}).items()):
        counts = info.get("reconcile_counts") or {}
        head = ", ".join(f"{k}={v:,}" for k, v in sorted(counts.items()))
        _say(f"  {role:<8} {_human(info.get('backup_bytes', 0)):>12}  {head}")
    _say()

    if not _drill_ok(report):
        raise MoveError(
            "드릴이 통과하지 못했습니다 — 이 세트를 설치하지 마세요.\n"
            "  이전 완성 세트로 다시 시도하고, 차이가 의심되면 별도로 조사하세요."
        )
    _say("  드릴 통과")
    _say()

    if not args.install:
        _say("=" * 68)
        _say("  검증만 했습니다. 아무것도 바꾸지 않았습니다.")
        _say("  실제로 설치하려면 같은 명령에 --install 을 붙이세요.")
        _say("=" * 68)
        return 0

    result = install_set(package_files, data_dir, args.port, expected_sha)
    result["extras"] = _install_extras(package_dir, data_dir, manifest_verified)
    _say()
    _print_import_next_steps(data_dir, result)
    return 0


def _install_extras(package_dir: Path, data_dir: Path, from_package: bool) -> list[str]:
    """export 가 함께 담은 폴더(db-backups·media)를 운영 위치에 놓는다.

    담아 오기만 하고 설치하지 않으면 '가져갔다'는 표시만 남고 새 서버에서는 비어 있다.
    이미 있는 폴더는 덮어쓰지 않는다 — 새 PC 의 것이 더 최신일 수 있고, 합치는 규칙을
    도구가 임의로 정하면 안 된다. 그 경우 사람이 판단하도록 알린다.
    """
    if not from_package:
        return []
    installed: list[str] = []
    for name in ("db-backups", "media"):
        source = package_dir / name
        if not source.is_dir():
            continue
        target = data_dir / name
        if target.exists():
            _say(f"  [건너뜀] {name} — 새 PC 에 이미 있습니다: {target}")
            _say(f"           패키지 쪽: {source}  (합칠지는 사람이 판단하세요)")
            continue
        shutil.copytree(source, target)
        total = sum(p.stat().st_size for p in target.rglob("*") if p.is_file())
        _say(f"  {name} 설치 완료 ({_human(total)})")
        installed.append(name)
    return installed


def _old_machine_paths(content_db: Path) -> list[tuple[str, str]]:
    """DB 안에 남은 옛 PC 경로 후보. 새 PC 에서 접근 가능한지 사람이 봐야 한다."""
    rows: list[tuple[str, str]] = []
    try:
        uri = content_db.resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as conn:
            cur = conn.execute(
                "SELECT name, render_root_path FROM project"
                " WHERE render_root_path IS NOT NULL AND render_root_path != ''"
            )
            for name, path in cur.fetchall():
                rows.append((str(name), str(path)))
    except sqlite3.Error:
        return []
    return rows


def _print_import_next_steps(data_dir: Path, result: dict[str, Any]) -> None:
    _say("=" * 68)
    _say("  설치 완료 — 남은 할 일")
    _say("=" * 68)
    _say("  1. 서버 IP 를 옛 서버와 같게 설정 (같으면 팀원이 아무것도 안 바꿔도 됨)")
    _say("  2. 방화벽에서 서버 포트 인바운드 허용")
    _say("  3. MV_server.bat 로 한 번 띄우고 /api/ready 200 확인")
    _say("  4. 팀원 1명에게 접속·로그인·팀 탭 확인 요청")
    _say("  5. register_autostart.bat 실행 (자동시작 + NAS 백업 복제 경로 재설정)")
    _say("  6. IP 가 바뀌었으면 앱에서 [팀에 공지]")
    _say()
    _say("  ** 7. 생성 접수 재개 (가장 놓치기 쉬움) **")
    _say("     generation_deployment_paused 는 DB 에 저장돼 백업을 타고 따라옵니다.")
    _say("     옛 서버에서 멈춰 뒀다면 새 서버도 멈춘 채로 뜹니다.")
    _say("     docs/SERVER.md 의 deployment-pause 해제 명령을 실행하세요.")
    _say()

    content = Path(result["targets"]["content"])
    rows = _old_machine_paths(content)
    if rows:
        _say("-" * 68)
        _say("  DB 안에 옛 PC 경로가 남아 있습니다 — 새 PC 에서 접근되는지 확인하세요")
        _say("-" * 68)
        for name, path in rows[:20]:
            _say(f"  {name}: {path}")
        if len(rows) > 20:
            _say(f"  ... 외 {len(rows) - 20}건")
        _say()

    _say(f"  기존 DB 보존 위치: {result['archive_dir']}")
    _say("  새 서버가 정상임을 확인할 때까지 지우지 마세요.")
    _say()


# ---------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="server_move",
        description="MV Hub 공유 서버 이전·재해복구 패키지 도구",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    exp = sub.add_parser("export", help="옛 서버에서 이전 패키지 만들기 (서버 중지 필수)")
    exp.add_argument("dest", help="패키지를 만들 빈 폴더")
    exp.add_argument("--data-dir", help="운영 데이터 폴더(기본: CONTENT_HUB_DATA 또는 backend/data)")
    exp.add_argument("--content-db", help="콘텐츠 DB 를 직접 지정")
    exp.add_argument("--port", type=int, default=DEFAULT_PORT, help="서버 포트(기본 8010)")
    exp.add_argument("--with-worker-backups", action="store_true", help="db-backups 도 포함")
    exp.add_argument("--with-media", action="store_true", help="media 폴더도 포함")
    exp.set_defaults(func=cmd_export)

    imp = sub.add_parser("import", help="새 PC 에서 검증(기본) 또는 설치(--install)")
    imp.add_argument("package", nargs="?", help="export 로 만든 패키지 폴더")
    imp.add_argument("--backup-set", help="manifest 없는 NAS 백업의 content_hub_<stamp>.db")
    imp.add_argument("--install", action="store_true", help="실제로 운영 DB 를 교체한다")
    imp.add_argument("--data-dir", help="설치할 데이터 폴더")
    imp.add_argument("--port", type=int, default=DEFAULT_PORT, help="서버 포트(기본 8010)")
    imp.add_argument(
        "--server-timeout", type=float, default=90.0, help="격리 서버 준비 제한(초, 기본 90)"
    )
    imp.set_defaults(func=cmd_import)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except ServerActive as exc:
        _say()
        _say("[중단] 서버가 아직 멈추지 않았습니다:")
        _say(str(exc))
        _say()
        _say("  docs/SERVER_RECOVERY.md 의 '수동 중지' 절차대로 예약 작업을 먼저")
        _say("  /DISABLE 한 뒤 /End 하세요. /End 만 하면 재부팅 때 되살아납니다.")
        return 2
    except (MoveError, FileNotFoundError, FileExistsError, ValueError) as exc:
        _say()
        _say(f"[중단] {exc}")
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
