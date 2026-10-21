import asyncio
import json

import pytest

from app.services import install_journal as journal, release_contract, runtime_activation as runtime


def test_startup_intent_is_durable_before_any_database_access(tmp_path):
    path = tmp_path / "journal.json"
    value = journal.new_journal(path, role="worker", previous={"build_id": "old"}, target={"build_id": "new"})
    for phase in journal.PHASES[1:6]:
        value = journal.advance(path, value, phase)
    with pytest.raises(ValueError, match="mutate"):
        journal.advance(path, value, "starting")
    value = journal.advance(path, value, "starting", db_mutation_possible=True, business_writes_possible=True)
    assert journal.read_journal(path)["db_mutation_possible"] is True
    with pytest.raises(ValueError, match="monotonic"):
        journal.advance(path, value, "ready", db_mutation_possible=False)
    assert journal.resume_action(value) == "inspect_before_recovery"


def test_failed_journal_write_leaves_previous_phase(tmp_path, monkeypatch):
    path = tmp_path / "journal.json"
    value = journal.new_journal(path, role="worker", previous={}, target={})
    before = path.read_bytes()
    monkeypatch.setattr(journal.os, "replace", lambda *_: (_ for _ in ()).throw(OSError("fixture")))
    with pytest.raises(OSError):
        journal.advance(path, value, "verified")
    assert path.read_bytes() == before


@pytest.mark.parametrize("phase,action", [("prepare", "abort_preparation"), ("draining", "abort_preparation"),
                                        ("quiesced", "restore_previous_program"), ("activation_pending", "restore_previous_program"),
                                        ("starting", "inspect_before_recovery"), ("committed", "done")])
def test_resume_does_not_turn_interruption_into_success(phase, action):
    assert journal.resume_action({"phase": phase, "db_mutation_possible": phase in {"starting", "committed"}}) == action


def test_program_rollback_keeps_database_and_requires_every_identity_and_protocol():
    value = {"db_mutation_possible": True, "business_writes_possible": True, "checkpoints": [{"key": "path-a", "database_id": "db-a"}]}
    row = {"key": "path-a", "status": "compatible", "database_id": "db-a", "schema_version": 1,
           "minimum_reader_protocol": 1, "minimum_writer_protocol": 2}
    compatible = {"db_schema": {"read_min": 1, "read_max": 1, "write_min": 1, "write_max": 1},
                  "reader_protocol": 1, "writer_protocol": 2}
    assert journal.rollback_decision(value, [row], compatible) == "program_only"
    assert journal.rollback_decision(value, [row], None) == "recovery_required"
    for mutation in ({"minimum_writer_protocol": 3}, {"status": "unversioned"}, {"database_id": "other"}, {"schema_version": 2}, {"key": "moved"}, {"components": ["future"]}):
        assert journal.rollback_decision(value, [{**row, **mutation}], compatible) == "recovery_required"
    assert journal.rollback_decision(value, [], compatible) == "recovery_required"


def test_activation_cannot_be_opened_by_wrong_nonce_or_unrecorded_business_writes(tmp_path, monkeypatch):
    control = tmp_path / "control.json"
    path = tmp_path / "journal.json"
    monkeypatch.setenv("MVHUB_ACTIVATION_ROOT", str(tmp_path))
    monkeypatch.setenv("MVHUB_ACTIVATION_CONTROL", str(control))
    monkeypatch.setenv("MVHUB_EXECUTION_NONCE", "expected")
    assert runtime.admission_state() == "blocked"
    value = {"format_version": 1, "state": "activated", "execution_nonce": "wrong", "journal": str(path), "run_id": "run"}
    control.write_text(json.dumps(value))
    assert runtime.admission_state() == "blocked"
    value["execution_nonce"] = "expected"
    control.write_text(json.dumps(value))
    record = {"run_id": "run", "execution_nonce": "expected", "phase": "ready", "db_mutation_possible": True,
              "business_writes_possible": False}
    path.write_text(json.dumps(record))
    assert runtime.admission_state() == "blocked"
    record["business_writes_possible"] = True
    path.write_text(json.dumps(record))
    assert runtime.admission_state() == "activated"


def test_normal_boot_and_health_remain_available_while_pending_requests_are_refused(tmp_path, monkeypatch):
    monkeypatch.delenv("MVHUB_ACTIVATION_CONTROL", raising=False)
    assert runtime.admission_state() == "normal"
    calls, messages = [], []
    async def app(scope, receive, send):
        calls.append(scope["path"])
    async def send(message):
        messages.append(message)
    middleware = runtime.ActivationAdmissionMiddleware(app)
    asyncio.run(middleware({"type": "http", "path": "/api/example"}, None, send))
    assert calls == ["/api/example"]
    monkeypatch.setenv("MVHUB_ACTIVATION_CONTROL", str(tmp_path / "missing.json"))
    asyncio.run(middleware({"type": "http", "path": "/api/example"}, None, send))
    assert messages[0]["status"] == 503 and calls == ["/api/example"]
    asyncio.run(middleware({"type": "http", "path": "/api/ready"}, None, send))
    assert calls[-1] == "/api/ready"


@pytest.mark.parametrize("size", [1024 * 1024 + 1, release_contract.MAX_JSON, release_contract.MAX_JSON + 1])
def test_runtime_build_identity_uses_release_contract_size_limit(tmp_path, monkeypatch, size):
    monkeypatch.setattr(runtime, "_ROOT", tmp_path)
    monkeypatch.setenv("MVHUB_BUILD_ID", "fallback")
    monkeypatch.delenv("MVHUB_ACTIVATION_CONTROL", raising=False)
    raw = json.dumps({"build_id": "installed-build"}).encode()
    (tmp_path / "build-manifest.json").write_bytes(raw.ljust(size, b" "))
    expected = "installed-build" if size <= release_contract.MAX_JSON else "fallback"
    assert runtime.runtime_identity()["build_id"] == expected


@pytest.mark.parametrize("size", [1024 * 1024 + 1, release_contract.MAX_JSON, release_contract.MAX_JSON + 1])
def test_activation_journal_uses_release_contract_size_limit(tmp_path, monkeypatch, size):
    control = tmp_path / "control.json"
    path = tmp_path / "journal.json"
    monkeypatch.setenv("MVHUB_ACTIVATION_ROOT", str(tmp_path))
    monkeypatch.setenv("MVHUB_ACTIVATION_CONTROL", str(control))
    monkeypatch.setenv("MVHUB_EXECUTION_NONCE", "expected")
    control.write_text(json.dumps({"format_version": 1, "state": "activated", "execution_nonce": "expected",
                                   "journal": str(path), "run_id": "run"}))
    raw = json.dumps({"run_id": "run", "execution_nonce": "expected", "phase": "committed",
                      "db_mutation_possible": True, "business_writes_possible": True}).encode()
    path.write_bytes(raw.ljust(size, b" "))
    expected = "activated" if size <= release_contract.MAX_JSON else "blocked"
    assert runtime.admission_state() == expected
