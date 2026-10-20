"""Synthetic ZIP + process/HTTP doubles only; never an actual release run."""
import json
from pathlib import Path
import sys
import shutil
import sqlite3
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "backend"))
import qualify_release_artifact as q
from release_contract_fixture import qualified_package


@pytest.fixture
def artifact(tmp_path):
    payload = {"VERSION.txt": b"fixture", "hf_cli_version.txt": b"1.1.26",
               "runtime/higgsfield/node_modules/@higgsfield/cli/package.json": b'{"version":"1.1.26"}',
               "runtime/python/python.exe": b"inert-fixture-not-executable",
               "backend/serve.py": b"raise RuntimeError('must not run')",
               "frontend/dist/index.html": b'<div id="root"></div>',
               "frontend/dist/assets/app.js": b"/* synthetic */"}
    candidate, _ = qualified_package(tmp_path, "fixture", payload=payload)
    path = tmp_path / "candidate.json"
    path.write_bytes(q.c.json_bytes(candidate))
    return path, tmp_path / "receipt.json"


def proof(*_args):
    return {"fresh_data": True, "ready": {"status": "ready"},
            "process_cleanup": {"port_released": True}, "databases": [{"kind": "content"}]}


def test_existing_smoke_has_no_receipt_producer():
    import smoke_release_package
    assert not hasattr(smoke_release_package, "qualify")


def test_artifact_receipt_entrypoint_exists():
    assert callable(q.qualify)


def test_produces_bound_receipt_after_cleanup_only(artifact, monkeypatch):
    candidate, output = artifact
    monkeypatch.setattr(q, "_boot", proof)
    result = q.qualify(candidate, output)
    parsed = q.c.validate_receipt(output.read_bytes(), q.c.document(candidate.read_bytes()))
    assert parsed["checks"] == {key: "passed" for key in q.c.REQUIRED_CHECKS}
    assert parsed["skips"] == [] and parsed["run_id"] == result["run_id"]
    assert parsed["tool_sha256"]["tools/qualify_release_artifact.py"] == q.c.file_sha256(Path(q.__file__))
    assert not list(output.parent.glob("*.writing-*"))


@pytest.mark.parametrize("failure", ["boot", "cleanup", "unknown-cleanup", "skip", "payload-change", "tools-change", "candidate-change"])
def test_failure_has_no_success_receipt(artifact, monkeypatch, failure):
    candidate, output = artifact
    def run(root, work, descriptor, timeout):
        if failure == "boot":
            raise RuntimeError("HTTP failure")
        if failure == "unknown-cleanup":
            raise q.CleanupUncertain("mock cleanup")
        if failure == "payload-change":
            (root / "frontend/dist/index.html").write_text("changed")
        if failure == "candidate-change":
            candidate.write_text("{}")
        if failure == "skip":
            raise q.c.ContractError("required check unsupported; cannot skip")
        result = proof()
        if failure == "cleanup":
            result["process_cleanup"]["port_released"] = False
        return result
    monkeypatch.setattr(q, "_boot", run)
    if failure == "tools-change":
        real_hashes = q._hashes
        calls = 0
        def changed_hashes():
            nonlocal calls
            calls += 1
            return real_hashes() if calls == 1 else {"changed": "a" * 64}
        monkeypatch.setattr(q, "_hashes", changed_hashes)
    if failure in {"unknown-cleanup", "cleanup"}:
        # Keep the retained unknown fixture inside pytest's disposable folder.
        directory = output.parent / "unknown-runtime"
        directory.mkdir()
        monkeypatch.setattr(q.tempfile, "mkdtemp", lambda **_: str(directory))
    with pytest.raises(Exception):
        q.qualify(candidate, output)
    assert not output.exists()
    assert not list(output.parent.glob("*.writing-*"))
    if failure in {"unknown-cleanup", "cleanup"}:
        assert directory.exists()


def test_wrong_zip_rejected_before_boot(artifact, monkeypatch):
    candidate, output = artifact
    document = q.c.document(candidate.read_bytes())
    (candidate.parent / document["file"]).write_bytes(b"different ZIP")
    boot = Mock()
    monkeypatch.setattr(q, "_boot", boot)
    with pytest.raises(q.c.ContractError):
        q.qualify(candidate, output)
    boot.assert_not_called()
    assert not output.exists()


