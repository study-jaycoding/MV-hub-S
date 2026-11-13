"""Synthetic contracts only: no retained scene preparation or performance run."""
import ast
import asyncio
import io
import json
from pathlib import Path
import sys
import tarfile
import types

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from browser_measure import camera_original as camera


@pytest.fixture
def original():
    data = (camera.HOME / "measure/risk_diag.py").read_bytes()
    assert camera.sha(data) == camera.INPUTS["measure/risk_diag.py"]
    return data.decode("utf-8")


def test_original_functions_preserved_and_no_main_side_effect(original):
    safe = camera.safe_risk_source(original)
    before, after = ast.parse(original), ast.parse(safe)
    names = ("ops", "switch", "judge", "bake", "open_page", "wait_gpu", "overlap", "gesture")
    for name in names:
        a = next(n for n in before.body if getattr(n, "name", None) == name)
        b = next(n for n in after.body if getattr(n, "name", None) == name)
        assert ast.dump(a) == ast.dump(b)
    assert "Stop-Process" not in safe
    assert "asyncio.run(main())" not in safe
    with pytest.raises(ValueError):
        camera.safe_risk_source(original.replace("asyncio.run(main())", "asyncio.run(ops())"))


def test_original_65_order_and_alternating_source_sequence(original):
    rows = camera.schedule(original)
    assert len(rows) == 65
    assert [r["mode"] for r in rows] == ["bake"] * 10 + ["ops"] * 10 + ["switch"] * 40 + ["judge"] * 5
    assert [r["src"] for r in rows[:6]] == ["src_o", "src_n", "src_n", "src_o", "src_o", "src_n"]
    assert [(r["flag"], r["rate"]) for r in rows[20:24]] == [("0", 1), ("0", 4), ("1", 1), ("1", 4)]
    with pytest.raises(ValueError):
        camera.schedule(original.replace("list(reversed(SRCS))", "SRCS"))


def test_actual_observation_definitions_apply_and_reverse_all_three_fixed_sources():
    builder = (camera.HOME / "measure/build_r2diag.py").read_bytes()
    assert camera.sha(builder) == camera.INPUTS["measure/build_r2diag.py"]
    patches = camera.patch_definitions(builder.decode("utf-8"))
    for name, revision in camera.SOURCES.items():
        selected = patches[:1] if name == "src_pred" else patches
        for rel in dict.fromkeys(p[1] for p in selected):
            source = camera.git("show", f"{revision}:{rel}").decode("utf-8").replace("\r\n", "\n")
            result = camera.apply_observations(source, [p for p in selected if p[1] == rel])
            assert result != source
            if name == "src_pred":
                assert result.count("__gd?.draw.push") == 2
                assert camera.sha(result.encode()) == "65d58c786d4cb4143620a3090455fcbc574f52d992a1b58fb533646c635e7510"


def test_builder_calls_cannot_run():
    with pytest.raises(ValueError, match="nonconstant"):
        camera.patch_definitions("P = __import__('os').getcwd()")
    with pytest.raises(ValueError, match="anchor"):
        camera.apply_observations("one one", [("test", "f", 1, "one", "two")])


@pytest.mark.parametrize("name,kind", [("../outside", "file"), ("/absolute", "file"),
                                        ("link", "sym"), ("hard", "hard"), ("pipe", "fifo")])
def test_archive_rejects_paths_and_links(tmp_path, name, kind):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as archive:
        member = tarfile.TarInfo(name)
        member.type = {"sym": tarfile.SYMTYPE, "hard": tarfile.LNKTYPE, "fifo": tarfile.FIFOTYPE}.get(kind, tarfile.REGTYPE)
        member.linkname = "outside"
        archive.addfile(member)
    with pytest.raises(ValueError):
        camera.extract_archive(buf.getvalue(), tmp_path / "snapshot")
    assert not (tmp_path / "outside").exists()


