"""Phase 1 administrator actions and comparison; existing quota consumers stay untouched."""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from decimal import Decimal

from ..repo import hf_org_usage as repo
from ..services import hf_org_usage_collector as worker
from ..services.hf_org_usage_key import UsageError, hashed, load_key, protect_key, public_key_state


def period(start=None, end=None, *, at=None) -> tuple[int, int]:
    today = at or datetime.now(worker.KST).date()
    try:
        first = date.fromisoformat(start) if start else today.replace(day=1)
        last = date.fromisoformat(end) if end else (today.replace(day=28) + timedelta(days=4)).replace(day=1)
        if first >= last or first < worker.FIRST_DAY or (last - first).days > 3660:
            raise ValueError()
        return worker.day_ms(first), worker.day_ms(last)
    except (ValueError, TypeError, OverflowError):
        raise UsageError("invalid_period") from None


def status() -> dict:
    config = repo.read_config()
    result = public_key_state(config)
    state = repo.read_collector()
    result.update(repo.latest_attempt(config["org_id"]))
    result.update(environment_ok=worker.env_ok(), pause_code=state["pause_code"],
                  last_success_at_ms=state["last_progress_at_ms"],
                  delay_ms=repo.now_ms() - state["last_progress_at_ms"] if state["last_progress_at_ms"] else None)
    return result


def _context(config):
    return {"revision": config["revision"], "org_id": config["org_id"]}


def _confirm(key: str, config: dict) -> dict:
    at = repo.now_ms()
    today = worker.day_ms(datetime.now(worker.KST).date())
    try:
        return worker.request_page(key, _context(config), today, max(today + 1, at), collecting=False)
    except UsageError as exc:
        if exc.code != "report_limit_exceeded":
            raise
    return worker.request_page(key, _context(config), today, max(today + 1, at), collecting=False, limit=500)


def register_key(key: str, expected_revision: int, expires_on: str | None, actor: str, authorize) -> dict:
    config = repo.read_config()
    if config["revision"] != expected_revision:
        raise UsageError("revision_conflict")
    if expires_on:
        try:
            date.fromisoformat(expires_on)
        except (TypeError, ValueError):
            raise UsageError("invalid_expiry") from None
    answer = _confirm(key, config)
    protected = protect_key(key)
    authorize()  # The network wait may outlive the administrator's approval/session.
    repo.update_config(expected_revision, dict(org_id=answer["org_id"], encrypted_key=protected,
                       enabled=0, restore_paused=0, registered_at_ms=repo.now_ms(), registered_by=actor,
                       expires_on=expires_on, last_check_at_ms=repo.now_ms(), last_check_code="ok"), verified=True)
    return status()


def check_key(key: str | None, expected_revision: int, authorize) -> dict:
    config = repo.read_config()
    if config["revision"] != expected_revision:
        raise UsageError("revision_conflict")
    try:
        _confirm(key or load_key(config), config)
    except UsageError as exc:
        authorize()
        if key is None:
            repo.mark_key_check(expected_revision, exc.code)
            if exc.code in ("http_401", "http_403"):
                repo.pause_auth(_context(config), exc.code)
        raise
    authorize()
    if repo.read_config()["revision"] != expected_revision:
        raise UsageError("revision_conflict")
    if key is None:
        repo.mark_key_check(expected_revision, "ok", verified=True)
    return dict(status(), check_code="ok", candidate=key is not None)


def delete_key(expected_revision: int) -> dict:
    repo.update_config(expected_revision, dict(encrypted_key=None, enabled=0, registered_at_ms=None,
                       registered_by=None, expires_on=None, last_check_at_ms=None, last_check_code=None))
    return status()


def set_collection(enabled: bool, expected_revision: int) -> dict:
    config = repo.read_config()
    if enabled:
        if not worker.env_ok():
            raise UsageError("environment_blocked")
        load_key(config)
        if config["key_verified_revision"] != expected_revision:
            raise UsageError("key_check_required")
    repo.update_config(expected_revision, dict(enabled=int(enabled), restore_paused=0 if enabled else config["restore_paused"]))
    return status()


