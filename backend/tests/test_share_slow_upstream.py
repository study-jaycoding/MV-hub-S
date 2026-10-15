"""Jay 결정 10A(10-15) — 공유 서버가 60초 넘게 늦을 때 '실패' 대신 '확인 중', 원장으로 끝을 묻는다.

설계: docs/status/결정일곱_설계_2026-10-15.md 10A · 4차 보완 E12~14. 임시 DB만 쓴다.
"""

from __future__ import annotations

import json
import socket
import urllib.error
from types import SimpleNamespace
from unittest import mock

import pytest
from fastapi import BackgroundTasks, HTTPException

from app import db, repo
from app.models import IntentOutcomesIn
from app.routers import _proxy, publish, share


@pytest.fixture
def isolated_content_db(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    repo.set_setting("shared_server_url", "http://share.example.test/")
    repo.set_setting("shared_server_token", "token")
    try:
        yield
    finally:
        db.flush_pool()


def _request():
    return SimpleNamespace(state=SimpleNamespace(account=None))


def _seed(gen_id: str = "local-1", job_id: str = "server-1", *, shared: bool = True) -> str:
    gid = repo.create_local_generation({"model": "m", "prompt": "p"}, "me", generation_id=gen_id)
    with db.get_connection() as conn:
        conn.execute("UPDATE generation SET status='done', job_id=? WHERE id=?", (job_id, gid))
    if shared:
        repo.publish(gid, "me", "team")
    return gid


SLOW = HTTPException(502, "공유 서버가 60초 안에 답하지 않았습니다", headers={_proxy.UPSTREAM_STATE_HEADER: "timeout"})


def _raiser(error):
    def raise_(*_args, **_kwargs):
        raise error

    return raise_


def test_raw_request_marks_timeouts_but_not_connection_failures(monkeypatch):
    for error, slow in (
        (socket.timeout("timed out"), True),
        (urllib.error.URLError(TimeoutError("timed out")), True),
        (urllib.error.URLError(ConnectionRefusedError("refused")), False),
    ):
        monkeypatch.setattr(_proxy, "_open", _raiser(error))
        with pytest.raises(HTTPException) as failed:
            _proxy.raw_request("GET", "http://share.example.test/api/x")
        assert failed.value.status_code == 502
        assert _proxy.upstream_timed_out(failed.value) is slow


def test_slow_finalize_answers_with_intent_ref_instead_of_plain_failure(isolated_content_db):
    gid = _seed()
    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json", side_effect=SLOW),
        mock.patch.object(share, "kick_share_state_reconciler"),
    ):
        with pytest.raises(HTTPException) as slow:
            share.finalize(gid, _request(), BackgroundTasks())
    detail = slow.value.detail
    assert slow.value.status_code == 502 and detail["code"] == "upstream_timeout"
    [ref] = detail["refs"]
    assert ref["gen_id"] == gid
    assert share.share_intent_state(ref["intent_id"], ref["seq"], ref["scope"]) == {"state": "pending"}  # 원장은 결과 불명으로 남아 있다
    # 그사이 허브 계정이 바뀌었으면 남의 원장을 묻지 않는다(Codex 10A 리뷰)
    assert share.share_intent_state(ref["intent_id"], ref["seq"], "other@example.test") == {"state": "unknown", "reason": "account_changed"}
    # 여러 참조를 한 번에 — 참조 순서대로, 판정은 한 건짜리와 같다(Codex 63회차: 하나씩이면 묶음 2,000장이 한 바퀴 2,000 요청)
    body = IntentOutcomesIn(refs=[
        {"intent_id": ref["intent_id"], "seq": ref["seq"], "scope": ref["scope"]},
        {"intent_id": ref["intent_id"], "seq": ref["seq"], "scope": "other@example.test"},
        {"intent_id": "missing", "seq": 1},
    ])
    assert share.share_intent_outcomes(body) == [
        {"intent_id": ref["intent_id"], "seq": ref["seq"], "state": "pending"},
        {"intent_id": ref["intent_id"], "seq": ref["seq"], "state": "unknown", "reason": "account_changed"},
        {"intent_id": "missing", "seq": 1, "state": "unknown"},
    ]


def test_plain_502_stays_a_plain_failure(isolated_content_db):
    gid = _seed()
    with (
        mock.patch.object(share._proxy, "proxying", return_value=True),
        mock.patch.object(share._proxy, "proxy_json", side_effect=HTTPException(502, "공유 서버 연결 실패: refused")),
        mock.patch.object(share, "kick_share_state_reconciler"),
    ):
        with pytest.raises(HTTPException) as failed:
            share.finalize(gid, _request(), BackgroundTasks())
    assert failed.value.detail == "공유 서버 연결 실패: refused"


