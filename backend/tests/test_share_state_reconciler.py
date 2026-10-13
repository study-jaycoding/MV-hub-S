"""공유/골드 reconciler의 관측→수렴 계약(설계 §8: 3·4·7·8)."""

from __future__ import annotations

import asyncio
import json
from unittest import mock

import pytest
from fastapi import Request

from app import db, repo
from app.routers import _proxy, publish
from app.routers._telemetry import touch_generation_telemetry
from app.services import share_state_reconciler as reconciler

# 계층 경계로 reconciler 는 라우터 의존을 주입받는다(운영은 main.py lifespan 이 담당).
reconciler.configure_share_state_router_deps(
    proxy=_proxy, touch_telemetry=touch_generation_telemetry
)


@pytest.fixture
def isolated_content_db(monkeypatch, tmp_path):
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    db.init_db()
    repo.ensure_default_worker()
    repo.set_setting("shared_server_url", "http://share.example.test/")
    repo.set_setting("shared_server_token", "token")
    monkeypatch.setattr(reconciler._proxy, "proxying", lambda: True)
    try:
        yield
    finally:
        db.flush_pool()


def _seed_generation(
    generation_id: str,
    job_id: str,
    *,
    shared: bool = False,
    final: bool = False,
) -> str:
    gen_id = repo.create_local_generation(
        {"model": "test-model", "prompt": "share reconciliation"},
        "me",
        generation_id=generation_id,
    )
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE generation SET status='done', job_id=? WHERE id=?",
            (job_id, gen_id),
        )
    if shared:
        repo.publish(gen_id, "me", "team")
    if final:
        repo.set_final(gen_id, True, "me")
    return gen_id


def _release(ref: dict) -> None:
    assert repo.release_share_state_intent_claim(
        ref["intent_id"], ref["intent_seq"], ref["claim_token"]
    )


def _patch_observer(monkeypatch, observer) -> None:
    monkeypatch.setattr(reconciler, "_observe_remote_state", observer)

    def observe_batch(origin, token, intents):
        return {
            str(intent["intent_id"]): observer(origin, token, intent)
            for intent in intents
        }

    monkeypatch.setattr(reconciler, "_observe_remote_states", observe_batch)


def _pending_composite(
    local_id: str,
    job_id: str,
    *,
    base_shared: bool,
) -> dict:
    ref = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor=job_id,
        local_id=local_id,
        operation_kind="composite_finalize",
        desired_shared=True,
        desired_final=True,
        base_shared=base_shared,
        base_final=False,
    )
    assert repo.transition_share_state_intent(
        ref["intent_id"],
        ref["intent_seq"],
        ref["claim_token"],
        "pending",
        observed_state={
            "shared": True,
            "is_final": False,
            "publish_confirmed": True,
        },
    )
    _release(ref)
    return ref


def test_cycle_observation_uses_one_server_batch_request():
    intents = [
        {"intent_id": "intent-1", "job_anchor": "job-1"},
        {"intent_id": "intent-2", "server_generation_id": "server-2"},
    ]
    payload = {
        "items": {
            "job-1": {"id": "job-1", "shared": True, "is_final": False},
            "server-2": {"id": "server-2", "shared": True, "is_final": True},
        },
        "missing": [],
    }
    with mock.patch.object(
        reconciler._proxy, "raw_request", return_value=(200, payload)
    ) as request:
        observed = reconciler._observe_remote_states(
            "http://share.example.test", "stored-token", intents
        )

    assert observed["intent-1"]["shared"] is True
    assert observed["intent-2"]["is_final"] is True
    request.assert_called_once_with(
        "POST",
        "http://share.example.test/api/generations/batch",
        token="stored-token",
        body={"gen_ids": ["job-1", "server-2"]},
        timeout=15,
    )


