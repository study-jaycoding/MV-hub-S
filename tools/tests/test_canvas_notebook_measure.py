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
        "isolation": {"shared_url": "http://127.0.0.1:8237", "owned_shared_url": "http://127.0.0.1:8237",
                      "has_token": True, "cli_available": False, "shared_process_owned": True,
                      "shared_auth_enabled": True, "ephemeral_admin": True, "token_verified": True},
        "checks": {name: {"status": "passed", "actual": True, "expected": True} for name in CASES[case]},
        "errors": [], "forbidden_requests": []}
    if case == "performance":
        result["timing"] = {"samples_ms": [10.0] * 20, "sync_ms": 900, "max_slowdown": 1.1, "baseline_ratios": {"p50_ms": 1, "p95_ms": 1}}
    if case == "first_transition":
        result["transition"] = {"variant": "empty", "start_order": "a", "old_checkout": "temporary/0123"}
        result["previous_browser_records"] = {name: {"store_sha256": "a" * 64, "scenes": [{"id": name, "sha256": "b" * 64}], "mirrorRecovery": None} for name in ("a", "b")}
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


@pytest.mark.parametrize("field,value", [("shared_url", "http://192.168.1.171:8010"), ("has_token", False), ("cli_available", True),
    ("shared_url", "http://127.0.0.1:8238"), ("shared_process_owned", False), ("shared_auth_enabled", False),
    ("ephemeral_admin", False), ("token_verified", False), ("owned_shared_url", None)])
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
    monkeypatch.setenv("CONTENT_HUB_SCENE_WRITER", "0")
    env = measure.make_env(tmp_path, 8239)
    assert env["CONTENT_HUB_DB"] == str(tmp_path / "db" / "content_hub.db")
    assert "CONTENT_HUB_WORKER_BACKUP_STATE_DB" not in env
    assert env["CONTENT_HUB_SHARED_URL"] == "http://127.0.0.1:9"
    assert "CONTENT_HUB_SCENE_WRITER" not in env  # 부모의 0/1 없이 운영 기본 켬을 잰다
    assert env["CONTENT_HUB_AUTH"] == "0"
    monkeypatch.setenv("CONTENT_HUB_SCENE_WRITER", "1")
    assert measure.make_env(tmp_path, 8239, writer=False)["CONTENT_HUB_SCENE_WRITER"] == "0"  # 미러 준비 단계만 끔


def test_mirror_is_seeded_on_writer_off_start_then_hub_restarts_with_writer(tmp_path, monkeypatch):
    import asyncio
    instance = measure.Measurement("bootstrap", tmp_path)
    seeds = measure.fixture()
    calls, rows = [], []
    def request(path, body=None, method=None):
        calls.append((path, method, body))
        if method == "PUT":
            rows.extend({"id": item["id"], "data": item["data"]} for item in body["upserts"])
            return 200, {"ok": True}
        return 200, {"restore_generation": "synthetic-generation", "items": list(rows)}
    monkeypatch.setattr(instance.hub, "request", request)
    monkeypatch.setattr(instance.hub, "stop", lambda: calls.append(("stop",)))
    monkeypatch.setattr(instance.hub, "start", lambda **options: calls.append(("start", options)))
    asyncio.run(instance.seed_mirror(seeds))
    put = next(body for path, method, body in (c for c in calls if len(c) == 3) if method == "PUT")
    assert put["restore_generation"] == "synthetic-generation" and put["project_id"] == ""
    assert [json.loads(item["data"]) for item in put["upserts"]] == seeds  # 브라우저 직렬화와 같은 간결 JSON
    assert all(item["data"] == json.dumps(seed, separators=(",", ":")) for item, seed in zip(put["upserts"], seeds))
    assert calls[0] == ("start", {"writer": False})  # 공책 끔으로 먼저 띄운다
    assert [c[0] for c in calls].index("stop") > max(i for i, c in enumerate(calls) if len(c) == 3 and c[1] == "PUT")
    assert calls[-2:] == [("stop",), ("start", {})]  # 미러를 채운 뒤에만 공책을 켜고 다시 띄운다
    assert instance.report["mirror_seed"]["scenes"] == len(seeds)
    assert "empty-mirror first transition is not measured" in instance.report["limitations"][-1]


def test_first_transition_skips_mirror_seed_and_runs_its_own_flow(tmp_path, monkeypatch):
    import asyncio
    instance = measure.Measurement("first_transition", tmp_path)
    calls = []
    async def seed(self, seeds):
        calls.append("seed_mirror")
    async def first(self, stack, seeds):
        calls.append(("first_transition", len(seeds)))
        return self.report
    monkeypatch.setattr(measure, "find_browser", lambda: "chrome.exe")
    monkeypatch.setattr(measure.Measurement, "seed_mirror", seed)
    monkeypatch.setattr(measure.Measurement, "first_transition", first)
    asyncio.run(instance.run(None))
    assert calls == [("first_transition", 3)]  # 빈 허브 미러 그대로 — 미러를 채우면 빈 미러 첫 전환을 재지 못한다
    assert {"before_confirmation", "previous_browser", "selected_raw", "before_start", "reconnect"} <= CASES["first_transition"]


