"""R13-IDEM-1 — placeholder 충돌 판정의 원자 상태기계 계약."""

from __future__ import annotations

import asyncio
import threading
from unittest.mock import MagicMock

import pytest

from app import db, repo
import app.repo.gen_requests as gen_request_repo
from app.usecases import gen_requests as gen_request_usecases
from app.usecases.gen_requests import (
    GenRequestCommand,
    GenerationIdempotencyConflict,
)


EMAIL = "artist@example.com"
CREATOR_UID = "artist"
IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444"


@pytest.fixture
def pooled_db(tmp_path, monkeypatch):
    """운영 기본인 스레드별 풀 ON 상태로 transaction-root 누수를 드러낸다."""
    monkeypatch.setenv("CONTENT_HUB_DB", str(tmp_path / "content_hub.db"))
    db.flush_pool()
    monkeypatch.setattr(db, "_POOL_ENABLED", True)
    db.init_db()
    repo.ensure_default_worker()
    monkeypatch.setattr(gen_request_usecases, "MANAGE_ENABLED", False)
    monkeypatch.setattr(gen_request_usecases.agent_signals, "signal", MagicMock())
    monkeypatch.setattr(
        gen_request_usecases, "journal_generation_event", MagicMock()
    )
    try:
        yield
    finally:
        db.flush_pool()


def _command(flavor: str, *, prompt: str = "same") -> GenRequestCommand:
    canvas_link = None
    idempotency_key = IDEMPOTENCY_KEY
    if flavor == "canvas":
        canvas_link = {
            "attempt_id": "attempt_r13_atomic",
            "generation_id": "generation_r13_atomic",
            "scene_id": "scene-r13",
            "card_id": "card-r13",
        }
        idempotency_key = None
    return GenRequestCommand(
        kind="create",
        email=EMAIL,
        creator_uid=CREATOR_UID,
        worker_id="me",
        source_gen_id=None,
        workspace={"scope": "personal", "id": None, "name": None},
        data={"prompt": prompt, "model": "model", "params": {}},
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


def _activate(command: GenRequestCommand, gen_id: str, contract: dict) -> dict:
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
    return result


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


def _assert_pool_connection_clean() -> None:
    with db.get_connection() as conn:
        assert not conn.in_transaction


@pytest.mark.parametrize("flavor", ["idempotent", "canvas"])
def test_winner_activation_before_loser_atomic_decision_converges(
    pooled_db, monkeypatch, flavor
):
    """구현 전에는 첫 조회 preparing, 다음 조회 pending이 되어 가짜 충돌하던 순서다."""
    command = _command(flavor)
    gen_id, contract = _seed_preparing(command)
    loser_read_placeholder = threading.Event()
    winner_activated = threading.Event()
    activation_errors: list[BaseException] = []

    def activate_as_winner() -> None:
        assert loser_read_placeholder.wait(3), "패자가 판정 직전까지 오지 못했습니다"
        try:
            _activate(command, gen_id, contract)
        except BaseException as exc:  # 스레드 예외를 본 테스트로 전달한다.
            activation_errors.append(exc)
        finally:
            winner_activated.set()

    original_get_generation = repo.get_generation
    first_read_lock = threading.Lock()
    first_read_done = False

    def pause_after_loser_reads_placeholder(requested_gen_id: str):
        nonlocal first_read_done
        generation = original_get_generation(requested_gen_id)
        with first_read_lock:
            should_pause = not first_read_done
            first_read_done = True
        if should_pause:
            loser_read_placeholder.set()
            assert winner_activated.wait(3), "승자가 예약을 활성화하지 못했습니다"
        return generation

    winner = threading.Thread(target=activate_as_winner)
    winner.start()
    monkeypatch.setattr(repo, "get_generation", pause_after_loser_reads_placeholder)

    result = asyncio.run(gen_request_usecases.submit_gen_request(command))

    winner.join(timeout=3)
    assert not winner.is_alive()
    assert activation_errors == []
    assert result is not None and result["id"] == gen_id
    with db.get_connection() as conn:
        row = conn.execute(
            "SELECT status FROM gen_request WHERE gen_id=?", (gen_id,)
        ).fetchone()
        assert row["status"] == "pending"
    _assert_pool_connection_clean()


@pytest.mark.parametrize("flavor", ["idempotent", "canvas"])
def test_atomic_classifier_state_machine_and_transaction_root(
    pooled_db, flavor
):
    command = _command(flavor)
    gen_id, contract = _seed_preparing(command)
    statements: list[str] = []
    with db.get_connection() as conn:
        conn.set_trace_callback(statements.append)

    assert _classify(command, contract) == {
        "state": "resumable",
        "gen_id": gen_id,
        "reason": "",
    }

    with db.get_connection() as conn:
        conn.set_trace_callback(None)
    normalized = [statement.strip().upper() for statement in statements]
    begin_index = next(
        index for index, statement in enumerate(normalized)
        if statement.startswith("BEGIN IMMEDIATE")
    )
    select_index = next(
        index for index, statement in enumerate(normalized)
        if statement.startswith("SELECT")
    )
    assert begin_index < select_index
    assert any(statement.startswith("COMMIT") for statement in normalized)
    _assert_pool_connection_clean()

    _activate(command, gen_id, contract)
    assert _classify(command, contract)["state"] == "completed"
    assert _classify(command, {**contract, "changed": True}) == {
        "state": "conflict",
        "gen_id": gen_id,
        "reason": "contract_mismatch",
    }
    _assert_pool_connection_clean()


def test_true_idempotency_contract_mismatch_still_raises_conflict(pooled_db):
    original = _command("idempotent", prompt="original")
    gen_id, contract = _seed_preparing(original)
    _activate(original, gen_id, contract)

    changed = _command("idempotent", prompt="changed")
    with pytest.raises(GenerationIdempotencyConflict):
        asyncio.run(gen_request_usecases.submit_gen_request(changed))

    assert repo.get_generation(gen_id) is not None
    _assert_pool_connection_clean()


def test_atomic_classifier_rolls_back_exception_with_pool_on(
    pooled_db, monkeypatch
):
    command = _command("idempotent")
    _gen_id, contract = _seed_preparing(command)

    def fail_inside_transaction(*_args, **_kwargs):
        raise RuntimeError("injected classifier failure")

    monkeypatch.setattr(
        gen_request_repo,
        "_idempotent_placeholder_is_resumable",
        fail_inside_transaction,
    )
    with pytest.raises(RuntimeError, match="injected classifier failure"):
        _classify(command, contract)
    _assert_pool_connection_clean()
