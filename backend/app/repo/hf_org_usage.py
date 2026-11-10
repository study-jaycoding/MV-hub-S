"""Organization snapshots, fenced publication and the shared persisted request budget."""
from __future__ import annotations

import hashlib
import json
import time
from contextlib import contextmanager

from .. import manage_db
from ..services.hf_org_usage_key import UsageError

DAY_MS = 86_400_000
LEASE_MS = 90_000
IO_MS = 90_000  # Longer than the HTTP hard deadline, also survives process death.
NO_AUTO_DUE = 2**63 - 1
ROW_FIELDS = (
    "row_id", "type", "created_at", "workspace_id", "workspace_name", "actor_user_id",
    "actor_email", "model", "model_name", "credits_c", "charged_c", "refunded_c",
    "status", "state", "error_code", "generation_id", "original_generation_id", "output_type", "surface",
)


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def today_start(at: int) -> int:
    return (at + 9 * 3_600_000) // DAY_MS * DAY_MS - 9 * 3_600_000


def base_priority(start: int, at: int) -> int:
    today = today_start(at)
    return 20 if start >= today else 15 if start >= today - 7 * DAY_MS else 0


def today_success(org_id: str | None, at: int) -> int | None:
    with manage_db.get_connection() as conn:
        row = conn.execute("SELECT succeeded_at_ms FROM hf_org_usage_window "
                           "WHERE org_id=? AND kind='day' AND start_ms=?", (org_id, today_start(at))).fetchone()
        return row[0] if row else None


@contextmanager
def transaction():
    with manage_db.get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        yield conn


def read_config(conn=None) -> dict:
    if conn is None:
        with manage_db.get_connection() as db:
            return read_config(db)
    row = conn.execute("SELECT * FROM hf_org_usage_config WHERE singleton=1").fetchone()
    if row is None:
        raise UsageError("not_initialized")
    return dict(row)


def read_collector(conn=None) -> dict:
    if conn is None:
        with manage_db.get_connection() as db:
            return read_collector(db)
    return dict(conn.execute("SELECT * FROM hf_org_usage_collector WHERE singleton=1").fetchone())


def latest_attempt(org_id: str | None) -> dict:
    with manage_db.get_connection() as conn:
        row = conn.execute("SELECT last_attempt_at_ms,last_attempt_code FROM hf_org_usage_window "
                           "WHERE org_id=? AND last_attempt_at_ms IS NOT NULL ORDER BY last_attempt_at_ms DESC LIMIT 1",
                           (org_id,)).fetchone()
        return dict(row) if row else {}


def update_config(expected_revision: int, changes: dict, *, verified=False) -> dict:
    allowed = {"org_id", "encrypted_key", "enabled", "restore_paused", "registered_at_ms",
               "registered_by", "expires_on", "last_check_at_ms", "last_check_code"}
    if not set(changes) <= allowed:
        raise ValueError("Unsupported config field")
    with transaction() as conn:
        old = read_config(conn)
        if old["revision"] != expected_revision:
            raise UsageError("revision_conflict")
        if changes.get("org_id") and old["org_id"] and changes["org_id"] != old["org_id"]:
            raise UsageError("organization_conflict")
        new_revision = old["revision"] + 1
        changes = dict(changes, revision=new_revision)
        # A confirmed key stays confirmed across explicit on/off, but restore invalidates it.
        changes["key_verified_revision"] = (new_revision if verified or (
            old["key_verified_revision"] == old["revision"]
            and "encrypted_key" not in changes and not changes.get("restore_paused")) else None)
        columns = ",".join(f"{key}=?" for key in changes)
        conn.execute(f"UPDATE hf_org_usage_config SET {columns} WHERE singleton=1", tuple(changes.values()))
        conn.execute("UPDATE hf_org_usage_collector SET lease_owner=NULL, lease_fence=lease_fence+1, "
                     "lease_until_ms=0, pause_code=NULL WHERE singleton=1")
        return read_config(conn)


def mark_key_check(revision: int, code: str, *, verified=False) -> None:
    with transaction() as conn:
        conn.execute("UPDATE hf_org_usage_config SET last_check_at_ms=?,last_check_code=?,"
                     "key_verified_revision=CASE WHEN ? THEN revision ELSE key_verified_revision END "
                     "WHERE singleton=1 AND revision=?", (now_ms(), code, int(verified), revision))


