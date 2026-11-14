"""Retained camera scripts, fixed sources and owned, isolated Windows workers.

prepare creates a NEW directory; pilot and measure retain every attempted row.
No original builder/runner is executed. Performance runs require prior review.
"""
from __future__ import annotations

import argparse
import ast
import asyncio
import collections
import hashlib
import http.server
import importlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import types
import urllib.request
import uuid
from urllib.parse import unquote, urlsplit

if __package__:
    from . import camera_ab_check as ab
else:
    import camera_ab_check as ab

REPO = Path(__file__).resolve().parents[2]
HOME = REPO.parent / "work/cam-save-handoff"
SOURCES = {
    "src_o": "cea6e4baf663351a07e0d6bf99ce4444d2d6ba87",
    "src_pred": "9d31e32a21d0f4da206ab11b81088ff8d72aa70c",
    "src_n": "d971883c9356d95d68613dee7973693116004f9a",
}
INPUTS = {
    "measure/scene.json": "7151a1812165ebb56a88395666aa534a298a8dd31b7d26f824c3f49c5c3957ce",
    "measure/scene_2000.json": "58430f33dbec92edd4a0231e1e38c56a9a60f7749865ff16b5300164d11fb556",
    "measure/real_measure.py": "f499d0e3732957bc13e82a7630f6795dc16c50bc50fa30d23c0fbaecd9b0b50d",
    "measure/risk_diag.py": "736e86ba3069356b58e5cc3ddb693eba3bcf7de601589169a77f44b88c335df7",
    "measure/check_risk_measure2.py": "bcaaf37fd766ea8f56043e8975d40640a112c3f50a15240f49657ea8bb0986f5",
    "measure/build_r2diag.py": "de09ba3893dd8790cbc704bd46af42d4aaae36f7311ff9d9f455df12ff397f57",
    "anchor/anchor_measure.py": "2a798dde0fbfb6f11c1adac64cb55b9f9b326e1b746d7b4a222baf8011a52aa3",
    "anchor/pan_measure.py": "3236844e1c5d79435a74c7c12cafd2e61941b033fca6b37b6496a7d33d3df626",
}
MODES = (
    ("bake", ("src_o", "src_n"), ("1",), (4,), "bake5"),
    ("ops", ("src_o", "src_n"), ("1",), (4,), "ops5"),
    ("switch", ("src_pred", "src_n"), ("0", "1"), (1, 4), "switch5n"),
    ("judge", ("src_n",), ("1",), (4,), "judge5"),
)
MEDIA = ("/api/assets/thumb", "/api/assets/file", "/media/", "/api/media-thumb", "/api/assets/locate")
MARKER = "camera-original-65-v1"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(REPO), *args])


def save(path: Path, value) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)


def clean_env(parent) -> dict:
    return {k: v for k, v in parent.items() if not k.upper().startswith(
        ("CONTENT_HUB_", "RD_", "REAL_", "PAN_", "PYTHONPATH", "PYTHONHOME")) and k.upper() not in {
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "ELECTRON_RUN_AS_NODE",
            "NODE_OPTIONS", "NODE_PATH", "NODE_ENV", "NODE_V8_COVERAGE",
            "MVHUB_OPEN_LINK", "MVHUB_REGISTER_LINK", "NODEFAULTCURRENTDIRECTORYINEXEPATH", "CAMERA_ORIGINAL_WORKER"}}


def read_inputs(home: Path) -> dict[str, bytes]:
    data = {name: (home / name).read_bytes() for name in INPUTS}
    if any(sha(data[name]) != expected for name, expected in INPUTS.items()):
        raise ValueError("retained input hash mismatch")
    for name, size in (("scene.json", 792119), ("scene_2000.json", 3976525)):
        if len(data[f"measure/{name}"]) != size:
            raise ValueError("retained scene size mismatch")
    return data


def patch_definitions(builder: str) -> list:
    # Evaluate ONLY the eight constant tuples, never any builder statement/call.
    values = {}
    for node in ast.parse(builder).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name not in {"G", "GPU", "SCN", "P"}:
                continue
            allowed = (ast.Constant, ast.List, ast.Tuple, ast.JoinedStr, ast.FormattedValue, ast.Name, ast.Load)
            if any(not isinstance(n, allowed) for n in ast.walk(node.value)):
                raise ValueError("nonconstant observation definition")
            values[name] = eval(compile(ast.Expression(node.value), "<patch constants>", "eval"),
                                {"__builtins__": {}}, values)
    patches = values["P"]
    if [p[0] for p in patches] != ["draw", "judge", "pending", "tick", "cand", "cam", "flush0", "flush1"]:
        raise ValueError("unexpected observation patches")
    return patches


def apply_observations(original: str, patches: list) -> str:
    updated = original
    for name, _path, count, before, after in patches:
        if updated.count(before) != count or after in updated:
            raise ValueError(f"observation anchor mismatch: {name}")
        updated = updated.replace(before, after)
    reverse = updated
    for _name, _path, count, before, after in reversed(patches):
        if reverse.count(after) != count:
            raise ValueError("observation reversal mismatch")
        reverse = reverse.replace(after, before)
    if reverse != original:
        raise ValueError("observation changed product logic")
    return updated


def safe_risk_source(source: str) -> str:
    tree = ast.parse(source)
    mains = [n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "main"]
    last = tree.body[-1]
    if len(mains) != 1 or ast.unparse(last) != "asyncio.run(main())":
        raise ValueError("original runner entry changed")
    lines = source.splitlines(keepends=True)
    for node in (last, mains[0]):
        lines[node.lineno - 1:node.end_lineno] = ["\n"] * (node.end_lineno - node.lineno + 1)
    result = "".join(lines)
    expected = [n for n in tree.body if n not in (mains[0], last)]
    if ast.dump(ast.Module(body=expected, type_ignores=[])) != ast.dump(ast.parse(result)):
        raise ValueError("measurement functions changed")
    return result


