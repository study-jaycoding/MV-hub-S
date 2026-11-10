import json
from datetime import date

from app.repo import hf_org_usage as repo
from app.services.hf_org_usage_collector import day_ms
from app.usecases.hf_org_usage import compare_snapshot, period
from hf_org_usage_fake import row

START = day_ms(date(2026, 11, 1))


def snapshot(days=1):
    windows = [dict(id=i+1, start_ms=START+i*repo.DAY_MS, end_ms=START+(i+1)*repo.DAY_MS,
                    kind="day", snapshot_version=1, success_complete=1,
                    actual_start_ms=START+i*repo.DAY_MS, actual_end_ms=START+(i+1)*repo.DAY_MS,
                    succeeded_at_ms=START+(days+1)*repo.DAY_MS) for i in range(days)]
    return dict(windows=windows, rows=[], facts=[], job_ids=set(), links=[], accounts=[], transactions=[],
                check=None, content_read_at_ms=1, manage_read_at_ms=2)


def compare(data, days=1):
    return compare_snapshot(data, "org", START, START+days*repo.DAY_MS, START+(days+2)*repo.DAY_MS)


def test_kst_and_empty_success_vs_missing():
    assert period("2026-11-01", "2026-12-01") == (1793458800000, 1796050800000)
    data = snapshot()
    assert compare(data)["api_net_c"] == 0
    data["windows"] = []
    assert compare(data)["api_net_c"] is None
    assert compare(data)["api_reason"] == "missing_day"


def test_incomplete_first_day_and_unfinished_yesterday():
    data = snapshot()
    data["windows"][0]["success_complete"] = 0
    assert compare(data)["api_reason"] == "incomplete_day"
    data["windows"][0]["success_complete"] = 1
    data["windows"][0]["actual_end_ms"] -= 1
    assert compare(data)["api_reason"] == "unfinished_day"


def test_duplicate_ids_between_days_are_not_deduplicated():
    data = snapshot(2)
    data["rows"] = [dict(row(), window_id=1), dict(row(), window_id=2)]
    answer = compare(data, 2)
    assert answer["api_net_c"] is None and answer["api_reason"] == "duplicate_row"


def test_three_sources_charge_and_relation_do_not_multiply():
    data = snapshot()
    data["rows"] = [dict(row("r1"), window_id=1), dict(row("r2", type="charge", generation_id=None), window_id=1)]
    data["job_ids"] = {"job-1"}
    data["facts"] = [dict(workspace_id="space-1", real_credits=None, est_credits=1.25)]
    data["transactions"] = [dict(workspace_id="space-1", credits=-1.50, action="spend"),
                            dict(workspace_id="space-1", credits=0.25, action="refund"),
                            dict(workspace_id="space-1", credits=100, action="grant")]
    result = compare(data)
    item = result["spaces"][0]
    assert (item["api_net_c"], item["fact_c"], item["cli_c"], item["difference_c"]) == (250, 125, 125, 125)
    assert (item["generation_count"], item["mv_record"], item["non_generation"]) == (1, 1, 1)
    assert item["fact_estimated_count"] == item["cli_other_count"] == 1
    assert "unlinked@example.test" not in json.dumps(result)
    assert item["actors"][0]["label"].startswith("미연결 #")


def test_mismatch_is_sticky_and_exact_never_added_to_days():
    data = snapshot()
    exact = dict(data["windows"][0], id=2, kind="exact")
    data["windows"].append(exact)
    data["rows"] = [dict(row(), window_id=1), dict(row(credits_c=300), window_id=2)]
    data["check"] = dict(state="mismatch", exact_snapshot_version=1, daily_versions_json='{"1":1}')
    assert compare(data)["api_net_c"] == 300
    data["windows"][0]["snapshot_version"] = 2
    answer = compare(data)
    assert answer["api_source"] == "exact" and answer["check_state"] == "stale"
    data["windows"].pop()
    assert compare(data)["api_net_c"] is None


def test_invalid_legacy_amount_does_not_become_zero_and_deleted_space_stays():
    data = snapshot()
    data["transactions"] = [dict(workspace_id="deleted", credits=float("inf"), action="spend")]
    result = compare(data)["spaces"][0]
    assert result["workspace_id"] == "deleted"
    assert result["cli_c"] is None and result["difference_c"] is None and result["cli_invalid_count"] == 1


def test_over_31_days_and_future():
    assert compare(snapshot(32), 32)["check_state"] == "over_31_days"
    data = snapshot()
    answer = compare_snapshot(data, "org", START, START+repo.DAY_MS, START-1)
    assert answer["api_net_c"] is None and answer["api_reason"] == "future_period"


def test_unknown_row_type_is_in_total_and_shown_without_calling_it_charge():
    data = snapshot()
    data["rows"] = [dict(row(type="future_kind"), window_id=1)]
    item = compare(data)["spaces"][0]
    assert item["api_net_c"] == 125 and item["generation_count"] == item["non_generation"] == 0
    assert item["other_types"] == {"future_kind": 1}