def test_raw_fingerprints_detect_same_id_content_execution_marks_and_order_changes():
    scenes = [{"id": "a", "cards": [{"text": "원문"}], "edges": [{"from": "c1", "to": "c2"}], "comfyRuns": [{"id": "run"}]}, {"id": "b"}]
    fingerprints = measure.scene_fingerprints(scenes)
    assert measure.scene_fingerprints(json.loads(json.dumps(scenes))) == fingerprints
    for altered in ([{**scenes[0], "cards": [{"text": "다른 원문"}]}, scenes[1]],
                    [{**scenes[0], "edges": []}, scenes[1]], [{**scenes[0], "comfyRuns": []}, scenes[1]], list(reversed(scenes))):
        assert measure.scene_fingerprints(altered) != fingerprints


@pytest.mark.parametrize("missing", ["store_sha256", "scenes"])
def test_first_transition_rejects_ids_without_actual_previous_raw_fingerprints(missing):
    value = report("first_transition")
    value["previous_browser_records"]["a"].pop(missing)
    assert verify(value)


def held_records(value):
    records = value['previous_browser_records']
    records['a']['mirrorRecovery'] = json.dumps({'generation': 'G2', 'blockedIds': []})
    records['b']['mirrorRecovery'] = json.dumps({'generation': 'G2', 'blockedIds': ['b']})
    for name, actual in [('held_first', ['b', 'a']), ('held_archive_before_confirmation', [records['b']['scenes']])]:
        value['checks'][name] = {'status': 'passed', 'actual': actual, 'expected': actual}
    loser = 'b' if value['transition']['start_order'] == 'a' else 'a'
    archives = [records[loser]['scenes']]
    value['checks']['other_browser_preserved'] = {'status': 'passed', 'actual': archives, 'expected': archives}


@pytest.mark.parametrize('order', ['a', 'b'])
@pytest.mark.parametrize('broken', ['duplicate', 'boolean', 'missing'])
def test_held_first_verifier_requires_one_original_archive_without_received_canvas(order, broken):
    value = report('first_transition'); value['transition'].update(variant='held', start_order=order)
    held_records(value)
    assert verify(value) == []
    check = value['checks']['other_browser_preserved']
    if broken == 'duplicate':
        extra = [{'id': 'received', 'sha256': 'c' * 64}]
        check.update(actual=[*check['actual'], extra], expected=[*check['expected'], extra])
    elif broken == 'boolean': check.update(actual=True, expected=True)
    else: del value['checks']['other_browser_preserved']
    assert verify(value)


@pytest.mark.parametrize("variant", ["same_generation", "held"])
def test_first_transition_requires_actual_previous_generation_record(variant):
    value = report("first_transition")
    value["transition"]["variant"] = variant
    assert verify(value)
    if variant == 'held': held_records(value)
    else: value["previous_browser_records"]["a"]["mirrorRecovery"] = json.dumps({"generation": "G2", "blockedIds": []})
    assert verify(value) == []


@pytest.mark.parametrize("variant", ["empty", "different", "restored_unknown", "equal", "same_generation", "held", "limit_exact", "limit_over"])
def test_first_transition_variants_require_size_or_history_evidence(variant):
    value = report("first_transition")
    value["transition"]["variant"] = variant
    if variant == 'held': held_records(value)
    if variant == 'same_generation':
        value["previous_browser_records"]["a"]["mirrorRecovery"] = json.dumps({"generation": "G2", "blockedIds": []})
    if variant.startswith("limit_"):
        assert verify(value)
        size = 5 * 1024 * 1024 + (variant == "limit_over")
        value["checks"]["size_boundary"] = {"status": "passed", "actual": size, "expected": size}
    assert verify(value) == []


@pytest.mark.parametrize('broken', ['open_order', 'archive', 'held_on_a', 'generation', 'confirmation_order'])
def test_held_first_verifier_requires_b_provenance_order_and_preconfirmation_archive(broken):
    value = report('first_transition'); value['transition'].update(variant='held', start_order='b')
    held_records(value)
    assert verify(value) == []
    if broken == 'open_order':
        value['checks']['held_first'].update(actual=['a', 'b'], expected=['a', 'b'])
    if broken == 'archive': del value['checks']['held_archive_before_confirmation']
    if broken == 'held_on_a':
        value['previous_browser_records']['a']['mirrorRecovery'] = json.dumps({'generation': 'G2', 'blockedIds': ['a']})
        value['previous_browser_records']['b']['mirrorRecovery'] = json.dumps({'generation': 'G2', 'blockedIds': []})
    if broken == 'generation': value['previous_browser_records']['a']['mirrorRecovery'] = json.dumps({'generation': 'G1', 'blockedIds': []})
    if broken == 'confirmation_order': value['transition']['start_order'] = 'simultaneous'
    assert verify(value)