def test_receipt_for_different_zip_rejected(artifact, monkeypatch):
    candidate, output = artifact
    monkeypatch.setattr(q, "_boot", proof)
    q.qualify(candidate, output)
    document = q.c.document(candidate.read_bytes())
    document["sha256"] = "0" * 64
    with pytest.raises(q.c.ContractError):
        q.c.validate_receipt(output.read_bytes(), document)


@pytest.mark.parametrize("failure", ["write", "fsync", "rename"])
def test_recording_error_leaves_no_qualifiable_receipt(artifact, monkeypatch, failure):
    candidate, output = artifact
    monkeypatch.setattr(q, "_boot", proof)
    def fail(*args, **kwargs):
        raise OSError("synthetic recording error")
    if failure == "fsync":
        monkeypatch.setattr(q.os, "fsync", fail)
    elif failure == "rename":
        monkeypatch.setattr(q.os, "rename", fail)
    else:
        original = Path.open
        def open_path(path, *args, **kwargs):
            if ".writing-" in path.name:
                raise OSError("synthetic open error")
            return original(path, *args, **kwargs)
        monkeypatch.setattr(Path, "open", open_path)
    with pytest.raises(OSError):
        q.qualify(candidate, output)
    assert not output.exists() and not list(output.parent.glob("*.writing-*"))


def test_existing_receipt_never_overwritten(artifact, monkeypatch):
    candidate, output = artifact
    output.write_bytes(b"existing")
    boot = Mock()
    monkeypatch.setattr(q, "_boot", boot)
    with pytest.raises(q.c.ContractError):
        q.qualify(candidate, output)
    assert output.read_bytes() == b"existing"
    boot.assert_not_called()


def test_receipt_consumed_by_existing_explicit_qualify_command(artifact, monkeypatch):
    # Existing qualify only attaches an already-produced receipt; no package run.
    import release_contract as consumer
    candidate, output = artifact
    document = q.c.document(candidate.read_bytes())
    package = candidate.parent / document["file"]
    package.with_suffix(".validation.json").unlink()
    package.with_suffix(".candidate.json").unlink()
    document["contract"]["validation_receipt"] = None
    candidate.write_bytes(q.c.json_bytes(document))
    monkeypatch.setattr(q, "_boot", proof)
    q.qualify(candidate, output)
    final = consumer.qualify(candidate, output)
    bound = q.c.document(final.read_bytes())
    q.c.verify_artifact(package, bound, output.read_bytes())


def test_required_skip_receipt_rejected_by_existing_contract(artifact, monkeypatch):
    candidate, output = artifact
    monkeypatch.setattr(q, "_boot", proof)
    result = q.qualify(candidate, output)
    result["skips"] = ["runtime_health"]
    with pytest.raises(q.c.ContractError):
        q.c.validate_receipt(q.c.json_bytes(result), q.c.document(candidate.read_bytes()))


@pytest.mark.parametrize("field", ["execution_nonce", "build_id", "role", "process_id"])
def test_ready_identity_and_actual_owned_listener_required(monkeypatch, field):
    import psutil
    process = SimpleNamespace(pid=42, load_create_time=100)
    runtime = {"execution_nonce": "nonce", "build_id": "build", "role": "worker", "process_id": 42}
    runtime[field] = "foreign"
    monkeypatch.setattr(psutil, "Process", lambda pid: SimpleNamespace(create_time=lambda: 100))
    def listener(proc, port, ready):
        q.c.require(ready["runtime"]["process_id"] == 42, "not owned")
        return 42
    monkeypatch.setattr(q, "_owned_listener", listener)
    with pytest.raises(q.c.ContractError):
        q._identity(process, 1234, {"status": "ready", "runtime": runtime}, {"build_id": "build", "role": "worker"}, "nonce")


