"""One request lane shared by key checks and collection, with persisted budget/fences."""
from __future__ import annotations

import asyncio
import logging
import sqlite3
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone

from .. import config, manage_db
from ..repo import hf_org_usage as repo
from . import shared_connection
from .hf_org_usage_key import UsageError, load_key

KST = timezone(timedelta(hours=9))
FIRST_DAY = date(2026, 2, 1)
logger = logging.getLogger(__name__)


def day_ms(day: date) -> int:
    dt = datetime.combine(day, datetime.min.time(), tzinfo=KST)
    return int(dt.timestamp()) * 1000


def env_ok() -> bool:
    return (shared_connection.is_shared_team_server() and config.MANAGE_ENABLED
            and not config.READ_ONLY and config.EXTERNAL_RECOVERY_ENABLED)


def collect_ok(settings: dict, state: dict, owner: str, fence: int) -> bool:
    return (env_ok() and bool(settings["enabled"]) and not settings["restore_paused"]
            and settings["key_verified_revision"] == settings["revision"]
            and bool(settings["encrypted_key"]) and not state["pause_code"]
            and state["lease_owner"] == owner and state["lease_fence"] == fence
            and state["lease_until_ms"] > repo.now_ms())


def request_page(key: str, context: dict, start: int, end: int, cursor=None, *, collecting=True, limit=1000):
    from .hf_org_usage_client import fetch_page

    if not env_ok():
        raise UsageError("environment_blocked")
    ticket = uuid.uuid4().hex
    repo.reserve_request(ticket, context, collecting=collecting)
    retry_after = 0
    try:
        # Check again after waiting for SQLite's writer lock.
        if not env_ok():
            raise UsageError("environment_blocked")
        return fetch_page(key, start, end, cursor, expected_org=context["org_id"], limit=limit)
    except UsageError as exc:
        retry_after = exc.retry_after
        if collecting and exc.code in ("http_401", "http_403"):
            repo.pause_auth(context, exc.code)
        raise
    finally:
        repo.finish_request(ticket, retry_after=retry_after)