def schedule(original: str, count: int = 5) -> list[dict]:
    main = next(n for n in ast.parse(original).body if isinstance(n, ast.AsyncFunctionDef) and n.name == "main")
    loop = next(n for n in main.body if isinstance(n, ast.For))
    # Reuse the original four nested loops and key expression, omitting their actions.
    copied = ast.parse(ast.unparse(loop)).body[0]
    inner = copied
    for _ in range(3):
        inner = inner.body[0]
        if not isinstance(inner, ast.For):
            raise ValueError("original iteration structure changed")
    key_assignment = inner.body[0]
    if not isinstance(key_assignment, ast.Assign) or ast.unparse(key_assignment.targets[0]) != "key":
        raise ValueError("original key changed")
    inner.body = [key_assignment, ast.parse("rows.append((i, src, flag, rate, key))").body[0]]
    code = compile(ast.fix_missing_locations(ast.Module(body=[copied], type_ignores=[])), "<original order>", "exec")
    out = []
    for mode, sources, flags, rates, tag in MODES:
        scope = dict(N=count, SRCS=list(sources), FLAGS=flags, RATES=rates, rows=[])
        exec(code, {"__builtins__": {"range": range, "list": list, "reversed": reversed, "int": int}}, scope)
        expected = [(i, src, flag, rate, f"{src}|gpu{flag}|x{rate}") for i in range(count)
                    for src in (sources if i % 2 == 0 else sources[::-1]) for flag in flags for rate in rates]
        if scope["rows"] != expected:
            raise ValueError("original execution order changed")
        out.extend(dict(mode=mode, round=i + 1, src=src, flag=flag, rate=rate, key=key, tag=tag)
                   for i, src, flag, rate, key in expected)
    return out


def extract_archive(data: bytes, destination: Path) -> None:
    destination.mkdir()
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            target = (destination / member.name).resolve()
            if not (member.isfile() or member.isdir()) or destination.resolve() not in target.parents:
                raise ValueError("unsafe source archive member")
        archive.extractall(destination, filter="data")


def package_links(source: Path, target: Path) -> dict:
    target.mkdir()
    versions = {}
    packages = [p for p in source.iterdir() if not p.name.startswith(".")]
    for entry in packages:
        children = list(entry.iterdir()) if entry.name.startswith("@") else [entry]
        if entry.name.startswith("@"):
            (target / entry.name).mkdir()
        for package in children:
            rel = package.relative_to(source)
            if not package.is_dir() or not (package / "package.json").is_file():
                raise ValueError("installed package is not a package directory")
            versions[rel.as_posix()] = json.loads((package / "package.json").read_text(encoding="utf-8"))["version"]
            subprocess.run(["cmd", "/d", "/c", "mklink", "/J", str(target / rel), str(package.resolve())],
                           check=True, stdout=subprocess.DEVNULL)
    return versions


def scene_summary(data: bytes) -> dict:
    scene = json.loads(data)
    schemes = collections.Counter()

    def walk(value):
        if isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, str) and re.match(r"^(https?|blob|data|file):", value):
            schemes[value.split(":", 1)[0]] += 1
    walk(scene)
    return {"bytes": len(data), "sha256": sha(data), "cards": len(scene.get("cards", [])),
            "edges": len(scene.get("edges", [])), "groups": len(scene.get("groups", [])), "url_schemes": dict(schemes)}


