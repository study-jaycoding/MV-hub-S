"""Synthetic AB contract tests. No browser, hub, or retained scene is opened."""
import itertools
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from browser_measure import camera_ab_check as ab
from browser_measure import camera_original as camera
from test_camera_original import original, retained_home  # retained scripts only


def spec():
    return {"format": ab.FORMAT, "sources": {"src_o": "a" * 40, "src_n": "b" * 40},
            "d_commit": "c" * 40, "source_diff_sha256": ab.digest(b"approved patch"),
            "rounds": dict(ab.ROUNDS), "order": "original-alternating-v1", "criteria": dict(ab.LIMITS)}


def git_source(*args):
    if args[0] == "rev-parse":
        return args[-1].split("^")[0].encode()
    if args[0] == "rev-list":
        return ("b" * 40 + " " + "a" * 40).encode()
    if args[0] == "merge-base":
        return b""
    if args[0] == "diff":
        if "--raw" in args:
            return b"".join((f":100644 100644 {'1' * 40} {'2' * 40} M\0{p}\0").encode() for p in ab.PRODUCTS)
        return b"approved patch"
    if args[0] == "show":
        return args[1].split(":", 1)[1].encode()
    raise AssertionError(args)


def phase(gpu="gpu", lock=None):
    return {"gpu": gpu, "lock": lock}


def sample(row):
    p = phase("gpu" if row["flag"] == "1" else "dom")
    if row["mode"] == "bake":
        measurement = {"pending_before": 30, "bakes": int(row["src"] == "src_o"), "bakes_after": 1,
                       "gaps33": 0, "bake_calls": 2, "cam_commits_in_window": 0,
                       "first_input_delay": 0, "window_ms": 100, "end": dict(p)}
    elif row["mode"] == "ops":
        measurement = {"start": dict(p), "end": dict(p), "ops": {op: {
            "gaps33": 0, "bakes": 0, "bake_calls": 2, "cam_commits": 0, "first_input_delay": 0,
            "window_ms": 100, "idb": {"n": 0, "ms": 0}, "flush": {"n": 0, "ms": 0}} for op in ab.OPS}}
    else:
        measurement = {"phase": dict(p), "after_switch_2s_gaps33": 0, "idb": []}
    return {"row": dict(row), "status": "measured", "measurement": measurement,
            "evidence": {"stored_cards": [412, 412] if row["mode"] == "switch" else [2060],
                         "observations": {"raf": 1, "loafSupported": True, "loafError": False,
                                          "draw": int(row["flag"]), "tick": 2, "cam": 0, "flush": 0, "blockedWS": 0},
                         "phase": p, "renderer": "Synthetic hardware", "runtime_errors": 0,
                         "static_errors": 0, "requests": {"owned": 1, "disabled-background": 1},
                         "browser_version": {k: "fixed" for k in ("product", "revision", "jsVersion", "protocolVersion")}},
            "versions": {k: "fixed" for k in ("python", "PIL", "websockets")}, "jpeg_hashes": ["d" * 64] * 32}


def rows():
    return [sample(r) for r in ab.order()]


def job():
    return {"status": "exited", "exit_code": 0, "active_after": 0, "cleanup_errors": []}


def write_series(work, folder, records):
    dest = work / folder
    dest.mkdir()
    aggregates = {}
    for i, record in enumerate(records):
        camera.save(dest / f"row-{i:03}.json", record)
        camera.save(dest / f"row-{i:03}.job.json", job())
        r = record["row"]
        aggregates.setdefault(r["tag"], {}).setdefault(r["key"], []).append(record["measurement"])
    for tag, values in aggregates.items():
        camera.save(dest / f"rd_{tag}.json", values)