def test_slow_bundle_publish_returns_a_ref_per_item_and_folder_share_counts_them_as_confirming(isolated_content_db, monkeypatch):
    first = _seed("local-1", "server-1", shared=False)
    second = _seed("local-2", "server-2", shared=False)
    monkeypatch.setattr(publish._proxy, "proxying", lambda: True)
    monkeypatch.setattr(publish, "_http_json", _raiser(SLOW))
    monkeypatch.setattr(publish, "kick_share_state_reconciler", lambda: None)
    with pytest.raises(HTTPException) as slow:
        publish.publish_bundle_to_server([first, second])
    assert sorted(ref["gen_id"] for ref in slow.value.detail["refs"]) == [first, second]

    monkeypatch.setattr(publish.repo, "folder_share_candidates", lambda *a: [f"g{i}" for i in range(250)])
    monkeypatch.setattr(publish, "publish_bundle_to_server", _raiser(slow.value))
    out = publish._publish_folder_pinned("p1", "ep01", _request())
    # 확인 중이 아닌 것은 모두 미처리 — 이 묶음에서 허브가 걸러 보내지 않은 것도 빠지지 않는다(Codex 10A 리뷰)
    assert (len(out["confirming"]), out["unprocessed"], out["accepted"]) == (2, 248, 0)


def _intent(**fields) -> dict:
    ref = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="server-1",
        local_id="local-1",
        operation_kind=fields.pop("operation_kind", "finalize"),
        desired_shared=True,
        desired_final=True,
        base_shared=bool(fields.pop("base_shared", True)),
        base_final=False,
        desired_held=fields.pop("desired_held", None),
    )
    if fields:
        if "observed_state_json" in fields:
            fields["observed_state_json"] = json.dumps(fields["observed_state_json"])
        sets = ", ".join(f"{key}=?" for key in fields)
        with db.get_connection() as conn:
            conn.execute(f"UPDATE share_state_intent SET {sets} WHERE intent_id=?", (*fields.values(), ref["intent_id"]))
    return ref


@pytest.mark.parametrize(
    "fields, expected",
    [
        ({}, {"state": "pending"}),
        ({"status": "converged", "observed_state_json": {"shared": True, "is_final": True}}, {"state": "confirmed"}),
        # 서버는 목표 상태로 받았는데 로컬 대상을 잃어 rejected 로 닫혔다 — 실패가 아니라 확인됨(Codex 4차)
        ({"status": "rejected", "last_error_code": "local_target_lost", "observed_state_json": {"shared": True, "is_final": True}},
         {"state": "confirmed"}),
        ({"status": "rejected", "last_error_code": "local_target_lost", "observed_state_json": {"shared": True, "is_final": False}},
         {"state": "unknown"}),
        ({"status": "rejected", "last_error_code": "remote_403"}, {"state": "failed"}),
        ({"status": "rejected", "last_error_code": "remote_blocked"}, {"state": "failed"}),
        # 합성 최종 지정이 들어가지 않았다 — 보상까지 마친 로컬 적용은 오류 코드를 지운다(작업 종류로 가린다, Codex 10A 리뷰)
        ({"operation_kind": "composite_finalize", "status": "rejected", "base_shared": False,
          "observed_state_json": {"shared": False, "is_final": False}}, {"state": "failed", "reason": "composite_reverted"}),
        ({"operation_kind": "composite_finalize", "status": "rejected", "observed_state_json": {"shared": True, "is_final": False}},
         {"state": "failed", "reason": "composite_final_refused"}),
        ({"operation_kind": "composite_finalize", "status": "rejected", "last_error_code": "remote_409"}, {"state": "failed"}),
        ({"operation_kind": "composite_finalize", "status": "rejected",
          "observed_state_json": {"shared": True, "is_final": False, "unknown_watch_expired": True}}, {"state": "unknown"}),
        ({"status": "rejected", "last_error_code": "remote_result_unknown_expired",
          "observed_state_json": {"shared": True, "is_final": False}}, {"state": "unknown"}),
        ({"status": "superseded", "observed_state_json": {"shared": False, "is_final": False}}, {"state": "unknown"}),
        ({"status": "converged", "desired_held": False, "observed_state_json": {"shared": True, "is_final": True, "is_held": True}},
         {"state": "unknown"}),
    ],
)
def test_outcome_comes_from_observation_and_cause_not_status_name(isolated_content_db, fields, expected):
    ref = _intent(**fields)
    assert repo.share_intent_outcome(ref["intent_id"], ref["intent_seq"]) == expected


def test_outcome_of_a_replaced_or_missing_request_is_unknown(isolated_content_db):
    ref = _intent()
    assert repo.share_intent_outcome(ref["intent_id"], ref["intent_seq"] + 1) == {"state": "unknown"}
    assert repo.share_intent_outcome("missing", 1) == {"state": "unknown"}
