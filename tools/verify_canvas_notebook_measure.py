"""Validate canvas-notebook browser evidence; missing measurements never pass.

Usage: python tools/verify_canvas_notebook_measure.py <report.json> [...]
Reports contain synthetic fixtures only. This command starts no server/browser.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from urllib.parse import urlsplit

CASES = {
    "cross_browser": {"closed_before_open", "content", "order", "deletion"},
    "normal_handoff": {"content", "input_flush", "drag_flush", "normal_notice", "within_five_seconds"},
    "crash_takeover": {"forced_notice", "offline_copy", "original_preserved"},
    "delete_crash": {"intent_durable", "absent_after_restart", "tombstone"},
    "lease_races": {"third_party", "late_release", "late_write", "restart", "account_aba", "bfcache", "floating_only"},
    "offline": {"local_edit", "no_save_failure", "new_token", "automatic_upload"},
    "bootstrap": {"first_canvas", "archive", "archive_unchanged", "no_merge"},
    "performance": {"fixture", "samples", "baseline", "latency", "sync_under_second"},
    "rollback": {"old_checkout", "old_write", "new_recovery", "retained", "overwrite_then_delete_retained", "deleted_original_absent"},
    "first_transition": {"previous_browser", "default_enabled", "before_confirmation", "no_upload_before", "confirmation",
                         "selected_raw", "join_generation", "other_browser_preserved", "no_merge", "before_start", "reconnect"},
}


def verify(report: dict) -> list[str]:
    if not isinstance(report, dict):
        return ["report object required"]
    errors: list[str] = []
    case = report.get("case")
    if report.get("format") != "mvhub-canvas-notebook-measure-v1":
        errors.append("unknown report format")
    if not isinstance(case, str) or case not in CASES:
        return errors + ["unknown case"]
    safety = report.get("isolation", {})
    if not isinstance(safety, dict):
        safety = {}
    try:
        shared = urlsplit(safety.get("shared_url", ""))
        loopback = (shared.scheme == "http" and shared.hostname == "127.0.0.1" and shared.port is not None
                    and 1024 <= shared.port <= 65535 and shared.port not in (8010, 8012)
                    and not (shared.username or shared.password or shared.path or shared.query or shared.fragment))
    except (TypeError, ValueError, AttributeError):
        loopback = False
    if (not loopback or safety.get("shared_url") != safety.get("owned_shared_url")
            or safety.get("has_token") is not True or safety.get("cli_available") is not False
            or any(safety.get(key) is not True for key in ("shared_process_owned", "shared_auth_enabled", "ephemeral_admin", "token_verified"))):
        errors.append("owned loopback S with verified ephemeral-admin session and CLI isolation required")
    profiles = report.get("profiles", [])
    if not isinstance(profiles, list) or len(profiles) != 2 or not all(isinstance(p, str) and p for p in profiles) or len(set(profiles)) != 2:
        errors.append("two distinct Chrome profiles required")
    if report.get("browser_kind") != "chrome":
        errors.append("Chrome measurement required")
    checks = report.get("checks", {})
    if not isinstance(checks, dict):
        return errors + ["checks object required"]
    for name in sorted(CASES[case]):
        check = checks.get(name, {})
        if not isinstance(check, dict) or check.get("status") != "passed" or "actual" not in check or "expected" not in check:
            errors.append(f"{case}.{name}: missing, failed or unverified")
    for name, check in checks.items():
        if not isinstance(check, dict) or check.get("status") != "passed":
            errors.append(f"{name}: non-passing measurement")
            continue
        try:
            actual = json.dumps(check["actual"], sort_keys=True, allow_nan=False)
            expected = json.dumps(check["expected"], sort_keys=True, allow_nan=False)
            if actual != expected:
                errors.append(f"{name}: actual/expected evidence differs")
        except (KeyError, TypeError, ValueError):
            errors.append(f"{name}: invalid comparison evidence")
    if report.get("errors"):
        errors.append("runner errors present")
    if report.get("forbidden_requests"):
        errors.append("generation or external mutation attempted")
    if case == "first_transition":
        transition = report.get("transition", {})
        if not isinstance(transition, dict):
            transition = {}
        if not isinstance(transition, dict) or transition.get("variant") not in {
                "empty", "different", "restored_unknown", "equal", "same_generation", "held", "limit_exact", "limit_over"} or transition.get("start_order") not in {"a", "b", "simultaneous"}:
            errors.append("explicit first-transition variant and start order required")
        if transition.get("variant") in {"limit_exact", "limit_over"}:
            boundary = checks.get("size_boundary")
            expected_size = 5 * 1024 * 1024 + (transition["variant"] == "limit_over")
            if not isinstance(boundary, dict) or boundary.get("status") != "passed" or boundary.get("actual") != expected_size:
                errors.append("measured UTF-8 size boundary required")
        if transition.get("fault", "none") not in {"none", "lost_chunk", "lost_commit"}:
            errors.append("unknown first-transition fault")
        elif transition.get("fault", "none") != "none":
            response_loss = checks.get("response_loss")
            if not isinstance(response_loss, dict) or response_loss.get("actual") != 1:
                errors.append("one processed response must actually be lost")
        records = report.get("previous_browser_records", {})
        if not isinstance(records, dict) or set(records) != {"a", "b"}:
            errors.append("actual previous-browser records for both profiles required")
        else:
            for name, record in records.items():
                def digest(value):
                    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)
                if (not isinstance(record, dict) or not digest(record.get("store_sha256")) or
                        not isinstance(record.get("scenes"), list) or not record["scenes"] or
                        any(not isinstance(row, dict) or not isinstance(row.get("id"), str) or not digest(row.get("sha256")) for row in record["scenes"])):
                    errors.append(f"previous browser {name}: ordered raw fingerprints required")
            if transition.get("variant") in {"same_generation", "held"}:
                try:
                    recovery = json.loads(records["a"].get("mirrorRecovery") or "null")
                    if not isinstance(recovery, dict) or not recovery.get("generation") or not isinstance(recovery.get("blockedIds"), list):
                        raise ValueError("mirror record missing")
                    if transition["variant"] == "held" and not recovery["blockedIds"]:
                        raise ValueError("actual held record missing")
                    if transition["variant"] == "same_generation" and recovery["blockedIds"]:
                        raise ValueError("normal untransmitted edit cannot use held provenance")
                except (TypeError, ValueError, AttributeError):
                    errors.append("actual previous-browser generation/held record required")
    if case == "performance":
        timing = report.get("timing", {})
        if not isinstance(timing, dict):
            return errors + ["timing object required"]
        values = timing.get("samples_ms", [])
        if not isinstance(values, list) or len(values) < 20 or any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in values):
            errors.append("at least 20 finite timing samples required")
        if type(timing.get("sync_ms")) not in (int, float) or not math.isfinite(timing["sync_ms"]) or not 0 <= timing["sync_ms"] < 1000:
            errors.append("ten-scene synchronization must finish below 1000 ms")
        limit, ratios = timing.get("max_slowdown"), timing.get("baseline_ratios")
        if type(limit) not in (int, float) or not math.isfinite(limit) or limit <= 0:
            errors.append("explicit positive slowdown threshold required; there is no default tolerance")
        elif not isinstance(ratios, dict) or any(type(ratios.get(key)) not in (int, float) or not math.isfinite(ratios[key]) or not 0 <= ratios[key] <= limit for key in ("p50_ms", "p95_ms")):
            errors.append("measured p50/p95 ratios exceed the explicit threshold or are missing")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", nargs="+", type=Path)
    args = parser.parse_args()
    failed = False
    for path in args.reports:
        try:
            problems = verify(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError, TypeError) as exc:
            problems = [str(exc)]
        print(f"{path}: " + ("PASS" if not problems else "FAIL: " + "; ".join(problems)))
        failed |= bool(problems)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