def rewrite(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def test_fixed_order_matches_retained_loops(original):
    old = camera.schedule(original)
    assert len(old) == 65 and old[20]["src"] == "src_pred"
    expected = [{**r, "src": r["src"].replace("src_pred", "src_o"),
                 "key": r["key"].replace("src_pred", "src_o"), "tag": r["mode"] + "10"}
                for r in camera.schedule(original, 10) if r["mode"] != "judge"]
    order = ab.order()
    assert order == expected and len(order) == 120
    pilot = [r for r in order if r["round"] == 1]
    assert len(pilot) == 12
    assert [r["mode"] for r in pilot] == ["bake"] * 2 + ["ops"] * 2 + ["switch"] * 8
    for mode in ab.ROUNDS:
        for round_ in range(1, 11):
            group = [r for r in order if r["mode"] == mode and r["round"] == round_]
            srcs = [s for s, _ in itertools.groupby(r["src"] for r in group)]
            assert srcs == (["src_o", "src_n"] if round_ % 2 else ["src_n", "src_o"])


@pytest.mark.parametrize("mutation", ["extra", "missing", "third", "short-sha", "round", "bool", "float", "alpha", "order", "hash"])
def test_spec_rejects_changed_contract(mutation):
    s = spec()
    if mutation == "extra": s["optional"] = 1
    elif mutation == "missing": del s["criteria"]
    elif mutation == "third": s["sources"]["src_q"] = "d" * 40
    elif mutation == "short-sha": s["d_commit"] = "abcdef"
    elif mutation == "round": s["rounds"]["ops"] = 11
    elif mutation == "bool": s["criteria"]["lock_max_delta"] = True
    elif mutation == "float": s["rounds"]["ops"] = 10.0
    elif mutation == "alpha": s["criteria"]["alpha"] = 0.1
    elif mutation == "order": s["order"] = "shuffle"
    elif mutation == "hash": s["source_diff_sha256"] = "bad"
    with pytest.raises(ValueError): ab.spec_check(s)


@pytest.mark.parametrize("raw", ['{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}', '{"x":-Infinity}'])
def test_json_boundary_rejects_ambiguous_numbers_and_keys(raw):
    with pytest.raises(ValueError): ab.loads(raw)


def test_sources_are_checked_against_exact_patch_and_five_helpers():
    evidence = ab.source_check(spec(), git_source)
    assert evidence["diff"] == spec()["source_diff_sha256"]
    assert set(evidence["helpers"]) == set(ab.HELPERS)


@pytest.mark.parametrize("failure", ["parent", "merge", "ancestor", "not-commit", "other-file", "added", "deleted", "mode", "rename", "extra-file", "patch", "helper"])
def test_source_rejections(failure):
    def git(*args):
        value = git_source(*args)
        if args[0] == "rev-list" and failure in ("parent", "merge"):
            return value.replace(b"a", b"d") if failure == "parent" else value + b" " + b"e" * 40
        if args[0] == "merge-base" and failure == "ancestor": raise ValueError("not ancestor")
        if args[0] == "rev-parse" and failure == "not-commit": return b"wrong"
        if args[0] == "diff" and "--raw" in args:
            if failure == "other-file": return value.replace(ab.PRODUCTS[0].encode(), b"outside.py")
            if failure == "added": return value.replace(b":100644", b":000000", 1).replace(b" M\0", b" A\0", 1)
            if failure == "deleted": return value.replace(b" M\0", b" D\0", 1)
            if failure == "mode": return value.replace(b":100644 100644", b":100644 100755", 1)
            if failure == "rename": return value.replace(b" M\0", b" R100\0", 1)
            if failure == "extra-file": return value + value.split(b"\0", 2)[0] + b"\0fourth\0"
        if args[0] == "diff" and "--binary" in args and failure == "patch": return b"unauthorized inside allowed file"
        if args[0] == "show" and args[1].startswith("b" * 40) and failure == "helper": return b"changed"
        return value
    with pytest.raises(ValueError): ab.source_check(spec(), git)


def test_permutation_ties_and_ten_positive_differences():
    tied = ab.metric([3] * 10, [3] * 10, 20)
    assert tied["hits"] == 1024 and tied["p_bad"] == 1 and tied["passed"]
    bad = ab.metric([3] * 10, [4] * 10, 20)
    assert bad["hits"] == 1 and bad["p_bad"] == 1 / 1024 and not bad["passed"]


@pytest.mark.parametrize("negative,hits,passed", [(50, 51, False), (51, 52, True)])
def test_exact_hit_boundary(negative, hits, passed):
    d = [-(1 << i) if negative & (1 << i) else 1 << i for i in range(10)]
    result = ab.metric([1024] * 10, [1024 + x for x in d], 2000)
    assert (result["hits"], result["passed"]) == (hits, passed)


@pytest.mark.parametrize("margin,delta,passed", [(20, 20, True), (20, 21, False), (15, 15, True), (15, 16, False)])
def test_total_delta_boundary(margin, delta, passed):
    base = [100] * 10
    target = [0, 200, 100 + delta] + [100] * 7
    result = ab.metric(base, target, margin)
    assert result["hits"] >= 52 and result["delta"] == delta and result["passed"] == passed


@pytest.mark.parametrize("b,t,passed", [(0, 0, True), (0, 1, True), (0, 2, False), (1, 2, True), (2, 2, True), (2, 3, False)])
@pytest.mark.parametrize("mode,rate", [("bake", 4), ("ops", 4), ("switch", 1), ("switch", 4)])
def test_lock_rows_count_once_in_each_gate(b, t, passed, mode, rate):
    records = rows()
    for r in records:
        key = r["row"]
        if key["mode"] == mode and key["flag"] == "1" and key["rate"] == rate and key["round"] <= (b if key["src"] == "src_o" else t):
            r["evidence"]["phase"]["lock"] = "slow"
            for field in ("start", "end", "phase"):
                if field in r["measurement"]: r["measurement"][field]["lock"] = "slow"
    result = ab.judge(records)["locks"][f"{mode}|gpu1|x{rate}"]
    assert (result["B"], result["T"], result["passed"]) == (b, t, passed)


def test_locked_rows_stay_in_totals_and_rounds_pair_across_order():
    records = rows()
    for r in records:
        key, m = r["row"], r["measurement"]
        if key["mode"] == "ops":
            m["ops"]["low_out"]["gaps33"] = key["round"] + (10 if key["src"] == "src_n" else 0)
            if key["round"] == 2: m["start"]["lock"] = "slow"
        if key["mode"] == "switch":
            m["after_switch_2s_gaps33"] = key["round"]
    result = ab.judge(records)
    assert result["metrics"]["ops"]["B"] == list(range(1, 11))
    assert result["metrics"]["ops"]["T"] == list(range(11, 21))
    assert result["metrics"]["ops"]["T_total"] == 155
    assert result["metrics"]["switch"]["B"] == [4 * r for r in range(1, 11)]


@pytest.mark.parametrize("failure", ["baseline", "median", "pending", "bakes", "resume"])
def test_bake_preconditions_and_candidate_gate(failure):
    records = rows()
    base = [r for r in records if r["row"]["mode"] == "bake" and r["row"]["src"] == "src_o"]
    candidate = next(r for r in records if r["row"]["mode"] == "bake" and r["row"]["src"] == "src_n")
    if failure in ("baseline", "median"):
        for r in base[:10 if failure == "baseline" else 5]: r["measurement"]["bakes"] = 0
    elif failure == "pending": candidate["measurement"]["pending_before"] = 0
    elif failure == "bakes": candidate["measurement"]["bakes"] = 1
    else: candidate["measurement"]["bakes_after"] = 0
    if failure in ("baseline", "pending"):
        with pytest.raises(ValueError): ab.judge(records)
    else:
        assert ab.judge(records)["status"] == ("passed" if failure == "median" else "not-passed")


@pytest.mark.parametrize("value", [True, False, -1, 1.0, float("nan"), float("inf"), "1", None])
def test_bad_counts_rejected(value):
    records = rows()
    records[20]["measurement"]["ops"]["low_out"]["gaps33"] = value
    with pytest.raises(ValueError): ab.judge(records)


@pytest.mark.parametrize("failure", ["119", "duplicate", "key", "round", "missing", "phase", "gpu0lock", "gpu-missing", "gpu-exit", "software", "version", "browser", "cards", "float-cards", "raf", "loaf", "http", "ws", "runtime"])
def test_incomplete_rows_and_evidence(failure):
    records = rows()
    r = records[20]
    if failure == "119": records.pop()
    elif failure == "duplicate": records[1] = records[0]
    elif failure == "key": r["row"]["key"] = "wrong"
    elif failure == "round": r["row"]["round"] = True
    elif failure == "missing": del r["measurement"]["ops"]["low_out"]["gaps33"]
    elif failure == "phase": del r["measurement"]["start"]
    elif failure == "gpu0lock": records[40]["evidence"]["phase"]["lock"] = "slow"
    elif failure == "gpu-missing": r["evidence"]["observations"]["draw"] = 0
    elif failure == "gpu-exit": r["measurement"]["end"]["gpu"] = "dom"
    elif failure == "software": r["evidence"]["renderer"] = "ANGLE SwiftShader"
    elif failure == "version": r["versions"]["python"] = "changed"
    elif failure == "browser": r["evidence"]["browser_version"]["revision"] = "changed"
    elif failure == "cards": r["evidence"]["stored_cards"] = [2000]
    elif failure == "float-cards": r["evidence"]["stored_cards"] = [2060.0]
    elif failure == "raf": r["evidence"]["observations"]["raf"] = 0
    elif failure == "loaf": r["evidence"]["observations"]["loafError"] = True
    elif failure == "http": r["evidence"]["requests"]["blocked-api"] = 1
    elif failure == "ws": r["evidence"]["observations"]["blockedWS"] = 1
    elif failure == "runtime": r["evidence"]["runtime_errors"] = 1
    with pytest.raises((ValueError, KeyError)): ab.judge(records)


def test_complete_contract_output_and_low_out_note():
    result = ab.judge(rows())
    assert result["status"] == "passed" and result["reasons"] == []
    assert "historical signal not exercised" in result["notes"][1]
    assert result["supplemental"]["src_o|ops"]["low_out"]["gaps33"] == {"values": [0] * 10, "total": 0, "median": 0}
    assert result["supplemental"]["src_o|ops"]["low_out"]["flush"]["ms"]["median"] == 0
    assert result["supplemental"]["src_n|bake"]["first_input_delay"]["total"] == 0
    assert result["bake"]["baseline_median"] == 1


def test_absent_dom_gpu_attribute_is_valid_but_missing_phase_field_is_not():
    records = rows()
    for record in records:
        if record["row"]["flag"] == "0":
            record["evidence"]["phase"]["gpu"] = None
            record["measurement"]["phase"]["gpu"] = None
    # SceneBoard omits data-gpu when GPU is disabled or after a lock.
    records[1]["evidence"]["phase"] = phase(None, "slow")
    records[1]["measurement"]["end"] = phase(None, "slow")
    assert ab.judge(records)["status"] == "passed"
    del records[40]["measurement"]["phase"]["gpu"]
    with pytest.raises(ValueError): ab.judge(records)


@pytest.mark.parametrize("failure", [None, "aggregate", "job", "active", "cleanup", "missing-job", "extra-row"])
def test_raw_series_audit(tmp_path, failure):
    write_series(tmp_path, "measurement", rows())
    dest = tmp_path / "measurement"
    if failure == "aggregate": rewrite(dest / "rd_ops10.json", {})
    elif failure in ("job", "active", "cleanup"):
        value = job()
        value[{"job": "exit_code", "active": "active_after", "cleanup": "cleanup_errors"}[failure]] = ["close failed"] if failure == "cleanup" else 1
        rewrite(dest / "row-001.job.json", value)
    elif failure == "missing-job": (dest / "row-001.job.json").rename(dest / "missing.json")
    elif failure == "extra-row": camera.save(dest / "row-120.json", rows()[0])
    if failure:
        with pytest.raises(ValueError): ab.read_series(tmp_path, "measurement", ab.order())
    else:
        actual, environment, hashes = ab.read_series(tmp_path, "measurement", ab.order())
        assert actual == rows() and environment["renderer"] == "Synthetic hardware" and len(hashes) == 243


@pytest.fixture
def prepared(tmp_path, monkeypatch, original):
    home = tmp_path / "retained"
    home.mkdir()
    run = home / "run-ab-synthetic"
    experiment = tmp_path / "experiment.json"
    rewrite(experiment, spec())
    inputs = {name: b"synthetic" for name in camera.INPUTS}
    inputs.update({"measure/scene.json": b'{"cards":[]}', "measure/scene_2000.json": b'{"cards":[]}',
                   "measure/risk_diag.py": original.encode(), "anchor/anchor_measure.py": b'SRC = HERE / "src"'})
    monkeypatch.setattr(camera, "HOME", home)
    monkeypatch.setattr(camera, "read_inputs", lambda selected: inputs if selected == home else pytest.fail("wrong home"))
    monkeypatch.setattr(camera, "git", lambda *args: b"archive" if args[0] == "archive" else git_source(*args))
    patches = [(f"p{i}", ab.PRODUCTS[i % 3], 1, f"before{i}", f"after{i}") for i in range(8)]
    monkeypatch.setattr(camera, "patch_definitions", lambda text: patches)
    keys = ("CONTENT_HUB_AGENT_CHAT", "CONTENT_HUB_AGENT_CHAT_DIR", "CONTENT_HUB_DATA", "CONTENT_HUB_DB",
            "CONTENT_HUB_SHARED_URL", "CONTENT_HUB_NO_PROXY", "CONTENT_HUB_SERVER_SYNC")
    def archive(_data, root):
        root.mkdir()
        for rel in ab.PRODUCTS:
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(p[3] for p in patches if p[1] == rel))
        path = root / "backend/app/main.py"
        path.parent.mkdir(parents=True)
        path.write_text("            resolve_selection_monitor.start()\n" + "\n".join(keys))
    monkeypatch.setattr(camera, "extract_archive", archive)
    monkeypatch.setattr(camera, "package_links", lambda *a: {"vite": "fixed"})
    def build(_command, **kw):
        dest = kw["cwd"] / "dist"
        dest.mkdir()
        (dest / "fake.js").write_text("synthetic")
    monkeypatch.setattr(camera.subprocess, "run", build)
    camera.prepare(run, home, experiment)
    return run