@pytest.mark.parametrize("failure", ["missing-declaration", "schema", "protocol", "component", "missing-db", "db-mutated"])
def test_readonly_compatibility_failure(monkeypatch, tmp_path, failure):
    declaration = {"reader_protocol": 1, "writer_protocol": 1, "supported_components": ["content_core"],
                   "db_schema": {"read_min": 0, "read_max": 2, "write_min": 0, "write_max": 2}}
    info = SimpleNamespace(status="compatible", schema_version=2, minimum_reader_protocol=1,
                           minimum_writer_protocol=1, components=("content_core",))
    if failure == "missing-declaration": del declaration["reader_protocol"]
    if failure == "schema": info.schema_version = 3
    if failure == "protocol": info.minimum_writer_protocol = 2
    if failure == "component": info.components = ("unknown",)
    monkeypatch.setattr(q, "load_inspector", lambda _: lambda *a, **k: info)
    monkeypatch.setattr(q, "database_paths", lambda *a: [] if failure == "missing-db" else [("content", tmp_path / "fake.db")])
    calls = 0
    def files(*a):
        nonlocal calls
        calls += 1
        return {"db": calls if failure == "db-mutated" else 1}
    monkeypatch.setattr(q, "file_set", files)
    with pytest.raises(q.c.ContractError):
        q._compatibility(tmp_path, {}, declaration)


@pytest.mark.parametrize("role", ["worker", "server"])
@pytest.mark.parametrize("failure", [None, "ready", "asset", "cleanup"])
def test_actual_boot_flow_with_mock_process_and_http(artifact, monkeypatch, failure, role):
    """Exercises actual _boot; only process, HTTP and DB inspector are doubles."""
    import psutil
    import load_test_100
    candidate, _ = artifact
    value = q.c.document(candidate.read_bytes())
    package = candidate.parent / value["file"]
    descriptor = q.c.verify_artifact(package, value, qualified=False)
    work = candidate.parent / "boot-work"
    work.mkdir()
    root = work / "package"
    root.mkdir()
    q._safe_extract(package, root)
    descriptor["role"] = role
    runtime_python = None
    if role == "server":
        runtime_python = root / ".venv/Scripts/python.exe"
        runtime_python.parent.mkdir(parents=True)
        runtime_python.write_bytes(b"inert-server-python")
        (root / "runtime/higgsfield/node_modules/@higgsfield/cli/package.json").unlink()
    captured = {}
    process = SimpleNamespace(pid=42, poll=lambda: None)
    def popen(args, **kwargs):
        captured.update(kwargs)
        captured["args"] = args
        return process
    monkeypatch.setattr(q.subprocess, "Popen", popen)
    owner = SimpleNamespace(pid=42, create_time=lambda: 100, children=lambda **kw: [])
    monkeypatch.setattr(psutil, "Process", lambda pid: owner)
    monkeypatch.setattr(load_test_100, "_listening_pid", lambda port: 42)
    monkeypatch.setattr(psutil, "net_connections", lambda **kw: [SimpleNamespace(
        status=psutil.CONN_LISTEN, pid=42,
        laddr=SimpleNamespace(ip="127.0.0.1", port=captured["port"]))])
    monkeypatch.setattr(q, "_free_port", lambda: 12345)
    captured["port"] = 12345
    def get(port, path):
        if path == "/api/ready":
            return q.c.json_bytes({"status": "ready", "runtime": {
                "process_id": 42, "execution_nonce": "foreign" if failure == "ready" else captured["env"]["MVHUB_EXECUTION_NONCE"],
                "build_id": descriptor["build_id"], "role": descriptor["role"]}})
        if failure == "asset" and path.endswith("app.js"):
            return b"wrong bytes"
        relative = "index.html" if path == "/" else path.lstrip("/")
        return (root / "frontend/dist" / relative).read_bytes()
    monkeypatch.setattr(q, "_get", get)
    stopped = []
    def stop(proc, port):
        stopped.append((proc.pid, port))
        if failure == "cleanup":
            raise RuntimeError("owned child still alive")
        return {"port_released": True}
    monkeypatch.setattr(q, "_stop_owned", stop)
    monkeypatch.setattr(q, "_compatibility", lambda *a: [{"kind": "content", "schema_version": 2}])
    if failure:
        with pytest.raises(q.CleanupUncertain if failure == "cleanup" else q.c.ContractError):
            q._boot(root, work, descriptor, 1, runtime_python=runtime_python)
    else:
        result = q._boot(root, work, descriptor, 1, runtime_python=runtime_python)
        assert result["frontend_files"] == 2 and result["listener_pid"] == 42
        assert result["process_cleanup"]["port_released"]
    assert stopped == [(42, 12345)]
    assert captured["args"][1:7] == ["-E", "-s", "-B", "-X", "utf8", "-u"]
    assert captured["env"]["CONTENT_HUB_NO_PROXY"] == "1"
    assert captured["env"]["CONTENT_HUB_EXTERNAL_RECOVERY"] == "0"
    assert captured["env"]["CONTENT_HUB_SERVER_SYNC"] == "0"
    assert captured["env"]["CONTENT_HUB_HOST"] == "127.0.0.1"
    assert captured["env"]["MVHUB_BUILD_ID"] == descriptor["build_id"]
    assert captured["env"]["MVHUB_PROCESS_ROLE"] == role