def prepare(work: Path, home: Path | None = None, experiment: Path | None = None) -> None:
    home = (home or HOME).resolve()
    work = work.resolve()
    if work.parent != home or not work.name.startswith("run-ab-" if experiment else "run-"):
        raise ValueError("new run must be a direct run-* child of the retained folder")
    if work.exists():
        raise FileExistsError("run folder already exists")
    spec_bytes = experiment.read_bytes() if experiment else None
    spec = ab.loads(spec_bytes) if experiment else None
    source_evidence = ab.source_check(spec, git) if experiment else None
    inputs = read_inputs(home)
    work.mkdir()  # No reuse, overwrite or removal.
    meta = {"format": MARKER, "sources": SOURCES, "inputs": INPUTS, "files": {}, "source_hashes": {},
            "patches": {}, "scenes": {}, "packages": {}, "static_resources": {}, "tool": sha(Path(__file__).read_bytes())}
    if spec is not None:
        meta.update(format=spec["format"], sources=spec["sources"], home=str(home), contract=ab.contract_for(spec["format"]),
                    experiment_sha256=sha(ab.canonical(spec)), source_evidence=source_evidence,
                    reviewed_tools={"camera_original.py": meta["tool"],
                                    "camera_ab_check.py": sha(Path(ab.__file__).read_bytes())})
        (work / "experiment.json").write_bytes(spec_bytes)
        meta["files"]["experiment.json"] = sha(spec_bytes)
    for folder in ("anchor", "measure"):
        (work / folder).mkdir()
    for name, content in inputs.items():
        target = work / name
        if name.endswith("build_r2diag.py"):
            continue  # Constant definitions are already read; never stage an executable builder.
        if name.endswith("risk_diag.py"):
            content = safe_risk_source(content.decode("utf-8")).encode("utf-8")
        elif name.endswith("anchor_measure.py"):
            old = b'SRC = HERE / "src"'
            if content.count(old) != 1:
                raise ValueError("anchor source binding changed")
            content = content.replace(old, b'SRC = HERE.parent / "measure" / "src_n"')
        target.write_bytes(content)
        if name.endswith(".json"):
            meta["scenes"][name] = scene_summary(content)
    patches = patch_definitions(inputs["measure/build_r2diag.py"].decode("utf-8"))
    for variant, revision in meta["sources"].items():
        root = work / "measure" / variant
        extract_archive(git("archive", "--format=tar", revision), root)
        files = [p for p in root.rglob("*") if p.is_file()]
        meta["source_hashes"][variant] = {p.relative_to(root).as_posix(): sha(p.read_bytes()) for p in files}
        chosen = patches[:1] if variant == "src_pred" else patches
        for rel in dict.fromkeys(p[1] for p in chosen):
            path = root / rel
            original = path.read_text(encoding="utf-8")
            updated = apply_observations(original, [p for p in chosen if p[1] == rel])
            path.write_bytes(updated.encode("utf-8"))
            meta["patches"][f"{variant}/{rel}"] = {"before": sha(original.encode()), "after": sha(updated.encode())}
        main = root / "backend/app/main.py"
        text = main.read_text(encoding="utf-8")
        before = "            resolve_selection_monitor.start()"
        if text.count(before) != 1:
            raise ValueError("Resolve monitor anchor changed")
        main.write_bytes(text.replace(before, "            pass  # diagnostic snapshot: real Resolve monitor disabled").encode())
        config = "\n".join(p.read_text(encoding="utf-8") for p in files
                           if p.suffix == ".py" and p.is_relative_to(root / "backend/app"))
        for key in ("CONTENT_HUB_AGENT_CHAT", "CONTENT_HUB_AGENT_CHAT_DIR", "CONTENT_HUB_DATA", "CONTENT_HUB_DB",
                    "CONTENT_HUB_SHARED_URL", "CONTENT_HUB_NO_PROXY", "CONTENT_HUB_SERVER_SYNC"):
            if key not in config:
                raise ValueError(f"fixed backend lacks isolation key: {key}")
        (root / "HEAD_SHA.txt").write_text(revision, encoding="ascii")
        meta["packages"][variant] = package_links(REPO / "frontend/node_modules", root / "frontend/node_modules")
        with (work / f"build-{variant}.log").open("xb") as log:
            subprocess.run([shutil.which("node") or "node", str(root / "frontend/node_modules/vite/bin/vite.js"), "build"],
                           cwd=root / "frontend", env=clean_env(os.environ), stdout=log, stderr=subprocess.STDOUT, check=True)
        meta["static_resources"][variant] = check_static_requests(root / "frontend/dist")
        files += [root / "HEAD_SHA.txt"] + [p for p in (root / "frontend/dist").rglob("*") if p.is_file()]
        for path in files:
            meta["files"][path.relative_to(work).as_posix()] = sha(path.read_bytes())
    for name in inputs:
        if (work / name).is_file():
            meta["files"][name] = sha((work / name).read_bytes())
    rows = schedule(inputs["measure/risk_diag.py"].decode("utf-8"), 10 if spec is not None else 5)
    if spec is not None:
        # Compare against the retained loop as well as the independent fixed contract.
        rows = [{**r, "src": "src_o" if r["src"] == "src_pred" else r["src"],
                 "key": r["key"].replace("src_pred", "src_o"), "tag": r["mode"] + "10"}
                for r in rows if r["mode"] in ab.rounds_for(spec["format"])]
        ab.require(rows == ab.order(spec["format"]), "AB order differs from retained loop")
    save(work / "order.json", rows)
    meta["files"]["order.json"] = sha((work / "order.json").read_bytes())
    save(work / "manifest.json", meta)


def validate(work: Path) -> dict:
    meta = ab.read(work / "manifest.json")
    if meta.get("format") in (ab.FORMAT, ab.N2_FORMAT):
        spec = ab.read(work / "experiment.json")
        ab.spec_check(spec)
        ab.require(work.resolve().parent == Path(meta["home"]).resolve() and work.name.startswith("run-ab-"), "AB run escaped retained home")
        ab.require(meta["format"] == spec["format"] and meta["contract"] == ab.contract_for(spec["format"])
                   and meta["experiment_sha256"] == sha(ab.canonical(spec)), "experiment contract changed")
        ab.require(meta["sources"] == spec["sources"] and meta["inputs"] == INPUTS, "AB sources/inputs changed")
        ab.require(meta["source_evidence"] == ab.source_check(spec, git), "AB source evidence changed")
        ab.require(meta["reviewed_tools"] == {"camera_original.py": sha(Path(__file__).read_bytes()),
                                             "camera_ab_check.py": sha(Path(ab.__file__).read_bytes())}, "reviewed tools changed")
        ab.require(ab.canonical(ab.read(work / "order.json")) == ab.canonical(ab.order(spec["format"])), "AB order changed")
        ab.require({"experiment.json", "order.json", *INPUTS.keys()} - {"measure/build_r2diag.py"} <= meta["files"].keys(), "incomplete manifest")
    elif meta.get("format") != MARKER or meta.get("sources") != SOURCES or meta.get("inputs") != INPUTS:
        raise ValueError("not the fixed original experiment")
    if meta["tool"] != sha(Path(__file__).read_bytes()):
        raise ValueError("execution tool changed since prepare")
    for rel, expected in meta["files"].items():
        path = (work / rel).resolve(strict=True)
        if work.resolve() not in path.parents or sha(path.read_bytes()) != expected:
            raise ValueError("prepared source/tool/build changed")
    return meta


def load_fixed(name: str, relative: str, root: Path | None = None):
    data = git("show", f"{SOURCES['src_n']}:{relative}")
    if root is not None and (root / relative).read_bytes() != data:
        raise ValueError("fixed helper changed")
    module = types.ModuleType(name)
    module.__file__ = str((root or REPO) / relative)
    exec(compile(data, module.__file__, "exec"), module.__dict__)
    return module