def test_prepare_freezes_contract_inputs_order_tools_and_observations(prepared):
    meta = camera.validate(prepared)
    assert meta["format"] == ab.FORMAT and meta["sources"] == spec()["sources"]
    assert meta["contract"] == ab.CONTRACT and meta["experiment_sha256"] == ab.digest(ab.canonical(spec()))
    assert set(meta["source_hashes"]) == {"src_o", "src_n"}
    assert len(meta["patches"]) == 6 and ab.read(prepared / "order.json") == ab.order()
    for rel in ab.PRODUCTS:
        assert (prepared / "measure/src_o" / rel).read_bytes() == (prepared / "measure/src_n" / rel).read_bytes()
        assert b"before" not in (prepared / "measure/src_o" / rel).read_bytes()
    assert not (prepared / "measure/build_r2diag.py").exists()
    assert not (prepared / "measure/src_pred").exists()


@pytest.mark.parametrize("changed", ["experiment", "order", "tool", "checker", "contract", "source", "input", "escape"])
def test_manifest_drift_rejected(prepared, changed):
    meta = ab.read(prepared / "manifest.json")
    if changed == "experiment": (prepared / "experiment.json").write_text(json.dumps(spec(), indent=4))
    elif changed == "order": rewrite(prepared / "order.json", ab.order()[::-1])
    elif changed == "tool": meta["reviewed_tools"]["camera_original.py"] = "0" * 64
    elif changed == "checker": meta["reviewed_tools"]["camera_ab_check.py"] = "0" * 64
    elif changed == "contract": meta["contract"] = "0" * 64
    elif changed == "source": (prepared / "measure/src_o" / ab.PRODUCTS[0]).write_text("drift")
    elif changed == "input": (prepared / "measure/scene.json").write_text("synthetic changed")
    else: meta["files"]["../../experiment.json"] = ab.digest((prepared.parent.parent / "experiment.json").read_bytes())
    rewrite(prepared / "manifest.json", meta)
    with pytest.raises(ValueError): camera.validate(prepared)


