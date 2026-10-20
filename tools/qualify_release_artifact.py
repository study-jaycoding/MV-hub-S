"""Qualify an explicit existing ZIP using trusted tools and its bundled runtime.

Fresh extraction/DATA boot only: this is not an existing-install update test.
No source gate, build, publication, candidate mutation, or supplied check results.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.services import release_contract as c
from smoke_env import build_smoke_env, validate_smoke_paths, _local_path
from smoke_release_package import _safe_extract, _required_file, _free_port
from install_db_probe import database_paths, load_inspector, file_set
from load_test_100 import _owned_listener, _stop_owned

TOOLS = ("tools/qualify_release_artifact.py", "tools/smoke_release_package.py",
         "tools/smoke_env.py", "tools/install_db_probe.py", "tools/load_test_100.py",
         "backend/app/services/release_contract.py", "backend/app/services/isolated_env.py",
         "backend/app/schema_compat.py")


class CleanupUncertain(RuntimeError):
    """Retain the disposable directory rather than deleting live runtime files."""


def _hashes() -> dict:
    return {name: c.file_sha256(_local_path(ROOT / name)) for name in TOOLS}


def _get(port: int, path: str) -> bytes:
    # Ignore inherited proxy settings and reject redirects away from loopback.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(f"http://127.0.0.1:{port}{path}", timeout=3) as response:
        c.require(response.status == 200, "probe HTTP status")
        return response.read()


def _identity(process, port: int, ready: dict, descriptor: dict, nonce: str) -> int:
    runtime = ready.get("runtime", {})
    c.require(ready.get("status") == "ready" and runtime.get("execution_nonce") == nonce
              and runtime.get("build_id") == descriptor["build_id"]
              and runtime.get("role") == descriptor["role"], "ready identity mismatch")
    import psutil
    c.require(psutil.Process(process.pid).create_time() == process.load_create_time,
              "launcher PID identity changed")
    return _owned_listener(process, port, ready)


def _boot(root: Path, work: Path, descriptor: dict, timeout: float, *, runtime_python: Path | None = None) -> dict:
    import psutil
    role = descriptor.get("role")
    c.require(role in {"worker", "server"}, "unsupported runtime role")
    if role == "server":
        c.require(runtime_python is not None, "server runtime Python required")
        python = _local_path(runtime_python)
        c.require(python == _local_path(root / ".venv/Scripts/python.exe") and python.is_file(),
                  "server runtime must be stage .venv Python")
    else:
        python = _required_file(root, "runtime/python/python.exe")
        c.require(runtime_python is None or _local_path(runtime_python) == _local_path(python),
                  "worker must use its bundled Python")
    python = _local_path(python)
    runtime_sha = c.file_sha256(python)
    serve = _required_file(root, "backend/serve.py")
    frontend = root / "frontend/dist"
    _required_file(root, "frontend/dist/index.html")
    if role == "worker":
        cli = json.loads(_required_file(root, "runtime/higgsfield/node_modules/@higgsfield/cli/package.json").read_text("utf-8"))
        c.require(cli.get("version") == descriptor["runtime"]["higgsfield_cli"], "bundled CLI mismatch")
    port = _free_port()
    env = build_smoke_env(os.environ, work, frontend_dist=frontend, python_exe=python, port=port)
    nonce = uuid.uuid4().hex
    env.update({"MVHUB_EXECUTION_NONCE": nonce, "MVHUB_PROCESS_ROLE": role,
                "MVHUB_BUILD_ID": descriptor["build_id"]})
    validate_smoke_paths(work, env, allowed_frontend_root=frontend)
    process = None
    evidence = {"fresh_data": not Path(env["CONTENT_HUB_DB"]).exists(), "port": port}
    c.require(evidence["fresh_data"], "DATA not fresh")
    try:
        with (work / "stdout.log").open("wb") as stdout, (work / "stderr.log").open("wb") as stderr:
            process = subprocess.Popen([str(python), "-E", "-s", "-B", "-X", "utf8", "-u", str(serve)],
                                       cwd=serve.parent, env=env, stdout=stdout, stderr=stderr,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            process.load_create_time = psutil.Process(process.pid).create_time()
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    ready = c.document(_get(port, "/api/ready"))
                except (OSError, ValueError):
                    time.sleep(0.1)
                    continue
                pid = _identity(process, port, ready, descriptor, nonce)
                evidence.update({"ready": ready, "listener_pid": pid,
                                 "launcher_create_time": process.load_create_time,
                                 "listener_create_time": psutil.Process(pid).create_time()})
                break
            c.require("ready" in evidence, "runtime not ready")
            # Every packaged frontend file is served byte-for-byte. Never execute a CLI.
            rows = [row for row in descriptor["payload"] if row["path"].startswith("frontend/dist/")]
            c.require(any(row["path"] == "frontend/dist/index.html" for row in rows), "frontend missing")
            for row in rows:
                relative = row["path"][len("frontend/dist/"):]
                from urllib.parse import quote
                raw = _get(port, "/" if relative == "index.html" else "/" + quote(relative, safe="/"))
                c.require(len(raw) == row["size"] and c.sha256(raw) == row["sha256"], "served frontend mismatch")
                if relative == "index.html":
                    c.require(b'id="root"' in raw or b"id='root'" in raw, "frontend shell missing")
            evidence["frontend_files"] = len(rows)
    finally:
        if process is not None:
            try:
                evidence["process_cleanup"] = _stop_owned(process, port)
            except Exception as exc:
                raise CleanupUncertain("owned cleanup unconfirmed") from exc
    evidence["databases"] = _compatibility(root, env, descriptor["compatibility"])
    c.require(c.file_sha256(_local_path(python)) == runtime_sha, "runtime Python changed")
    evidence["runtime_python_sha256"] = runtime_sha
    return evidence


def _payload_hashes(root: Path, descriptor: dict) -> dict:
    rows = descriptor.get("payload")
    c.require(isinstance(rows, list) and rows, "runtime payload inventory required")
    result = {}
    for row in rows:
        name = row.get("path")
        c.require(isinstance(name, str) and c.payload_name(name) and name.casefold() not in result,
                  "runtime payload path invalid or duplicate")
        path = _local_path(root / name)
        c.require(path.is_file() and path.is_relative_to(root) and type(row.get("size")) is int
                  and path.stat().st_size == row["size"] and c.digest(row.get("sha256"))
                  and c.file_sha256(path) == row["sha256"], "runtime payload mismatch")
        result[name.casefold()] = row["sha256"]
    c.require({"backend/serve.py", "frontend/dist/index.html"} <= result.keys(),
              "runtime entry points missing from payload")
    return result


def probe_runtime(root: Path, work: Path, descriptor: dict, timeout: float = 90,
                  *, runtime_python: Path | None = None) -> dict:
    """Fresh DATA probe shared with server qualification; never an install/update.

    Caller supplies an already-verified stage and binds the returned proof to its
    own source receipt/fingerprint. Descriptor/result must live outside the stage.
    The new work root is removed only after confirmed process cleanup.
    """
    root, work = _local_path(root), _local_path(work)
    c.require(root.is_dir() and not work.exists() and not work.is_relative_to(root)
              and not root.is_relative_to(work), "probe requires separate new work root")
    c.require(isinstance(descriptor.get("build_id"), str) and descriptor["build_id"]
              and 0 < timeout <= 600, "probe build/timeout required")
    before = _payload_hashes(root, descriptor)
    tools = _hashes()
    work.mkdir(parents=True)
    uncertain = False
    try:
        evidence = _boot(root, work, descriptor, timeout, runtime_python=runtime_python)
        if evidence.get("process_cleanup", {}).get("port_released") is not True:
            raise CleanupUncertain("cleanup not confirmed")
        c.require(_payload_hashes(root, descriptor) == before and _hashes() == tools,
                  "probe inputs changed")
    except CleanupUncertain:
        uncertain = True
        raise
    finally:
        if not uncertain:
            shutil.rmtree(work)
    c.require(not work.exists(), "probe temporary cleanup incomplete")
    evidence["temp_removed"] = True
    return {"status": "passed", "evidence": evidence, "tool_sha256": tools,
            "descriptor_sha256": c.sha256(c.json_bytes(descriptor)),
            "payload_sha256": c.sha256(c.json_bytes(before)),
            "scope": "fresh-data-runtime-probe"}


def _compatibility(root: Path, env: dict, declaration: dict) -> list[dict]:
    # Trusted inspector, never candidate Python/module imports.
    inspector = load_inspector(ROOT)
    paths = database_paths(root, env)
    c.require(any(kind == "content" for kind, _ in paths), "fresh content DB missing")
    # mode=ro may create/update WAL's SHM index. Keep its link checks in
    # file_set, but compare only data-bearing main/WAL/rollback-journal files.
    before = {path: value for path, value in file_set(paths).items() if not str(path).endswith("-shm")}
    rows = []
    c.require(type(declaration.get("reader_protocol")) is int
              and type(declaration.get("writer_protocol")) is int
              and isinstance(declaration.get("supported_components"), list), "compatibility proof declaration missing")
    for kind, path in paths:
        # database_paths already rejects links; no candidate-supplied inspector.
        info = inspector(path, expected_kind=kind)
        c.require(info.status == "compatible", "database incompatible")
        bounds = declaration["db_schema"]
        c.require(bounds["read_min"] <= info.schema_version <= bounds["read_max"]
                  and bounds["write_min"] <= info.schema_version <= bounds["write_max"]
                  and declaration["reader_protocol"] >= info.minimum_reader_protocol
                  and declaration["writer_protocol"] >= info.minimum_writer_protocol
                  and set(info.components) <= set(declaration["supported_components"]), "declared compatibility mismatch")
        rows.append({"kind": kind, "schema_version": info.schema_version, "components": list(info.components)})
    after = {path: value for path, value in file_set(paths).items() if not str(path).endswith("-shm")}
    c.require(before == after, "compatibility inspection changed database files")
    return rows


def _publish(path: Path, raw: bytes, candidate: dict) -> None:
    # Windows rename is atomic and fails if destination exists. No replacement.
    staging = path.with_name(path.name + ".writing-" + uuid.uuid4().hex)
    try:
        with staging.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        c.require(staging.read_bytes() == raw, "receipt recording mismatch")
        c.validate_receipt(staging.read_bytes(), candidate)
        if os.name != "nt":
            raise c.ContractError("receipt publication requires Windows no-replace rename")
        os.rename(staging, path)
    finally:
        staging.unlink(missing_ok=True)


def qualify(candidate_path: Path, output: Path, *, timeout: float = 90) -> dict:
    candidate_path, output = _local_path(candidate_path), _local_path(output)
    c.require(not output.exists() and output.parent.is_dir(), "receipt target must be new")
    candidate_raw = candidate_path.read_bytes()
    candidate = c.document(candidate_raw)
    c.require(c.safe_name(candidate.get("file")), "unsafe candidate package name")
    package = _local_path(candidate_path.parent / candidate["file"])
    c.require(output not in {candidate_path, package}, "receipt overlaps inputs")
    hashes = _hashes()
    descriptor = c.verify_artifact(package, candidate, qualified=False)
    started = datetime.now(timezone.utc).isoformat()
    work = Path(tempfile.mkdtemp(prefix="mvhub-artifact-qualification-"))
    uncertain_cleanup = False
    try:
        root = work / "package"
        root.mkdir()
        _safe_extract(package, root)
        evidence = _boot(root, work, descriptor, timeout)
        if evidence.get("process_cleanup", {}).get("port_released") is not True:
            raise CleanupUncertain("cleanup not confirmed")
        for row in descriptor["payload"]:
            path = _local_path(root / row["path"])
            c.require(path.stat().st_size == row["size"] and c.file_sha256(path) == row["sha256"],
                      "extracted payload changed during qualification")
    except CleanupUncertain:
        uncertain_cleanup = True
        raise
    finally:
        if not uncertain_cleanup:
            shutil.rmtree(work)
    c.require(not work.exists(), "temporary cleanup incomplete")
    c.require(candidate_path.read_bytes() == candidate_raw and _hashes() == hashes, "qualification inputs changed")
    c.verify_artifact(package, candidate, qualified=False)
    value = {"format_version": 1, "run_id": uuid.uuid4().hex, "scope": "artifact", "profile": c.PROFILE,
             "status": "passed", "release_eligible": True,
             "artifact": {"sha256": candidate["sha256"], "size": candidate["size"]},
             "descriptor_sha256": candidate["contract"]["descriptor_sha256"],
             "checks": {name: "passed" for name in sorted(c.REQUIRED_CHECKS)}, "skips": [],
             "cleanup": {"status": "passed"}, "tool_sha256": hashes,
             "started_at": started, "finished_at": datetime.now(timezone.utc).isoformat(),
             "evidence": evidence, "install_scope": "fresh-extract-separate-data-only",
             "compatibility_scope": "fresh-databases-readonly-schema-protocol-components"}
    raw = c.json_bytes(value)
    c.validate_receipt(raw, candidate)
    _publish(output, raw, candidate)
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    if len(sys.argv) > 1 and sys.argv[1] == "probe":
        parser.add_argument("command", choices=["probe"])
        parser.add_argument("--root", required=True, type=Path)
        parser.add_argument("--work-root", required=True, type=Path)
        parser.add_argument("--descriptor", required=True, type=Path)
        parser.add_argument("--runtime-python", type=Path)
        parser.add_argument("--timeout", type=float, default=90)
        args = parser.parse_args()
        try:
            c.require(os.name == "nt", "Windows probe required")
            source = _local_path(args.descriptor)
            root, work = _local_path(args.root), _local_path(args.work_root)
            c.require(not source.is_relative_to(root) and not source.is_relative_to(work),
                      "descriptor must be outside stage and work")
            raw = source.read_bytes()
            result = probe_runtime(root, work, c.document(raw), args.timeout, runtime_python=args.runtime_python)
            c.require(source.read_bytes() == raw, "probe descriptor changed")
            result["descriptor_file_sha256"] = c.sha256(raw)
            print(json.dumps(result, ensure_ascii=False))
            return 0
        except Exception as exc:
            print(json.dumps({"status": "failed", "release_eligible": False, "error": type(exc).__name__}))
            return 1
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--timeout", type=float, default=90)
    args = parser.parse_args()
    try:
        c.require(os.name == "nt" and 0 < args.timeout <= 600, "Windows/timeout required")
        result = qualify(args.candidate, args.receipt, timeout=args.timeout)
        print(json.dumps({"status": "passed", "run_id": result["run_id"]}))
        return 0
    except Exception as exc:
        # Never print subprocess contents, paths, environment, or user data.
        print(json.dumps({"status": "failed", "release_eligible": False, "error": type(exc).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