@pytest.mark.parametrize("failure", [None, "payload-change", "cleanup-unknown", "cleanup-incomplete"])
def test_public_stage_probe_cleanup_and_fingerprint(artifact, monkeypatch, failure):
    candidate, _ = artifact
    value = q.c.document(candidate.read_bytes())
    package = candidate.parent / value["file"]
    descriptor = q.c.verify_artifact(package, value, qualified=False)
    root = candidate.parent / "stage"
    root.mkdir()
    q._safe_extract(package, root)
    work = candidate.parent / "new-probe-work"
    def run(root, work, desc, timeout, *, runtime_python):
        if failure == "cleanup-unknown":
            raise q.CleanupUncertain("mock still running")
        if failure == "payload-change":
            (root / "backend/serve.py").write_bytes(b"changed")
        result = proof()
        if failure == "cleanup-incomplete":
            result["process_cleanup"]["port_released"] = False
        return result
    monkeypatch.setattr(q, "_boot", run)
    if failure:
        with pytest.raises(q.CleanupUncertain if failure in {"cleanup-unknown", "cleanup-incomplete"} else q.c.ContractError):
            q.probe_runtime(root, work, descriptor)
        assert work.exists() == (failure in {"cleanup-unknown", "cleanup-incomplete"})
    else:
        result = q.probe_runtime(root, work, descriptor)
        assert result["evidence"]["temp_removed"] and result["status"] == "passed"
        assert result["descriptor_sha256"] == q.c.sha256(q.c.json_bytes(descriptor))
        assert not work.exists()


def test_probe_json_cli_and_no_supplied_result_option(artifact, monkeypatch, capsys):
    candidate, _ = artifact
    descriptor = candidate.parent / "descriptor.json"
    descriptor.write_bytes(q.c.json_bytes({"build_id": "stage", "role": "server"}))
    root, work = candidate.parent / "stage", candidate.parent / "probe-work"
    runtime = root / ".venv/Scripts/python.exe"
    calls = []
    def probe(*args, **kwargs):
        calls.append((args, kwargs))
        return {"status": "passed", "evidence": {"temp_removed": True}}
    monkeypatch.setattr(q, "probe_runtime", probe)
    monkeypatch.setattr(sys, "argv", [q.__file__, "probe", "--root", str(root), "--work-root", str(work),
                                     "--descriptor", str(descriptor), "--runtime-python", str(runtime)])
    assert q.main() == 0
    result = json.loads(capsys.readouterr().out)
    assert result["descriptor_file_sha256"] == q.c.file_sha256(descriptor)
    assert calls[0][1]["runtime_python"] == runtime
    monkeypatch.setattr(sys, "argv", [q.__file__, "probe", "--supplied-result", "passed"])
    with pytest.raises(SystemExit) as failure:
        q.main()
    assert failure.value.code != 0