def acquire_lease(owner: str, at: int | None = None) -> int | None:
    at = now_ms() if at is None else at
    with transaction() as conn:
        current = read_collector(conn)
        if current["lease_owner"] != owner and current["lease_until_ms"] > at:
            return None
        fence = current["lease_fence"] + (current["lease_owner"] != owner or current["lease_until_ms"] <= at)
        conn.execute("UPDATE hf_org_usage_collector SET lease_owner=?,lease_fence=?,lease_until_ms=? "
                     "WHERE singleton=1", (owner, fence, at + LEASE_MS))
        return fence


def assert_current(conn, context: dict, at: int, *, collecting=True) -> None:
    config = read_config(conn)
    if config["revision"] != context["revision"] or config["org_id"] != context["org_id"]:
        raise UsageError("stale_work")
    if collecting:
        state = read_collector(conn)
        if (not config["enabled"] or config["restore_paused"] or state["pause_code"]
                or config["key_verified_revision"] != config["revision"]
                or state["lease_owner"] != context["owner"] or state["lease_fence"] != context["fence"]
                or state["lease_until_ms"] <= at):
            raise UsageError("stale_work")


def reserve_request(ticket: str, context: dict, *, collecting: bool, at=None) -> None:
    at = now_ms() if at is None else at
    with transaction() as conn:
        assert_current(conn, context, at, collecting=collecting)
        state = read_collector(conn)
        if state["io_until_ms"] > at or state["retry_after_ms"] > at:
            raise UsageError("request_wait", retry_after=max(state["io_until_ms"], state["retry_after_ms"]) - at)
        history = [ts for ts in json.loads(state["rate_state_json"]) if ts > at - 60_000]
        if len(history) >= 30:
            raise UsageError("rate_wait", retry_after=history[0] + 60_000 - at)
        history.append(at)
        conn.execute("UPDATE hf_org_usage_collector SET rate_state_json=?,io_owner=?,io_until_ms=? "
                     "WHERE singleton=1", (json.dumps(history), ticket, at + IO_MS))
        if collecting:
            conn.execute("UPDATE hf_org_usage_collector SET lease_until_ms=? WHERE singleton=1", (at + LEASE_MS,))


def finish_request(ticket: str, *, retry_after=0) -> None:
    with transaction() as conn:
        conn.execute("UPDATE hf_org_usage_collector SET io_owner=NULL,io_until_ms=0,"
                     "retry_after_ms=MAX(retry_after_ms,?) WHERE singleton=1 AND io_owner=?",
                     (now_ms() + retry_after if retry_after else 0, ticket))


def pause_auth(context: dict, code: str) -> None:
    with transaction() as conn:
        if read_config(conn)["revision"] == context["revision"]:
            conn.execute("UPDATE hf_org_usage_collector SET pause_code='auth',lease_fence=lease_fence+1,"
                         "lease_until_ms=0 WHERE singleton=1")
            conn.execute("UPDATE hf_org_usage_config SET enabled=0,key_verified_revision=NULL,"
                         "revision=revision+1,last_check_code=? WHERE singleton=1", (code,))


def reserve_windows(org_id: str, windows: list[tuple], *, at=None) -> None:
    at = now_ms() if at is None else at
    with transaction() as conn:
        for start, end, kind, priority in windows:
            conn.execute("INSERT INTO hf_org_usage_window(org_id,start_ms,end_ms,kind,priority,next_due_ms) "
                         "VALUES(?,?,?,?,?,?) ON CONFLICT(org_id,start_ms,end_ms,kind) DO UPDATE SET "
                         "priority=MAX(priority,excluded.priority),next_due_ms=MIN(next_due_ms,excluded.next_due_ms)",
                         (org_id, start, end, kind, priority, at))


def due_window(org_id: str, at: int) -> dict | None:
    with manage_db.get_connection() as conn:
        row = conn.execute("SELECT * FROM hf_org_usage_window WHERE org_id=? AND next_due_ms<=? "
                           "AND (kind='day' OR end_ms<=?) "
                           "ORDER BY priority DESC,next_due_ms,id LIMIT 1", (org_id, at, today_start(at))).fetchone()
        return dict(row) if row else None