def test_restart_cycle_converges_prepared_and_waiting_local_rows(
    isolated_content_db, monkeypatch
):
    prepared_id = _seed_generation("local-prepared", "job-prepared")
    waiting_id = _seed_generation("local-waiting", "job-waiting")
    prepared = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="job-prepared",
        local_id=prepared_id,
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )
    _release(prepared)  # 크래시 뒤 재시작에서 만료 lease가 회수된 상태
    waiting = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="job-waiting",
        local_id=waiting_id,
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )
    assert repo.mark_share_state_intent_waiting_local(
        waiting["intent_id"], waiting["intent_seq"], waiting["claim_token"]
    )

    _patch_observer(
        monkeypatch,
        lambda _origin, _token, intent: {
            "id": intent["job_anchor"],
            "job_id": intent["job_anchor"],
            "shared": True,
            "is_final": False,
        },
    )

    counts = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("restart-worker")
    )

    assert counts["claimed"] == 2
    assert counts["converged"] == 2
    assert repo.get_generation(prepared_id)["shared"] is True
    assert repo.get_generation(waiting_id)["shared"] is True
    assert repo.get_share_state_intent(prepared["intent_id"])["status"] == "converged"
    assert repo.get_share_state_intent(waiting["intent_id"])["status"] == "converged"


@pytest.mark.parametrize(
    ("ledger_status", "observed", "expected_status", "expected_error", "unknown_since"),
    [
        (
            "prepared",
            {"id": "remote-only", "shared": True, "is_final": False},
            "converged",
            "local_mirror_skipped_no_target",
            None,
        ),
        (
            # '이전 상태' 관측은 지켜보는 기한이 지난 뒤에야 거절이다(아래 '결과를 모르는 요청' 시험들)
            "prepared",
            {"id": "remote-only", "shared": False, "is_final": False},
            "rejected",
            "local_target_missing",
            "2000-01-01 00:00:00",
        ),
        (
            "pending",
            {"id": "remote-only", "shared": False, "is_final": False},
            "superseded",
            "local_target_missing",
            None,
        ),
    ],
    ids=["desired", "prepared-at-base-after-watch", "other-observation"],
)
def test_remote_only_no_target_closes_from_server_observation(
    isolated_content_db,
    monkeypatch,
    ledger_status,
    observed,
    expected_status,
    expected_error,
    unknown_since,
):
    unrelated_id = _seed_generation(
        "local-unrelated", "job-unrelated", shared=True, final=True
    )
    ref = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="remote-only",
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )
    if ledger_status != "prepared":
        assert repo.transition_share_state_intent(
            ref["intent_id"],
            ref["intent_seq"],
            ref["claim_token"],
            ledger_status,
        )
    if unknown_since:
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE share_state_intent SET observed_state_json=? WHERE intent_id=?",
                (
                    json.dumps({"result_unknown": True, "unknown_since": unknown_since}),
                    ref["intent_id"],
                ),
            )
    _release(ref)
    _patch_observer(monkeypatch, lambda *_args: dict(observed))

    counts = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("remote-only-worker")
    )

    assert counts[expected_status] == 1
    row = repo.get_share_state_intent(ref["intent_id"])
    assert row["status"] == expected_status
    assert row["last_error_code"] == expected_error
    assert json.loads(row["observed_state_json"]) == observed
    unrelated = repo.get_generation(unrelated_id)
    assert unrelated["shared"] is True
    assert unrelated["is_final"] is True


@pytest.mark.parametrize(
    ("fail_streak", "expected_status", "expected_fail_streak"),
    [(4, "waiting_local", 5), (5, "rejected", 5)],
    ids=["retry-before-limit", "reject-at-limit"],
)
def test_lost_local_target_has_bounded_retry(
    isolated_content_db,
    monkeypatch,
    fail_streak,
    expected_status,
    expected_fail_streak,
):
    ref = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="remote-lost",
        local_id="local-lost",
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE share_state_intent SET status='waiting_local', fail_streak=? "
            "WHERE intent_id=?",
            (fail_streak, ref["intent_id"]),
        )
    _release(ref)
    observed = {
        "id": "remote-lost",
        "shared": True,
        "is_final": False,
    }
    _patch_observer(monkeypatch, lambda *_args: dict(observed))

    counts = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("lost-local-worker")
    )

    assert counts[expected_status] == 1
    row = repo.get_share_state_intent(ref["intent_id"])
    assert row["status"] == expected_status
    assert row["fail_streak"] == expected_fail_streak
    assert row["last_error_code"] == "local_target_lost"
    assert json.loads(row["observed_state_json"]) == observed
    assert (row["next_retry_at"] is not None) is (expected_status == "waiting_local")