@pytest.mark.parametrize("target", ["outside", "nested", "reuse", "prefix"])
def test_prepare_rejects_paths_before_reading_inputs(tmp_path, monkeypatch, target):
    home = tmp_path / "home"
    home.mkdir()
    work = {"outside": tmp_path / "run-ab-outside", "nested": home / "nested/run-ab-child",
            "reuse": home / "run-ab-used", "prefix": home / "run-original"}[target]
    if target == "reuse": work.mkdir()
    monkeypatch.setattr(camera, "read_inputs", lambda *a: pytest.fail("inputs must not be opened"))
    with pytest.raises((ValueError, FileExistsError)):
        camera.prepare(work, home, tmp_path / "unused-spec.json")


@pytest.mark.parametrize("action", ["prepare", "pilot", "measure", "worker", "smoke", "smoke-worker"])
def test_all_camera_cli_stages_require_home(tmp_path, monkeypatch, action):
    monkeypatch.setattr(sys, "argv", ["camera_original", action, "--run", str(tmp_path)])
    with pytest.raises(SystemExit) as exc: camera.main()
    assert exc.value.code == 2


def test_cli_prepare_uses_selected_home_not_module_default(tmp_path, monkeypatch):
    home = tmp_path / "correct"
    home.mkdir()
    monkeypatch.setattr(camera, "HOME", tmp_path / "wrong")
    run, experiment = home / "run-ab-synthetic", tmp_path / "spec.json"
    observed = []
    monkeypatch.setattr(camera, "prepare", lambda *args: observed.append(args))
    monkeypatch.setattr(sys, "argv", ["camera_original", "prepare", "--home", str(home), "--run", str(run), "--experiment", str(experiment)])
    camera.main()
    assert observed == [(run, home, experiment)] and camera.HOME == home