def run_owned(command: list[str], log: Path, timeout: float, fixed_root: Path | None = None) -> dict:
    module = load_fixed("camera_job", "backend/app/services/win_job.py", fixed_root)
    job, process = module.ProcessJob(), None
    result = {"command": command, "status": "incomplete", "active_after": None}
    try:
        with log.open("xb") as output:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                       env={**clean_env(os.environ), "CAMERA_ORIGINAL_WORKER": "1"},
                                       creationflags=module.CREATE_SUSPENDED | subprocess.CREATE_NO_WINDOW)
            result["pid"] = process.pid
            job.adopt_suspended(process.pid)
            try:
                result["exit_code"] = process.wait(timeout=timeout)
                result["status"] = "exited"
            except subprocess.TimeoutExpired:
                result["status"] = "timeout"
    except BaseException as exc:
        result["error_type"] = type(exc).__name__
    finally:
        cleanup_errors = []
        try:
            # Also handles a worker exiting before its own Chrome/server descendants.
            if job.active():
                result["active_before_termination"] = job.active()
                job.terminate()
        except BaseException as exc:
            cleanup_errors.append(type(exc).__name__)
        try:
            if process is not None and process.poll() is None:
                process.kill()  # This exact child may have failed adoption while suspended.
        except BaseException as exc:
            cleanup_errors.append(type(exc).__name__)
        try:
            if process is not None:
                process.wait(timeout=5)
        except BaseException as exc:
            cleanup_errors.append(type(exc).__name__)
        try:
            deadline = time.monotonic() + 10
            while job.active() and time.monotonic() < deadline:
                time.sleep(0.05)
            result["active_after"] = job.active()
        except BaseException as exc:
            cleanup_errors.append(type(exc).__name__)
        try:
            job.close()
        except BaseException as exc:
            cleanup_errors.append(type(exc).__name__)
        finally:
            result["cleanup_errors"] = cleanup_errors
            save(log.with_suffix(".job.json"), result)
    if result["active_after"] != 0 or "error_type" in result or cleanup_errors:
        raise RuntimeError("owned process adoption/reaping was not confirmed")
    return result


def request_kind(url: str, method: str, origins: set[str]) -> str:
    parsed = urlsplit(url)
    if parsed.scheme in ("http", "https") and any(p in url for p in MEDIA):
        return "fake-media"
    if parsed.scheme in ("data", "blob"):
        return "local-resource"
    if f"{parsed.scheme}://{parsed.netloc}" not in origins:
        return "blocked-origin"
    if (method, parsed.path) in (("POST", "/api/generations/batch"), ("GET", "/api/update-notices")):
        return "owned"
    if (method, parsed.path) == ("GET", "/api/release-update/status"):
        return "disabled-background"
    path = unquote(parsed.path).lower()
    if path.startswith("/api/") and any(p in path for p in ("resolve", "gen-requests", "agent-chat", "update", "release")):
        return "blocked-api"
    if method in ("GET", "HEAD", "OPTIONS") or parsed.path.startswith("/api/scenes/"):
        return "owned"
    return "blocked-method"