def test_apply_cas_lost_does_not_schedule_local_retry():
    intent = {"intent_id": "stale-intent", "intent_seq": 1, "fail_streak": 0}
    observed = {"id": "remote", "shared": True, "is_final": False}
    with (
        mock.patch.object(
            reconciler,
            "_apply_observed_local",
            return_value=repo.SHARE_STATE_APPLY_CAS_LOST,
        ),
        mock.patch.object(reconciler, "_mark_retry") as mark_retry,
    ):
        result = asyncio.run(
            reconciler._apply_or_retry(
                intent,
                "stale-claim",
                observed,
                status="converged",
            )
        )

    assert result == repo.SHARE_STATE_APPLY_CAS_LOST
    mark_retry.assert_not_called()


def test_remote_observation_supersedes_stale_finalize_without_blind_replay(
    isolated_content_db, monkeypatch
):
    gen_id = _seed_generation("local-final", "job-final", shared=True, final=True)
    ref = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="job-final",
        local_id=gen_id,
        operation_kind="finalize",
        desired_shared=True,
        desired_final=True,
        base_shared=True,
        base_final=False,
    )
    assert repo.transition_share_state_intent(
        ref["intent_id"],
        ref["intent_seq"],
        ref["claim_token"],
        "pending",
        observed_state={"shared": True, "is_final": True},
    )
    _release(ref)
    _patch_observer(
        monkeypatch,
        lambda *_args: {
            "id": "job-final",
            "job_id": "job-final",
            "shared": True,
            "is_final": False,
        },
    )
    remote_mutation = mock.Mock()
    monkeypatch.setattr(reconciler, "_unpublish_remote", remote_mutation)

    counts = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("blind-worker")
    )

    assert counts["superseded"] == 1
    assert repo.get_generation(gen_id)["shared"] is True
    assert repo.get_generation(gen_id)["is_final"] is False
    assert repo.get_share_state_intent(ref["intent_id"])["status"] == "superseded"
    remote_mutation.assert_not_called()


def test_composite_partial_unpublishes_only_when_base_was_unshared(
    isolated_content_db, monkeypatch
):
    new_share_id = _seed_generation("local-new-share", "job-new-share", shared=True)
    existing_share_id = _seed_generation(
        "local-existing-share", "job-existing-share", shared=True
    )
    new_share = _pending_composite(
        new_share_id, "job-new-share", base_shared=False
    )
    existing_share = _pending_composite(
        existing_share_id, "job-existing-share", base_shared=True
    )

    _patch_observer(
        monkeypatch,
        lambda _origin, _token, intent: {
            "id": intent["job_anchor"],
            "job_id": intent["job_anchor"],
            "shared": True,
            "is_final": False,
        },
    )
    cleanup_calls: list[str] = []

    def cleanup(_origin, _token, intent):
        cleanup_calls.append(intent["job_anchor"])
        return {
            "id": intent["job_anchor"],
            "shared": False,
            "is_final": False,
            "cleanup": "unpublished",
        }

    monkeypatch.setattr(reconciler, "_unpublish_remote", cleanup)

    counts = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("composite-worker")
    )

    assert counts["rejected"] == 2
    assert cleanup_calls == ["job-new-share"]
    assert repo.get_generation(new_share_id)["shared"] is False
    assert repo.get_generation(existing_share_id)["shared"] is True
    assert repo.get_share_state_intent(new_share["intent_id"])["status"] == "rejected"
    assert repo.get_share_state_intent(existing_share["intent_id"])["status"] == "rejected"


