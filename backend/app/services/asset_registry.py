"""에셋 대장 관리자(서버) — 훑기 자식 프로세스 하나를 돌리고, 끝나면 결과를 한 번에 반영한다.
설계: docs/ASSET_REGISTRY.md(Claude 설계 · Codex 적대적 검토 합의, 2026-09-30).

  · NAS 는 자식(services/asset_registry_scan.py)만 읽는다. 여기는 DB 에 반영만 한다 — 완주한 결과를
    BEGIN IMMEDIATE 한 번으로(백업은 반영 전 또는 후만 본다). 미완주·시간 초과·비정상 종료면 버린다.
  · 자식은 늘 하나다. 시간 상한 + KILL_GRACE_S 가 지나면 taskkill /T /F 로 끝낸다(SMB 에 멈춘 스레드는 못 끊는다).
    서버 종료·재시작·업데이트 때(stop) 새 실행을 막고 같은 방법으로 끝낸다.
  · 서버가 살아 있는지(health·ready)는 이것과 무관하다 — NAS 가 멈춰도 워치독이 서버를 재시작하지 않게.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from .. import repo
from ..config import (
    ASSET_REGISTRY_DRIVES,
    ASSET_REGISTRY_ENABLED,
    ASSET_REGISTRY_MIBPS,
    BACKEND_DIR,
    DATA_DIR,
)
from ..db import get_connection, maintenance_active, pool_epoch, pool_state_nowait
from ..repo import asset_registry as registry
from ..repo import nas_results as nas_repo
from . import project_folders
from .async_tools import to_thread_non_abandon
from .operational_logging import log_event

_log = logging.getLogger("mvhub.asset_registry")

MIB = 1 << 20
DIR_RATE = 20  # 초당 폴더 목록 읽기 상한(항목 수가 아니다 — scandir 한 번이 크기·시각을 함께 준다)
MAX_ENTRIES = 300_000
MAX_RESULT_BYTES = 256 * MIB
MANUAL_DEADLINE_S = 45 * 60
# 정한 시간 자동 훑기도 일반 훑기 1회 45분(속도만 자동 상한). 옛 10분 주기용 5분은 큰 프로젝트 목록도 못 끝냈다(2026-10-02).
AUTO_DEADLINE_S = 45 * 60
LARGE_CAP_S = 45 * 60  # 큰 파일 전용 실행의 최대 시간 — 넘으면 '수동 스캔 대기'로 남긴다
RESULTS_DEADLINE_S = 15 * 60  # 결과물 훑기(파일당 앞 64KiB) 한 프로젝트의 최대 시간 — docs/NAS_RESULTS.md
KILL_GRACE_S = 30
_STARTUP_DELAY_S = 60
LEASE_TTL_S = 10 * 60  # 도우미가 1분마다 연장한다 — 도우미가 죽어도 서버 훑기를 오래 막지 않게
# 누가 훑나 — 서버 자신 / 관리자 PC(도우미). 관리자 창에서 고르고 서버 DB 에 둔다(Jay 2026-09-30, Codex 합의).
MODES = ("server", "local")
_MODE_KEY = "asset_registry_mode"
# (풀 에폭, 값) — 이벤트 루프(자동 주기·/scan)가 DB 를 기다리지 않게. DB 파일을 복원·교체하면 에폭이 올라 다시 읽는다(Codex P1:
#  캐시가 없으면 복원 게이트가 닫힌 동안 루프가 멈추고, 에폭 없는 캐시는 복원된 값을 무시한다).
_mode_cache: Optional[tuple[int, str]] = None
# 캐시 확인·다시 읽기·대입을 한 덩어리로 — 늦게 끝난 옛 읽기가 방금 바꾼 값을 덮지 않게(Codex P0). 잠금 순서는 leases.lock → 이것만.
_mode_lock = threading.Lock()


def registry_mode() -> str:
    """고른 훑는 곳 — 없거나 이상하면 "server"(예전 동작). DB 를 교체하는 중에는 읽지 않고 마지막 값을 준다
    (기다리면 이벤트 루프가 멈춘다, Codex P1). 그동안 서버 훑기는 시작하지 않는다(_mode_allows)."""
    global _mode_cache
    with _mode_lock:
        epoch = pool_epoch()
        if _mode_cache is not None and _mode_cache[0] == epoch:
            return _mode_cache[1]
        if maintenance_active():
            return _mode_cache[1] if _mode_cache else "server"
        mode = repo.get_setting(_MODE_KEY, "server")
        _mode_cache = (epoch, mode if mode in MODES else "server")
        return _mode_cache[1]


def registry_mode_nowait() -> Optional[str]:
    """이벤트 루프의 자동 시작용 — 잠금도 DB 도 기다리지 않는다(Codex r3). 지금 에폭의 캐시만 쓰고, 잠금이 바쁘거나
    DB 를 교체하는 중이거나 캐시가 낡았으면 None(= 이번엔 시작하지 않음)."""
    state = pool_state_nowait()
    if state is None or state[1]:
        return None
    if not _mode_lock.acquire(blocking=False):
        return None
    try:
        return _mode_cache[1] if _mode_cache is not None and _mode_cache[0] == state[0] else None
    finally:
        _mode_lock.release()


# ── 자동 훑기 시간(Jay 2026-10-02, docs/ASSET_REGISTRY.md §11 — Claude 설계 r3·Codex 조건부 승인) ─────────────
# 끔·매월(1~28일)·매주(요일)·매일 + 시. 판정은 **서버 시계 하나**로: 예정 시각부터 SCHEDULE_WINDOW_S 안에 물어 온 곳만
# 그 회차를 맡는다(서버 틱·관리자 PC 틱 모두 60초라 그 시각에 켜져 있으면 정상 동작에서 창 안에 한 번은 묻는다).
# 창이 지나면 그 회차는 건너뛴다(따라잡지 않음). 맡김 표식은 회차당 한 곳 — '실행 성공'이 아니라 '시도를 맡김' 기록이다.
_KST = timezone(timedelta(hours=9))
_SCHEDULE_KEY = "asset_registry_schedule"
_MARK_KEY = "asset_registry_schedule_mark"
SCHEDULE_KINDS = ("off", "month", "week", "day")
SCHEDULE_WINDOW_S = 120
SCHEDULE_TICK_S = 60


def _iso(value: Any) -> Optional[datetime]:
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=_KST)


_OFF = {"kind": "off", "day": 1, "weekday": 0, "hour": 3, "saved_at": None}


def _in_range(value: Any, low: int, high: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def parse_schedule(raw: Optional[str]) -> dict[str, Any]:
    """저장값 → {kind, day, weekday, hour, saved_at}. 없거나 **조금이라도 깨졌으면 끔** — 다른 시각으로 고쳐 켜지 않는다(Codex)."""
    try:
        value = json.loads(raw) if raw else {}
    except ValueError:
        return dict(_OFF)
    if not isinstance(value, dict) or value.get("kind") not in SCHEDULE_KINDS or value["kind"] == "off":
        return dict(_OFF)
    if not (_in_range(value.get("day"), 1, 28) and _in_range(value.get("weekday"), 0, 6)
            and _in_range(value.get("hour"), 0, 23) and _iso(value.get("saved_at")) is not None):
        return dict(_OFF)
    return {key: value[key] for key in ("kind", "day", "weekday", "hour", "saved_at")}


def latest_slot(schedule: dict[str, Any], now: datetime) -> Optional[datetime]:
    """now(KST) 이하의 가장 최근 예정 시각. 끔이면 None."""
    kind = schedule.get("kind")
    if kind not in ("month", "week", "day"):
        return None
    slot = now.replace(hour=schedule["hour"], minute=0, second=0, microsecond=0)
    if kind == "day":
        return slot if slot <= now else slot - timedelta(days=1)
    if kind == "week":
        slot -= timedelta(days=(now.weekday() - schedule["weekday"]) % 7)
        return slot if slot <= now else slot - timedelta(days=7)
    slot = slot.replace(day=schedule["day"])
    if slot <= now:
        return slot
    previous = slot.replace(day=1) - timedelta(days=1)  # 지난달 마지막 날 — day 는 28 이하라 언제나 있다
    return previous.replace(day=schedule["day"])


def next_slot(schedule: dict[str, Any], now: datetime) -> Optional[datetime]:
    """now(KST) 다음 예정 시각(화면용). 끔이면 None."""
    kind = schedule.get("kind")
    if kind not in ("month", "week", "day"):
        return None
    slot = now.replace(hour=schedule["hour"], minute=0, second=0, microsecond=0)
    if kind == "day":
        return slot if slot > now else slot + timedelta(days=1)
    if kind == "week":
        slot += timedelta(days=(schedule["weekday"] - now.weekday()) % 7)
        return slot if slot > now else slot + timedelta(days=7)
    slot = slot.replace(day=schedule["day"])
    if slot > now:
        return slot
    following = slot.replace(day=28) + timedelta(days=4)  # 다음 달 어딘가
    return following.replace(day=schedule["day"])


def _settings(conn: Any, *keys: str) -> dict[str, str]:
    """받은 conn 으로 바로 읽는다 — repo.get_setting 을 트랜잭션 안에서 부르면 연결이 겹쳐 먼저 커밋될 수 있다(Codex r2)."""
    marks = ",".join("?" * len(keys))
    return {row["key"]: row["value"] for row in conn.execute(
        f"SELECT key, value FROM app_setting WHERE key IN ({marks})", keys).fetchall()}


def _put_setting(conn: Any, key: str, value: str) -> None:
    conn.execute("INSERT INTO app_setting(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                  (key, value))


def save_schedule(kind: str, day: int, weekday: int, hour: int) -> dict[str, Any]:
    """관리자 창 [저장]. saved_at 은 저장 트랜잭션 안의 서버 시각 — 그 전 회차는 돌지 않는다(03:20 에 '매일 3시' → 내일부터)."""
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            # 범위는 라우트(ScheduleIn)가 검사한다. 저장 시각은 이 트랜잭션 안의 서버 시각.
            schedule = {"kind": kind, "day": day, "weekday": weekday, "hour": hour,
                        "saved_at": datetime.now(_KST).isoformat(timespec="seconds")}
            _put_setting(conn, _SCHEDULE_KEY, json.dumps(schedule))
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    return schedule


def consume_slot(runner: str, mode_required: str) -> tuple[bool, str, Optional[str], Optional[str]]:
    """이번 회차를 runner 에게 맡긴다 — (맡김?, 이유, 예정 시각 ISO, 표식 id). 트랜잭션 하나에서 **지금** 모드·시간표·표식을
    읽고 정한다(설정 변경·DB 복원과 겹쳐도 새 값 기준). now 는 잠금을 얻은 뒤에 잰다(대기 뒤 낡은 시각 금지, Codex r2)."""
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            now = datetime.now(_KST)
            values = _settings(conn, _MODE_KEY, _SCHEDULE_KEY, _MARK_KEY)
            mode = values.get(_MODE_KEY) if values.get(_MODE_KEY) in MODES else "server"
            schedule = parse_schedule(values.get(_SCHEDULE_KEY))
            slot = latest_slot(schedule, now)
            saved_at = _iso(schedule.get("saved_at"))
            taken = _iso(_mark(values.get(_MARK_KEY)).get("slot"))
            if mode != mode_required:  # 로컬이면 서버 틱은 표식을 건드리지 않는다 — 관리자 PC 의 회차를 소진하지 않게(Codex r1)
                reason = "mode"
            elif slot is None or not 0 <= (now - slot).total_seconds() <= SCHEDULE_WINDOW_S:
                reason = "not_due"
            elif saved_at is not None and slot <= saved_at:
                reason = "before_saved"
            elif taken is not None and slot <= taken:  # 같은 회차·시계 역행
                reason = "taken"
            else:
                mark_id = uuid.uuid4().hex
                _put_setting(conn, _MARK_KEY, json.dumps(
                    {"id": mark_id, "slot": slot.isoformat(), "runner": runner, "state": "started"}))
                conn.execute("COMMIT")
                return True, "", slot.isoformat(), mark_id
            conn.execute("ROLLBACK")
            return False, reason, None, None
        except Exception:
            conn.execute("ROLLBACK")
            raise


def mark_outcome(mark_id: str, state: str) -> bool:
    """맡긴 회차의 뒷소식(예: 시작 못 함). 표식이 **그 id 그대로일 때만** 바꾼다 — 그사이 복원·다른 회차면 덮지 않는다."""
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            mark = _mark(_settings(conn, _MARK_KEY).get(_MARK_KEY))
            if mark.get("id") != mark_id:
                conn.execute("ROLLBACK")
                return False
            _put_setting(conn, _MARK_KEY, json.dumps({**mark, "state": state}))
            conn.execute("COMMIT")
            return True
        except Exception:
            conn.execute("ROLLBACK")
            raise


def _mark(raw: Optional[str]) -> dict[str, Any]:
    try:
        value = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def schedule_status() -> dict[str, Any]:
    """관리자 창 표시용 — 시간표·다음 예정 시각·마지막 맡김(누가·무엇). 스레드(동기 라우트)에서만 부른다."""
    schedule = parse_schedule(repo.get_setting(_SCHEDULE_KEY))
    upcoming = next_slot(schedule, datetime.now(_KST))
    mark = _mark(repo.get_setting(_MARK_KEY))
    return {
        "schedule": {key: schedule[key] for key in ("kind", "day", "weekday", "hour")},
        "next_run_at": upcoming.isoformat() if upcoming else None,
        "schedule_mark": {key: mark[key] for key in ("slot", "runner", "state") if key in mark} or None,
    }


def _rates() -> tuple[float, float]:
    """(수동, 자동) 바이트/초. 설정이 이상하면 합의한 시작값(8, 5 MiB/s)."""
    try:
        manual, auto = (float(x) for x in ASSET_REGISTRY_MIBPS.split(",", 1))
        # 1 MiB/s 미만은 받지 않는다 — 1 MiB 조각마다 쉬는 시간이 1초를 넘으면 그동안 부모 감시가 멈춘다(Codex P2).
        if manual >= 1 and auto >= 1:
            return manual * MIB, auto * MIB
    except ValueError:
        pass
    return 8 * MIB, 5 * MIB


def drive_map(raw: str = "") -> dict[str, str]:
    """"Z:=\\\\nas\\share;X:=..." → {"Z:": "\\\\nas\\share"}."""
    out: dict[str, str] = {}
    for part in (raw or ASSET_REGISTRY_DRIVES).split(";"):
        drive, sep, share = part.partition("=")
        drive = drive.strip().upper()
        if sep and re.fullmatch(r"[A-Z]:", drive) and share.strip():
            out[drive] = share.strip().rstrip("\\/")
    return out


def resolve_root(root: str, mapping: Optional[dict[str, str]] = None) -> str:
    """프로젝트 루트(드라이브 글자일 수 있다) → 서버가 읽을 경로. 대응표에 없으면 그대로(그 드라이브가 서버에 보이면 된다)."""
    mapping = drive_map() if mapping is None else mapping
    m = re.match(r"^([A-Za-z]:)[\\/]?(.*)$", root.strip())
    if not m or m.group(1).upper() not in mapping:
        return root.strip()
    rest = m.group(2).replace("/", "\\").strip("\\")
    return mapping[m.group(1).upper()] + ("\\" + rest if rest else "")


def canonical_unc(root: str) -> Optional[str]:
    """프로젝트 루트의 공유 주소 — 루트가 이미 UNC 면 그대로, 드라이브 글자면 DRIVES 대응표로. 모르면 None.
    도우미 PC 가 '같은 NAS 의 같은 폴더'를 훑는지 이것으로 대조한다(드라이브 글자는 PC 마다 다를 수 있다)."""
    resolved = resolve_root(root).replace("/", "\\").rstrip("\\")
    return resolved if resolved.startswith("\\\\") else None


def root_key(root: str) -> str:
    """루트 비교 열쇠 — 공유 주소(UNC)로 풀리면 그것, 아니면 서버가 읽는 경로. 결과물 스냅샷이 어느 루트에서 만든 것인지
    이것으로 적고 견준다(서버 훑기는 드라이브 글자, 도우미는 공유 주소를 들고 오므로 한 꼴로 맞춘다)."""
    raw = (root or "").strip()
    if not raw:
        return ""
    return (canonical_unc(raw) or resolve_root(raw)).replace("/", "\\").rstrip("\\").casefold()


def read_results(path: Path) -> tuple[Optional[dict[str, Any]], list[dict[str, Any]], list]:
    """결과물 모드 JSONL → (end 줄, 파일들, []). end 가 없으면 미완주."""
    end: Optional[dict[str, Any]] = None
    files: list[dict[str, Any]] = []
    if not path.is_file() or path.stat().st_size > MAX_RESULT_BYTES:
        return None, files, []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                item = json.loads(line)
            except ValueError:
                return None, [], []
            if item.get("t") == "end":
                end = item
            elif item.get("t") == "result":
                files.append(result_row(item))
    return end, files, []


def result_row(item: dict[str, Any]) -> dict[str, Any]:
    """자식(또는 도우미)이 낸 한 줄 → nas_result_file 한 행. 값은 ok 일 때만 남긴다."""
    ok = item.get("st") == "ok"
    return {
        "path": item["p"], "bytes": int(item.get("b") or 0), "mtime_ns": int(item.get("m") or 0),
        "head_sha": item.get("h") if ok else None,
        "hf_job_id": item.get("hf") if ok else None,
        "mv_job_id": item.get("mj") if ok else None,
        "mv_gen_id": item.get("mg") if ok else None,
        "id_conflict": 1 if ok and item.get("x") else 0,
        "status": item.get("st") or "undetermined",
    }


def apply_results_snapshot(project_id: str, start_root: str, runner: str, files: list[dict[str, Any]]) -> dict[str, Any]:
    """완주한 결과물 훑기를 그 프로젝트의 스냅샷으로 바꾼다 — **지금 루트가 훑기 시작 루트와 같을 때만**, 루트 재확인과
    교체를 한 트랜잭션에서(Codex 승인 조건). 다르면 버린다(훑는 사이 루트가 바뀌었다)."""
    key = root_key(start_root)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if not key or root_key(nas_repo.current_root(conn, project_id)) != key:
            return {"applied": False, "why": "root_changed"}
        count = nas_repo.replace_snapshot(conn, project_id, uuid.uuid4().hex, key, runner, files, registry.utc_now())
    return {"applied": True, "files": count}


def pm_projects() -> list[tuple[str, str, str]]:
    """(project_id, 이름, 루트) — 보관하지 않은 PM 프로젝트 중 루트가 있는 것."""
    out: list[tuple[str, str, str]] = []
    for p in repo.list_projects(include_archived=False).get("projects") or []:
        pid, name = str(p.get("id") or ""), str(p.get("name") or "")
        root = project_folders.effective_root_path(pid).strip() if pid else ""
        if pid and root:
            out.append((pid, name, root))
    return out


def read_result(path: Path) -> tuple[Optional[dict[str, Any]], list[registry.RegistryFile], list[tuple[str, int, str]]]:
    """결과 JSONL → (end 줄, 파일들, 대기 파일(경로, 크기, 이유)). end 가 없으면 미완주."""
    end: Optional[dict[str, Any]] = None
    files: list[registry.RegistryFile] = []
    pending: list[tuple[str, int, str]] = []
    if not path.is_file() or path.stat().st_size > MAX_RESULT_BYTES:
        return None, files, pending
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                item = json.loads(line)
            except ValueError:
                return None, [], []
            if item.get("t") == "end":
                end = item
            elif item.get("t") == "file":
                status = item.get("st") or "undetermined"
                files.append(registry.RegistryFile(item["p"], int(item.get("b") or 0), int(item.get("m") or 0),
                                                   item.get("s"), status))
                if status == "pending":
                    pending.append((item["p"], int(item.get("b") or 0), item.get("why") or "budget"))
    return end, files, pending


async def _kill(proc: subprocess.Popen) -> None:
    """자식을 끝낸다 — taskkill /T /F(worker_backup 과 같은 방식). 실패하면 proc.kill 로 한 번 더."""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        with contextlib.suppress(OSError, asyncio.TimeoutError):
            killer = await asyncio.create_subprocess_exec(
                shutil.which("taskkill.exe") or r"C:\Windows\System32\taskkill.exe",
                "/PID", str(proc.pid), "/T", "/F",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            await asyncio.wait_for(killer.wait(), timeout=5)
    if proc.poll() is None:
        with contextlib.suppress(OSError):
            proc.kill()
    for _ in range(50):
        if proc.poll() is not None:
            return
        await asyncio.sleep(0.1)


class HelperLeases:
    """도우미 PC 훑기 자리 하나(서버 메모리 — 재시작하면 사라지고, 그 뒤 올라온 결과는 거부된다).
    서버 자체 훑기와 서로 막는다: 한 번에 하나만 NAS 를 읽고 대장에 반영한다(request_scan 도 이 잠금 안에서 본다).
    반영(applying) 중에는 만료되지 않는다. 같은 순번·같은 내용의 재전송은 저장한 답을 다시 준다(응답 유실 대비)."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self._lease: Optional[dict[str, Any]] = None

    def alive_locked(self) -> bool:
        lease = self._lease
        return lease is not None and (lease["applying"] or lease["expires"] > time.monotonic())

    def active(self) -> bool:
        with self.lock:
            return self.alive_locked()

    def summary(self) -> Optional[dict[str, Any]]:
        with self.lock:
            lease = self._lease
            if lease is None or not self.alive_locked():
                return None
            return {"project_id": lease["project_id"], "name": lease["name"], "started_at": lease["started_at"]}

    def acquire(self, project_id: str, name: str, owner: str, unc: str, busy) -> Optional[dict[str, Any]]:
        """자리를 준다. 서버 훑기(busy())나 살아 있는 다른 자리가 있으면 None."""
        with self.lock:
            if busy() or self.alive_locked():
                return None
            self._lease = {
                "id": uuid.uuid4().hex, "project_id": project_id, "name": name, "owner": owner, "unc": unc,
                "started_at": registry.utc_now(), "expires": time.monotonic() + LEASE_TTL_S, "applying": False,
                "seq": 0, "digest": "", "ack": None,
            }
            return dict(self._lease)

    def _mine_locked(self, lease_id: str, owner: str) -> dict[str, Any]:
        lease = self._lease
        if lease is None or lease["id"] != lease_id or lease["owner"] != owner or not self.alive_locked():
            raise LookupError("훑기 자리가 없거나 만료됐습니다")
        return lease

    def renew(self, lease_id: str, owner: str) -> None:
        with self.lock:
            self._mine_locked(lease_id, owner)["expires"] = time.monotonic() + LEASE_TTL_S

    def begin_apply(self, lease_id: str, owner: str, seq: int, digest: str) -> tuple[str, Any]:
        """("ack", 저장한 답) — 같은 순번·같은 내용의 재전송. ("apply", 자리) — 반영해도 된다(applying 으로 묶는다).
        그 밖(낡은 순번·같은 순번의 다른 내용·반영 중)은 ValueError."""
        with self.lock:
            lease = self._mine_locked(lease_id, owner)
            if lease["applying"]:
                raise ValueError("이전 결과를 반영하는 중입니다")
            if seq == lease["seq"] and digest == lease["digest"] and lease["ack"] is not None:
                return "ack", lease["ack"]
            if seq != lease["seq"] + 1:
                raise ValueError("순번이 맞지 않습니다")
            lease["applying"] = True
            return "apply", dict(lease)

    def finish_apply(self, lease_id: str, seq: int, digest: str, ack: Optional[dict[str, Any]]) -> None:
        """반영을 끝낸다. ack 가 None(반영 실패)이면 순번을 올리지 않는다 — 같은 순번으로 다시 올릴 수 있다."""
        with self.lock:
            lease = self._lease
            if lease is None or lease["id"] != lease_id:
                return
            lease["applying"] = False
            lease["expires"] = time.monotonic() + LEASE_TTL_S
            if ack is not None:
                lease.update(seq=seq, digest=digest, ack=ack)

    def release(self, lease_id: str, owner: str) -> None:
        with self.lock:
            lease = self._lease
            if lease is not None and lease["id"] == lease_id and lease["owner"] == owner and not lease["applying"]:
                self._lease = None