def schedule_due_windows(org_id: str, at: int) -> None:
    today = datetime.fromtimestamp(at // 1000, KST).date()
    first, midnight = day_ms(FIRST_DAY), day_ms(today)
    with repo.transaction() as conn:
        for offset in range(8):
            start = midnight - offset * repo.DAY_MS
            if start < first:
                continue
            conn.execute("INSERT OR IGNORE INTO hf_org_usage_window(org_id,start_ms,end_ms,kind,priority,next_due_ms) "
                         "VALUES(?,?,?,'day',?,?)", (org_id, start, start + repo.DAY_MS, repo.base_priority(start, at), at))
        state = repo.read_collector(conn)
        # Cursor advances on scheduling, not on success. A bad old day cannot stop history forever.
        backfill = state["backfill_cursor"] or first
        rotation = state["rotation_cursor"] or first
        if backfill < midnight - 7 * repo.DAY_MS:
            conn.execute("INSERT OR IGNORE INTO hf_org_usage_window(org_id,start_ms,end_ms,kind,priority,next_due_ms) "
                         "VALUES(?,?,?,'day',1,?)", (org_id, backfill, backfill + repo.DAY_MS, at))
            backfill += repo.DAY_MS
        if rotation >= midnight - 7 * repo.DAY_MS:
            rotation = first
        # One history slot per cycle with bounded priority; manual refresh is still coalesced.
        conn.execute("UPDATE hf_org_usage_window SET next_due_ms=MIN(next_due_ms,?) "
                     "WHERE org_id=? AND kind='day' AND start_ms=? AND next_due_ms<=?",
                     (at, org_id, rotation, at))
        conn.execute("UPDATE hf_org_usage_collector SET backfill_cursor=?,rotation_cursor=? WHERE singleton=1",
                     (backfill, rotation + repo.DAY_MS))


def collect_window(window: dict, context: dict, *, stop: threading.Event | None = None) -> None:
    from .hf_org_usage_client import DATA_START_MS

    key = load_key(repo.read_config())
    started = repo.now_ms()
    actual_start = max(window["start_ms"], DATA_START_MS)
    actual_end = min(window["end_ms"], started)
    if window["kind"] == "exact" and window["end_ms"] > repo.today_start(started):
        raise UsageError("invalid_period")
    if actual_end <= actual_start:
        raise UsageError("future_period")
    deadline = time.monotonic() + 240
    pages, restarts, retries = 0, 0, 0
    limit, limit_reduced = 1000, False
    cursor, seen = None, set()
    with manage_db.get_connection() as conn:
        repo.create_stage(conn)
        while True:
            if (stop and stop.is_set()) or time.monotonic() >= deadline:
                raise UsageError("window_deadline")
            try:
                page = request_page(key, context, actual_start, actual_end, cursor, limit=limit)
            except UsageError as exc:
                if exc.code == "report_limit_exceeded" and not limit_reduced and limit > 1:
                    limit, limit_reduced = max(1, limit // 2), True
                    continue  # Same cursor/bounds, once only, all calls use the common budget.
                if exc.code == "http_410" and restarts < 1:
                    conn.execute("DELETE FROM temp.hf_usage_stage")
                    conn.commit()
                    cursor, seen, pages = None, set(), 0
                    restarts += 1
                    continue
                if exc.code in ("rate_wait", "request_wait", "http_429") or (exc.code in ("http_5xx", "http_503") and retries < 3):
                    retries += exc.code in ("http_5xx", "http_503")
                    delay = max(exc.retry_after / 1000, min(2 ** retries, 8))
                    if delay + time.monotonic() >= deadline:
                        raise UsageError("window_deadline") from None
                    if stop:
                        if stop.wait(delay):
                            raise UsageError("stopped") from None
                    else:
                        time.sleep(delay)
                    if repo.acquire_lease(context["owner"]) != context["fence"]:
                        raise UsageError("stale_work") from None
                    continue
                raise
            if time.monotonic() >= deadline:
                raise UsageError("window_deadline")
            pages += 1
            repo.stage_rows(conn, page["rows"])
            limit_reduced = False  # A later page may independently need one smaller-limit attempt.
            cursor = page["next_cursor"]
            if not cursor:
                break
            if cursor in seen:
                raise UsageError("repeated_cursor")
            seen.add(cursor)
            if pages >= 1000:
                raise UsageError("page_limit")
        if not env_ok() or (stop and stop.is_set()):
            raise UsageError("environment_blocked")
        today_start = day_ms(datetime.now(KST).date())
        interval = (config.HF_ORG_USAGE_TODAY_SECONDS * 1000 if window["start_ms"] >= today_start
                    else 3_600_000 if window["start_ms"] >= today_start - 7 * repo.DAY_MS else repo.DAY_MS)
        if time.monotonic() >= deadline:
            raise UsageError("window_deadline")
        repo.publish_window(conn, window, context, actual_end=actual_end, started=started,
                            pages=pages, next_due=repo.now_ms() + interval, actual_start=actual_start,
                            complete=window["start_ms"] >= day_ms(FIRST_DAY) + repo.DAY_MS)
    repo.refresh_identity_links(context["org_id"])


class Collector:
    def __init__(self):
        self.owner = uuid.uuid4().hex
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if not env_ok() or self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self.run, name="hf-org-usage", daemon=True)
        self._thread.start()

    async def stop(self):
        self._stop.set()
        if self._thread:
            await asyncio.to_thread(self._thread.join, 40)
            if self._thread.is_alive():
                raise RuntimeError("Organization collector did not stop")
            self._thread = None

    def run(self):
        while not self._stop.wait(2):
            try:
                self.run_once()
            except Exception:
                # Failure recording can fail too; keep the worker alive without exception text.
                logger.warning("hf_org_usage: collection_failed")

    def run_once(self):
        window = None
        try:
            if not env_ok():
                return
            settings = repo.read_config()
            if not settings["enabled"] or not settings["encrypted_key"] or settings["restore_paused"]:
                return
            fence = repo.acquire_lease(self.owner)
            if fence is None or not collect_ok(settings, repo.read_collector(), self.owner, fence):
                return
            context = dict(revision=settings["revision"], org_id=settings["org_id"], owner=self.owner, fence=fence)
            schedule_due_windows(settings["org_id"], repo.now_ms())
            window = repo.due_window(settings["org_id"], repo.now_ms())
            if window:
                collect_window(window, context, stop=self._stop)
        except UsageError as exc:
            if window:
                repo.attempt_failed(window["id"], exc.code, max(60_000, exc.retry_after))
            else:
                logger.warning("hf_org_usage: collection_failed")
        except Exception as exc:
            if window:
                repo.attempt_failed(window["id"], "integrity_error" if isinstance(exc, sqlite3.IntegrityError) else "collection_failed")
            else:
                logger.warning("hf_org_usage: collection_failed")


collector = Collector()