def test_claim_scopes_to_server_origin_and_avoids_starvation(isolated_content_db):
    """R5 2-A — 다른 권위 서버의 오래된 due 행이 limit 을 다 채워도 현재 origin 행이
    claim 된다(starvation 방지). 다른 서버 행은 건드리지 않는다(전환 시 재개)."""
    other_origin = "http://other.example.test"
    for index in range(4):  # limit(아래 2)보다 많은 외부 origin 행을 먼저(=더 오래된 due) 준비
        ref = repo.prepare_share_state_intent(
            other_origin,
            job_anchor=f"job-other-{index}",
            local_id=f"local-other-{index}",
            operation_kind="publish",
            desired_shared=True,
            desired_final=False,
            base_shared=False,
            base_final=False,
        )
        _release(ref)
    mine = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="job-mine",
        local_id="local-mine",
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )
    _release(mine)

    claimed = repo.claim_due_share_state_intents(
        "origin-worker",
        limit=2,
        server_origin="http://share.example.test/",  # 정규화 전 형태도 수용
    )
    assert [row["job_anchor"] for row in claimed] == ["job-mine"]
    # 외부 origin 행은 계약대로 무접촉(claim_token NULL 유지)
    with db.get_connection() as conn:
        untouched = conn.execute(
            "SELECT COUNT(*) FROM share_state_intent "
            "WHERE server_origin=? AND claim_token IS NULL",
            (repo.normalize_share_server_origin(other_origin),),
        ).fetchone()[0]
    assert untouched == 4
    # origin 미지정 호출(기존 호출자 계약)은 종전대로 전 origin due 를 본다
    legacy = repo.claim_due_share_state_intents("legacy-worker", limit=10)
    assert len(legacy) == 4

    # 코덱스 P2 — 최종 SELECT 의 origin 조건 고정: 같은 token 으로 이미 잡혀 있던 외부
    # origin 행이 있어도 origin 스코프 claim 결과에 섞여 나오면 안 된다.
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE share_state_intent SET claim_token='mixed-worker', "
            "lease_until=datetime('now','+120 seconds') "
            "WHERE server_origin=? AND job_anchor='job-other-0'",
            (repo.normalize_share_server_origin(other_origin),),
        )
    repo.release_share_state_intent_claim(mine["intent_id"], mine["intent_seq"], "origin-worker")
    mixed = repo.claim_due_share_state_intents(
        "mixed-worker", limit=10, server_origin="http://share.example.test"
    )
    assert [row["job_anchor"] for row in mixed] == ["job-mine"]  # 외부 행 미혼입


def test_lost_lease_renewal_blocks_stale_remote_cleanup(
    isolated_content_db, monkeypatch
):
    """R5 reconciler-2 — 관측 락 해제 후 lease 갱신에 진(새 intent_seq 가 이긴) stale
    worker 는 그 행을 만지지 않는다. 종전엔 낡은 관측으로 composite partial 의 원격
    unpublish 까지 실행한 뒤에야 로컬 CAS 에서 졌다."""
    gen_id = _seed_generation("local-stale", "job-stale", shared=True)
    _pending_composite(gen_id, "job-stale", base_shared=False)

    _patch_observer(
        monkeypatch,
        lambda _origin, _token, intent: {
            "id": intent["job_anchor"],
            "job_id": intent["job_anchor"],
            "shared": True,
            "is_final": False,
        },
    )
    cleanup = mock.Mock()
    monkeypatch.setattr(reconciler, "_unpublish_remote", cleanup)
    monkeypatch.setattr(
        reconciler.repo,
        "renew_share_state_intent_lease",
        lambda *args, **kwargs: False,
    )

    counts = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("stale-worker")
    )

    assert counts["claimed"] == 1
    assert counts.get("cas_lost") == 1
    cleanup.assert_not_called()  # stale worker 의 원격 정리 차단이 핵심 계약
    assert repo.get_generation(gen_id)["shared"] is True  # 로컬 상태도 불변