def request_refresh(start=None, end=None) -> dict:
    first, last = period(start, end)
    config = repo.read_config()
    if not worker.env_ok() or not config["enabled"] or config["restore_paused"]:
        raise UsageError("collection_disabled")
    load_key(config)
    if config["key_verified_revision"] != config["revision"] or repo.read_collector()["pause_code"]:
        raise UsageError("key_check_required")
    at = repo.now_ms()
    windows = [(day, day + repo.DAY_MS, "day", 30) for day in range(first, min(last, at), repo.DAY_MS)]
    if last - first <= 31 * repo.DAY_MS and first < at:
        windows.append((first, last, "exact", 25))
    repo.reserve_windows(config["org_id"], windows)
    return dict(queued=len(windows), start_ms=first, end_ms=last)


def _legacy_cents(value) -> int | None:
    """Legacy REAL source: str(value) is observable precision, not recovered original precision."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value)) * 100
        if not number.is_finite() or number != number.to_integral_value() or abs(number) > 2**63 - 1:
            return None
        return int(number)
    except (ValueError, ArithmeticError):
        return None


def _actor_labels(snapshot: dict, org_id: str) -> dict:
    result = {}
    old = {link["actor_user_id"]: link for link in snapshot["links"]}
    for actor in {row["actor_user_id"] or "" for row in snapshot["rows"]}:
        matches = [a for a in snapshot["accounts"] if a.get("creator_uid") == actor]
        link = old.get(actor)
        valid = (actor and actor != "local" and not actor.startswith("acct:") and len(matches) == 1
                 and matches[0]["status"] == "approved"
                 and (not link or link["state"] != "conflict" and
                      (not link["account_email"] or link["account_email"] == matches[0]["email"])))
        result[actor] = matches[0]["email"] if valid else "미연결 #" + hashed(org_id + ":" + actor)
    return result


def compare_snapshot(snapshot: dict, org_id: str, start: int, end: int, at: int) -> dict:
    windows = snapshot["windows"]
    days, reason = repo.daily_selection(windows, start, end, at)
    daily_ids = {w["id"] for w in days}
    daily_rows = [r for r in snapshot["rows"] if r["window_id"] in daily_ids]
    if repo.row_signature(daily_rows) is None:
        reason = "duplicate_row"
    exact = next((w for w in windows if w["kind"] == "exact" and w["start_ms"] == start
                  and w["end_ms"] == end and w["success_complete"]
                  and w["actual_start_ms"] == start
                  and w["actual_end_ms"] >= min(end, worker.day_ms(datetime.fromtimestamp(at // 1000, worker.KST).date()))), None)
    check = snapshot["check"]
    versions = {str(w["id"]): w["snapshot_version"] for w in days}
    checked_current = bool(check and exact and check["exact_snapshot_version"] == exact["snapshot_version"]
                           and json.loads(check["daily_versions_json"]) == versions)
    check_state = (check["state"] if checked_current else "stale" if check else "not_checked")
    if end - start > 31 * repo.DAY_MS:
        check_state = "over_31_days"
    if check and check["state"] == "mismatch":
        reason = "daily_mismatch"  # Sticky until a later exact/daily check actually passes.
    chosen, rows, source = days, daily_rows, "daily"
    if reason:
        if exact:
            chosen, source = [exact], "exact"
            rows = [r for r in snapshot["rows"] if r["window_id"] == exact["id"]]
        else:
            chosen, rows, source = [], [], None
    confirmed = source is not None
    labels = _actor_labels(snapshot, org_id)
    spaces = {}

    def space(workspace_id, name=None):
        key = workspace_id or ""
        if key not in spaces:
            spaces[key] = dict(workspace_id=workspace_id, workspace_name=name or workspace_id or "공간 미상",
                               api_net_c=0 if confirmed else None, api_charged_c=0 if confirmed else None,
                               api_refunded_c=0 if confirmed else None, generation_count=0 if confirmed else None,
                               fact_c=0, fact_estimated_count=0, fact_invalid_count=0,
                               cli_c=0, cli_other_count=0, cli_invalid_count=0,
                               mv_record=0 if confirmed else None, no_mv_record=0 if confirmed else None,
                               non_generation=0 if confirmed else None, actors={}, errors={}, other_types={})
        return spaces[key]

    for row in rows:
        item = space(row["workspace_id"], row["workspace_name"])
        for output, column in (("api_net_c", "credits_c"), ("api_charged_c", "charged_c"), ("api_refunded_c", "refunded_c")):
            item[output] += row[column]
        is_generation = row["type"] == "generation"
        item["generation_count"] += is_generation
        if row["type"] == "charge":
            item["non_generation"] += 1
        elif is_generation:
            relation = "mv_record" if row["generation_id"] in snapshot["job_ids"] else "no_mv_record"
            item[relation] += 1
        else:
            item["other_types"][row["type"]] = item["other_types"].get(row["type"], 0) + 1
        label = labels[row["actor_user_id"] or ""]
        actor = item["actors"].setdefault(label, dict(label=label, net_c=0, charged_c=0, refunded_c=0, generation_count=0))
        actor["net_c"] += row["credits_c"]
        actor["charged_c"] += row["charged_c"]
        actor["refunded_c"] += row["refunded_c"]
        actor["generation_count"] += is_generation
        if row["error_code"]:
            item["errors"][row["error_code"]] = item["errors"].get(row["error_code"], 0) + 1
    for fact in snapshot["facts"]:
        item = space(fact["workspace_id"], fact.get("workspace_name"))
        estimated = fact["real_credits"] is None
        cents = _legacy_cents(fact["est_credits"] if estimated else fact["real_credits"])
        item["fact_estimated_count"] += estimated
        if cents is None:
            item["fact_invalid_count"] += 1
        else:
            item["fact_c"] += cents
    for transaction in snapshot["transactions"]:
        item = space(transaction["workspace_id"])
        if transaction["action"] not in ("spend", "refund"):
            item["cli_other_count"] += 1
            continue
        cents = _legacy_cents(transaction["credits"])
        if cents is None or (transaction["action"] == "spend" and cents > 0) or (transaction["action"] == "refund" and cents < 0):
            item["cli_invalid_count"] += 1
        else:
            item["cli_c"] -= cents  # Spend is negative, refund positive; never abs().
    last = min((w["succeeded_at_ms"] for w in chosen), default=None)
    actual_end = max((w["actual_end_ms"] for w in chosen), default=None)
    for item in spaces.values():
        if item["fact_invalid_count"]:
            item["fact_c"] = None
        if item["cli_invalid_count"]:
            item["cli_c"] = None
        item["difference_c"] = item["api_net_c"] - item["cli_c"] if confirmed and item["cli_c"] is not None else None
        item["actors"] = sorted(item["actors"].values(), key=lambda a: a["label"])
        item["errors"] = [dict(code=key, count=value) for key, value in sorted(item["errors"].items())]
        item.update(source=source, completeness="complete" if confirmed else "unconfirmed", last_success_at_ms=last)
    return dict(start_ms=start, end_ms=end, actual_end_ms=actual_end, api_source=source, api_reason=reason,
                api_net_c=sum(r["credits_c"] for r in rows) if confirmed else None,
                check_state=check_state, checked_current=checked_current, snapshot_versions={str(w["id"]): w["snapshot_version"] for w in chosen},
                last_success_at_ms=last, delay_ms=at - last if last else None,
                content_read_at_ms=snapshot["content_read_at_ms"], manage_read_at_ms=snapshot["manage_read_at_ms"],
                sources={"api": "created_at", "facts": "created_at (real else estimated)", "cli": "transaction created_at; legacy REAL precision"},
                spaces=list(spaces.values()))


def compare_usage(start=None, end=None) -> dict:
    first, last = period(start, end)
    config = repo.read_config()
    snapshot = repo.read_comparison_snapshot(config["org_id"] or "", first, last)
    return compare_snapshot(snapshot, config["org_id"] or "", first, last, repo.now_ms())