@pytest.mark.parametrize('order', ['a', 'b'])
@pytest.mark.parametrize('fault', ['none', 'lost_commit'])
def test_held_first_cli_accepts_b_first_with_either_confirmation_order(tmp_path, monkeypatch, order, fault):
    async def execute(args):
        assert args.transition == 'held' and args.start_order == order
        return 0
    monkeypatch.setattr(measure, 'execute', execute)
    monkeypatch.setattr(sys, 'argv', ['canvas_notebook.py', '--case', 'first_transition', '--old-checkout', str(tmp_path), '--transition', 'held', '--start-order', order, '--transition-fault', fault])
    assert measure.main() == 0


def test_equal_b_cli_selects_interrupted_clean_upgrade_without_starting_a_browser(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock
    run = AsyncMock(return_value=0)
    monkeypatch.setattr(measure, 'execute', run)
    monkeypatch.setattr(sys, 'argv', ['canvas_notebook.py', '--case', 'first_transition', '--old-checkout', str(tmp_path), '--transition', 'equal', '--start-order', 'b'])
    assert measure.main() == 0
    assert run.call_args.args[0].start_order == 'b'


@pytest.mark.parametrize('broken', ['missing_join', 'missing_close', 'missing_no_upload', 'based_id', 'upload', 'archive', 'union', 'malformed_records'])
def test_interrupted_equal_verifier_requires_close_bases_no_upload_and_original_archive(broken):
    value = report('first_transition'); value['transition'].update(variant='equal', start_order='b')
    records = value['previous_browser_records']
    evidence = {
        'interrupted_clean_upgrade': {'not_started': True, 'join_id': '', 'awaiting': False, 'based_ids': ['a']},
        'interrupted_closed': {'closed': True, 'released': True}, 'interrupted_no_upload': False,
        'other_browser_preserved': [records['a']['scenes']], 'selected_raw': records['b']['scenes'], 'no_merge': records['b']['scenes'],
    }
    for name, actual in evidence.items(): value['checks'][name] = {'status': 'passed', 'actual': actual, 'expected': actual}
    assert verify(value) == []
    if broken.startswith('missing_'):
        del value['checks'][{'missing_join': 'interrupted_clean_upgrade', 'missing_close': 'interrupted_closed', 'missing_no_upload': 'interrupted_no_upload'}[broken]]
    elif broken == 'based_id': value['checks']['interrupted_clean_upgrade']['actual']['based_ids'] = []
    elif broken == 'upload': value['checks']['interrupted_no_upload'].update(actual=True, expected=True)
    elif broken == 'archive': value['checks']['other_browser_preserved'].update(actual=True, expected=True)
    elif broken == 'union': value['checks']['no_merge'].update(actual=[*records['a']['scenes'], *records['b']['scenes']], expected=[*records['a']['scenes'], *records['b']['scenes']])
    else: value['previous_browser_records'] = None
    assert verify(value)


def test_interrupted_equal_flow_closes_a_before_b_confirmation_and_reopens_the_same_profile(tmp_path, monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock
    instance = measure.Measurement('first_transition', tmp_path)
    instance.transition_args = SimpleNamespace(old_checkout=tmp_path, transition='equal', start_order='b', transition_fault='none')
    seeds = measure.fixture(); original_b = [{**seeds[-1], 'id': 'prior-b', 'name': 'browser B original'}]
    selected, closed, events = False, False, []
    pages = {name: SimpleNamespace(goto=AsyncMock(), wait=AsyncMock(return_value=True), send=AsyncMock(), shot=AsyncMock(),
             mirror_hold_script='hold', mutations=[], proc=Mock()) for name in ('a', 'b', 'reopened-a')}
    pages['a'].proc.poll.side_effect = lambda: 0 if closed else None
    async def kill():
        nonlocal closed
        closed = True; events.append('closed-a')
    pages['a']._kill = kill
    async def choose(_selector):
        nonlocal selected
        assert closed
        selected = True; events.append('confirmed-b'); return True
    pages['b'].click = choose
    a_opens = 0
    async def open_page(_stack, name, seed=None, **_kwargs):
        nonlocal a_opens
        if name == 'a':
            a_opens += 1
            if a_opens == 2:
                assert selected and seed is None
                events.append('reopened-a'); return pages['reopened-a']
        return pages[name]
    instance.open = AsyncMock(side_effect=open_page)
    async def evaluate(name, script):
        if name == 'a' and closed: raise AssertionError('closed A cannot be read')
        if script == measure.READ_STORE:
            joined = {'notebookId': 'book' if selected else '', 'restoreGeneration': 'G1'}
            entries = [(json.dumps(['nj', instance.account], separators=(',', ':')), joined)]
            entries.extend((json.dumps(['b', instance.bucket, s['id']], separators=(',', ':')), {'hash': 'old'}) for s in seeds)
            if name == 'reopened-a': entries.append((json.dumps(['nr', instance.account], separators=(',', ':')), [{'scenes': {instance.bucket: seeds}}]))
            return entries
        if script == 'window.__measureNetwork': return []
        if script.startswith('!!document.'): return False
        if script == 'navigator.userAgent': return 'synthetic Chrome'
        return None
    for name, page in pages.items():
        async def eval_page(script, n=name): return await evaluate(n, script)
        page.eval = eval_page
    async def local(page): return seeds if page is pages['a'] else original_b
    def book():
        scenes = original_b if selected else seeds
        return {'restore_generation': 'G1', 'notebook_id': 'book' if selected else None,
                'items': [{'id': s['id'], 'data': json.dumps(s)} for s in scenes], 'order': {'ids': [s['id'] for s in scenes]}}
    def request(path, *_args):
        if path == '/api/auth/config': return 200, {'features': ['scene_writer_confirm_v1']}
        if path == '/api/scenes/writer': return 200, {'writer': None}
        return 200, book()
    instance.hub.request = request; instance.hub.start = Mock(); instance.hub.stop = Mock()
    instance.local = local; instance.wait_local = AsyncMock(); instance.ensure_canvas = AsyncMock(); instance.take = AsyncMock()
    async def synced(_page, _timeout): return book()
    instance.synced = synced
    monkeypatch.setattr(measure, 'validate_checkout', lambda _p: tmp_path)
    monkeypatch.setattr(measure, 'retained_rows', lambda _p: [{'reason': 'before_start', 'data': s} for s in seeds])
    asyncio.run(instance.first_transition(None, seeds))
    assert events == ['closed-a', 'confirmed-b', 'reopened-a']
    assert all(check['status'] == 'passed' for check in instance.report['checks'].values()), instance.report['checks']
    assert any('window.__measureInterruptedStart' in call.kwargs.get('source', '') for call in pages['a'].send.call_args_list)
    assert instance.report['checks']['other_browser_preserved']['actual'] == [measure.scene_fingerprints(seeds)]


@pytest.mark.parametrize('order', ['a', 'b'])
def test_held_first_verifier_cli_requires_the_actual_preconfirmation_archive(tmp_path, order):
    import subprocess
    value = report('first_transition'); value['transition'].update(variant='held', start_order=order)
    held_records(value)
    path = tmp_path / 'held-first.json'
    for expected in (0, 1):
        if expected: del value['checks']['held_archive_before_confirmation']
        path.write_text(json.dumps(value), encoding='utf-8')
        result = subprocess.run([sys.executable, str(TOOLS / 'verify_canvas_notebook_measure.py'), str(path)], capture_output=True, text=True)
        assert result.returncode == expected, result.stdout + result.stderr


@pytest.mark.parametrize("fault", ["lost_chunk", "lost_commit"])
def test_first_transition_reply_loss_must_be_observed(fault):
    value = report("first_transition")
    value["transition"]["fault"] = fault
    assert verify(value)
    value["checks"]["response_loss"] = {"status": "passed", "actual": 1, "expected": 1}
    assert verify(value) == []


def test_first_transition_cli_requires_an_old_checkout_before_launch(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["canvas_notebook.py", "--case", "first_transition"])
    with pytest.raises(SystemExit) as error:
        measure.main()
    assert error.value.code == 2


def test_first_transition_verifier_cli_accepts_complete_evidence_and_rejects_missing_raws(tmp_path):
    import subprocess
    evidence = report("first_transition")
    path = tmp_path / "synthetic-evidence.json"
    for expected in (0, 1):
        if expected:
            del evidence["previous_browser_records"]["a"]["scenes"]
        path.write_text(json.dumps(evidence), encoding="utf-8")
        result = subprocess.run([sys.executable, str(TOOLS / "verify_canvas_notebook_measure.py"), str(path)], capture_output=True, text=True)
        assert result.returncode == expected, result.stdout + result.stderr


@pytest.mark.parametrize("join, notebook_id, converged", [
    ({"notebookId": "nb", "restoreGeneration": "g1"}, "nb", True),
    ({"notebookId": "", "restoreGeneration": "g1"}, "nb", True),     # 시작 전 미러에 합류한 브라우저(제품이 "" 로 둔다)
    (None, "nb", False),                                             # 같은 씬이어도 합류 기록이 없다
    ({"notebookId": "", "restoreGeneration": "g1"}, None, False),    # 공책이 아직 시작되지 않은 미러
    ({"notebookId": "other", "restoreGeneration": "g1"}, "nb", False),  # 다른 공책
    ({"notebookId": "nb", "restoreGeneration": "g0"}, "nb", False),  # 옛 복원 세대
])
def test_synced_requires_started_notebook_and_matching_browser_join(tmp_path, monkeypatch, join, notebook_id, converged):
    import asyncio
    instance = measure.Measurement("bootstrap", tmp_path)
    key = lambda parts: json.dumps(parts, separators=(",", ":"))
    scene = {"id": "a", "name": "a"}
    entries = [[key(["o", instance.bucket]), ["a"]], [key(["s", instance.bucket, "a"]), scene]]
    if join is not None:
        entries.append([key(["nj", instance.account]), join])
    book = {"notebook_id": notebook_id, "restore_generation": "g1", "items": [{"id": "a", "data": json.dumps(scene), "deleted_at": None}]}
    monkeypatch.setattr(instance.hub, "request", lambda *_: (200, book))
    class FakePage:
        async def eval(self, _script):
            return entries
    if converged:
        assert asyncio.run(instance.synced(FakePage(), timeout=1)) is book
    else:
        with pytest.raises(RuntimeError, match="converge"):
            asyncio.run(instance.synced(FakePage(), timeout=.3))


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
    assert "_switch_account_db(original, original_uid)" in script and "active_account.clear_active()" not in script
    assert "runpy.run_path" in script


def test_measurement_report_does_not_contain_control_secret(tmp_path):
    instance = measure.Measurement("lease_races", tmp_path)
    assert instance.hub.control_token
    assert instance.hub.control_token not in json.dumps(instance.report)
    assert instance.hub.shared.password not in json.dumps(instance.report)


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


@pytest.mark.parametrize("visible,clicked", [(True, True), (False, True), (True, False)])
def test_take_waits_for_button_before_click_and_timing(tmp_path, monkeypatch, visible, clicked):
    import asyncio
    from types import SimpleNamespace
    events = []
    async def wait(expression, timeout):
        events.append(("wait", timeout))
        if timeout == 10:
            assert expression == "document.querySelector('.canvas-away button')"
            return visible
        assert timeout == 15
        return True
    async def click(expression):
        assert expression == "document.querySelector('.canvas-away button')"
        events.append(("click",))
        return clicked
    def now():
        events.append(("time",))
        return 1.0
    monkeypatch.setattr(measure, 'time', SimpleNamespace(monotonic=now))
    operation = measure.Measurement("normal_handoff", tmp_path).take(SimpleNamespace(wait=wait, click=click))
    if visible and clicked:
        assert asyncio.run(operation) == 0
        assert events == [("wait", 10), ("time",), ("click",), ("wait", 15), ("time",)]
    else:
        with pytest.raises(RuntimeError, match="takeover button missing"):
            asyncio.run(operation)
        assert events == ([("wait", 10), ("time",), ("click",)] if visible else [("wait", 10)])


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


@pytest.mark.parametrize("moved", [True, False])
def test_handoff_drag_uses_card_body_and_checks_visible_motion_before_release(tmp_path, moved):
    import asyncio
    from types import SimpleNamespace
    events = []

    async def evaluate(expression):
        events.append(("eval", expression))
        assert '.scene-card[data-id=\\"card-0\\"]' in expression
        assert "scene-card-hd" not in expression
        assert "getBoundingClientRect" in expression
        return [20, 30] if "return [r.x,r.y]" in expression else {"x": 100, "y": 38}

    async def send(method, **kwargs):
        events.append(("send", kwargs["type"]))

    async def wait(expression, timeout):
        events.append(("wait", expression))
        assert "getBoundingClientRect" in expression
        assert "p[0]-20" in expression and "p[1]-30" in expression
        assert timeout == 3
        return moved

    instance = measure.Measurement("normal_handoff", tmp_path)
    operation = instance.start_card_drag(SimpleNamespace(eval=evaluate, send=send, wait=wait))
    if moved:
        asyncio.run(operation)
    else:
        with pytest.raises(RuntimeError, match="card body did not move"):
            asyncio.run(operation)
    assert events[-1][0] == "wait"
    assert [event[1] for event in events if event[0] == "send"] == ["mousePressed"] + ["mouseMoved"] * 5
    assert instance.report["checks"]["drag_started"]["status"] == ("passed" if moved else "failed")


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


@pytest.mark.parametrize("url", ["http://127.0.0.1:9", "http://127.0.0.1:8010", "http://127.0.0.1:8012",
    "https://127.0.0.1:8237", "http://localhost:8237", "http://127.0.0.1:8237/path", "http://user@127.0.0.1:8237",
    "http://127.0.0.1:8237?remote=1", "http://127.0.0.1:bad", "http://192.168.1.171:8010"])
def test_owned_shared_server_requires_exact_safe_loopback_origin(tmp_path, url):
    with pytest.raises(ValueError):
        measure.make_env(tmp_path, 8239, shared_url=url)
    value = report()
    value["isolation"].update(shared_url=url, owned_shared_url=url)
    assert verify(value)


def test_shared_server_uses_isolation_builder_and_ephemeral_admin_without_writing_credentials(tmp_path, monkeypatch):
    from types import SimpleNamespace
    launched = []
    proc = SimpleNamespace(poll=lambda: None, terminate=lambda: None, wait=lambda **_: 0)
    monkeypatch.setattr(measure.subprocess, "Popen", lambda command, **kwargs: launched.append((command, kwargs)) or proc)
    monkeypatch.setattr(measure.servers, "wait_ready", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(measure, "isolated_request", lambda _url, path: (200, {"cli_available": False} if path == "/api/health" else {"auth_enabled": True}))
    shared = measure.IsolatedSharedServer(tmp_path)
    shared.start()
    shared.start()  # restarts of H reuse this owned S and its session signing secret
    assert len(launched) == 1
    env = launched[0][1]["env"]
    assert env["CONTENT_HUB_AUTH"] == "1"
    assert env["CONTENT_HUB_ADMIN_EMAIL"] == shared.email
    assert shared.email.endswith("@localhost.invalid")
    assert env["CONTENT_HUB_ADMIN_PASSWORD"] == shared.password
    assert env["CONTENT_HUB_SHARED_URL"] == measure.servers.DEAD_URL
    assert Path(env["CONTENT_HUB_DB"]).is_relative_to(tmp_path)
    assert not list(tmp_path.rglob("creds.json"))
    shared.stop()


@pytest.mark.parametrize("already_logged_in", [False, True])
def test_hub_login_only_when_missing_then_validates_existing_token_with_owned_s(tmp_path, monkeypatch, already_logged_in):
    import sqlite3
    from contextlib import closing
    hub = measure.Hub(tmp_path)
    database = tmp_path / "hub" / "db" / "content_hub.db"
    database.parent.mkdir(parents=True)
    with closing(sqlite3.connect(database)) as connection, connection:
        connection.execute("CREATE TABLE app_setting(key TEXT PRIMARY KEY,value TEXT)")
        connection.execute("INSERT INTO app_setting VALUES('shared_server_token','synthetic-token')")
    status = {"url": hub.shared.url, "has_token": already_logged_in, "email": hub.shared.email, "is_admin": True}
    calls = []
    def request(path, body=None):
        calls.append(path)
        if path == "/api/shared-server/login":
            assert body == {"url": hub.shared.url, "email": hub.shared.email, "password": hub.shared.password}
            status["has_token"] = True
        return 200, dict(status)
    def shared_request(url, path, *, headers):
        assert (url, path) == (hub.shared.url, "/api/auth/me")
        assert headers == {"Authorization": "Bearer synthetic-token"}
        return 200, {"email": hub.shared.email, "global_roles": ["admin"]}
    monkeypatch.setattr(hub, "request", request)
    monkeypatch.setattr(measure, "isolated_request", shared_request)
    assert hub.authenticate()["has_token"] is True
    assert calls.count("/api/shared-server/login") == int(not already_logged_in)
    assert "synthetic-token" not in json.dumps(hub.isolation)


def test_hub_rejects_foreign_shared_session_before_any_login(tmp_path, monkeypatch):
    hub = measure.Hub(tmp_path)
    monkeypatch.setattr(hub, "request", lambda *_: (200, {"url": "http://192.168.1.171:8010", "has_token": True}))
    with pytest.raises(RuntimeError, match="owned S"):
        hub.authenticate()


def test_open_seeds_account_bucket_before_boot_and_requires_canvas_not_library_chips(tmp_path, monkeypatch):
    import asyncio
    from types import SimpleNamespace
    events, scripts = [], []
    instance = measure.Measurement("cross_browser", tmp_path)
    async def send(method, **kwargs):
        events.append(method)
        scripts.append(kwargs["source"])
    async def goto(*_args, **_kwargs):
        events.append("goto")
    async def wait(condition, _timeout):
        events.append("wait")
        assert ".scene-board" in condition and ".canvas-away" in condition and ".scene-tab" not in condition
        return events.count("wait") > 1
    async def click(expression):
        events.append("canvas-menu")
        assert "getClientRects" in expression
        return True
    page = SimpleNamespace(send=send, goto=goto, wait=wait, click=click)
    class Stack:
        async def enter_async_context(self, _context):
            return page
    monkeypatch.setattr(measure, "Page", lambda *_: object())
    asyncio.run(instance.open(Stack(), "a", [{"id": "s"}]))
    assert "ch.activeAccount" in scripts[1] and instance.hub.shared.email.lower() in scripts[1]
    assert instance.bucket in scripts[2] and instance.bucket.startswith("acct:")
    assert events == ["Page.addScriptToEvaluateOnNewDocument"] * 3 + ["goto", "wait", "canvas-menu", "wait"]
    assert instance.report["database"]["owner"] == "me"
    assert instance.report["database"]["account_db_switching"] is False
    assert any("401" in line for line in instance.report["limitations"])


def test_legacy_rename_and_delete_use_scene_bar_title_then_context_menu(tmp_path, monkeypatch):
    import asyncio
    from types import SimpleNamespace
    events = []
    instance = measure.Measurement("rollback", tmp_path)
    async def local(_page):
        return [{"id": "s", "name": "old name"}]
    async def evaluate(_expression):
        return False  # old SceneBar has no data-scene-tab
    async def click(expression, **kwargs):
        events.append(("click", expression, kwargs)); return True
    async def wait(_expression, _timeout):
        return True
    async def key(*args, **_kwargs):
        events.append(("key", args))
    async def type_text(text):
        events.append(("type", text))
    async def wait_local(*_args):
        return []
    page = SimpleNamespace(eval=evaluate, click=click, wait=wait, key=key, type=type_text)
    monkeypatch.setattr(instance, "local", local)
    monkeypatch.setattr(instance, "wait_local", wait_local)
    asyncio.run(instance.rename(page, "new name", "s"))
    assert ".scene-bar button.scene-tab" in events[0][1] and "old name" in events[0][1]
    assert events[0][2]["button"] == "right"
    assert ".scene-ws-menu-name" in events[1][1]
    events.clear()
    asyncio.run(instance.delete(page, "s"))
    assert ".scene-bar button.scene-tab" in events[0][1]
    assert "closest('.scene-tab-wrap')" in events[0][1]


def test_account_scoped_idb_reader_does_not_read_local_bucket():
    key = lambda parts: json.dumps(parts, separators=(",", ":"))
    bucket = "acct:synthetic@localhost.invalid::_none"
    entries = [[key(["o", bucket]), ["a"]], [key(["s", bucket, "a"]), {"id": "a"}],
               [key(["o", measure.BUCKET]), ["legacy"]], [key(["s", measure.BUCKET, "legacy"]), {"id": "legacy"}]]
    assert measure.scene_rows(entries, bucket) == [{"id": "a"}]


@pytest.mark.parametrize("safety", [None, [], "invalid", 1, True])
def test_non_object_isolation_is_rejected_without_throwing(safety):
    evidence = report()
    evidence["isolation"] = safety
    assert verify(evidence)


def test_account_aba_control_restores_the_same_authenticated_a_and_uid(tmp_path):
    import ast
    import asyncio
    import threading
    from types import SimpleNamespace
    state = {"account": "bm-a@localhost.invalid", "uid": "original-uid", "epoch": 10}
    changes = []
    active = SimpleNamespace(transition_lock=threading.RLock(),
        account_key=lambda: state["account"], active_uid=lambda: state["uid"], account_epoch=lambda: state["epoch"])
    def switch(account, uid):
        changes.append((account, uid))
        state.update(account=account, uid=uid, epoch=state["epoch"] + 1)
    # Execute only the isolated route's function with doubles, never backend imports/serve.py.
    route = next(node for node in ast.parse(measure.controlled_launcher(tmp_path, "synthetic-control")).body
                 if isinstance(node, ast.AsyncFunctionDef))
    route.decorator_list = []
    scope = {"Request": object, "HTTPException": RuntimeError, "active_account": active, "_switch_account_db": switch}
    exec(compile(ast.Module(body=[route], type_ignores=[]), "isolated-route-unit", "exec"), scope)
    request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"), headers={"X-Measure-Control": "synthetic-control"})
    result = asyncio.run(scope["account_aba"](request))
    assert changes == [("measure-b@localhost.invalid", "measure-b"), ("bm-a@localhost.invalid", "original-uid")]
    assert result == {"before": 10, "after": 12, "account_before": "bm-a@localhost.invalid",
                      "account_b": "measure-b@localhost.invalid", "account": "bm-a@localhost.invalid"}
    assert state["uid"] == "original-uid"


def test_direct_scene_probes_send_the_same_expected_account_as_seeded_browser(tmp_path, monkeypatch):
    hub = measure.Hub(tmp_path)
    calls = []
    def request(url, path, body, method, headers):
        calls.append((path, dict(headers)))
        return 200, {}
    monkeypatch.setattr(measure, "isolated_request", request)
    hub.request("/api/scenes/notebook")
    hub.request("/api/scenes/backup", {"token": "synthetic", "upserts": []}, "PUT")
    hub.request("/api/shared-server/status")
    assert calls[:2] == [(path, {"X-MVHub-Expect-Account": f"acct:{hub.shared.email.lower()}", "X-MVHub-Canvas-Protocol": "confirm-v1"})
                         for path in ("/api/scenes/notebook", "/api/scenes/backup")]
    assert calls[2][1] == {}


def test_large_korean_seed_fits_legacy_storage_and_opens_a_small_scene(tmp_path, monkeypatch):
    import asyncio
    import re
    from contextlib import AsyncExitStack
    from unittest.mock import AsyncMock
    scripts = []
    class FakePage:
        def __init__(self, *_args): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *_args): pass
        async def send(self, _method, **options): scripts.append(options.get('source', ''))
        async def goto(self, *_args, **_options): pass
    monkeypatch.setattr(measure, 'Page', FakePage)
    instance = measure.Measurement('first_transition', tmp_path)
    instance.ensure_canvas = AsyncMock()
    seeds = measure.fixture()
    seeds[0]['cards'][0]['text'] = '한' * (5 * 1024 * 1024 // 3)
    async def run():
        async with AsyncExitStack() as stack:
            await instance.open(stack, 'a', seeds)
    asyncio.run(run())
    script = next(s for s in scripts if "setItem('ch.scenes'," in s)
    stored = json.loads(re.search(r"setItem\('ch.scenes', (.*)\);", script)[1])
    assert len(stored.encode('utf-16-le')) < 5 * 1024 * 1024
    assert json.loads(stored)[instance.bucket] == seeds
    active = json.loads(json.loads(re.search(r"setItem\('ch.scenes.active', (.*)\);", script)[1]))
    assert active[instance.bucket] == seeds[-1]['id']


@pytest.mark.parametrize('clear', [False, True])
def test_restore_injection_uses_owned_live_server_not_external_sqlite(tmp_path, monkeypatch, clear):
    hub = measure.Hub(tmp_path, controls=True)
    calls = []
    monkeypatch.setattr(hub, 'start', lambda **options: calls.append(('start', options)))
    monkeypatch.setattr(hub, 'stop', lambda: calls.append(('stop',)))
    def request(path, body):
        calls.append((path, body))
        return 200, {'generation': body['generation'], 'cleared': body['clear']}
    monkeypatch.setattr(hub, 'request', request)
    monkeypatch.setattr(measure.sqlite3, 'connect', lambda *_a, **_k: pytest.fail('external SQLite mutation forbidden'))
    hub.restore_fixture('restored-G2', clear=clear)
    assert calls == [('stop',), ('start', {'writer': False}),
        ('/api/__measure/restore-generation', {'generation': 'restored-G2', 'clear': clear}), ('stop',)]


@pytest.mark.parametrize('clear', [False, True])
def test_isolated_restore_route_changes_generation_and_optionally_clears_only_fixture(tmp_path, clear):
    import ast
    import asyncio
    import sqlite3
    import threading
    from contextlib import contextmanager
    from types import SimpleNamespace
    path = tmp_path / 'fixture.db'
    with sqlite3.connect(path) as conn:
        conn.executescript("CREATE TABLE app_setting(key TEXT, value TEXT); INSERT INTO app_setting VALUES('share_db_generation','G1'); CREATE TABLE scene_backup(id TEXT); INSERT INTO scene_backup VALUES('prior');")
    @contextmanager
    def connection():
        conn = sqlite3.connect(path)
        try:
            with conn: yield conn
        finally: conn.close()
    route = next(n for n in ast.parse(measure.controlled_launcher(tmp_path, 'synthetic')).body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'restore_generation')
    route.decorator_list = []
    class Denied(Exception): pass
    scope = {'Request': object, 'HTTPException': Denied, 'active_account': SimpleNamespace(transition_lock=threading.RLock()), 'db': SimpleNamespace(get_connection=connection)}
    exec(compile(ast.Module(body=[route], type_ignores=[]), 'isolated-restore-unit', 'exec'), scope)
    async def body(): return {'generation': 'G2', 'clear': clear}
    request = SimpleNamespace(client=SimpleNamespace(host='127.0.0.1'), headers={'X-Measure-Control': 'synthetic'}, json=body)
    assert asyncio.run(scope['restore_generation'](request)) == {'generation': 'G2', 'cleared': clear}
    with sqlite3.connect(path) as conn:
        assert conn.execute('SELECT value FROM app_setting').fetchone()[0] == 'G2'
        assert conn.execute('SELECT COUNT(*) FROM scene_backup').fetchone()[0] == (0 if clear else 1)
    request.headers = {}
    with pytest.raises(Denied): asyncio.run(scope['restore_generation'](request))


@pytest.mark.parametrize('variant,order', [('same_generation', 'a'), ('held', 'a'), ('held', 'b')])
def test_first_transition_holds_b_until_selection_and_checks_both_confirmation_orders(tmp_path, monkeypatch, variant, order):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock
    instance = measure.Measurement('first_transition', tmp_path)
    instance.transition_args = SimpleNamespace(old_checkout=tmp_path, transition=variant, start_order=order, transition_fault='none')
    seeds = measure.fixture()
    pages = {name: SimpleNamespace(goto=AsyncMock(), wait=AsyncMock(return_value=True), send=AsyncMock(), mirror_hold_script='hold') for name in ('a', 'b')}
    class Selected(Exception): pass
    async def choose(_selector): raise Selected()
    pages['a'].click = choose
    pages['b'].click = choose
    original_b = [{**seeds[-1], 'id': 'prior-b'}]
    async def evaluate(name, script):
        if script == measure.READ_STORE:
            return [(json.dumps(['nr', instance.account], separators=(',', ':')), [{'scenes': {instance.bucket: original_b}}])] if variant == 'held' and name == 'b' and pages['b'].goto.await_count >= 2 else []
        if script == 'window.__measureNetwork': return []
        return json.dumps({'generation': 'G1', 'blockedIds': ['prior-b'] if name == 'b' else []})
    for name, page in pages.items():
        async def run_eval(script, n=name): return await evaluate(n, script)
        page.eval = run_eval
    instance.open = AsyncMock(side_effect=lambda _stack, name, *_a, **_k: pages[name])
    instance.wait_local = AsyncMock(); instance.rename = AsyncMock(); instance.ensure_canvas = AsyncMock()
    async def local(page):
        return seeds if page is pages['a'] or (variant == 'held' and pages['b'].goto.await_count >= 2) else original_b
    instance.local = local
    instance.hub.start = Mock(); instance.hub.stop = Mock()
    instance.hub.restore_fixture = Mock()
    def request(path, *_args):
        if path == '/api/auth/config': return 200, {'features': ['scene_writer_confirm_v1']}
        return 200, {'restore_generation': 'G1', 'notebook_id': None, 'items': [{'data': json.dumps(s)} for s in seeds]}
    instance.hub.request = request
    monkeypatch.setattr(measure, 'validate_checkout', lambda _p: tmp_path)
    with pytest.raises(Selected): asyncio.run(instance.first_transition(None, seeds))
    b_call = next(call for call in instance.open.call_args_list if call.args[1] == 'b')
    assert b_call.args[2][0]['cards'] == seeds[-1]['cards']
    if variant == 'same_generation': pages['b'].goto.assert_not_awaited()
    else:
        assert instance.report['checks']['held_first']['actual'] == ['b', 'a']
        assert instance.report['checks']['held_archive_before_confirmation']['status'] == 'passed'
    assert instance.report['checks']['before_confirmation']['status'] == 'passed'
    assert instance.report['checks']['no_upload_before']['status'] == 'passed'