def test_auth_required_row_resumes_after_relogin_kick(
    isolated_content_db, monkeypatch
):
    gen_id = _seed_generation("local-auth", "job-auth")
    ref = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="job-auth",
        local_id=gen_id,
        operation_kind="publish",
        desired_shared=True,
        desired_final=False,
        base_shared=False,
        base_final=False,
    )
    _release(ref)

    def auth_required(*_args):
        raise reconciler._RemoteAuthRequired()

    _patch_observer(monkeypatch, auth_required)
    first = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("auth-worker-1")
    )
    assert first["auth_required"] == 1
    assert repo.get_share_state_intent(ref["intent_id"])["status"] == "auth_required"

    with (
        mock.patch.object(
            publish,
            "_http_json",
            return_value=(
                200,
                {
                    "token": "renewed-token",
                    "account": {
                        "email": "artist@example.com",
                        "name": "Artist",
                        "global_roles": [],
                    },
                },
            ),
        ),
        mock.patch.object(publish, "_switch_account_db"),
        mock.patch.object(publish, "kick_share_state_reconciler") as kick,
    ):
        publish.shared_server_login(
            publish.SharedLoginIn(
                url="http://share.example.test",
                email="artist@example.com",
                password="password",
            ),
            # R7 0-A loopback 가드 — 로그인 라우트는 이 PC 브라우저 전용
            Request({"type": "http", "client": ("127.0.0.1", 40000), "headers": []}),
        )
    kick.assert_called_once_with()
    _patch_observer(
        monkeypatch,
        lambda *_args: {
            "id": "job-auth",
            "job_id": "job-auth",
            "shared": True,
            "is_final": False,
        },
    )

    second = asyncio.run(
        reconciler.run_share_state_reconciliation_cycle("auth-worker-2")
    )

    assert second["converged"] == 1
    row = repo.get_share_state_intent(ref["intent_id"])
    assert row["status"] == "converged"
    assert json.loads(row["observed_state_json"])["shared"] is True
    assert repo.get_generation(gen_id)["shared"] is True

# ── 결과를 모르는 요청(시간 초과·응답 유실) — 2026-10-14 격리 실측(허브 → 늦은 서버) ──
#  허브가 60초에 "실패"로 답한 뒤 서버가 밀려 있던 최종 요청을 처리했다. 원장에는 서버 id 만 있어(로컬 행은 job_id 로만
#  이어진다) ① 관측이 최종이어도 내 로컬 행을 못 찾아 converged(local_mirror_skipped_no_target) ② 관측이 먼저 처리돼
#  '이전 상태'면 그 자리에서 rejected 로 닫혀, 뒤에 온 최종을 영영 놓쳤다.
#  지금: 결과 불명(prepared)은 '바라던 상태'가 보일 때까지 닫지 않고 지켜본다(기한 하루). 로컬 행은 관측의 job_id 로도 찾는다.
def _prepared_by_server_id(server_id: str, *, local_id: str | None = None) -> dict:
    ref = repo.prepare_share_state_intent(
        "http://share.example.test",
        server_generation_id=server_id,
        local_id=local_id,
        operation_kind="finalize",
        desired_shared=True,
        desired_final=True,
        base_shared=True,
        base_final=False,
        desired_held=False,
        base_held=False,
    )
    _release(ref)  # 결과 불명 — 라우트가 claim 만 돌려준 상태(_record_proxy_failure)
    return ref


def _observed(
    server_id: str, job_id: str | None, *, final: bool, shared: bool = True
) -> dict:
    state = {"id": server_id, "shared": shared, "is_final": final, "is_held": False}
    if job_id is not None:
        state["job_id"] = job_id
    if final:
        state["final_by"] = "supervisor"
    return state


def _retry_now(intent_id: str) -> None:
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE share_state_intent SET next_retry_at=NULL WHERE intent_id=?",
            (intent_id,),
        )


def _set_origin(generation_id: str, origin: str, status: str = "done") -> None:
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE generation SET origin=?, status=? WHERE id=?",
            (origin, status, generation_id),
        )


def _cycle(name: str) -> dict:
    return asyncio.run(reconciler.run_share_state_reconciliation_cycle(name))