@pytest.mark.parametrize("action", ["pilot", "measure", "worker", "smoke-worker"])
def test_cli_rejects_escape_before_dispatch(tmp_path, monkeypatch, action):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(camera, "HOME", home)
    monkeypatch.setenv("CAMERA_ORIGINAL_WORKER", "1")
    monkeypatch.setattr(sys, "argv", ["camera_original", action, "--home", str(home), "--run", str(tmp_path / "run-ab-escape"), "--row", "normal"])
    with pytest.raises(ValueError): camera.main()


def test_internal_workers_need_owned_supervisor(tmp_path, monkeypatch):
    monkeypatch.delenv("CAMERA_ORIGINAL_WORKER", raising=False)
    monkeypatch.setattr(sys, "argv", ["camera_original", "worker", "--home", str(tmp_path), "--run", str(tmp_path / "run-ab-synthetic")])
    with pytest.raises(ValueError, match="owned Job"): camera.main()


def test_prepared_home_cannot_be_replaced_by_cli_home(prepared, tmp_path, monkeypatch):
    monkeypatch.setattr(camera, "HOME", tmp_path)
    with pytest.raises(ValueError, match="CLI home"):
        camera.series(prepared, True)
    assert not (prepared / "safety-smoke").exists()


def test_prepare_method_default_is_not_bound_to_old_home(tmp_path, monkeypatch):
    monkeypatch.setattr(camera, "HOME", tmp_path)
    run = tmp_path / "run-original-synthetic"
    def reached(home):
        assert home == tmp_path
        raise RuntimeError("synthetic boundary before any input")
    monkeypatch.setattr(camera, "read_inputs", reached)
    with pytest.raises(RuntimeError, match="synthetic boundary"):
        camera.prepare(run)