def request_label(url: str, method: str, hub_url: str, origins: set[str]) -> str:
    parsed = urlsplit(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    scope = "hub" if origin == hub_url else "shared" if origin in origins else "outside"
    verb = method if method in ("GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE") else "other"
    route = {
        "/api/generations/batch": "generations.batch",
        "/api/update-notices": "update-notices.list",
        "/api/release-update/status": "release-update.status",
        "/api/gen-requests/canvas-links/resolve": "canvas-links.resolve",
        "/api/comfy/canvas-runs/resolve": "comfy-canvas-runs.resolve",
    }.get(parsed.path, "other")
    return f"{scope}|{verb}|{route}"


def check_static_requests(dist: Path) -> int:
    paths = [p for p in dist.rglob("*") if p.is_file() and p.suffix in (".js", ".css")]
    if not paths:
        raise ValueError("build has no static JS/CSS")
    origin = "http://127.0.0.1:54321"
    if any(request_kind(origin + "/" + p.relative_to(dist).as_posix(), "GET", {origin}) != "owned" for p in paths):
        raise ValueError("normal built resource would be blocked")
    return len(paths)


def websocket_guard(origin: str) -> str:
    return f"""(() => {{ const W=window.WebSocket; window.__blockedWS=0;
window.WebSocket=class extends W {{ constructor(url, protocols) {{
const u=new URL(url,location.href);if(u.protocol==='http:')u.protocol='ws:';if(u.protocol==='https:')u.protocol='wss:';
if(u.origin!=={json.dumps(origin.replace('http:', 'ws:'))}) {{
window.__blockedWS++; throw new Error('WebSocket outside owned hub'); }}
super(url,...(protocols===undefined?[]:[protocols])); }} }}; }})();"""


def guarded_page(base, origins: set[str], hub_url: str, evidence: dict, collect=None):
    evidence["request_routes"] = collections.Counter()
    class Guarded(base):
        async def send(self, method, **params):
            if method == "Fetch.enable":
                params = {"patterns": [{"urlPattern": "*"}]}
            return await super().send(method, **params)

        async def __aenter__(self):
            await super().__aenter__()
            await self.send("Network.setBypassServiceWorker", bypass=True)
            evidence["service_worker_bypass_accepted"] = True
            await self.send("Fetch.enable")
            await self.send("Page.addScriptToEvaluateOnNewDocument", source=websocket_guard(hub_url))
            evidence["chrome_command"] = self.proc.args
            evidence["browser"] = await self.send("Browser.getVersion")
            return self

        async def _read(self):
            original_ws = self.ws
            page = self

            class Filtered:
                def __aiter__(self):
                    return self.messages()

                async def messages(self):
                    async for raw in original_ws:
                        message = json.loads(raw)
                        if message.get("method") == "Fetch.requestPaused":
                            params = message["params"]
                            request = params["request"]
                            kind = request_kind(request["url"], request["method"], origins)
                            evidence["requests"][kind] += 1
                            evidence["request_routes"][request_label(request["url"], request["method"], hub_url, origins)] += 1
                            if kind != "fake-media":
                                args = {"requestId": params["requestId"]}
                                method = "Fetch.continueRequest"
                                if kind.startswith("blocked") or kind == "disabled-background":
                                    method = "Fetch.failRequest"
                                    args["errorReason"] = "BlockedByClient"
                                    if urlsplit(request["url"]).path.endswith((".js", ".css")):
                                        evidence["static_errors"] += 1
                                asyncio.create_task(page.send(method, **args))
                                continue
                        elif message.get("method") == "Runtime.exceptionThrown":
                            evidence["runtime_errors"] += 1
                        elif message.get("method") == "Network.responseReceived":
                            response = message["params"]["response"]
                            path = urlsplit(response["url"]).path
                            if response["status"] >= 400 and path.endswith((".js", ".css")):
                                evidence["static_errors"] += 1
                        yield raw

                async def send(self, *args, **kwargs):
                    return await original_ws.send(*args, **kwargs)

                async def close(self):
                    return await original_ws.close()

            self.ws = Filtered()
            await super()._read()

        async def __aexit__(self, *exc):
            try:
                if not exc[0] and collect is not None:
                    await collect(self)
            finally:
                await super().__aexit__(*exc)
    return Guarded


def synthetic_image_page(Page):
    """Compile the retained image generator/reader only, with no import side effects."""
    source = (HOME / "measure/real_measure.py").read_bytes()
    if sha(source) != INPUTS["measure/real_measure.py"]:
        raise ValueError("retained media helper changed")
    nodes = [n for n in ast.parse(source).body if isinstance(n, (ast.FunctionDef, ast.ClassDef))
             and n.name in ("fake_jpegs", "ImgPage")]
    scope = {"pm": types.SimpleNamespace(TPage=Page), "asyncio": asyncio, "json": json}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<retained fake media>", "exec"), scope)
    scope["ImgPage"].jpegs = scope["fake_jpegs"]()
    return scope["ImgPage"]


async def smoke_worker(work: Path, behavior: str) -> None:
    Page = load_fixed("camera_cdp", "tools/browser_measure/cdp.py").Page
    hits = collections.Counter()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            hits[self.server.server_name] += 1
            if urlsplit(self.path).path == "/api/release-update/status":
                hits["release-status"] += 1
            if self.path == "/api/update-notices":
                hits["notices"] += 1
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"[]")
                return
            scripts = {"/chunk.js": b"window.staticLoaded=true", "/sw.js":
                       b"self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>e.respondWith(new Response('intercepted')));"}
            content = scripts.get(self.path, b"<!doctype html><script src='/chunk.js'></script>")
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript" if self.path in scripts else "text/html")
            self.end_headers()
            self.wfile.write(content)

        def do_POST(self):
            hits[self.server.server_name] += 1
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path == "/api/generations/batch":
                hits["batch"] += 1
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"synthetic":true}')

        def log_message(self, *_args):
            pass

    owned = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    canary = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    owned.server_name, canary.server_name = "owned", "canary"
    for server in (owned, canary):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    own_url, foreign = (f"http://127.0.0.1:{s.server_port}" for s in (owned, canary))
    evidence = {"requests": collections.Counter(), "runtime_errors": 0, "static_errors": 0}
    SafePage = guarded_page(synthetic_image_page(Page), {own_url}, own_url, evidence)
    try:
        async with SafePage(0, work / "chrome", size=(2560, 1400)) as page:
            await page.goto(own_url, settle=0.1)
            checks = await page.eval("""(async () => {
const foreign=FOREIGN; const sizes=[];
for(const path of ['/api/assets/thumb/a','/api/assets/file/a','/media/a','/api/media-thumb/a']) {
sizes.push(await new Promise((resolve,reject)=>{const i=new Image;i.onload=()=>resolve(i.naturalWidth);i.onerror=reject;i.src=foreign+path})); }
const opaque=await fetch(foreign+'/api/assets/locate',{method:'POST',mode:'no-cors',body:JSON.stringify({tokens:['synthetic']})});
const locate=await (await fetch('/api/assets/locate',{method:'POST',body:JSON.stringify({tokens:['synthetic']})})).json();
const batch=await(await fetch('/api/generations/batch',{method:'POST',body:JSON.stringify({ids:['synthetic']})})).json();
const notices=await(await fetch('/api/update-notices')).json();
let outsideApi=0;for(const path of ['/api/generations/batch','/api/update-notices','/api/release-update/status']) {
try{await fetch(foreign+path,{method:path.includes('batch')?'POST':'GET',mode:'no-cors'})}catch{outsideApi++} }
let releaseBlocked=false,wrongMethod=false;
try{await fetch('/api/release-update/status?refresh=true')}catch{releaseBlocked=true}
try{await fetch('/api/generations/batch',{method:'PUT'})}catch{wrongMethod=true}
let blocked=false,ws=false,ownWS=false;try{await fetch(foreign+'/outside')}catch{blocked=true}
try{new WebSocket(foreign.replace('http:','ws:')+'/socket')}catch{ws=true}
try{const w=new WebSocket('/socket');w.close();ownWS=true}catch{}
const blob=URL.createObjectURL(new Blob(['local'],{type:'text/plain'}));
const local=(await(await fetch(blob)).text())==='local';URL.revokeObjectURL(blob);
const data=await(await fetch('data:text/plain,local')).text();
await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
const bypass=await(await fetch('/sw-probe')).text();
return {static:window.staticLoaded===true,jpegs:sizes.every(n=>n===256),locate:locate.open[0]==='synthetic'&&opaque.type==='opaque',
batch:batch.synthetic===true,notices:Array.isArray(notices),outsideApi:outsideApi===3,releaseBlocked,wrongMethod,
blocked,ws,ownWS,blob:local,data:data==='local',serviceWorkerBypass:bypass!=='intercepted'};})()""".replace("FOREIGN", json.dumps(foreign)))
            checks["allowed_api_reached"] = hits["batch"] == 1 and hits["notices"] == 1
            checks["release_api_not_reached"] = hits["release-status"] == 0
            evidence.update(checks=checks, canary_hits=hits["canary"], chrome_pid=page.proc.pid)
            save(work / "smoke.json", evidence)
            if not all(checks.values()) or hits["canary"] or evidence["static_errors"]:
                raise RuntimeError("network canary failed")
            if behavior == "timeout":
                await asyncio.sleep(3600)
            if behavior == "error":
                raise RuntimeError("synthetic worker error")
    finally:
        for server in (owned, canary):
            server.shutdown()
            server.server_close()