def test_late_server_apply_converges_through_observed_job_id(
    isolated_content_db, monkeypatch
):
    mine = _seed_generation("local-mine", "job-mine", shared=True)
    other = _seed_generation("local-other", "job-other", shared=True)
    ref = _prepared_by_server_id("server-uuid-1")

    # 첫 관측 — 서버가 아직 그 요청을 처리하지 않았다('이전 상태'). 닫지 않고 다시 본다.
    _patch_observer(
        monkeypatch, lambda *_args: _observed("server-uuid-1", "job-mine", final=False)
    )
    counts = _cycle("late-1")
    assert counts.get("retry") == 1
    assert "rejected" not in counts and "converged" not in counts
    row = repo.get_share_state_intent(ref["intent_id"])
    assert (row["status"], row["fail_streak"], row["last_error_code"]) == (
        "prepared",
        1,
        "remote_result_unknown",
    )
    assert row["next_retry_at"] is not None and row["claim_token"] is None
    noted = json.loads(row["observed_state_json"])
    assert noted["result_unknown"] is True and noted["unknown_since"]
    assert (noted["shared"], noted["is_final"], noted["job_id"]) == (True, False, "job-mine")
    assert repo.get_generation(mine)["is_final"] is False

    # 다시 볼 때 — 그사이 서버가 밀려 있던 최종을 적용했다. 관측의 job_id 로 내 로컬 행을 찾아 맞춘다.
    _retry_now(ref["intent_id"])
    _patch_observer(
        monkeypatch, lambda *_args: _observed("server-uuid-1", "job-mine", final=True)
    )
    counts = _cycle("late-2")
    assert counts.get("converged") == 1
    row = repo.get_share_state_intent(ref["intent_id"])
    assert (row["status"], row["local_id"], row["last_error_code"]) == (
        "converged",
        mine,
        None,
    )
    assert "result_unknown" not in json.loads(row["observed_state_json"])
    assert repo.get_generation(mine)["is_final"] is True
    assert repo.get_generation(other)["is_final"] is False  # 다른 행은 건드리지 않는다


def test_observed_final_finds_local_row_by_observed_job_id_at_once(
    isolated_content_db, monkeypatch
):
    mine = _seed_generation("local-mine", "job-mine", shared=True)
    ref = _prepared_by_server_id("server-uuid-1")
    _patch_observer(
        monkeypatch, lambda *_args: _observed("server-uuid-1", "job-mine", final=True)
    )
    assert _cycle("late-once").get("converged") == 1
    row = repo.get_share_state_intent(ref["intent_id"])
    # 전에는 converged(local_mirror_skipped_no_target) 로 닫히고 로컬 행은 최종이 아닌 채 남았다
    assert (row["status"], row["local_id"], row["last_error_code"]) == (
        "converged",
        mine,
        None,
    )
    assert repo.get_generation(mine)["is_final"] is True


@pytest.mark.parametrize(
    "job_id", [None, "job-nowhere"], ids=["old-server-without-job-id", "no-local-row"]
)
def test_observed_job_id_never_creates_or_guesses_a_local_row(
    isolated_content_db, monkeypatch, job_id
):
    unrelated = _seed_generation("local-unrelated", "job-unrelated", shared=True)
    ref = _prepared_by_server_id("server-uuid-1")
    _patch_observer(
        monkeypatch, lambda *_args: _observed("server-uuid-1", job_id, final=True)
    )
    with db.get_connection() as conn:
        before = conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0]
    _cycle("late-none")
    row = repo.get_share_state_intent(ref["intent_id"])
    assert (row["status"], row["local_id"], row["last_error_code"]) == (
        "converged",
        None,
        "local_mirror_skipped_no_target",
    )
    with db.get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM generation").fetchone()[0] == before
    assert repo.get_generation(unrelated)["is_final"] is False


def test_observed_job_id_prefers_the_local_original_over_a_received_copy(
    isolated_content_db, monkeypatch
):
    copy = _seed_generation("received-copy", "job-mine", shared=True)
    mine = _seed_generation("local-mine", "job-mine", shared=True)
    _set_origin(copy, "synced")
    ref = _prepared_by_server_id("server-uuid-1")
    _patch_observer(
        monkeypatch, lambda *_args: _observed("server-uuid-1", "job-mine", final=True)
    )
    _cycle("late-dup")
    assert repo.get_share_state_intent(ref["intent_id"])["local_id"] == mine
    assert repo.get_generation(mine)["is_final"] is True
    assert repo.get_generation(copy)["is_final"] is False