def test_smoke_forwards_explicit_home_without_starting_processes(tmp_path, monkeypatch):
    home = tmp_path
    run = home / "run-ab-synthetic"
    run.mkdir()
    monkeypatch.setattr(camera, "HOME", home)
    commands = []
    def owned(command, logfile, _timeout):
        commands.append(command)
        assert command[command.index("--home") + 1] == str(home)
        behavior = command[-1]
        camera.save(logfile.parent / "smoke.json", {"canary_hits": 0, "checks": {"synthetic": True}})
        return {**job(), "status": "timeout" if behavior == "timeout" else "exited",
                "exit_code": 2 if behavior == "error" else 0}
    monkeypatch.setattr(camera, "run_owned", owned)
    camera.smoke(run / "safety-smoke")
    assert len(commands) == 3
    with pytest.raises(FileExistsError): camera.smoke(run / "safety-smoke")
    with pytest.raises(ValueError): camera.smoke(tmp_path.parent / "run-ab-outside")


@pytest.mark.parametrize("performance_failure", [False, True])
def test_pilot_and_measure_forward_home_and_keep_all_120_rows(prepared, monkeypatch, performance_failure):
    commands = []
    monkeypatch.setattr(camera, "smoke", lambda path: None)
    monkeypatch.setattr(ab, "check_smoke", lambda *args: {})
    def owned(command, logfile, _timeout, _root):
        commands.append(command)
        assert command[command.index("--home") + 1] == str(prepared.parent)
        row = json.loads(command[command.index("--row") + 1])
        result = sample(row)
        if performance_failure and row["mode"] == "bake" and row["src"] == "src_n":
            result["measurement"]["bakes"] = 1
        camera.save(Path(command[-1]), result)
        camera.save(logfile.with_suffix(".job.json"), job())
        return job()
    monkeypatch.setattr(camera, "run_owned", owned)
    monkeypatch.setattr(camera, "finish_ab", lambda *a: None)
    camera.series(prepared, True)
    assert ab.read(prepared / "pilot/complete.json") == {"status": "ready", "rows": 12}
    camera.series(prepared, False)
    assert len(commands) == 132
    measured, _, _ = ab.read_series(prepared, "measurement", ab.order())
    assert ab.judge(measured)["status"] == ("not-passed" if performance_failure else "passed")
    with pytest.raises(FileExistsError): camera.series(prepared, False)