def smoke(work: Path) -> None:
    run = work.parent if work.name == "safety-smoke" else work
    if run.resolve().parent != HOME.resolve() or not run.name.startswith("run-"):
        raise ValueError("smoke output must be a new retained run-* directory")
    work.mkdir()
    for behavior in ("normal", "error", "timeout"):
        child = work / behavior
        child.mkdir()
        result = run_owned([sys.executable, "-B", "-X", "utf8", str(Path(__file__).resolve()),
                            "smoke-worker", "--home", str(HOME.resolve()), "--run", str(child), "--row", behavior],
                           child / "worker.log", 30 if behavior == "timeout" else 60)
        evidence = json.loads((child / "smoke.json").read_text(encoding="utf-8"))
        if evidence["canary_hits"] or not all(evidence["checks"].values()):
            raise RuntimeError("smoke incomplete")
        if (behavior == "normal" and result.get("exit_code") != 0
                or behavior == "error" and result.get("exit_code") != 2
                or behavior == "timeout" and result["status"] != "timeout"):
            raise RuntimeError("unexpected smoke worker outcome")
    save(work / "complete.json", {"status": "passed", "cases": ["normal", "error", "timeout"],
                                   "tool": sha(Path(__file__).read_bytes())})


def n2_open_page(base_open, current, evidence, seeded):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    async def open_page(stack, hub, work, flag, scenes, active):
        url = hub.url
        match = re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})", url)
        ab.require(current and hub is current[-1] and match and int(match[1]) <= 65535
                   and int(match[1]) not in (5173, 8012), "seed target is not the owned loopback hub")
        ids = [scene["id"] for scene in scenes]
        ab.require(ids and len(ids) == len(set(ids)), "seed scene IDs must be nonempty and unique")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

        def call(path, body=None):
            ab.require(current and hub is current[-1] and hub.url == url, "seed hub changed")
            request = urllib.request.Request(url + "/api/scenes/" + path,
                data=None if body is None else json.dumps(body, allow_nan=False).encode("utf-8"),
                headers={"Content-Type": "application/json",
                         "X-MVHub-Expect-Account": f"acct:{hub.shared.email.lower()}"},
                method="GET" if body is None else "POST")
            with opener.open(request, timeout=60) as response:
                ab.require(response.status == 200, "seed request failed")
                result = ab.loads(response.read())
            ab.require(isinstance(result, dict), "invalid seed response")
            return result

        book = call("notebook?project_id=")
        generation = book.get("restore_generation")
        ab.require(book["notebook_id"] is None and isinstance(generation, str) and 1 <= len(generation) <= 200,
                   "seed notebook must be unstarted with a restore generation")
        token = call("writer", {"action": "claim", "browser_id": "camera-original-seed", "tab_id": "camera-original-seed"}).get("token")
        ab.require(isinstance(token, str) and 1 <= len(token) <= 200, "seed writer claim failed")
        try:
            start = {"restore_generation": generation, "token": token, "attempt_id": uuid.uuid4().hex,
                     "project_id": "", "expected_count": len(scenes), "order": ids}
            for i in range(0, len(scenes), 200):
                call("notebook/start", {**start, "commit": False, "upserts": [
                    {"id": scene["id"], "name": scene["name"], "data": json.dumps(scene, allow_nan=False)}
                    for scene in scenes[i:i + 200]]})
            committed = call("notebook/start", {**start, "commit": True, "upserts": []})
            notebook_id = committed.get("notebook_id")
            ab.require(committed.get("status") == "committed" and isinstance(notebook_id, str) and notebook_id,
                       "seed start was not committed")
        finally:
            ab.require(call("writer", {"action": "release", "token": token})["writer"] is None,
                       "seed writer was not released")
        confirmed = call("notebook?project_id=")
        live_ids = [item["id"] for item in confirmed["items"] if item["deleted_at"] is None]
        ab.require(confirmed["notebook_id"] == notebook_id and confirmed["restore_generation"] == generation
                   and len(live_ids) == len(ids) and set(live_ids) == set(ids) and confirmed["order"]["ids"] == ids,
                   "seed notebook differs from requested scenes")
        seeded.update(notebook_id=notebook_id, restore_generation=generation, ids=ids)
        evidence["seed"] = {"scenes": len(scenes), "cards": [len(scene["cards"]) for scene in scenes], "notebook_started": True}
        return await base_open(stack, hub, work, flag, [], active)

    return open_page