def attempt_failed(window_id: int, code: str, retry_ms: int = 60_000) -> None:
    with transaction() as conn:
        at = now_ms()
        window = conn.execute("SELECT * FROM hf_org_usage_window WHERE id=?", (window_id,)).fetchone()
        if window is None:
            return
        failures = window["fail_count"] + 1
        deterministic = code.startswith("invalid_") or code in {
            "report_limit_exceeded", "row_outside_window", "response_range_mismatch",
            "page_limit", "repeated_cursor", "duplicate_row", "integrity_error"}
        delay = DAY_MS if deterministic else min(DAY_MS, max(retry_ms, 60_000 * 2**min(failures - 1, 11)))
        conn.execute("UPDATE hf_org_usage_window SET last_attempt_at_ms=?,last_attempt_code=?,next_due_ms=?,"
                     "fail_count=?,priority=? WHERE id=?",
                     (at, code, at + delay, failures, base_priority(window["start_ms"], at), window_id))


def publish_window(conn, window: dict, context: dict, *, actual_end: int, started: int,
                   pages: int, next_due: int, complete=True, actual_start: int | None = None) -> None:
    """Caller owns a TEMP stage on this connection; no persistent writes during HTTP."""
    conn.execute("BEGIN IMMEDIATE")
    assert_current(conn, context, now_ms())
    actual_start = window["start_ms"] if actual_start is None else actual_start
    if not window["start_ms"] <= actual_start < actual_end <= window["end_ms"]:
        raise UsageError("invalid_range")
    window_id = window["id"]
    fields = ",".join(ROW_FIELDS)
    count = conn.execute("SELECT COUNT(*) FROM temp.hf_usage_stage").fetchone()[0]
    conn.execute("DELETE FROM hf_org_usage_row WHERE window_id=?", (window_id,))
    conn.execute(f"INSERT INTO hf_org_usage_row(window_id,{fields}) SELECT ?,{fields} FROM temp.hf_usage_stage", (window_id,))
    at = now_ms()
    conn.execute("UPDATE hf_org_usage_window SET snapshot_version=snapshot_version+1,success_complete=?,"
                 "actual_start_ms=?,actual_end_ms=?,request_started_at_ms=?,succeeded_at_ms=?,"
                 "row_count=?,page_count=?,last_attempt_at_ms=?,last_attempt_code='ok',next_due_ms=?,"
                 "priority=?,fail_count=0 WHERE id=?",
                 (int(complete), actual_start, actual_end, started, at, count, pages, at, next_due,
                  base_priority(window["start_ms"], at), window_id))
    conn.execute("UPDATE hf_org_usage_collector SET last_progress_at_ms=? WHERE singleton=1", (at,))
    conn.commit()
    update_checks(conn, window["org_id"], window)


def create_stage(conn) -> None:
    # AS SELECT keeps the allowlisted row shape identical to the persisted table.
    conn.execute("CREATE TEMP TABLE hf_usage_stage AS SELECT * FROM hf_org_usage_row WHERE 0")
    conn.execute("CREATE UNIQUE INDEX temp.hf_usage_stage_id ON hf_usage_stage(row_id)")


def stage_rows(conn, rows: list[dict]) -> None:
    fields = ",".join(ROW_FIELDS)
    conn.executemany(f"INSERT INTO temp.hf_usage_stage({fields}) VALUES({','.join('?' for _ in ROW_FIELDS)})",
                     [tuple(row.get(key) for key in ROW_FIELDS) for row in rows])
    conn.commit()  # TEMP only; persistent publication is a later, fenced transaction.


def reconcile_identity_links(conn, org_id: str, actors: set[str], accounts: list[dict], at: int) -> dict:
    """Read-only account evidence; never writes account/creator or guesses UID prefixes."""
    result = {}
    for actor in actors:
        matches = [a for a in accounts if a.get("creator_uid") == actor]
        old = conn.execute("SELECT * FROM hf_org_identity_link WHERE org_id=? AND actor_user_id=?", (org_id, actor)).fetchone()
        valid = (actor not in ("", "local") and not actor.startswith("acct:")
                 and len(matches) == 1 and matches[0].get("status") == "approved")
        conflict = bool(old and old["state"] == "conflict") or len(matches) > 1 or (valid and old and old["account_email"]
                                      and old["account_email"] != matches[0]["email"])
        state = "conflict" if conflict else "verified" if valid else "stale"
        email = matches[0]["email"] if state == "verified" else old["account_email"] if old else None
        fingerprint = hashlib.sha256(json.dumps(matches, sort_keys=True).encode()).hexdigest()
        conn.execute("INSERT INTO hf_org_identity_link VALUES(?,?,?,?,?,?,?) ON CONFLICT(org_id,actor_user_id) "
                     "DO UPDATE SET account_email=excluded.account_email,creator_uid=excluded.creator_uid,"
                     "state=excluded.state,evidence_fingerprint=excluded.evidence_fingerprint,verified_at_ms=excluded.verified_at_ms",
                     (org_id, actor, email, actor, state, fingerprint, at))
        result[actor] = email if state == "verified" else None
    return result