@pytest.fixture
def measured(prepared):
    root = prepared / "safety-smoke"
    root.mkdir()
    meta = camera.validate(prepared)
    camera.save(root / "complete.json", {"status": "passed", "cases": ["normal", "error", "timeout"], "tool": meta["tool"]})
    for behavior in ("normal", "error", "timeout"):
        dest = root / behavior
        dest.mkdir()
        camera.save(dest / "smoke.json", {"canary_hits": 0, "static_errors": 0,
                                         "checks": dict.fromkeys(ab.SMOKE_CHECKS, True)})
        camera.save(dest / "worker.job.json", {**job(), "status": "timeout" if behavior == "timeout" else "exited",
                                              "exit_code": 2 if behavior == "error" else 0})
    write_series(prepared, "pilot", [sample(r) for r in ab.order() if r["round"] == 1])
    camera.save(prepared / "pilot/complete.json", {"status": "ready", "rows": 12})
    write_series(prepared, "measurement", rows())
    return prepared


@pytest.mark.parametrize("bake_failure", [False, True])
def test_checker_audits_complete_synthetic_experiment(measured, capsys, bake_failure):
    if bake_failure:
        record = ab.read(measured / "measurement/row-001.json")
        record["measurement"]["bakes_after"] = 0
        rewrite(measured / "measurement/row-001.json", record)
        aggregate = ab.read(measured / "measurement/rd_bake10.json")
        aggregate[record["row"]["key"]][0] = record["measurement"]
        rewrite(measured / "measurement/rd_bake10.json", aggregate)
    assert ab.main(["--run", str(measured)]) == int(bake_failure)
    result = ab.read(measured / "measurement/ab-verdict.json")
    assert set(result) == {"format", "experiment_sha256", "sources", "status", "metrics", "locks", "bake", "supplemental", "reasons", "notes", "evidence"}
    assert result["status"] == ("not-passed" if bake_failure else "passed") and len(result["evidence"]) > 270
    assert capsys.readouterr().out
    with pytest.raises(FileExistsError): ab.main(["--run", str(measured)])