async def worker(work: Path, row: dict, output: Path) -> None:
    meta = validate(work)
    order = json.loads((work / "order.json").read_text(encoding="utf-8"))
    if row not in order or output.resolve().parent not in (work / "pilot", work / "measurement"):
        raise ValueError("worker row/output is not in the fixed experiment")
    sys.path.insert(0, str(work / "measure"))
    rd = importlib.import_module("risk_diag")
    cn = rd.am.cn
    fixed = work / "measure/src_n"
    if cn.REPO.resolve() != fixed.resolve():
        raise ValueError("H/S helpers are not fixed src_n")
    evidence = {"requests": collections.Counter(), "runtime_errors": 0, "static_errors": 0, "processes": []}
    base_env, base_hub, base_page = cn.servers.server_env, cn.Hub, rd.rm.ImgPage
    seeded = {}

    def env(parent, name, port, data):
        result = base_env(clean_env(parent), name, port, data)
        result.update(CONTENT_HUB_AGENT_CHAT="0", CONTENT_HUB_AGENT_CHAT_DIR=str(data / "agent-chat"))
        if not data.resolve().is_relative_to(work.resolve()):
            raise ValueError("server data escaped the owned run")
        return result

    async def collect(page):
        hub = current[0]
        bucket = f"acct:{hub.shared.email.lower()}::_none"
        entries = await page.eval(cn.READ_STORE)
        stored = cn.scene_rows(entries, bucket)
        if meta.get("format") == ab.N2_FORMAT:
            values = dict(entries)
            account = f"acct:{hub.shared.email.lower()}"
            archives = values.get(json.dumps(["nr", account], ensure_ascii=False, separators=(",", ":")), [])
            joined = values.get(json.dumps(["nj", account], ensure_ascii=False, separators=(",", ":")))
            stored_ids = [scene["id"] for scene in stored]
            empty_archives = isinstance(archives, list) and all(
                isinstance(archive, dict) and isinstance(archive.get("scenes"), dict)
                and all(scenes == [] for scenes in archive["scenes"].values())
                and archive.get("conflicts") == []
                and isinstance(archive.get("controls"), dict) and not archive["controls"]
                for archive in archives)
            ab.require(seeded and empty_archives and isinstance(joined, dict)
                       and joined.get("notebookId") == seeded["notebook_id"]
                       and joined.get("restoreGeneration") == seeded["restore_generation"]
                       and len(stored_ids) == len(seeded["ids"]) and set(stored_ids) == set(seeded["ids"]),
                       "seeded notebook was not adopted without archived data")
            evidence["seed"]["empty_archives"] = len(archives)
        evidence["stored_cards"] = sorted(len(sc.get("cards", [])) for sc in stored)
        evidence["observations"] = await page.eval("""(() => { const p=window.__p,g=window.__gd;
return {raf:p?.raf?.length,draw:g?.draw?.length,tick:g?.tick?.length,cam:g?.cam?.length,
flush:g?.flush?.length,loafSupported:PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'),
loafError:!!p?.loafErr,blockedWS:window.__blockedWS||0}; })()""")
        evidence["renderer"] = await page.eval("""(() => {const c=document.createElement('canvas'),g=c.getContext('webgl2');
if(!g)return null;const e=g.getExtension('WEBGL_debug_renderer_info');return e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER);})()""")
        evidence["phase"] = await page.eval(rd.PHASE)
        if meta.get("format") in (ab.FORMAT, ab.N2_FORMAT):
            evidence["browser_version"] = await page.send("Browser.getVersion")

    current = []

    class Hub(base_hub):
        def start(self, checkout=fixed, **kwargs):
            if checkout.resolve() != (work / "measure" / row["src"]).resolve():
                raise ValueError("unselected backend")
            current.append(self)
            super().start(checkout=checkout, **kwargs)
            evidence["isolation"] = {k: v for k, v in self.isolation.items() if "url" not in k}
            evidence["processes"] = [self.proc.pid, self.shared.proc.pid]
            rd.rm.ImgPage = guarded_page(base_page, {self.url, self.shared.url}, self.url, evidence, collect)

    cn.servers.server_env, cn.Hub = env, Hub
    result = {"row": row, "status": "incomplete", "evidence": evidence}
    base_open = None
    try:
        if meta.get("format") == ab.N2_FORMAT:
            base_open = rd.open_page
            rd.open_page = n2_open_page(base_open, current, evidence, seeded)
        result["measurement"] = await getattr(rd, row["mode"])(row["src"], row["flag"], row["rate"])
        expected = [2060] if row["mode"] in ("bake", "ops") else [412, 412] if row["mode"] == "switch" else [412]
        observation = evidence.get("observations", {})
        if evidence.get("stored_cards") != expected or not observation.get("raf") or not observation.get("loafSupported"):
            raise RuntimeError("scene/RAF/LoAF observation precondition failed")
        if observation.get("loafError") or evidence["static_errors"] or evidence["runtime_errors"]:
            raise RuntimeError("browser instrumentation/resource error")
        if any(n for kind, n in evidence["requests"].items()
               if kind not in ("owned", "fake-media", "local-resource", "disabled-background")) or observation.get("blockedWS"):
            raise RuntimeError("unexpected blocked request")
        # GPU failure/lock stays in the row and original checker; never discard a sample.
        result["status"] = "measured"
    except Exception as exc:
        result["error_type"] = type(exc).__name__
    finally:
        if base_open is not None:
            rd.open_page = base_open
        result["jpeg_hashes"] = [sha(__import__("base64").b64decode(x)) for x in rd.rm.fake_jpegs()]
        result["versions"] = {"python": sys.version, **{p: importlib.import_module(p).__version__ for p in ("PIL", "websockets")}}
        save(output, result)
    if result["status"] != "measured":
        raise RuntimeError("round incomplete; see retained evidence")