leases = HelperLeases()


class AssetRegistryController:
    def __init__(self) -> None:
        self._run_task: Optional[asyncio.Task] = None
        self._loop_task: Optional[asyncio.Task] = None
        self._proc: Optional[subprocess.Popen] = None
        self._stopping = False
        self._current: dict[str, Any] = {}
        self._last: dict[str, Any] = {}
        # 지문 캐시(프로젝트 → 경로 → [크기, 시각, sha]) — 큰 파일 전용 실행·지난 주기의 지문을 다음 목록에서 다시 안 읽게.
        # 메모리에만 둔다(재시작하면 다시 계산). ponytail: 재시작이 잦아 큰 파일을 자꾸 다시 읽으면 표로 옮긴다.
        self._cache: dict[str, dict[str, list]] = {}
        self._priority: dict[str, list[str]] = {}
        self._waiting: dict[str, int] = {}  # 전용 실행으로도 못 끝낸 큰 파일 수('수동 스캔 대기')

    # ── 상태 ────────────────────────────────────────────────────────────────
    @property
    def enabled(self) -> bool:
        return ASSET_REGISTRY_ENABLED

    def busy(self) -> bool:
        return self._run_task is not None and not self._run_task.done()

    def status(self) -> dict[str, Any]:
        with get_connection() as conn:
            scans = registry.scan_rows(conn)
            counts = registry.registry_counts(conn)
        names = {
            str(p.get("id")): str(p.get("name") or "")
            for p in repo.list_projects(include_archived=True).get("projects") or [] if isinstance(p, dict)
        }
        return {
            "enabled": self.enabled,
            "mode": registry_mode(),
            "lease": leases.summary(),
            "interval_min": 0,  # 옛 간격 주기는 없앴다(2026-10-02) — 옛 화면 형식 호환용으로만 남긴다
            **schedule_status(),
            "running": self.busy(),
            "current": dict(self._current),
            "last": dict(self._last),
            "projects": [{**row, "name": names.get(row["project_id"], "")} for row in scans],
            "counts": counts,
            "waiting_large": dict(self._waiting),
        }

    # ── 수명 ────────────────────────────────────────────────────────────────
    def start(self) -> None:
        """정한 시간 자동 훑기 루프를 켠다(시간표가 '끔'이면 틱마다 아무것도 안 한다). 수동 훑기는 request_scan 이 언제든 받는다."""
        self._stopping = False
        self._clear_leftovers()
        if self._loop_task is None or self._loop_task.done():
            self._loop_task = asyncio.create_task(self._loop(), name="asset-registry-loop")

    @staticmethod
    def _clear_leftovers() -> None:
        """강제 종료가 남긴 작업 파일(경로 목록)을 치운다 — 자식이 없을 때만 부른다. 아직 멈추는 중인 옛 자식이 쥔 것은 다음에."""
        work = DATA_DIR / "asset_registry"
        for leftover in [*work.glob("job-*.json"), *work.glob("out-*.jsonl")]:
            with contextlib.suppress(OSError):
                leftover.unlink()

    async def stop(self) -> None:
        """새 실행을 막고 → 자식을 끝내고 → 기다린다. 반영 안 한 결과는 버린다."""
        self._stopping = True
        for task in (self._loop_task,):
            if task and not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        if self._proc is not None:
            await _kill(self._proc)
        if self._run_task and not self._run_task.done():
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(self._run_task, timeout=15)
        self._loop_task = None

    def request_scan(self, project_ids: Optional[list[str]] = None, mode: str = "manual", *, wait: bool = True) -> bool:
        # 도우미 PC 가 훑는 중(자리가 살아 있음)이거나 훑는 곳이 로컬이면 서버는 안 훑는다 — 자동·수동 모두 여기를 지나고,
        # 훑는 곳 바꾸기(set_mode)·자리 발급과 같은 잠금이라 서로 끼어들지 못한다(Codex P0).
        # wait=False(정한 시간 자동 시작): 이벤트 루프가 잠금·DB 를 기다리지 않게 바로 얻지 못하면 시작하지 않는다(Codex r3).
        if not leases.lock.acquire(blocking=wait):
            return False
        try:
            if self._stopping or self.busy() or leases.alive_locked() or not self._mode_allows(wait):
                return False
            self._run_task = asyncio.create_task(self._run(project_ids, mode), name=f"asset-registry-{mode}")
        finally:
            leases.lock.release()
        return True

    def _mode_allows(self, wait: bool = True) -> bool:
        """이 관리자가 훑어도 되나 — 서버는 '서버'를 골랐을 때만, DB 를 교체하는 중이 아닐 때만.
        도우미(관리자 PC)는 서버가 자리를 줄 때 본다(덮어쓴다)."""
        if not wait:
            return registry_mode_nowait() == "server"
        return not maintenance_active() and registry_mode() == "server"

    def set_mode(self, mode: str) -> bool:
        """훑는 곳을 바꾼다. 서버 훑기·도우미 자리가 살아 있거나 DB 를 교체하는 중이면 False — DB 를 기다리며
        leases.lock 을 쥐고 있으면 자동 주기(이벤트 루프)가 그 잠금에서 멈춘다."""
        global _mode_cache
        if maintenance_active():
            return False
        with leases.lock:
            if self.busy() or leases.alive_locked():
                return False
            with _mode_lock:
                repo.set_setting(_MODE_KEY, mode)
                _mode_cache = (pool_epoch(), mode)
        return True

    async def _loop(self) -> None:
        """정한 시간 자동 훑기(서버 모드) — 60초마다 '이번 회차를 서버가 맡나'만 묻는다. DB 는 스레드에서만(이벤트 루프는
        DB·잠금을 기다리지 않는다), 회차 기록은 취소돼도 끝까지 기다리는 스레드로(Codex r2)."""
        await asyncio.sleep(_STARTUP_DELAY_S)
        while not self._stopping:
            try:
                # 모드 캐시를 먼저 채운다 — 아래 wait=False 시작은 지금 에폭의 캐시만 본다(재시작·복원 직후 빈 캐시, Codex r3)
                await asyncio.to_thread(registry_mode)
                ok, _reason, slot, mark_id = await to_thread_non_abandon(consume_slot, "server", "server")
                if ok:
                    started = self.request_scan(mode="auto", wait=False)
                    log_event(_log, "asset_registry_scheduled", slot=slot, runner="server", started=started)
                    if not started:
                        await to_thread_non_abandon(mark_outcome, mark_id, "not_started")
            except Exception:  # noqa: BLE001 — 한 틱의 실패(DB 잠김 등)가 이후 회차를 없애지 않게
                _log.warning("asset_registry_schedule_tick_failed", exc_info=True)
            await asyncio.sleep(SCHEDULE_TICK_S)

    # ── 훑기 ────────────────────────────────────────────────────────────────
    async def _run(self, project_ids: Optional[list[str]], mode: str) -> None:
        manual_rate, auto_rate = _rates()
        rate = manual_rate if mode == "manual" else auto_rate
        deadline = MANUAL_DEADLINE_S if mode == "manual" else AUTO_DEADLINE_S
        started = time.monotonic()
        summary: dict[str, Any] = {"mode": mode, "projects": 0, "failed": 0}
        try:
            projects = await asyncio.to_thread(self._projects)
            if project_ids:
                wanted = set(project_ids)
                projects = [p for p in projects if p[0] in wanted]
            for pid, name, root in projects:
                if self._stopping:
                    break
                state = await self._project_run(pid, name, root, rate, deadline)
                summary["projects"] += 1
                summary["failed"] += int(state == "failed")
        except Exception:  # noqa: BLE001 — 한 번 실패해도 다음 실행을 막지 않는다
            log_event(_log, "asset_registry_run_failed", level=logging.WARNING, exc_info=True)
        finally:
            self._current = {}
            summary["elapsed_ms"] = int((time.monotonic() - started) * 1000)
            summary["finished_at"] = registry.utc_now()
            self._last = summary
            log_event(_log, "asset_registry_run", **summary)

    def _halted(self) -> bool:
        """자식을 멈춰야 하나 — 서버는 종료 중일 때만. 도우미는 로그인 바뀜·서버 자리 잃음도(services/asset_registry_helper)."""
        return self._stopping

    def _projects(self) -> list[tuple[str, str, str]]:
        """(project_id, 이름, 루트). 서버는 자기 PM 목록 — 도우미 PC 는 서버에 묻는다(services/asset_registry_helper)."""
        return pm_projects()

    async def _project_run(self, pid: str, name: str, root: str, rate: float, deadline: float) -> str:
        """프로젝트 하나: 일반 훑기 → 예산 밖 큰 파일이 있으면 전용 실행 → 다시 훑기. 첫 훑기의 상태를 돌려준다."""
        result = await self._scan_project(pid, name, root, rate, deadline)
        large = result.get("large") or []
        if large and not self._halted():
            if await self._hash_large(pid, root, large, rate):
                # 큰 파일 지문이 캐시에 들어왔다 — 목록을 한 번 더 돌려 이동·새 파일 판정을 온전히 한다.
                await self._scan_project(pid, name, root, rate, deadline)
        if result.get("state") != "stopped" and not self._halted():
            # 결과물 훑기(docs/NAS_RESULTS.md) — 같은 자리(서버 훑기·도우미 자리) 안에서 이어서. 대장 결과와 무관하게 돈다.
            await self._results_project(pid, name, root, rate)
        return str(result.get("state") or "")

    async def _results_project(self, pid: str, name: str, root_raw: str, rate: float) -> None:
        """render 까지 훑어 파일마다 앞 64KiB 지문·PNG 속 번호 — 완주만 스냅샷으로. 실패해도 대장에는 영향 없다."""
        t0 = time.monotonic()
        self._current = {"project_id": pid, "name": name, "phase": "results", "started_at": registry.utc_now()}
        job = {"root": resolve_root(root_raw), "results": True, "rate_bytes": rate, "dir_rate": DIR_RATE,
               "deadline_s": RESULTS_DEADLINE_S, "max_entries": MAX_ENTRIES}
        end, files, _pending, note = await self._run_child(job, RESULTS_DEADLINE_S, reader=read_results)
        complete = bool(end and end.get("complete")) and note != "stopping"
        outcome: dict[str, Any] = {"applied": False}
        if complete:
            outcome = await to_thread_non_abandon(self._apply_results, pid, root_raw, files)
        if "files" in outcome:
            # 저장 결과의 files(저장한 행 수)는 아래 files(훑은 수)와 이름이 겹친다 — 겹치면 TypeError 가 회차 전체를 멈췄다(2026-10-03).
            outcome["saved"] = outcome.pop("files")
        log_event(_log, "nas_results_scan", project_id=pid, complete=complete, files=len(files),
                  read=int((end or {}).get("read") or 0), undetermined=int((end or {}).get("undetermined") or 0),
                  pending=int((end or {}).get("pending") or 0), note=note or (end or {}).get("note") or "",
                  elapsed_ms=int((time.monotonic() - t0) * 1000), **outcome)

    def _apply_results(self, pid: str, root_raw: str, files: list[dict[str, Any]]) -> dict[str, Any]:
        """서버 훑기 — 서버 DB 에 스냅샷. 도우미는 이것을 서버로 올리는 것으로 바꾼다(services/asset_registry_helper)."""
        return apply_results_snapshot(pid, root_raw, "server", files)

    def _known(self, pid: str) -> dict[str, list]:
        with get_connection() as conn:
            rows = registry.registry_rows(conn, pid)
        known = {r["path"]: [r["bytes"], r["mtime_ns"] or 0, r["sha256"]] for r in rows if r["state"] == "present"}
        known.update(self._cache.get(pid) or {})
        return known

    async def _scan_project(self, pid: str, name: str, root_raw: str, rate: float, deadline_s: float) -> dict[str, Any]:
        root = resolve_root(root_raw)
        started_at = registry.utc_now()
        t0 = time.monotonic()
        self._current = {"project_id": pid, "name": name, "phase": "scan", "started_at": started_at}
        job = {
            "root": root,
            "known": await asyncio.to_thread(self._known, pid),
            "priority": self._priority.get(pid, []),
            "rate_bytes": rate,
            "dir_rate": DIR_RATE,
            "deadline_s": deadline_s,
            "max_entries": MAX_ENTRIES,
            "hide_render": True,
        }
        end, files, pending, note = await self._run_child(job, deadline_s)
        if note == "stopping":
            # 서버가 끄느라 끊은 것이지 NAS 상태가 아니다 — 결과는 버리고 마지막 훑기 기록도 덮지 않는다. 덮으면 그 프로젝트는
            # 다음 완주 전까지 레퍼런스 찾기에서 대장을 안 쓴다(2026-09-30 실측: 훑는 중 서버 재기동).
            log_event(_log, "asset_registry_scan", project_id=pid, state="stopped",
                      elapsed_ms=int((time.monotonic() - t0) * 1000))
            return {"state": "stopped", "large": []}
        complete = bool(end and end.get("complete"))
        scan = registry.RegistryScan(complete, files if complete else [])
        if complete:
            cache = self._cache.setdefault(pid, {})
            seen = {f.path for f in files}
            for gone in [p for p in cache if p not in seen]:
                del cache[gone]
            for f in files:
                if f.status == "ok" and f.sha256:
                    cache[f.path] = [f.bytes, f.mtime_ns, f.sha256]
            self._priority[pid] = [p for p, _size, why in pending if why == "budget"]
        state = "failed" if not complete else ("ok" if scan.clean else "partial")
        stats = {
            "root": root, "state": state, "started_at": started_at, "finished_at": registry.utc_now(),
            "complete": complete, "clean": scan.clean,
            "files": int((end or {}).get("files") or 0), "hashed": int((end or {}).get("hashed") or 0),
            "hashed_bytes": int((end or {}).get("hashed_bytes") or 0),
            "undetermined": int((end or {}).get("undetermined") or 0), "pending": int((end or {}).get("pending") or 0),
            "elapsed_ms": int((time.monotonic() - t0) * 1000),
            "note": note or (end or {}).get("note") or "",
        }
        kinds = await to_thread_non_abandon(self._apply, pid, name, scan, stats)
        log_event(_log, "asset_registry_scan", project_id=pid, **{k: v for k, v in stats.items() if k != "root"}, **kinds)
        large = [(p, size) for p, size, why in pending if why == "large"]
        return {"state": state, "large": large}

    def _apply(self, pid: str, name: str, scan: registry.RegistryScan, stats: dict[str, Any]) -> dict[str, int]:
        with get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            kinds: dict[str, int] = {}
            if scan.complete:
                plan = registry.plan_changes(registry.registry_rows(conn, pid), scan)
                kinds = registry.apply_plan(conn, pid, plan)
                if scan.clean and name:
                    kinds.update({f"backfill_{k}": v for k, v in registry.backfill_reference_links(conn, {name: pid}).items()})
            registry.record_scan(conn, pid, **stats)
        return kinds

    async def _hash_large(self, pid: str, root_raw: str, large: list[tuple[str, int]], rate: float) -> bool:
        """예산을 넘는 큰 파일만 같은 속도로 따로 읽는다(최대 LARGE_CAP_S). 끝낸 지문은 캐시에만 넣는다."""
        total = sum(size for _p, size in large)
        deadline = min(LARGE_CAP_S, math.ceil(total / rate) + 60)
        self._current = {"project_id": pid, "phase": "large", "files": len(large), "started_at": registry.utc_now()}
        job = {"root": resolve_root(root_raw), "hash_only": [p for p, _s in large], "rate_bytes": rate,
               "dir_rate": DIR_RATE, "deadline_s": deadline, "max_entries": MAX_ENTRIES}
        end, files, pending, _note = await self._run_child(job, deadline)
        done = 0
        if end and end.get("complete"):
            cache = self._cache.setdefault(pid, {})
            for f in files:
                if f.status == "ok" and f.sha256:
                    cache[f.path] = [f.bytes, f.mtime_ns, f.sha256]
                    done += 1
        self._waiting[pid] = len(large) - done
        return done > 0

    async def _run_child(self, job: dict[str, Any], deadline_s: float, reader=read_result):
        """(end, files, pending, note). 자식이 시간 상한 + KILL_GRACE_S 안에 안 끝나면 끝내고 결과를 버린다.
        reader — 결과 파일을 읽는 함수(대장: read_result, 결과물 모드: read_results)."""
        work = DATA_DIR / "asset_registry"
        work.mkdir(parents=True, exist_ok=True)
        tag = uuid.uuid4().hex
        job_path, out_path = work / f"job-{tag}.json", work / f"out-{tag}.jsonl"
        job = {**job, "out": str(out_path), "parent_pid": os.getpid()}  # 부모가 강제로 꺼지면 자식도 스스로 멈춘다
        note = ""
        try:
            job_path.write_bytes(json.dumps(job, ensure_ascii=False).encode("utf-8"))
            if self._halted():
                return None, [], [], "stopping"
            self._proc = subprocess.Popen(
                [sys.executable, "-m", "app.services.asset_registry_scan", str(job_path)],
                cwd=str(BACKEND_DIR),
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            limit = time.monotonic() + deadline_s + KILL_GRACE_S
            while self._proc.poll() is None:
                if self._halted() or time.monotonic() > limit:
                    note = "stopping" if self._halted() else "시간 초과 — 자식을 끝냄"
                    await _kill(self._proc)
                    return None, [], [], note
                await asyncio.sleep(0.5)
            if self._halted():  # stop() 이 자식을 먼저 끝냈다 — 비정상 종료가 아니라 서버 종료다
                return None, [], [], "stopping"
            if self._proc.returncode != 0:
                return None, [], [], f"자식 비정상 종료({self._proc.returncode})"
            end, files, pending = await asyncio.to_thread(reader, out_path)
            return end, files, pending, "" if end else "결과 없음"
        finally:
            self._proc = None
            for path in (job_path, out_path):
                with contextlib.suppress(OSError):
                    path.unlink()


controller = AssetRegistryController()
