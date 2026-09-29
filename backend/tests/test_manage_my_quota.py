"""Isolated repository tests for the personal advisory quota read model."""

import sqlite3

import pytest

from app import db, manage_db
from app.repo import manage_credit_plan as credit_plan
from app.repo.manage_quota import my_quota
from app.repo.manage_schema import _ensure_schema


@pytest.fixture(autouse=True)
def isolated_quota_db(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    monkeypatch.setattr(manage_db, "MANAGE_DB_PATH", tmp_path / "manage_hub.db")
    monkeypatch.setattr(credit_plan, "today_local", lambda: "2026-09-28")
    db.flush_pool()
    db.init_db()
    manage_db.init_manage_db()
    with db.get_connection() as conn:
        _ensure_schema(conn)
    yield
    db.flush_pool()


def _group(limit=900, *, quotas=None, period="month", anchor=1):
    quotas = {"a@x": None, "b@x": None, "c@x": None} if quotas is None else quotas
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO workspace_credit_plan(workspace_id, topup_day, revision) VALUES('ws1', ?, 7)",
            (anchor,),
        )
        conn.execute(
            "INSERT INTO workspace_credit_group(id, workspace_id, name, monthly_limit, "
            "limit_period, base_start, base_balance) VALUES('g1', 'ws1', 'Artists', ?, ?, '2024-01-01', 9000)",
            (limit, period),
        )
        conn.executemany(
            "INSERT INTO workspace_credit_group_member(workspace_id, account_email, group_id, quota) "
            "VALUES('ws1', ?, 'g1', ?)",
            list(quotas.items()),
        )


def _fact(gid, real=None, estimated=None, **patch):
    return {
        "local_gen_id": gid,
        "job_id": f"job-{gid}",
        "workspace_scope": "team",
        "workspace_id": "ws1",
        "workspace_name": "WS1",
        "model": "test-model",
        "status": "done",
        "real_credits": real,
        "est_credits": estimated,
        "created_at": "2026-09-28T00:00:00Z",
        **patch,
    }


def _push(*facts, email="a@x"):
    count, skipped = manage_db.upsert_facts(email, f"uid-{email}", list(facts))
    assert count == len(facts)
    assert skipped == []


def test_finite_override_and_exhausted_remaining():
    _group(10000, quotas={"a@x": 4000, "b@x": None})
    _push(_fact("real", real=3900), _fact("estimated", estimated=100))
    assert my_quota("ws1", " A@X ") == {
        "workspace_id": "ws1", "source": "override", "group_id": "g1", "group_name": "Artists",
        "quota": 4000.0, "used_real": 3900.0, "used_estimated": 100.0,
        "estimated_count": 1, "unknown_count": 0, "used": 4000.0, "remaining": 0.0, "exhausted": True,
        "limit_period": "month", "period_start": "2026-09-01T00:00:00+09:00",
        "period_end": "2026-10-01T00:00:00+09:00", "revision": 7, "enforcement": "advisory",
    }


def test_auto_share_is_the_per_person_limit_and_has_no_carryover():
    """그룹 한도 = 인당(Jay 2026-09-29). 덮어쓴 사람이 있어도 나머지 몫은 한도 그대로, base_balance 9000 은 무시."""
    _group(1000, quotas={"a@x": 600, "b@x": None, "c@x": None})
    _push(_fact("b", real=30), email="b@x")
    result = my_quota("ws1", "b@x")
    assert (result["source"], result["quota"], result["remaining"]) == ("auto", 1000, 970)
    assert my_quota("ws1", "a@x")["quota"] == 600


def test_zero_limit_is_exhausted_for_auto_members():
    _group(0, quotas={"a@x": None})
    result = my_quota("ws1", "a@x")
    assert (result["source"], result["quota"], result["remaining"], result["exhausted"]) == ("auto", 0, 0, True)


def test_small_positive_remaining_is_not_exhausted_after_display_rounding():
    _group(100, quotas={"a@x": 100 / 3, "b@x": None, "c@x": None})
    _push(_fact("small-remainder", real=33.33))
    result = my_quota("ws1", "a@x")
    assert result["remaining"] == 0
    assert result["exhausted"] is False


@pytest.mark.parametrize("quota", [0, 4000])
def test_override_is_finite_even_in_unlimited_group(quota):
    _group(None, quotas={"a@x": quota, "b@x": None})
    result = my_quota("ws1", "a@x")
    assert (result["source"], result["quota"], result["remaining"]) == ("override", quota, quota)
    unlimited = my_quota("ws1", "b@x")
    assert (unlimited["source"], unlimited["quota"], unlimited["remaining"]) == ("unlimited", None, None)
    assert unlimited["limit_period"] == "month"