def series(work: Path, pilot: bool) -> None:
    meta = validate(work)
    is_ab = meta.get("format") in (ab.FORMAT, ab.N2_FORMAT)
    if is_ab:
        ab.require(Path(meta["home"]).resolve() == HOME.resolve(), "CLI home differs from prepared home")
        pilot_order = [r for r in ab.order(meta["format"]) if r["round"] == 1]
    destination = work / ("pilot" if pilot else "measurement")
    if not pilot:
        gate = json.loads((work / "pilot/complete.json").read_text(encoding="utf-8"))
        if gate.get("status") != "ready":
            raise ValueError("pilot is not ready")
        if is_ab:
            ab.require(type(gate.get("rows")) is int and gate["rows"] == len(pilot_order), "AB pilot row count mismatch")
    else:
        smoke(work / "safety-smoke")
    if is_ab:
        ab.check_smoke(work, meta)
    destination.mkdir()
    order = json.loads((work / "order.json").read_text(encoding="utf-8"))
    if pilot:
        order = [r for r in order if r["round"] == 1]
    aggregates = {m + "10": {} for m in ab.rounds_for(meta["format"])} if is_ab else {tag: {} for *_rest, tag in MODES}
    environment = None
    if is_ab and not pilot:
        _, environment, _ = ab.read_series(work, "pilot", pilot_order)
    for number, row in enumerate(order):
        output = destination / f"row-{number:03}.json"
        command = [sys.executable, "-B", "-X", "utf8", str(Path(__file__).resolve()), "worker",
                   "--home", str(HOME.resolve()), "--run", str(work), "--row", json.dumps(row), "--output", str(output)]
        owned = run_owned(command, destination / f"row-{number:03}.log", 300, work / "measure/src_n")
        if owned.get("exit_code") != 0 or owned["status"] != "exited":
            raise RuntimeError("worker failed; series retained and stopped")
        result = json.loads(output.read_text(encoding="utf-8"))
        if result["status"] != "measured":
            raise RuntimeError("incomplete row")
        if is_ab:
            ab.job_check(owned)
            actual = ab.row_check(result, row)
            ab.require(environment is None or actual == environment, "measurement environment changed")
            environment = actual
        aggregates[row["tag"]].setdefault(row["key"], []).append(result["measurement"])
        if pilot:
            obs = result["evidence"]["observations"]
            renderer = result["evidence"].get("renderer") or ""
            if not renderer or any(s in renderer.lower() for s in ("swiftshader", "llvmpipe", "software", "basic render")):
                raise RuntimeError("pilot hardware renderer precondition failed; row retained")
            if row["flag"] == "1" and not obs.get("draw"):
                raise RuntimeError("pilot GPU precondition failed; row retained")
    for tag, rows in aggregates.items():
        save(destination / f"rd_{tag}.json", rows)
    if pilot:
        save(destination / "complete.json", {"status": "ready", "rows": len(order)})
    elif is_ab:
        finish_ab(work, meta)
    else:
        checker = work / "measure/check_risk_measure2.py"
        # The unchanged checker resolves input JSON beside __file__.
        target = destination / checker.name
        with target.open("xb") as stream:
            stream.write(checker.read_bytes())
        result = run_owned([sys.executable, "-B", "-X", "utf8", str(target)], destination / "checker.log", 30)
        try:
            lines = [line for line in (destination / "checker.log").read_text(encoding="utf-8").splitlines() if line.strip()]
            last = lines[-1] if lines else ""
        except (OSError, UnicodeError):
            last = ""
        failure_prefix = "판정: 미달 — "
        reported = (result.get("exit_code") == 0 and last == "판정: 통과" or
                    result.get("exit_code") == 1 and last.startswith(failure_prefix) and bool(last[len(failure_prefix):].strip()))
        if result["status"] != "exited" or not reported:
            save(destination / "complete.json", {"status": "incomplete", "rows": len(order), "checker": sha(target.read_bytes())})
            raise RuntimeError("checker infrastructure did not complete")
        save(destination / "complete.json", {"status": "passed" if result.get("exit_code") == 0 else "not-passed",
                                               "rows": len(order), "checker": sha(target.read_bytes())})
        if result["exit_code"]:
            raise SystemExit(result["exit_code"])


def finish_ab(work: Path, meta: dict) -> None:
    destination = work / "measurement"
    outcome = run_owned([sys.executable, "-B", "-X", "utf8", str(Path(ab.__file__).resolve()),
                         "--run", str(work)], destination / "checker.log", 120)
    try:
        result = ab.read(destination / "ab-verdict.json")
        code = ab.EXIT_CODES[result["status"]]
        ab.require(outcome["status"] == "exited" and type(outcome["exit_code"]) is int and outcome["exit_code"] == code
                   and type(outcome["active_after"]) is int and outcome["active_after"] == 0 and outcome["cleanup_errors"] == []
                   and "error_type" not in outcome and result["format"] == meta["format"], "checker outcome mismatch")
        if code != 2:
            ab.require(result["experiment_sha256"] == meta["experiment_sha256"] and result["sources"] == meta["sources"], "checker target mismatch")
            ab.require(result == ab.check(work), "checker result differs from evidence")
    except Exception as exc:
        raise RuntimeError("AB checker infrastructure did not complete") from exc
    if code == 2:
        raise SystemExit(2)
    save(destination / "complete.json", {"status": result["status"], "rows": len(ab.order(meta["format"])),
                                        "checker": meta["reviewed_tools"]["camera_ab_check.py"]})
    if code:
        raise SystemExit(code)


def main() -> None:
    global HOME
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "pilot", "measure", "worker", "smoke", "smoke-worker"))
    parser.add_argument("--run", required=True, type=Path)
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--experiment", type=Path)
    parser.add_argument("--row")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    HOME = args.home.resolve(strict=True)
    if args.experiment is not None and args.action != "prepare":
        raise ValueError("experiment is only accepted by prepare")
    if args.action in ("worker", "smoke-worker") and os.environ.get("CAMERA_ORIGINAL_WORKER") != "1":
        raise ValueError("internal workers must be launched by the owned Job supervisor")
    if args.action == "smoke-worker":
        child = args.run.resolve()
        run = child.parent.parent if child.parent.name == "safety-smoke" else child.parent
        if run.parent != HOME or not run.name.startswith("run-") or child.name != args.row or args.row not in ("normal", "error", "timeout"):
            raise ValueError("smoke worker escaped retained folder")
    if args.action in ("pilot", "measure", "worker"):
        if args.run.resolve().parent != HOME.resolve() or not args.run.name.startswith("run-"):
            raise ValueError("run is outside the retained folder")
    if args.action == "prepare":
        prepare(args.run, HOME, args.experiment)
    elif args.action == "smoke":
        smoke(args.run)
    elif args.action == "smoke-worker":
        asyncio.run(smoke_worker(args.run.resolve(), args.row))
    elif args.action == "worker":
        asyncio.run(worker(args.run.resolve(), json.loads(args.row), args.output))
    else:
        series(args.run.resolve(), args.action == "pilot")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"incomplete: {type(error).__name__}; inspect owned artifacts", file=sys.stderr)
        raise SystemExit(2) from None