@pytest.mark.parametrize("failure", ["job", "cleanup", "pilot", "smoke", "exception"])
def test_checker_incomplete_returns_two_and_never_complete(measured, monkeypatch, failure):
    if failure == "job": rewrite(measured / "measurement/row-000.job.json", {**job(), "exit_code": 1})
    elif failure == "cleanup": rewrite(measured / "measurement/row-000.job.json", {**job(), "cleanup_errors": ["close"]})
    elif failure == "pilot": rewrite(measured / "pilot/complete.json", {"status": "ready", "rows": 11})
    elif failure == "smoke": rewrite(measured / "safety-smoke/normal/smoke.json", {"canary_hits": 1, "checks": {"synthetic": True}})
    else: monkeypatch.setattr(ab, "check", lambda *a: (_ for _ in ()).throw(RuntimeError("synthetic unexpected")))
    assert ab.main(["--run", str(measured)]) == 2
    assert ab.read(measured / "measurement/ab-verdict.json")["status"] == "incomplete"
    assert not (measured / "measurement/complete.json").exists()


@pytest.mark.parametrize("failure", [None, "not-passed", "mismatch", "exception", "incomplete", "cleanup", "tampered"])
def test_runner_requires_consistent_checker_result(measured, monkeypatch, failure):
    if failure == "not-passed":
        records = rows()
        records[1]["measurement"]["bakes"] = 1
        rewrite(measured / "measurement/row-001.json", records[1])
        aggregate = ab.read(measured / "measurement/rd_bake10.json")
        aggregate[records[1]["row"]["key"]][0] = records[1]["measurement"]
        rewrite(measured / "measurement/rd_bake10.json", aggregate)
    def owned(*args):
        result = ab.check(measured)
        code = ab.EXIT_CODES[result["status"]]
        if failure == "exception": raise RuntimeError("synthetic checker crash")
        if failure == "incomplete": result, code = {"format": ab.FORMAT, "status": "incomplete"}, 2
        if failure == "tampered": result["metrics"]["ops"]["T_total"] = 999
        camera.save(measured / "measurement/ab-verdict.json", result)
        return {**job(), "exit_code": 1 if failure == "mismatch" else code,
                "cleanup_errors": ["close"] if failure == "cleanup" else []}
    monkeypatch.setattr(camera, "run_owned", owned)
    meta = camera.validate(measured)
    if failure in ("not-passed", "incomplete"):
        with pytest.raises(SystemExit) as exc: camera.finish_ab(measured, meta)
        assert exc.value.code == (1 if failure == "not-passed" else 2)
    elif failure:
        with pytest.raises(RuntimeError): camera.finish_ab(measured, meta)
    else: camera.finish_ab(measured, meta)
    complete = measured / "measurement/complete.json"
    assert complete.exists() == (failure in (None, "not-passed"))