def test_unassigned_has_no_quota_or_period_but_preserves_revision():
    assert my_quota("ws1", "a@x")["revision"] == 0
    _group(900, quotas={"b@x": None})
    result = my_quota("ws1", "a@x")
    assert result["source"] == "unassigned"
    assert result["revision"] == 7
    assert all(result[key] is None for key in (
        "group_id", "group_name", "quota", "remaining", "limit_period", "period_start", "period_end",
    ))


def test_real_estimated_unknown_and_tombstones_follow_existing_fact_scope():
    _group()
    _push(
        _fact("real", real=12.25, estimated=100),
        _fact("real-free", real=0, estimated=100),
        _fact("deleted", real=2.5, is_deleted=True),
        _fact("failed", estimated=7.5, status="failed"),
        _fact("pending", estimated=1.25, status="pending"),
        _fact("est-free", estimated=0),
        _fact("unknown"),
        _fact("no-date", real=100, created_at=None, is_deleted=True),
        _fact("old", real=100, created_at="2026-08-31T14:59:59Z"),
        _fact("future", real=100, created_at="2026-09-30T15:00:00Z"),
        _fact("other-space", real=100, workspace_id="ws2"),
        _fact("personal", real=100, workspace_scope="personal", workspace_id=None),
        _fact("unknown-space", real=100, workspace_scope="unknown", workspace_id=None),
    )
    _push(_fact("other-account", real=100), email="b@x")
    with db.get_connection() as conn:
        conn.execute(
            "INSERT INTO credit_txn(id, account_email, credits, action, workspace_id) "
            "VALUES('refund', 'a@x', 10, 'refund', 'ws1')"
        )
    result = my_quota("ws1", "a@x")
    assert (result["used_real"], result["used_estimated"], result["used"]) == (14.75, 8.75, 23.5)
    assert (result["estimated_count"], result["unknown_count"]) == (3, 1)
    assert result["remaining"] == 876.5


def test_repeated_facts_and_changed_local_id_count_job_once():
    _group()
    _push(_fact("old", estimated=100))
    _push(_fact("old", estimated=100))
    _push(_fact("new", real=75, estimated=100, job_id="job-old"))
    _push(_fact("new", real=75, estimated=100, job_id="job-old"))
    result = my_quota("ws1", "a@x")
    assert (result["used"], result["used_real"], result["used_estimated"]) == (75, 75, 0)
    assert result["estimated_count"] == 0


def test_quota_and_usage_are_not_rounded_before_subtraction():
    _group(100, quotas={"a@x": 100 / 3, "b@x": None, "c@x": None})
    _push(_fact("fraction", real=33.335))
    result = my_quota("ws1", "a@x")
    assert result["quota"] == 33.33
    assert result["remaining"] == 0
    _push(_fact("over", estimated=1))
    assert my_quota("ws1", "a@x")["remaining"] == -1


@pytest.mark.parametrize(("today", "period", "anchor", "start", "end"), [
    ("2026-02-27", "month", 31, "2026-01-31", "2026-02-28"),
    ("2026-02-28", "month", 31, "2026-02-28", "2026-03-31"),
    ("2024-02-29", "month", 31, "2024-02-29", "2024-03-31"),
    ("2026-09-28", "day", 31, "2026-09-28", "2026-09-29"),
    ("2026-12-31", "week", 31, "2026-12-28", "2027-01-04"),
])
def test_period_boundaries_are_kst_and_end_exclusive(monkeypatch, today, period, anchor, start, end):
    monkeypatch.setattr(credit_plan, "today_local", lambda: today)
    _group(period=period, anchor=anchor)
    result = my_quota("ws1", "a@x")
    assert result["period_start"] == f"{start}T00:00:00+09:00"
    assert result["period_end"] == f"{end}T00:00:00+09:00"
    assert result["limit_period"] == period


def test_usage_includes_start_and_excludes_end_with_mixed_timestamp_formats():
    _group(period="day")
    _push(
        _fact("before", real=100, created_at="2026-09-27T14:59:59Z"),
        _fact("start", real=1, created_at="2026-09-27T15:00:00Z"),
        _fact("last", real=2, created_at="2026-09-28 14:59:59"),
        _fact("end", real=100, created_at="2026-09-28T15:00:00Z"),
    )
    assert my_quota("ws1", "a@x")["used"] == 3


def test_unavailable_usage_does_not_masquerade_as_zero(monkeypatch):
    _group()

    def unavailable():
        raise sqlite3.OperationalError("isolated unavailable fixture")

    monkeypatch.setattr(manage_db, "get_connection", unavailable)
    with pytest.raises(sqlite3.OperationalError):
        my_quota("ws1", "a@x")