def test_archive_valid_and_existing_destination_not_overwritten(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as archive:
        member = tarfile.TarInfo("folder/source.py")
        member.size = 4
        archive.addfile(member, io.BytesIO(b"pass"))
    destination = tmp_path / "snapshot"
    camera.extract_archive(buf.getvalue(), destination)
    assert (destination / "folder/source.py").read_bytes() == b"pass"
    with pytest.raises(FileExistsError):
        camera.extract_archive(buf.getvalue(), destination)


def test_env_drops_parent_configuration_and_preserves_system_paths():
    keys = ("content_hub_db", "RD_N", "REAL_IMAGES", "PAN_CHECKOUT", "https_proxy", "PYTHONPATH", "NODE_OPTIONS")
    assert camera.clean_env({**dict.fromkeys(keys, "not-used"), "PATH": "system", "SystemRoot": "windows"}) == {
        "PATH": "system", "SystemRoot": "windows"}


@pytest.mark.parametrize("url,method,expected", [
    ("https://outside.invalid/api/assets/thumb/x", "GET", "fake-media"),
    ("https://outside.invalid/api/assets/locate", "POST", "fake-media"),
    ("https://outside.invalid/prefix/api/assets/file/x", "GET", "fake-media"),
    ("https://outside.invalid/item?image=/api/assets/thumb/x", "GET", "fake-media"),
    ("https://outside.invalid/item?lookup=/api/assets/locate", "POST", "fake-media"),
    ("ftp://outside.invalid/item?image=/api/assets/thumb/x", "GET", "blocked-origin"),
    ("http://127.0.0.1:8010/media/x", "GET", "fake-media"),
    ("https://outside.invalid/private", "GET", "blocked-origin"),
    ("http://127.0.0.1:12345/chunk.js", "GET", "owned"),
    ("http://127.0.0.1:12345/assets/useUpdate-abc.js", "GET", "owned"),
    ("http://127.0.0.1:12345/assets/resolve-panel.css", "GET", "owned"),
    ("http://127.0.0.1:12345/assets/release-abc.js", "GET", "owned"),
    ("http://127.0.0.1:12345/api/scenes/x", "PUT", "owned"),
    ("http://127.0.0.1:12345/api/gen-requests", "POST", "blocked-api"),
    ("http://127.0.0.1:12345/api/resolve/status", "GET", "blocked-api"),
    ("http://127.0.0.1:12345/api/%72esolve/status", "GET", "blocked-api"),
    ("http://127.0.0.1:12345/api/unknown", "POST", "blocked-method"),
    ("data:text/plain,hello", "GET", "local-resource"),
    ("blob:http://127.0.0.1:12345/id", "GET", "local-resource"),
])
def test_request_gate(url, method, expected):
    assert camera.request_kind(url, method, {"http://127.0.0.1:12345"}) == expected


def test_summaries_do_not_disclose_scene_content():
    summary = camera.scene_summary(json.dumps({"cards": [{"secret": "private", "url": "https://private/path?token=hidden"}],
                                               "edges": [], "groups": [{}]}).encode())
    assert summary["cards"] == 1 and summary["groups"] == 1 and summary["url_schemes"] == {"https": 1}
    assert "private" not in json.dumps(summary) and "hidden" not in json.dumps(summary)


@pytest.mark.parametrize("failure", ["adopt", "wait", "timeout", "none"])
def test_owned_job_reaps_normal_error_and_timeout(tmp_path, monkeypatch, failure):
    calls = []

    class Job:
        count = 0
        def adopt_suspended(self, pid):
            calls.append(("adopt", pid))
            self.count = 2
            if failure == "adopt":
                raise OSError("not adopted")
        def active(self):
            return self.count
        def terminate(self):
            calls.append("terminate")
            self.count = 0
        def close(self):
            calls.append("close")

    class Process:
        pid = 42
        code = None
        def wait(self, timeout):
            if self.code is None and failure == "timeout":
                raise camera.subprocess.TimeoutExpired("synthetic", timeout)
            if self.code is None and failure == "wait":
                raise OSError("wait failed")
            self.code = 0 if self.code is None else self.code
            return self.code
        def poll(self):
            return self.code
        def kill(self):
            self.code = -1
            calls.append("kill")

    def popen(*_args, **kwargs):
        assert kwargs["creationflags"] & 4
        calls.append("suspended")
        return Process()

    monkeypatch.setattr(camera, "load_fixed", lambda *a: types.SimpleNamespace(ProcessJob=Job, CREATE_SUSPENDED=4))
    monkeypatch.setattr(camera.subprocess, "Popen", popen)
    if failure in ("adopt", "wait"):
        with pytest.raises(RuntimeError):
            camera.run_owned(["synthetic"], tmp_path / "worker.log", 1)
    else:
        result = camera.run_owned(["synthetic"], tmp_path / "worker.log", 1)
        assert result["active_after"] == 0
        assert result["status"] == ("timeout" if failure == "timeout" else "exited")
    assert calls[:2] == ["suspended", ("adopt", 42)]
    assert "terminate" in calls and calls[-1] == "close"
    assert json.loads((tmp_path / "worker.job.json").read_text())["active_after"] == 0


def test_no_platform_fallback_when_job_creation_fails(tmp_path, monkeypatch):
    def fail():
        raise OSError("Job unavailable")
    monkeypatch.setattr(camera, "load_fixed", lambda *a: types.SimpleNamespace(ProcessJob=fail))
    monkeypatch.setattr(camera.subprocess, "Popen", lambda *a, **k: pytest.fail("unowned process started"))
    with pytest.raises(OSError):
        camera.run_owned(["synthetic"], tmp_path / "worker.log", 1)


def test_snapshot_hash_drift_rejected(tmp_path, monkeypatch):
    (tmp_path / "source").write_bytes(b"before")
    meta = {"format": camera.MARKER, "sources": camera.SOURCES, "inputs": camera.INPUTS,
            "tool": camera.sha(Path(camera.__file__).read_bytes()), "files": {"source": camera.sha(b"before")}}
    camera.save(tmp_path / "manifest.json", meta)
    camera.validate(tmp_path)
    (tmp_path / "source").write_bytes(b"after")
    with pytest.raises(ValueError, match="changed"):
        camera.validate(tmp_path)


def test_package_links_leave_vite_cache_directory_owned(tmp_path, monkeypatch):
    installed = tmp_path / "installed"
    for name in ("vite", "@scope/plugin"):
        path = installed / name
        path.mkdir(parents=True)
        (path / "package.json").write_text('{"version":"1.0.0"}')
    (installed / ".vite-temp").mkdir()
    commands = []
    monkeypatch.setattr(camera.subprocess, "run", lambda command, **kw: commands.append(command))
    target = tmp_path / "snapshot/node_modules"
    target.parent.mkdir()
    versions = camera.package_links(installed, target)
    assert versions == {"vite": "1.0.0", "@scope/plugin": "1.0.0"}
    assert target.is_dir() and not target.is_symlink()
    assert {Path(command[-2]) for command in commands} == {target / "vite", target / "@scope/plugin"}
    (target / ".vite-temp").mkdir()
    (target / ".vite-temp/config.js").write_text("synthetic")
    assert not (installed / ".vite-temp/config.js").exists()


def test_all_fixed_backends_have_isolation_keys_and_unique_monitor_anchor():
    keys = ("CONTENT_HUB_AGENT_CHAT", "CONTENT_HUB_AGENT_CHAT_DIR", "CONTENT_HUB_DATA", "CONTENT_HUB_DB",
            "CONTENT_HUB_SHARED_URL", "CONTENT_HUB_NO_PROXY", "CONTENT_HUB_SERVER_SYNC")
    for revision in camera.SOURCES.values():
        assert camera.git("show", f"{revision}:backend/app/main.py").count(b"            resolve_selection_monitor.start()") == 1
        for key in keys:
            assert camera.git("grep", "-l", key, revision, "--", "backend/app").strip()


def test_job_query_failure_is_not_reported_as_reaped(tmp_path, monkeypatch):
    class Job:
        def active(self):
            raise OSError("query unavailable")
        def close(self):
            pass
    monkeypatch.setattr(camera, "load_fixed", lambda *a: types.SimpleNamespace(ProcessJob=Job, CREATE_SUSPENDED=4))
    monkeypatch.setattr(camera.subprocess, "Popen", lambda *a, **kw: (_ for _ in ()).throw(OSError("spawn failed")))
    with pytest.raises(RuntimeError):
        camera.run_owned(["synthetic"], tmp_path / "worker.log", 1)
    assert json.loads((tmp_path / "worker.job.json").read_text())["active_after"] is None


def test_every_built_js_css_is_checked_as_normal_static_resource(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    for name in ("useUpdate-abc.js", "ResolvePanel-abc.js", "release.css"):
        (assets / name).write_text("synthetic")
    assert camera.check_static_requests(tmp_path) == 3


@pytest.mark.parametrize("failure", ["active", "terminate", "close"])
def test_failed_adoption_and_job_cleanup_error_still_reap_exact_child(tmp_path, monkeypatch, failure):
    calls = []

    class Job:
        queried = 0
        def adopt_suspended(self, pid):
            raise OSError("synthetic failed adoption")
        def active(self):
            self.queried += 1
            if failure == "active":
                raise OSError("synthetic query failure")
            return int(self.queried <= 2)
        def terminate(self):
            if failure == "terminate":
                raise OSError("synthetic termination failure")
        def close(self):
            calls.append("close")
            if failure == "close":
                raise OSError("synthetic close failure")

    class Process:
        pid = 47
        code = None
        def poll(self):
            return self.code
        def kill(self):
            self.code = -1
            calls.append(("kill", self.pid))
        def wait(self, timeout):
            calls.append(("wait", self.pid))
            return self.code

    monkeypatch.setattr(camera, "load_fixed", lambda *a: types.SimpleNamespace(ProcessJob=Job, CREATE_SUSPENDED=4))
    monkeypatch.setattr(camera.subprocess, "Popen", lambda *a, **kw: Process())
    with pytest.raises(RuntimeError, match="not confirmed"):
        camera.run_owned(["synthetic"], tmp_path / "worker.log", 1)
    assert calls == [("kill", 47), ("wait", 47), "close"]
    assert json.loads((tmp_path / "worker.job.json").read_text())["cleanup_errors"]


@pytest.mark.parametrize("outcome,log,expected", [
    ({"status": "exited", "exit_code": 0}, "details\n판정: 통과\n\n", "passed"),
    ({"status": "exited", "exit_code": 1}, "details\n판정: 미달 — synthetic reason\n", "not-passed"),
    ({"status": "exited", "exit_code": 1}, "Traceback\nKeyError: synthetic\n", "incomplete"),
    ({"status": "exited", "exit_code": 1}, "판정: 통과\n", "incomplete"),
    ({"status": "exited", "exit_code": 0}, "판정: 미달 — synthetic reason\n", "incomplete"),
    ({"status": "exited", "exit_code": 1}, "판정: 미달\n", "incomplete"),
    ({"status": "exited", "exit_code": 1}, "판정: 미달 — \n", "incomplete"),
    ({"status": "exited", "exit_code": 0}, "판정: 통과\nTraceback\n", "incomplete"),
    ({"status": "exited", "exit_code": 0}, " 판정: 통과\n", "incomplete"),
    ({"status": "exited", "exit_code": 0}, None, "incomplete"),
    ({"status": "exited", "exit_code": 2}, "판정: 통과\n", "incomplete"),
    ({"status": "timeout"}, "", "incomplete"),
])
def test_checker_performance_failure_and_infrastructure_failure_are_distinct(tmp_path, monkeypatch, outcome, log, expected):
    (tmp_path / "pilot").mkdir()
    (tmp_path / "measure").mkdir()
    camera.save(tmp_path / "pilot/complete.json", {"status": "ready"})
    camera.save(tmp_path / "order.json", [])
    (tmp_path / "measure/check_risk_measure2.py").write_text("synthetic checker")
    monkeypatch.setattr(camera, "validate", lambda work: {})
    def owned(_command, log_path, _timeout):
        if log is not None:
            log_path.write_text(log, encoding="utf-8")
        return outcome
    monkeypatch.setattr(camera, "run_owned", owned)
    if expected == "passed":
        camera.series(tmp_path, False)
    elif expected == "not-passed":
        with pytest.raises(SystemExit) as error:
            camera.series(tmp_path, False)
        assert error.value.code == 1
    else:
        with pytest.raises(RuntimeError, match="infrastructure"):
            camera.series(tmp_path, False)
    assert json.loads((tmp_path / "measurement/complete.json").read_text())["status"] == expected


@pytest.mark.parametrize("draws", [0, 1])
def test_pilot_preserves_lock_after_gpu_entry_but_rejects_missing_draw(tmp_path, monkeypatch, draws):
    row = {"mode": "bake", "round": 1, "src": "src_n", "flag": "1", "rate": 4, "key": "src_n|gpu1|x4", "tag": "bake5"}
    camera.save(tmp_path / "order.json", [row])
    monkeypatch.setattr(camera, "validate", lambda work: {})
    monkeypatch.setattr(camera, "smoke", lambda work: None)

    def owned(command, *_args):
        camera.save(Path(command[-1]), {"status": "measured", "measurement": {"end": {"gpu": "dom", "lock": "slow"}},
                                       "evidence": {"observations": {"draw": draws}, "renderer": "NVIDIA synthetic",
                                                    "phase": {"gpu": "dom", "lock": "slow"}}})
        return {"exit_code": 0, "status": "exited"}
    monkeypatch.setattr(camera, "run_owned", owned)
    if draws:
        camera.series(tmp_path, True)
        assert json.loads((tmp_path / "pilot/complete.json").read_text())["status"] == "ready"
        assert json.loads((tmp_path / "pilot/rd_bake5.json").read_text())[row["key"]][0]["end"]["lock"] == "slow"
    else:
        with pytest.raises(RuntimeError, match="GPU precondition"):
            camera.series(tmp_path, True)
        assert not (tmp_path / "pilot/complete.json").exists()
    assert (tmp_path / "pilot/row-000.json").is_file()


@pytest.mark.parametrize("mode,stored_cards,request_kind,blocked_ws", [
    ("bake", 2060, None, 0), ("ops", 2060, None, 0),
    ("bake", 2000, None, 0), ("ops", 2000, None, 0),
    ("bake", 2060, "disabled-background", 0),
    ("bake", 2060, "blocked-api", 0), ("bake", 2060, "blocked-method", 0),
    ("bake", 2060, "blocked-origin", 0), ("bake", 2060, "disabled-other", 0),
    ("bake", 2060, "disabled-background", 1),
])
def test_worker_checks_actual_retained_count_and_request_boundaries(tmp_path, monkeypatch, mode, stored_cards, request_kind, blocked_ws):
    data = (camera.HOME / "measure/scene_2000.json").read_bytes()
    assert len(data) == 3976525
    assert camera.sha(data) == camera.INPUTS["measure/scene_2000.json"]
    summary = camera.scene_summary(data)
    assert (summary["cards"], summary["edges"], summary["groups"]) == (2060, 1785, 160)
    row = {"mode": mode, "round": 1, "src": "src_n", "flag": "1", "rate": 4, "key": "src_n|gpu1|x4", "tag": mode + "5"}
    camera.save(tmp_path / "order.json", [row])
    (tmp_path / "measurement").mkdir()
    output = tmp_path / "measurement/row-000.json"

    class Hub:
        def __init__(self):
            self.url, self.isolation = "http://127.0.0.1:12345", {}
            self.proc = types.SimpleNamespace(pid=1)
            self.shared = types.SimpleNamespace(url="http://127.0.0.1:12346", proc=types.SimpleNamespace(pid=2))
        def start(self, **_kwargs):
            pass

    cn = types.SimpleNamespace(REPO=tmp_path / "measure/src_n", Hub=Hub,
                               servers=types.SimpleNamespace(server_env=lambda *args: {}))
    rd = types.SimpleNamespace(am=types.SimpleNamespace(cn=cn),
                               rm=types.SimpleNamespace(ImgPage=object, fake_jpegs=lambda: []))

    async def measurement(src, _flag, _rate):
        cn.Hub().start(checkout=tmp_path / "measure" / src)
        return {"synthetic": True}

    def observed_page(_base, _origins, _url, evidence, _collect):
        evidence.update(stored_cards=[stored_cards], observations={"raf": 1, "loafSupported": True, "blockedWS": blocked_ws})
        if request_kind:
            evidence["requests"][request_kind] += 1
        return object

    setattr(rd, mode, measurement)
    original_import = camera.importlib.import_module
    monkeypatch.setattr(camera.importlib, "import_module", lambda name: rd if name == "risk_diag" else original_import(name))
    monkeypatch.setattr(camera, "validate", lambda work: {})
    monkeypatch.setattr(camera, "guarded_page", observed_page)
    monkeypatch.setattr(sys, "path", list(sys.path))
    if stored_cards == summary["cards"] and request_kind in (None, "disabled-background") and not blocked_ws:
        asyncio.run(camera.worker(tmp_path, row, output))
        assert json.loads(output.read_text())["status"] == "measured"
    else:
        with pytest.raises(RuntimeError, match="round incomplete"):
            asyncio.run(camera.worker(tmp_path, row, output))
        assert json.loads(output.read_text())["status"] == "incomplete"


@pytest.mark.parametrize("path,method,expected", [
    ("/api/generations/batch", "POST", "owned"),
    ("/api/generations/batch?private=secret", "POST", "owned"),
    ("/api/generations/batch/child", "POST", "blocked-method"),
    ("/api/generations/batch/", "POST", "blocked-method"),
    ("/api/generations/batch", "PUT", "blocked-method"),
    ("/api/generations/batch", "GET", "owned"),
    ("/api/update-notices", "GET", "owned"),
    ("/api/update-notices?private=secret", "GET", "owned"),
    ("/api/update-notices/child", "GET", "blocked-api"),
    ("/api/update-notices", "POST", "blocked-api"),
    ("/api/release-update/status?refresh=true", "GET", "disabled-background"),
    ("/api/release-update/status/child", "GET", "blocked-api"),
    ("/api/release-update/status", "POST", "blocked-api"),
    ("/api/release-update/status", "HEAD", "blocked-api"),
    ("/api/gen-requests/canvas-links/resolve", "POST", "blocked-api"),
    ("/api/comfy/canvas-runs/resolve", "POST", "blocked-api"),
])
def test_exact_owned_api_exceptions(path, method, expected):
    origins = {"http://127.0.0.1:12345", "http://127.0.0.1:12346"}
    for origin in origins:
        assert camera.request_kind(origin + path, method, origins) == expected
    assert camera.request_kind("https://outside.invalid" + path, method, origins) == "blocked-origin"


def test_route_labels_never_include_request_values():
    hub, shared = "http://127.0.0.1:12345", "http://127.0.0.1:12346"
    origins = {hub, shared}
    cases = [
        (hub + "/api/generations/batch?token=private-query", "POST", "hub|POST|generations.batch"),
        (shared + "/api/update-notices?account=private-account", "GET", "shared|GET|update-notices.list"),
        (hub + "/api/release-update/status?private=value", "GET", "hub|GET|release-update.status"),
        (hub + "/api/gen-requests/canvas-links/resolve", "POST", "hub|POST|canvas-links.resolve"),
        (hub + "/api/comfy/canvas-runs/resolve", "POST", "hub|POST|comfy-canvas-runs.resolve"),
        ("https://private-host.invalid/api/private-id?secret=private-query", "PRIVATE-METHOD", "outside|other|other"),
        (hub + "/api/update-notices/private-id", "DELETE", "hub|DELETE|other"),
    ]
    labels = [camera.request_label(url, method, hub, origins) for url, method, _expected in cases]
    assert labels == [expected for _url, _method, expected in cases]
    assert "private" not in json.dumps(labels).lower()


def test_disabled_background_is_failed_before_network_and_route_counts_are_static():
    evidence = {"requests": camera.collections.Counter(), "runtime_errors": 0, "static_errors": 0}
    sent = []
    hub = "http://127.0.0.1:12345"
    requests = [("batch", hub + "/api/generations/batch?secret=private", "POST"),
                ("notice", hub + "/api/update-notices", "GET"),
                ("release", hub + "/api/release-update/status?refresh=true", "GET"),
                ("outside", "https://private.invalid/api/generations/batch", "POST")]

    class Socket:
        async def __aiter__(self):
            for request_id, url, method in requests:
                yield json.dumps({"method": "Fetch.requestPaused", "params": {
                    "requestId": request_id, "request": {"url": url, "method": method}}})

    class Base:
        async def send(self, method, **params):
            sent.append((method, params["requestId"]))
        async def _read(self):
            async for _raw in self.ws:
                pytest.fail("nonmedia Fetch event escaped the gate")

    async def check():
        page = camera.guarded_page(Base, {hub}, hub, evidence)()
        page.ws = Socket()
        await page._read()
        await asyncio.sleep(0)
    asyncio.run(check())
    assert sent == [("Fetch.continueRequest", "batch"), ("Fetch.continueRequest", "notice"),
                    ("Fetch.failRequest", "release"), ("Fetch.failRequest", "outside")]
    assert evidence["request_routes"] == {"hub|POST|generations.batch": 1, "hub|GET|update-notices.list": 1,
                                           "hub|GET|release-update.status": 1, "outside|POST|generations.batch": 1}
    assert "private" not in json.dumps(evidence)