def save_check(conn, org_id: str, start: int, end: int, state: str, exact: dict | None,
               versions: dict, reason: str | None) -> None:
    conn.execute("INSERT INTO hf_org_usage_check VALUES(?,?,?,?,?,?,?,?,?) "
                 "ON CONFLICT(org_id,start_ms,end_ms) DO UPDATE SET state=excluded.state,"
                 "exact_window_id=excluded.exact_window_id,exact_snapshot_version=excluded.exact_snapshot_version,"
                 "daily_versions_json=excluded.daily_versions_json,checked_at_ms=excluded.checked_at_ms,reason_code=excluded.reason_code",
                 (org_id, start, end, state, exact["id"] if exact else None,
                  exact["snapshot_version"] if exact else None, json.dumps(versions, sort_keys=True), now_ms(), reason))


def rows_for(conn, ids: list[int]) -> list[dict]:
    rows = []
    for window_id in ids:
        rows.extend(dict(row) for row in conn.execute("SELECT * FROM hf_org_usage_row WHERE window_id=?", (window_id,)))
    return rows


def daily_selection(windows: list[dict], start: int, end: int, at: int) -> tuple[list[dict], str | None]:
    days = {w["start_ms"]: w for w in windows if w["kind"] == "day" and w["end_ms"] == w["start_ms"] + DAY_MS}
    selected = []
    for day in range(start, min(end, at), DAY_MS):
        window = days.get(day)
        if not window or not window["snapshot_version"]:
            return selected, "missing_day"
        if not window["success_complete"] or window["actual_start_ms"] != day:
            return selected, "incomplete_day"
        if window["end_ms"] <= at and window["actual_end_ms"] != window["end_ms"]:
            return selected, "unfinished_day"
        selected.append(window)
    return selected, None if selected else "future_period"


def row_signature(rows: list[dict]) -> dict | None:
    result = {}
    for row in rows:
        if row["row_id"] in result:
            return None
        result[row["row_id"]] = tuple(row[key] for key in (
            "charged_c", "refunded_c", "credits_c", "actor_user_id", "workspace_id"))
    return result


def update_checks(conn, org_id: str, changed: dict) -> None:
    # Compare in a read snapshot, then fence the short writes against every observed version.
    at = now_ms()
    results = []
    conn.execute("BEGIN")
    try:
        exacts = [dict(r) for r in conn.execute(
            "SELECT * FROM hf_org_usage_window WHERE org_id=? AND kind='exact' AND success_complete=1 "
            "AND start_ms<? AND end_ms>? AND end_ms<=? AND end_ms-start_ms<=?",
            (org_id, changed["end_ms"], changed["start_ms"], today_start(at), 31 * DAY_MS))]
        for exact in exacts:
            windows = [dict(r) for r in conn.execute(
                "SELECT * FROM hf_org_usage_window WHERE org_id=? AND kind='day' AND start_ms>=? AND end_ms<=?",
                (org_id, exact["start_ms"], exact["end_ms"]))]
            days, reason = daily_selection(windows, exact["start_ms"], exact["end_ms"], at)
            if reason or not days or days[-1]["actual_end_ms"] != exact["actual_end_ms"]:
                continue
            daily = row_signature(rows_for(conn, [d["id"] for d in days]))
            state = ("duplicate" if daily is None else "matched" if daily ==
                     row_signature(rows_for(conn, [exact["id"]])) else "mismatch")
            results.append((exact, days, state))
    finally:
        conn.commit()
    for exact, days, state in results:
        conn.execute("BEGIN IMMEDIATE")
        try:
            observed = {w["id"]: w["snapshot_version"] for w in [exact, *days]}
            current = {r["id"]: r["snapshot_version"] for r in conn.execute(
                f"SELECT id,snapshot_version FROM hf_org_usage_window WHERE id IN ({','.join('?' for _ in observed)})",
                tuple(observed))}
            if current != observed:
                continue
            save_check(conn, org_id, exact["start_ms"], exact["end_ms"], state, exact,
                       {str(d["id"]): d["snapshot_version"] for d in days},
                       None if state == "matched" else "duplicate_row" if state == "duplicate" else "row_mismatch")
            if state in ("matched", "duplicate"):
                # An explicit refresh (priority 25) still gets its requested exact snapshot.
                conn.execute("UPDATE hf_org_usage_window SET next_due_ms=? WHERE id=? AND priority<25",
                             (NO_AUTO_DUE, exact["id"]))
            elif conn.execute("UPDATE hf_org_usage_window SET recheck_snapshot_version=? WHERE id=? "
                              "AND recheck_snapshot_version<?",
                              (exact["snapshot_version"], exact["id"], exact["snapshot_version"])).rowcount:
                conn.execute(f"UPDATE hf_org_usage_window SET next_due_ms=MIN(next_due_ms,?) "
                             f"WHERE id IN ({','.join('?' for _ in observed)}) AND fail_count=0",
                             (at + 600_000, *observed))
        except Exception:
            conn.rollback()
            raise
        finally:
            if conn.in_transaction:
                conn.commit()


