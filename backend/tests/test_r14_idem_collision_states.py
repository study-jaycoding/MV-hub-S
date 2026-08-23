"""R14 P2-5 — classify_placeholder_collision 의 미검증 2상태(예약·placeholder 소실).

두 상태 모두 conflict 로 fail-closed 되지만 원인이 다르고, 조용히 이어가면 사고가 다르다.
  · reservation_missing — 판정 시점에 예약행이 없다(준비 실패 정리가 예약을 지운 뒤 늦게 도착한
    재시도). 예약 없이 이어가면 남의 gen_id 를 재사용하거나 계약 검증 없이 진행하게 된다.
  · placeholder_missing — 예약은 활성화됐는데 그 gen placeholder 가 사라졌다(휴지통·정리).
    completed 로 반환하면 존재하지 않는 생성물을 성공으로 돌려주게 된다.
둘 다 "안전하게 이어갈 수 없음"이므로 usecase 는 원인별 메시지를 붙여 충돌로 올린다.

★결정적 실행: 진짜 동시성 대신 판정 직전(=BEGIN IMMEDIATE 직전)에 행을 지워 두 경합의
결과 상태를 그대로 만든다 — classify 는 BEGIN 뒤에만 읽으므로 지운 결과가 그대로 보인다.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from app import db, repo
from app.usecases import gen_requests as gen_request_usecases
from app.usecases.gen_requests import (
    CanvasGenerationConflict,
    GenRequestCommand,
    GenerationIdempotencyConflict,
)


EMAIL = "artist@example.com"
CREATOR_UID = "artist"
IDEMPOTENCY_KEY = "55555555-5555-4555-8555-555555555555"


@pytest.fixture
def pooled_db(tmp_path, monkeypatch):
    """운영 기본인 스레드별 풀 ON — transaction-root 누수까지 같이 드러낸다."""
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    monkeypatch.setattr(db, "_POOL_ENABLED", True)
    db.init_db()
    repo.ensure_default_worker()
    monkeypatch.setattr(gen_request_usecases, "MANAGE_ENABLED", False)
    monkeypatch.setattr(gen_request_usecases.agent_signals, "signal", MagicMock())
    monkeypatch.setattr(gen_request_usecases, "journal_generation_event", MagicMock())
    try:
        yield
    finally:
        db.flush_pool()


def _command(flavor: str) -> GenRequestCommand:
    canvas_link = None
    idempotency_key = IDEMPOTENCY_KEY
    if flavor == "canvas":
        canvas_link = {
            "attempt_id": "attempt_r14_states",
            "generation_id": "generation_r14_states",
            "scene_id": "scene-r14",
            "card_id": "card-r14",
        }
        idempotency_key = None
    return GenRequestCommand(
        kind="create",
        email=EMAIL,
        creator_uid=CREATOR_UID,
        worker_id="me",
        source_gen_id=None,
        workspace={"scope": "personal", "id": None, "name": None},
        data={"prompt": "same", "model": "model", "params": {}},
        canvas_link=canvas_link,
        idempotency_key=idempotency_key,
    )


def _contract(command: GenRequestCommand) -> dict:
    if command.canvas_link:
        return gen_request_usecases._canvas_command_contract(command)
    return gen_request_usecases._idempotency_command_contract(command)


def _seed_preparing(command: GenRequestCommand) -> tuple[str, dict]:
    contract = _contract(command)
    if command.canvas_link:
        reservation = repo.reserve_canvas_gen_request(
            command.email,
            command.creator_uid,
            command.canvas_link["generation_id"],
            command.kind,
            command.canvas_link,
            contract,
        )
    else:
        reservation = repo.reserve_idempotent_gen_request(
            command.email,
            command.creator_uid,
            command.kind,
            command.idempotency_key,
            contract,
        )
    gen_id = reservation["gen_id"]
    repo.create_local_generation(
        command.data,
        command.worker_id,
        creator_uid=command.creator_uid,
        workspace=command.workspace,
        generation_id=gen_id,
    )
    return gen_id, contract


def _activate(command: GenRequestCommand, gen_id: str, contract: dict) -> None:
    payload = repo.gen_recipe(gen_id)
    assert payload is not None
    payload["source_gen_id"] = command.source_gen_id
    if command.canvas_link:
        result = repo.activate_canvas_gen_request(
            command.email,
            command.canvas_link["attempt_id"],
            gen_id,
            payload,
            contract,
        )
    else:
        result = repo.activate_idempotent_gen_request(
            command.email,
            command.idempotency_key,
            gen_id,
            payload,
            contract,
        )
    assert result is not None


def _classify(command: GenRequestCommand, contract: dict) -> dict:
    return repo.classify_placeholder_collision(
        command.email,
        command.creator_uid,
        command.kind,
        contract,
        command.source_gen_id,
        idempotency_key=command.idempotency_key if not command.canvas_link else None,
        canvas_link=command.canvas_link,
    )


def _delete_reservation(command: GenRequestCommand) -> None:
    """준비 실패 정리(delete_*_reservation)가 예약을 지운 뒤와 같은 상태를 만든다."""
    with db.get_connection() as conn:
        if command.canvas_link:
            cur = conn.execute(
                "DELETE FROM gen_request WHERE canvas_attempt_id=?",
                (command.canvas_link["attempt_id"],),
            )
        else:
            cur = conn.execute(
                "DELETE FROM gen_request WHERE idempotency_key=?",
                (command.idempotency_key,),
            )
    assert cur.rowcount == 1


def _delete_placeholder(gen_id: str) -> None:
    """placeholder 만 사라진 상태(휴지통·정리) — 예약행은 그대로 둔다."""
    with db.get_connection() as conn:
        cur = conn.execute("DELETE FROM generation WHERE id=?", (gen_id,))
    assert cur.rowcount == 1


def _assert_pool_connection_clean() -> None:
    with db.get_connection() as conn:
        assert not conn.in_transaction


def _classify_after(sabotage):
    """판정 직전에 행을 지우는 래퍼를 끼운다 — 판정은 진짜 구현이 그대로 한다."""
    real_classify = repo.classify_placeholder_collision

    def classify(*args, **kwargs):
        sabotage()
        return real_classify(*args, **kwargs)

    return classify


# ── 판정기(repo) — 상태·이유 ─────────────────────────────────────────────────
@pytest.mark.parametrize("flavor", ["idempotent", "canvas"])
def test_missing_reservation_row_is_conflict(pooled_db, flavor):
    """예약행이 없으면 placeholder 가 남아 있어도 재사용하지 않고 conflict 로 끝낸다."""
    command = _command(flavor)
    gen_id, contract = _seed_preparing(command)
    _delete_reservation(command)

    assert _classify(command, contract) == {
        "state": "conflict",
        "gen_id": None,  # 판정 근거가 될 예약이 없으니 이어갈 gen_id 도 없다
        "reason": "reservation_missing",
    }
    assert repo.get_generation(gen_id) is not None, "판정은 placeholder 를 건드리지 않는다"
    _assert_pool_connection_clean()


@pytest.mark.parametrize("flavor", ["idempotent", "canvas"])
def test_activated_request_without_placeholder_is_conflict(pooled_db, flavor):
    """활성화된 예약인데 placeholder 가 없으면 completed 로 뭉개지 않고 conflict 로 끝낸다."""
    command = _command(flavor)
    gen_id, contract = _seed_preparing(command)
    _activate(command, gen_id, contract)
    assert _classify(command, contract)["state"] == "completed"  # 소실 전엔 completed

    _delete_placeholder(gen_id)

    assert _classify(command, contract) == {
        "state": "conflict",
        "gen_id": gen_id,  # 어느 gen 이 사라졌는지는 알려준다(호출부 메시지·로그용)
        "reason": "placeholder_missing",
    }
    _assert_pool_connection_clean()


# ── usecase — conflict 매핑 ──────────────────────────────────────────────────
@pytest.mark.parametrize("flavor", ["idempotent", "canvas"])
def test_reservation_lost_before_decision_raises_conflict(pooled_db, monkeypatch, flavor):
    """예약이 판정 직전에 사라지면 조용히 이어가지 않고 '이어갈 수 없음' 충돌로 올린다."""
    command = _command(flavor)
    _gen_id, _contract_ = _seed_preparing(command)
    monkeypatch.setattr(
        repo,
        "classify_placeholder_collision",
        _classify_after(lambda: _delete_reservation(command)),
    )
    expected = (
        CanvasGenerationConflict if command.canvas_link else GenerationIdempotencyConflict
    )
    message = (
        "같은 생성 ID가 다른 요청에 사용 중이라 안전하게 이어갈 수 없습니다"
        if command.canvas_link
        else "같은 생성 요청 키의 placeholder를 안전하게 이어갈 수 없습니다"
    )

    with pytest.raises(expected, match=message):
        asyncio.run(gen_request_usecases.submit_gen_request(command))

    _assert_pool_connection_clean()


@pytest.mark.parametrize("flavor", ["idempotent", "canvas"])
def test_placeholder_lost_before_decision_raises_conflict(pooled_db, monkeypatch, flavor):
    """placeholder 가 판정 직전에 사라지면 '찾을 수 없음' 충돌 — 성공으로 돌려주지 않는다.

    이 경로는 예약을 preparing 으로 읽은 뒤(=선행 단축 반환을 지나) 승자가 활성화하고
    그 placeholder 까지 사라진 이중 경합이다 — 판정기만 남아 막을 수 있는 구간."""
    command = _command(flavor)
    gen_id, contract = _seed_preparing(command)

    def winner_activates_then_placeholder_vanishes() -> None:
        _activate(command, gen_id, contract)
        _delete_placeholder(gen_id)

    monkeypatch.setattr(
        repo,
        "classify_placeholder_collision",
        _classify_after(winner_activates_then_placeholder_vanishes),
    )
    expected = (
        CanvasGenerationConflict if command.canvas_link else GenerationIdempotencyConflict
    )
    message = (
        "기존 캔버스 생성 요청의 placeholder를 찾을 수 없습니다"
        if command.canvas_link
        else "기존 생성 요청의 placeholder를 찾을 수 없습니다"
    )

    with pytest.raises(expected, match=message):
        asyncio.run(gen_request_usecases.submit_gen_request(command))

    _assert_pool_connection_clean()
