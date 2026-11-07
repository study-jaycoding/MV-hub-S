"""에이전트의 진행 확인 박자·쉬는 바퀴(2026-11-07 속도 점검 2-A, 기록 `docs/status/속도점검_묶음2A_진행확인_2026-11-07.md`).

- 추적 중이면 롱폴을 가장 이른 다음 직접 확인까지만 기다린다(1~25초). 다른 계정 범위의 지난 기한은 넣지 않는다.
- 정상 확인 간격 15초, 실패 재시도는 30·60·120초 그대로.
- 할 일이 없는 바퀴는 CLI `account status` 를 띄우지 않는다 — 단 '빈 응답' 은 200·빈 list 일 때만.
"""

from __future__ import annotations

import io
import json
import os
from unittest.mock import Mock, patch

from test_agent_contracts import _load_agent

SERVER = "http://127.0.0.1:8010"


class _Reply(io.BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_wait_uses_earliest_due_check_of_the_last_processed_scope_only():
    agent = _load_agent()
    now = 1000.0
    mine = agent._state_scope(SERVER, "a@example.com")
    other = agent._state_scope(SERVER, "b@example.com")
    agent._ACTIVE_BY_SCOPE.update({
        mine: {"j1": {"next_direct_check": now + 7.2}, "j2": {"next_direct_check": now + 14.0}},
        other: {"j3": {"next_direct_check": now - 500.0}},  # 다른 계정의 지난 기한 — 1초 대기를 만들면 안 된다
    })
    with patch.object(agent.time, "monotonic", return_value=now):
        agent._LAST_TRACK_SCOPE = mine
        assert agent._next_wait_seconds() == 8
        agent._ACTIVE_BY_SCOPE[mine]["j1"]["next_direct_check"] = now - 3  # 이미 지남 → 최소 1초
        assert agent._next_wait_seconds() == 1
        agent._ACTIVE_BY_SCOPE[mine] = {"j1": {"next_direct_check": now + 400}}
        assert agent._next_wait_seconds() == 25
        agent._ACTIVE_BY_SCOPE[mine] = {}
        assert agent._next_wait_seconds() is None  # 추적 없음 → 허브 기본 25초
        agent._LAST_TRACK_SCOPE = None
        assert agent._next_wait_seconds() is None


def test_wait_event_sends_wait_seconds_but_keeps_the_socket_timeout():
    agent = _load_agent()
    seen = []

    def fake_urlopen(req, timeout):
        seen.append((req.full_url, timeout))
        return _Reply(json.dumps({"wake": False, "reason": None}).encode())

    with patch.object(agent.urllib.request, "urlopen", side_effect=fake_urlopen):
        assert agent._wait_event(SERVER, "t", wait_seconds=7) is None
        assert agent._wait_event(SERVER, "t") is None
    assert seen == [
        (f"{SERVER}/api/agent/wait?timeout=7", 35),  # 인자를 모르는 옛 허브가 25초 붙잡아도 끊지 않는다
        (f"{SERVER}/api/agent/wait", 35),
    ]


def test_hub_clamps_the_requested_wait_and_defaults_to_25s():
    from app.routers.ingest import _agent_wait_seconds

    assert _agent_wait_seconds(None) == 25.0  # 옛 에이전트(인자 없음)
    assert _agent_wait_seconds("7") == 7.0
    assert _agent_wait_seconds("0") == 1.0
    assert _agent_wait_seconds("-5") == 1.0
    assert _agent_wait_seconds("999") == 25.0
    for bad in ("abc", "nan", "inf", ""):
        assert _agent_wait_seconds(bad) == 25.0


def test_processing_checks_every_15s_but_failures_back_off_from_30s():
    agent = _load_agent()
    now = 5000.0
    assert agent._DIRECT_CHECK_INTERVAL_SECONDS == 15.0
    tracked = {"rid": "r1", "job_id": "job-1", "next_direct_check": 0.0, "deadline": now + 3600, "check_failures": 0}
    with patch.object(agent.time, "monotonic", return_value=now), \
            patch.object(agent, "_report_reconcile", Mock()), \
            patch.object(agent, "_run_cli_json", return_value=({"id": "job-1", "status": "in_progress"}, None)):
        agent._poll_active_jobs(SERVER, "t", "cli", {"job-1": tracked}, None, budget_end=now + 100)
    assert tracked["next_direct_check"] == now + 15.0

    delays = []
    tracked.update(next_direct_check=0.0, check_failures=0)
    with patch.object(agent.time, "monotonic", return_value=now), \
            patch.object(agent, "_run_cli_json", return_value=(None, "boom")):
        for _ in range(4):
            tracked["next_direct_check"] = 0.0
            agent._poll_active_jobs(SERVER, "t", "cli", {"job-1": tracked}, None, budget_end=now + 100)
            delays.append(tracked["next_direct_check"] - now)
    assert delays == [30.0, 60.0, 120.0, 120.0]


def _idle_pass(agent, *, has_work=False, probes=(200, {"requests": []}), candidates=(200, {"candidates": []})):
    account = Mock(return_value="a@example.com")
    with patch.object(agent, "_state_has_work", return_value=has_work), \
            patch.object(agent, "_list_recovery_probes", return_value=probes) as probe_list, \
            patch.object(agent, "_list_reconcile_candidates", return_value=candidates) as cand_list, \
            patch.object(agent, "_cycle_account_email", account), \
            patch.object(agent, "_runtime_active", return_value={}), \
            patch.object(agent, "recovery_probe_pass") as recovery, \
            patch.object(agent, "reconcile_pass") as reconcile:
        result = agent.tracking_pass(SERVER, "t", "cli")
    return result, account, probe_list, cand_list, recovery, reconcile


def test_idle_pass_skips_the_cli_when_nothing_is_tracked_and_both_lists_are_empty():
    agent = _load_agent()
    result, account, probe_list, cand_list, recovery, reconcile = _idle_pass(agent)
    assert result == 0
    account.assert_not_called()  # node+hf.exe 를 띄우지 않는다
    probe_list.assert_called_once()
    cand_list.assert_called_once()
    recovery.assert_not_called()
    reconcile.assert_not_called()
    assert agent._LAST_TRACK_SCOPE is None


def test_any_work_or_unsure_answer_keeps_the_identity_check_and_reuses_the_reply():
    # 재조정 후보가 있으면 계정 확인부터 하고, 받은 응답을 재조정에 넘겨 다시 묻지 않는다
    agent = _load_agent()
    cands = (200, {"candidates": [{"job_id": "x", "rid": "r"}]})
    _, account, _, cand_list, recovery, reconcile = _idle_pass(agent, candidates=cands)
    account.assert_called_once()
    cand_list.assert_called_once()
    assert reconcile.call_args.kwargs["prefetched"] == cands
    assert recovery.call_args.kwargs["prefetched"] == (200, {"requests": []})
    assert agent._LAST_TRACK_SCOPE == agent._state_scope(SERVER, "a@example.com")

    # 복구 후보 응답이 비정상(503·필드 없음·연결 실패)이면 빈 것으로 보지 않는다
    for bad in ((503, "busy"), (200, {}), (0, "down")):
        agent = _load_agent()
        _, account, _, cand_list, recovery, _ = _idle_pass(agent, probes=bad)
        account.assert_called_once()
        cand_list.assert_not_called()  # 첫 조회에서 판정이 끝났다 — 나머지 선조회는 하지 않는다
        assert recovery.call_args.kwargs["prefetched"] == bad

    # 상태 DB 에 행이 있거나 조회가 실패하면 HTTP 선조회 없이 지금 경로
    for has_work in (True, None):
        agent = _load_agent()
        _, account, probe_list, _, recovery, _ = _idle_pass(agent, has_work=has_work)
        account.assert_called_once()
        probe_list.assert_not_called()
        assert recovery.call_args.kwargs["prefetched"] is None

    # 메모리 추적이 남아 있으면(다른 계정 범위라도) 지금 경로
    agent = _load_agent()
    agent._ACTIVE_BY_SCOPE[agent._state_scope(SERVER, "b@example.com")] = {"j": {"next_direct_check": 0.0}}
    _, account, probe_list, _, _, _ = _idle_pass(agent)
    account.assert_called_once()
    probe_list.assert_not_called()


def test_state_has_work_looks_at_every_account_of_this_server(tmp_path):
    with patch.dict(os.environ, {"LOCALAPPDATA": str(tmp_path)}):
        agent = _load_agent()
        assert agent._state_has_work(SERVER) is False
        agent._outbox_add("http://other-server:8010", "a@example.com", "r0", "job-0")
        assert agent._state_has_work(SERVER) is False  # 다른 서버의 행은 보지 않는다
        agent._outbox_add(SERVER + "/", "someone-else@example.com", "r1", "job-1")  # 다른 계정·끝 슬래시
        assert agent._state_has_work(SERVER) is True
        agent._outbox_remove(SERVER, "someone-else@example.com", "r1")
        assert agent._state_has_work(SERVER) is False
        agent._tracked_save(SERVER, None, {"rid": "r2", "job_id": "job-2", "next_direct_check": 0.0})  # unknown 범위
        assert agent._state_has_work(SERVER) is True