def read_comparison_snapshot(org_id: str, start: int, end: int) -> dict:
    from ..db import get_connection as content_connection

    # Separate physical DB snapshots; expose their observation times instead of claiming atomic cross-DB time.
    with content_connection() as conn:
        conn.execute("BEGIN")
        accounts = [dict(r) for r in conn.execute("SELECT email,creator_uid,status FROM account")]
        transactions = [dict(r) for r in conn.execute(
            "SELECT workspace_id,credits,action,created_at FROM credit_txn "
            "WHERE julianday(created_at)>=julianday(?/1000.0,'unixepoch') "
            "AND julianday(created_at)<julianday(?/1000.0,'unixepoch')", (start, end))]
        content_at = now_ms()
    with manage_db.get_connection() as conn:
        conn.execute("BEGIN")
        windows = [dict(r) for r in conn.execute("SELECT * FROM hf_org_usage_window WHERE org_id=? "
                   "AND start_ms>=? AND end_ms<=?", (org_id, start, end))]
        rows = rows_for(conn, [w["id"] for w in windows])
        facts = [dict(r) for r in conn.execute(
            "SELECT workspace_id,workspace_name,real_credits,est_credits,created_at FROM team_generation_fact "
            "WHERE julianday(created_at)>=julianday(?/1000.0,'unixepoch') "
            "AND julianday(created_at)<julianday(?/1000.0,'unixepoch')", (start, end))]
        # EXISTS semantics: duplicate telemetry reports never multiply organization usage.
        job_ids = {r[0] for r in conn.execute("SELECT DISTINCT f.job_id FROM team_generation_fact f "
                   "WHERE EXISTS(SELECT 1 FROM hf_org_usage_row r JOIN hf_org_usage_window w ON w.id=r.window_id "
                   "WHERE w.org_id=? AND w.start_ms>=? AND w.end_ms<=? AND r.generation_id=f.job_id)", (org_id, start, end))}
        links = [dict(r) for r in conn.execute("SELECT * FROM hf_org_identity_link WHERE org_id=?", (org_id,))]
        check = conn.execute("SELECT * FROM hf_org_usage_check WHERE org_id=? AND start_ms=? AND end_ms=?", (org_id, start, end)).fetchone()
        manage_at = now_ms()
    return dict(windows=windows, rows=rows, facts=facts, job_ids=job_ids, links=links,
                accounts=accounts, transactions=transactions, check=dict(check) if check else None,
                content_read_at_ms=content_at, manage_read_at_ms=manage_at)


def refresh_identity_links(org_id: str) -> None:
    from ..db import get_connection as content_connection
    with content_connection() as conn:
        accounts = [dict(r) for r in conn.execute("SELECT email,creator_uid,status FROM account")]
    with transaction() as conn:
        actors = {r[0] for r in conn.execute("SELECT DISTINCT actor_user_id FROM hf_org_usage_row r "
                  "JOIN hf_org_usage_window w ON w.id=r.window_id WHERE w.org_id=?", (org_id,)) if r[0]}
        reconcile_identity_links(conn, org_id, actors, accounts, now_ms())
