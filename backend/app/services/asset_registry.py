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
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from .. import repo
from ..config import (
    ASSET_REGISTRY_DRIVES,
    ASSET_REGISTRY_ENABLED,
    ASSET_REGISTRY_INTERVAL_MIN,
    ASSET_REGISTRY_MIBPS,
    BACKEND_DIR,
    DATA_DIR,
)
from ..db import get_connection
from ..repo import asset_registry as registry
from . import project_folders
from .async_tools import to_thread_non_abandon
from .operational_logging import log_event

_log = logging.getLogger("mvhub.asset_registry")

MIB = 1 << 20
DIR_RATE = 20  # 초당 폴더 목록 읽기 상한(항목 수가 아니다 — scandir 한 번이 크기·시각을 함께 준다)
MAX_ENTRIES = 300_000
MAX_RESULT_BYTES = 256 * MIB
MANUAL_DEADLINE_S = 45 * 60
AUTO_DEADLINE_S = 5 * 60
LARGE_CAP_S = 45 * 60  # 큰 파일 전용 실행의 최대 시간 — 넘으면 '수동 스캔 대기'로 남긴다
KILL_GRACE_S = 30
_STARTUP_DELAY_S = 60


def _rates() -> tuple[float, float]:
    """(수동, 자동) 바이트/초. 설정이 이상하면 합의한 시작값(8, 5 MiB/s)."""
    try:
        manual, auto = (float(x) for x in ASSET_REGISTRY_MIBPS.split(",", 1))
        if manual > 0 and auto > 0:
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
            "interval_min": ASSET_REGISTRY_INTERVAL_MIN,
            "running": self.busy(),
            "current": dict(self._current),
            "last": dict(self._last),
            "projects": [{**row, "name": names.get(row["project_id"], "")} for row in scans],
            "counts": counts,
            "waiting_large": dict(self._waiting),
        }

    # ── 수명 ────────────────────────────────────────────────────────────────
    def start(self) -> None:
        """자동 주기를 켠다(간격 > 0 일 때만). 수동 훑기는 request_scan 이 언제든 받는다."""
        self._stopping = False
        if ASSET_REGISTRY_INTERVAL_MIN > 0 and (self._loop_task is None or self._loop_task.done()):
            self._loop_task = asyncio.create_task(self._loop(ASSET_REGISTRY_INTERVAL_MIN * 60), name="asset-registry-loop")

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

    def request_scan(self, project_ids: Optional[list[str]] = None, mode: str = "manual") -> bool:
        if self._stopping or self.busy():
            return False
        self._run_task = asyncio.create_task(self._run(project_ids, mode), name=f"asset-registry-{mode}")
        return True

    async def _loop(self, interval_s: float) -> None:
        await asyncio.sleep(_STARTUP_DELAY_S)
        while not self._stopping:
            if not self.busy():
                self.request_scan(mode="auto")
            await asyncio.sleep(interval_s)

    # ── 훑기 ────────────────────────────────────────────────────────────────
    async def _run(self, project_ids: Optional[list[str]], mode: str) -> None:
        manual_rate, auto_rate = _rates()
        rate = manual_rate if mode == "manual" else auto_rate
        deadline = MANUAL_DEADLINE_S if mode == "manual" else AUTO_DEADLINE_S
        started = time.monotonic()
        summary: dict[str, Any] = {"mode": mode, "projects": 0, "failed": 0}
        try:
            projects = await asyncio.to_thread(pm_projects)
            if project_ids:
                wanted = set(project_ids)
                projects = [p for p in projects if p[0] in wanted]
            for pid, name, root in projects:
                if self._stopping:
                    break
                result = await self._scan_project(pid, name, root, rate, deadline)
                summary["projects"] += 1
                summary["failed"] += int(result.get("state") == "failed")
                large = result.get("large") or []
                if large and not self._stopping:
                    if await self._hash_large(pid, root, large, rate):
                        # 큰 파일 지문이 캐시에 들어왔다 — 목록을 한 번 더 돌려 이동·새 파일 판정을 온전히 한다.
                        await self._scan_project(pid, name, root, rate, deadline)
        except Exception:  # noqa: BLE001 — 한 번 실패해도 다음 실행을 막지 않는다
            log_event(_log, "asset_registry_run_failed", level=logging.WARNING, exc_info=True)
        finally:
            self._current = {}
            summary["elapsed_ms"] = int((time.monotonic() - started) * 1000)
            summary["finished_at"] = registry.utc_now()
            self._last = summary
            log_event(_log, "asset_registry_run", **summary)

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

    async def _run_child(self, job: dict[str, Any], deadline_s: float):
        """(end, files, pending, note). 자식이 시간 상한 + KILL_GRACE_S 안에 안 끝나면 끝내고 결과를 버린다."""
        work = DATA_DIR / "asset_registry"
        work.mkdir(parents=True, exist_ok=True)
        tag = uuid.uuid4().hex
        job_path, out_path = work / f"job-{tag}.json", work / f"out-{tag}.jsonl"
        job = {**job, "out": str(out_path), "parent_pid": os.getpid()}  # 부모가 강제로 꺼지면 자식도 스스로 멈춘다
        note = ""
        try:
            job_path.write_bytes(json.dumps(job, ensure_ascii=False).encode("utf-8"))
            if self._stopping:
                return None, [], [], "stopping"
            self._proc = subprocess.Popen(
                [sys.executable, "-m", "app.services.asset_registry_scan", str(job_path)],
                cwd=str(BACKEND_DIR),
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            limit = time.monotonic() + deadline_s + KILL_GRACE_S
            while self._proc.poll() is None:
                if self._stopping or time.monotonic() > limit:
                    note = "stopping" if self._stopping else "시간 초과 — 자식을 끝냄"
                    await _kill(self._proc)
                    return None, [], [], note
                await asyncio.sleep(0.5)
            if self._proc.returncode != 0:
                return None, [], [], f"자식 비정상 종료({self._proc.returncode})"
            end, files, pending = await asyncio.to_thread(read_result, out_path)
            return end, files, pending, "" if end else "결과 없음"
        finally:
            self._proc = None
            for path in (job_path, out_path):
                with contextlib.suppress(OSError):
                    path.unlink()


controller = AssetRegistryController()