def test_observed_job_id_skips_the_failed_request_row_kept_beside_the_real_result(
    isolated_content_db, monkeypatch
):
    # generation_sync 가 만드는 꼴: 실패로 보존한 요청 행(origin local · failed)과 실제 결과(synced · done)가 같은 job_id.
    #  로컬본 우선으로만 고르면 실패 행에 최종이 붙는다(Codex 설계 검토).
    placeholder = _seed_generation("local-placeholder", "job-mine")
    result = _seed_generation("synced-result", "job-mine", shared=True)
    _set_origin(placeholder, "local", status="failed")
    _set_origin(result, "synced")
    ref = _prepared_by_server_id("server-uuid-1")
    _patch_observer(
        monkeypatch, lambda *_args: _observed("server-uuid-1", "job-mine", final=True)
    )
    _cycle("late-placeholder")
    assert repo.get_share_state_intent(ref["intent_id"])["local_id"] == result
    assert repo.get_generation(result)["is_final"] is True
    assert repo.get_generation(placeholder)["is_final"] is False


def test_observed_job_id_does_not_pick_between_equal_candidates(
    isolated_content_db, monkeypatch
):
    first = _seed_generation("synced-a", "job-mine", shared=True)
    second = _seed_generation("synced-b", "job-mine", shared=True)
    _set_origin(first, "synced")
    _set_origin(second, "synced")
    ref = _prepared_by_server_id("server-uuid-1")
    _patch_observer(
        monkeypatch, lambda *_args: _observed("server-uuid-1", "job-mine", final=True)
    )
    _cycle("late-equal")
    row = repo.get_share_state_intent(ref["intent_id"])
    # 같은 급의 후보가 둘이면 어느 쪽에도 적용하지 않는다(전과 같이 '맞출 대상 없음'으로 닫는다)
    assert (row["status"], row["local_id"], row["last_error_code"]) == (
        "converged",
        None,
        "local_mirror_skipped_no_target",
    )
    assert repo.get_generation(first)["is_final"] is False
    assert repo.get_generation(second)["is_final"] is False


def test_observed_job_id_waits_while_another_open_ledger_holds_the_same_local_row(
    isolated_content_db, monkeypatch
):
    mine = _seed_generation("local-mine", "job-mine", shared=True)
    ref = _prepared_by_server_id("server-uuid-1")
    # 같은 생성물에 job 앵커로 잡힌 다른 미종결 원장(내 작업 쪽에서 낸 요청) — 그쪽의 의도가 더 새로울 수 있다
    other = repo.prepare_share_state_intent(
        "http://share.example.test",
        job_anchor="job-mine",
        local_id=mine,
        operation_kind="unfinalize",
        desired_shared=True,
        desired_final=False,
        base_shared=True,
        base_final=True,
        desired_held=False,
        base_held=False,
    )
    _release(other)
    _patch_observer(
        monkeypatch, lambda *_args: _observed("server-uuid-1", "job-mine", final=True)
    )
    _cycle("late-busy")
    row = repo.get_share_state_intent(ref["intent_id"])
    assert (row["status"], row["local_id"], row["last_error_code"]) == (
        "pending",
        None,
        "local_target_busy",
    )
    assert repo.get_generation(mine)["is_final"] is False

    # 그 원장이 끝난 뒤에는 적용한다
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE share_state_intent SET status='superseded', claim_token=NULL, next_retry_at=NULL "
            "WHERE intent_id=?",
            (other["intent_id"],),
        )
    _retry_now(ref["intent_id"])
    _cycle("late-busy-2")
    row = repo.get_share_state_intent(ref["intent_id"])
    assert (row["status"], row["local_id"]) == ("converged", mine)
    assert repo.get_generation(mine)["is_final"] is True


