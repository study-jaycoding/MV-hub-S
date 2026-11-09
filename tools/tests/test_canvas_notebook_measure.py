"""Unit tests only: no browser, server, default DB or external network is started."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from browser_measure import canvas_notebook as measure
from verify_canvas_notebook_measure import CASES, verify


def report(case="cross_browser"):
    result = {"format": "mvhub-canvas-notebook-measure-v1", "case": case,
        "profiles": ["temporary/chrome-a", "temporary/chrome-b"], "browser_kind": "chrome",
        "isolation": {"shared_url": "http://127.0.0.1:9", "has_token": False, "cli_available": False},
        "checks": {name: {"status": "passed", "actual": True, "expected": True} for name in CASES[case]},
        "errors": [], "forbidden_requests": []}
    if case == "performance":
        result["timing"] = {"samples_ms": [10.0] * 20, "sync_ms": 900, "max_slowdown": 1.1, "baseline_ratios": {"p50_ms": 1, "p95_ms": 1}}
    return result


@pytest.mark.parametrize("case", CASES)
def test_complete_evidence_required_for_each_case(case):
    value = report(case)
    assert verify(value) == []
    value["checks"].pop(next(iter(CASES[case])))
    assert verify(value)


@pytest.mark.parametrize("status", ["unverified", "failed", "skipped", None])
def test_unmeasured_or_failed_step_never_certifies_case(status):
    value = report("lease_races")
    value["checks"]["floating_only"]["status"] = status
    assert verify(value)


@pytest.mark.parametrize("field,value", [("shared_url", "http://192.168.1.171:8010"), ("has_token", True), ("cli_available", True)])
def test_shared_status_and_health_are_mandatory(field, value):
    evidence = report()
    evidence["isolation"][field] = value
    assert verify(evidence)


def test_profiles_are_distinct_and_chrome_not_edge():
    value = report()
    value["profiles"] = ["same", "same"]
    assert verify(value)
    value = report()
    value["browser_kind"] = "edge"
    assert verify(value)


def test_generation_request_invalidates_otherwise_passing_report():
    value = report()
    value["forbidden_requests"] = ["POST 127.0.0.1:9999/api/gen-requests"]
    assert verify(value)


def test_passed_label_cannot_override_mismatching_observation():
    value = report()
    value["checks"]["content"] = {"status": "passed", "actual": ["wrong scene"], "expected": ["original scene"]}
    assert verify(value)


@pytest.mark.parametrize("invalid", [None, [], "not a report", 123])
def test_non_object_report_is_rejected(invalid):
    assert verify(invalid)


@pytest.mark.parametrize("profiles", [[{}, {}], [["a"], ["b"]], ["", "b"], ["a"], "ab", None])
def test_malformed_profiles_are_rejected_without_throwing(profiles):
    value = report()
    value["profiles"] = profiles
    assert verify(value)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), True, None, "10"])
def test_nonfinite_or_non_numeric_sync_time_is_rejected(value):
    evidence = report("performance")
    evidence["timing"]["sync_ms"] = value
    assert verify(evidence)


def test_nan_comparison_is_rejected_even_with_passed_label():
    value = report()
    value["checks"]["content"] = {"status": "passed", "actual": float("nan"), "expected": float("nan")}
    assert verify(value)


def test_range_observation_is_boolean_with_raw_evidence_retained(tmp_path):
    value = measure.Measurement("normal_handoff", tmp_path)
    value.check("within_five_seconds", 5100, "<=5000ms", False)
    assert value.report["checks"]["within_five_seconds"] == {
        "status": "failed", "actual": False, "expected": True,
        "evidence": {"observed": 5100, "criterion": "<=5000ms"},
    }


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -1, "10"])
def test_performance_requires_finite_numeric_samples(bad):
    value = report("performance")
    value["timing"]["samples_ms"][0] = bad
    assert verify(value)


def test_performance_requires_all_twenty_samples_and_subsecond_sync():
    value = report("performance")
    value["timing"]["samples_ms"].pop()
    assert verify(value)
    value = report("performance")
    value["timing"]["sync_ms"] = 1000
    assert verify(value)


@pytest.mark.parametrize("port", [8010, 8012, 80, 65536])
def test_live_ports_are_rejected_before_launch(tmp_path, port):
    with pytest.raises(ValueError, match="unsafe"):
        measure.make_env(tmp_path, port)


def test_server_environment_uses_existing_isolation_builder(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTENT_HUB_DB", "forbidden-original.db")
    monkeypatch.setenv("CONTENT_HUB_WORKER_BACKUP_STATE_DB", "forbidden-worker.db")
    monkeypatch.setenv("CONTENT_HUB_SHARED_URL", "http://192.168.1.171:8010")
    env = measure.make_env(tmp_path, 8239)
    assert env["CONTENT_HUB_DB"] == str(tmp_path / "db" / "content_hub.db")
    assert "CONTENT_HUB_WORKER_BACKUP_STATE_DB" not in env
    assert env["CONTENT_HUB_SHARED_URL"] == "http://127.0.0.1:9"
    assert env["CONTENT_HUB_SCENE_WRITER_TEST"] == "1"
    assert env["CONTENT_HUB_AUTH"] == "0"
    assert "CONTENT_HUB_SCENE_WRITER_TEST" not in measure.make_env(tmp_path, 8239, legacy=True)


@pytest.mark.parametrize("name", ["MV-hub-S-dev", "MV-hub-S-release", "MV-hub-S", "data_test", "data"])
def test_rollback_refuses_live_checkout_even_if_path_exists(tmp_path, name):
    checkout = tmp_path / name
    checkout.mkdir()
    with pytest.raises(ValueError, match="forbidden"):
        measure.validate_checkout(checkout)


def test_rollback_needs_explicit_separate_built_checkout(tmp_path):
    with pytest.raises(ValueError, match="built"):
        measure.validate_checkout(tmp_path)
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / "serve.py").write_text("# test fixture", encoding="utf-8")
    (tmp_path / "frontend" / "dist").mkdir(parents=True)
    (tmp_path / "frontend" / "dist" / "index.html").write_text("fixture", encoding="utf-8")
    assert measure.validate_checkout(tmp_path) == tmp_path.resolve()


def test_performance_fixture_is_ten_150k_scenes_and_includes_357_cards():
    scenes = measure.fixture(performance=True)
    assert len(scenes) == 10
    assert max(len(scene["cards"]) for scene in scenes) == 357
    assert all(150 * 1024 - 2 <= len(json.dumps(scene).encode()) <= 150 * 1024 + 2 for scene in scenes)


def test_read_only_idb_snapshot_preserves_tab_order_and_excludes_tombstones():
    key = lambda parts: json.dumps(parts, separators=(",", ":"))
    entries = [[key(["o", measure.BUCKET]), ["b", "a"]],
        [key(["s", measure.BUCKET, "a"]), {"id": "a"}],
        [key(["s", measure.BUCKET, "b"]), {"id": "b"}],
        [key(["d", measure.BUCKET, "gone"]), {"intentId": "gone"}]]
    assert measure.scene_rows(entries) == [{"id": "b"}, {"id": "a"}]
    assert "'readonly'" in measure.READ_STORE
    assert ".put(" not in measure.READ_STORE


def test_sync_timing_excludes_handoff_wait_and_requires_ten_payloads():
    records = [
        {"path": "/api/scenes/writer", "method": "POST", "start": 0, "end": 5000, "status": 200},
        {"path": "/api/scenes/notebook?project_id=", "method": "GET", "start": 5001, "end": 5100, "status": 200},
        {"path": "/api/scenes/backup", "method": "PUT", "start": 5101, "end": 5200, "status": 200, "upserts": 10},
        {"path": "/api/scenes/notebook?project_id=", "method": "GET", "start": 5201, "end": 5300, "status": 200},
    ]
    assert measure.sync_window(records) == {"sync_ms": 299, "start_ms": 5001, "end_ms": 5300, "upserts": 10}
    records[2]["upserts"] = 9
    with pytest.raises(ValueError, match="ten dirty"):
        measure.sync_window(records)


def test_isolated_account_switch_launcher_has_loopback_and_secret_checks(tmp_path):
    script = measure.controlled_launcher(tmp_path, "test-control-secret")
    compile(script, "isolated-launcher", "exec")  # Never execute/import the backend.
    assert "request.client.host not in ('127.0.0.1', '::1')" in script
    assert "X-Measure-Control" in script and "test-control-secret" in script
    assert "_switch_account_db(" in script and "active_account.clear_active()" in script
    assert "runpy.run_path" in script


def test_measurement_report_does_not_contain_control_secret(tmp_path):
    instance = measure.Measurement("lease_races", tmp_path)
    assert instance.hub.control_token
    assert instance.hub.control_token not in json.dumps(instance.report)


def test_cross_browser_closes_first_profile_before_opening_second_without_take(tmp_path, monkeypatch):
    import asyncio
    from types import SimpleNamespace
    events = []
    instance = measure.Measurement("cross_browser", tmp_path)

    async def send(method):
        events.append(method)

    async def kill():
        events.append("owned_process_cleanup")

    async def wait(_condition, _timeout):
        events.append("automatic_claim_ready")
        return True

    async def open_second(_stack, name, seed):
        events.append(f"open_{name}")
        assert seed == [{"id": "prior-b"}]
        return SimpleNamespace(wait=wait)

    monkeypatch.setattr(instance.hub, "request", lambda *_: (200, {"writer": None}))
    monkeypatch.setattr(instance, "open", open_second)
    async def forbid_take(*_):
        pytest.fail("c01 must not substitute a normal/forced handoff")
    monkeypatch.setattr(instance, "take", forbid_take)
    asyncio.run(instance.close_then_open(SimpleNamespace(send=send, _kill=kill), None, [{"id": "prior-b"}]))
    assert events == ["Page.close", "owned_process_cleanup", "open_b", "automatic_claim_ready"]
    assert instance.report["checks"]["closed_before_open"]["status"] == "passed"


def test_handoff_input_probe_leaves_real_text_editor_pending(tmp_path):
    import asyncio
    from types import SimpleNamespace
    events = []
    async def click(selector, **kwargs):
        events.append(("click", selector, kwargs)); return True
    async def wait(selector, timeout):
        events.append(("wait", selector)); return True
    async def key(*args, **kwargs):
        events.append(("key", args))
    async def type_text(text):
        events.append(("type", text))
    page = SimpleNamespace(click=click, wait=wait, key=key, type=type_text)
    asyncio.run(measure.Measurement("normal_handoff", tmp_path).text_input(page, "last characters"))
    assert "scene-textview-inline" in events[0][1]
    assert "contenteditable" in events[1][1]
    assert events[-1] == ("type", "last characters")
    assert not any(event[0] == "key" and event[1][0] == "Enter" for event in events)


def test_retained_inspection_reads_only_owned_synthetic_database(tmp_path):
    import sqlite3
    from contextlib import closing
    path = tmp_path / "hub" / "db" / "content_hub.db"
    path.parent.mkdir(parents=True)
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("CREATE TABLE scene_archive(scene_id TEXT,reason TEXT,name TEXT,data TEXT)")
        connection.executemany("INSERT INTO scene_archive VALUES(?,?,?,?)", [
            ("s", "legacy_overwrite", "X", '{"name":"X"}'),
            ("s", "legacy_delete", "Y", '{"name":"Y"}'),
        ])
    before = path.read_bytes()
    assert {(r["reason"], r["data"]["name"]) for r in measure.retained_rows(tmp_path)} == {("legacy_overwrite", "X"), ("legacy_delete", "Y")}
    assert path.read_bytes() == before


def test_performance_does_not_invent_default_slowdown_margin():
    value = report("performance")
    del value["timing"]["max_slowdown"]
    assert verify(value)
    value["timing"]["max_slowdown"] = 1.01
    value["timing"]["baseline_ratios"]["p95_ms"] = 1.02
    assert verify(value)


@pytest.mark.parametrize("arguments", [
    ["--case", "performance", "--max-slowdown", "nan"],
    ["--case", "performance", "--max-slowdown", "0"],
    ["--case", "bootstrap", "--baseline-report", "baseline.json"],
    ["--case", "performance", "--baseline-report", "b.json", "--baseline-checkout", "old"],
    ["--case", "performance", "--baseline-checkout", "old", "--max-slowdown", "1.2"],
])
def test_invalid_baseline_option_combinations_fail_before_launch(monkeypatch, arguments):
    monkeypatch.setattr(sys, "argv", ["canvas_notebook.py", *arguments])
    with pytest.raises(SystemExit) as error:
        measure.main()
    assert error.value.code == 2


def test_runner_marks_every_missing_required_probe_unverified(tmp_path, monkeypatch):
    async def partial(self, _args):
        self.report.update(report("lease_races"))
        del self.report["checks"]["account_aba"]
        return self.report
    monkeypatch.setattr(measure.Measurement, "run", partial)
    monkeypatch.setattr(measure.tempfile, "mkdtemp", lambda **_: str(tmp_path))
    from types import SimpleNamespace
    import asyncio
    assert asyncio.run(measure.execute(SimpleNamespace(case="lease_races"))) == 1
    saved = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert saved["checks"]["account_aba"]["status"] == "unverified"
    assert saved["verdict"] == "failed"