@pytest.mark.parametrize("runtime", [None, "outside"])
def test_server_runtime_must_be_explicit_stage_venv(artifact, runtime):
    candidate, _ = artifact
    root = candidate.parent / "stage"
    root.mkdir()
    descriptor = {"role": "server"}
    with pytest.raises(q.c.ContractError):
        q._boot(root, candidate.parent / "work", descriptor, 1,
                runtime_python=None if runtime is None else candidate.parent / "outside-python.exe")


@pytest.mark.parametrize("mutation", [None, "main", "wal", "journal"])
def test_real_content_v2_wal_shm_bookkeeping_is_separate(tmp_path, monkeypatch, mutation):
    """Real SQLite/schema inspector, pure synthetic minimum v2 schema; no app boot."""
    inspect = q.load_inspector(q.ROOT)
    compat = sys.modules[inspect.__module__]
    source = tmp_path / "source.db"
    components = ("content_core", "content_share_commands")
    columns, keys = {}, {}
    for component in components:
        baseline = compat.BASELINES[component]
        for table, names in baseline.tables:
            columns.setdefault(table, set()).update(names)
        keys.update(dict(baseline.primary_keys))
    columns["generation"].update(compat._SHARE_REVISION_COLUMNS)
    columns["share"] = {"generation_id", "visibility", "shared_by"}
    conn = sqlite3.connect(source)
    try:
        for table, names in columns.items():
            definitions = [f'"{name}" TEXT' for name in sorted(names)]
            if table in keys:
                definitions.append('PRIMARY KEY(' + ','.join('"' + name + '"' for name in keys[table]) + ')')
            conn.execute(f'CREATE TABLE "{table}" ({",".join(definitions)})')
        for component in components:
            for name, table, names, unique, predicate in compat.BASELINES[component].indexes:
                conn.execute(f'CREATE {"UNIQUE " if unique else ""}INDEX "{name}" ON "{table}" '
                             '(' + ','.join('"' + col + '"' for col in names) + ')'
                             + (' WHERE ' + predicate if predicate else ''))
        for ddl in compat.SHARE_REVISION_TRIGGERS.values():
            conn.execute(ddl)
        conn.commit()
        for component in components:
            compat.record_baseline(conn, component)
        assert compat.inspect_schema(conn, "content").schema_version == 2
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA wal_autocheckpoint=0")
        conn.execute("CREATE TABLE synthetic_probe(value TEXT)")
        conn.execute("INSERT INTO synthetic_probe VALUES('wal-visible')")
        conn.commit()
        root = tmp_path / "stage"
        root.mkdir()
        data = tmp_path / "isolated-data"
        database = data / "db/content_hub.db"
        database.parent.mkdir(parents=True)
        shutil.copyfile(source, database)
        shutil.copyfile(Path(str(source) + "-wal"), Path(str(database) + "-wal"))
        assert not Path(str(database) + "-shm").exists()
        before_main, before_wal = q.c.file_sha256(database), q.c.file_sha256(Path(str(database) + "-wal"))
        declaration = {"reader_protocol": 1, "writer_protocol": 2, "supported_components": list(components),
                       "db_schema": {"read_min": 0, "read_max": 2, "write_min": 0, "write_max": 2}}
        if mutation:
            def changing_inspector(path, expected_kind):
                info = inspect(path, expected_kind=expected_kind)
                changed = path if mutation == "main" else Path(str(path) + ("-wal" if mutation == "wal" else "-journal"))
                with changed.open("ab") as stream:
                    stream.write(b"synthetic-mutation")
                return info
            monkeypatch.setattr(q, "load_inspector", lambda _: changing_inspector)
        env = {"CONTENT_HUB_DATA": str(data), "CONTENT_HUB_DB": str(database)}
        if mutation:
            with pytest.raises(q.c.ContractError, match="changed database files"):
                q._compatibility(root, env, declaration)
        else:
            rows = q._compatibility(root, env, declaration)
            assert rows == [{"kind": "content", "schema_version": 2, "components": list(components)}]
            assert Path(str(database) + "-shm").exists()
            assert q.c.file_sha256(database) == before_main
            assert q.c.file_sha256(Path(str(database) + "-wal")) == before_wal
    finally:
        conn.close()