def test_result_unknown_survives_an_auth_detour_and_other_observations(
    isolated_content_db, monkeypatch
):
    mine = _seed_generation("local-mine", "job-mine", shared=True)
    ref = _prepared_by_server_id("server-uuid-1")

    # 관측이 401 — 인증 대기로 가도 '결과 불명'은 이어진다(전에는 상태 이름이 바뀌어 다음 관측에 superseded 로 닫혔다)
    def unauthorized(*_args):
        raise reconciler._RemoteAuthRequired()

    monkeypatch.setattr(reconciler, "_observe_remote_states", unauthorized)
    assert _cycle("auth-1").get("auth_required") == 1
    row = repo.get_share_state_intent(ref["intent_id"])
    assert row["status"] == "auth_required"
    assert json.loads(row["observed_state_json"])["result_unknown"] is True

    # 로그인 뒤 — 서버가 '이전 상태'도 '바라던 상태'도 아닌 것을 보인다(다른 사람이 공유를 풀었다). 닫지 않는다.
    _patch_observer(
        monkeypatch,
        lambda *_args: _observed("server-uuid-1", "job-mine", final=False, shared=False),
    )
    assert _cycle("auth-2").get("retry") == 1
    row = repo.get_share_state_intent(ref["intent_id"])
    assert (row["status"], row["last_error_code"]) == ("prepared", "remote_result_unknown")
    local = repo.get_generation(mine)
    assert (local["shared"], local["is_final"]) == (True, False)  # 지켜보는 동안 로컬은 그대로다

    # 밀려 있던 최종이 뒤늦게 적용됐다(서버의 최종은 공유를 동반한다)
    _retry_now(ref["intent_id"])
    _patch_observer(
        monkeypatch, lambda *_args: _observed("server-uuid-1", "job-mine", final=True)
    )
    assert _cycle("auth-3").get("converged") == 1
    assert repo.get_generation(mine)["is_final"] is True


@pytest.mark.parametrize(
    ("unknown_since", "expected_status"),
    [("2999-01-01 00:00:00", "prepared"), ("2000-01-01 00:00:00", "rejected")],
    ids=["within-watch-keeps-watching", "after-watch-closes"],
)
def test_result_unknown_closes_only_after_the_watch_window(
    isolated_content_db, monkeypatch, unknown_since, expected_status
):
    mine = _seed_generation("local-mine", "job-mine", shared=True)
    ref = _prepared_by_server_id("server-uuid-1")
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE share_state_intent SET fail_streak=20, observed_state_json=? WHERE intent_id=?",
            (
                json.dumps({"result_unknown": True, "unknown_since": unknown_since}),
                ref["intent_id"],
            ),
        )
    _patch_observer(
        monkeypatch, lambda *_args: _observed("server-uuid-1", "job-mine", final=False)
    )
    counts = _cycle("late-window")
    row = repo.get_share_state_intent(ref["intent_id"])
    # 횟수(fail_streak)로는 닫지 않는다 — 기한으로만
    assert row["status"] == expected_status
    assert counts.get("retry" if expected_status == "prepared" else "rejected") == 1
    # 어느 쪽이든 로컬 행은 최종이 되지 않고 공유는 그대로다(서버의 지금 상태)
    local = repo.get_generation(mine)
    assert (local["shared"], local["is_final"]) == (True, False)


def test_long_watch_does_not_spend_the_lost_local_target_retries(
    isolated_content_db, monkeypatch
):
    # 오래 지켜보며 오른 횟수가 '로컬 대상 유실'의 재시도 예산(5)을 미리 써 버리면, 유실을 처음 본 순간 바로 닫힌다
    ref = _prepared_by_server_id("server-uuid-1", local_id="local-gone-for-now")
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE share_state_intent SET fail_streak=9 WHERE intent_id=?",
            (ref["intent_id"],),
        )
    _patch_observer(
        monkeypatch, lambda *_args: _observed("server-uuid-1", None, final=True)
    )
    assert _cycle("late-lost").get("waiting_local") == 1
    row = repo.get_share_state_intent(ref["intent_id"])
    assert (row["status"], row["fail_streak"], row["last_error_code"]) == (
        "waiting_local",
        1,
        "local_target_lost",
    )


def test_a_new_request_starts_a_fresh_watch(isolated_content_db):
    ref = _prepared_by_server_id("server-uuid-1")
    with db.get_connection() as conn:
        conn.execute(
            "UPDATE share_state_intent SET fail_streak=20, observed_state_json=? WHERE intent_id=?",
            (
                json.dumps({"result_unknown": True, "unknown_since": "2000-01-01 00:00:00"}),
                ref["intent_id"],
            ),
        )
    again = _prepared_by_server_id("server-uuid-1")  # 사용자가 다시 눌렀다 — 같은 행, 새 seq
    row = repo.get_share_state_intent(ref["intent_id"])
    assert again["intent_id"] == ref["intent_id"]
    assert (row["intent_seq"], row["fail_streak"], row["status"], row["observed_state_json"]) == (
        ref["intent_seq"] + 1,
        0,
        "prepared",
        None,
    )
