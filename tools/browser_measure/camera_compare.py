"""Synthetic, headless diagnosis; NEVER a replacement for the camera release gate.

Creates two fresh snapshots of the same candidate, changes only RISK_FILES in the
control, and applies identical observation/safety patches. No user DB is copied.
  python -B tools/browser_measure/camera_compare.py --runs 1  # pilot
  python -B tools/browser_measure/camera_compare.py --prepared <pilot-dir> --runs 10
Artifacts are retained. Only processes started by this run are stopped.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib
import io
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[2]
CANDIDATE = "d971883c9356d95d68613dee7973693116004f9a"
CONTROL = "e9b0b49b"
RISK_FILES = (
    "frontend/src/features/canvas/gpu/GpuBoard.tsx",
    "frontend/src/lib/useSceneViewport.ts",
    "frontend/src/lib/sceneStore.ts",
    "frontend/src/lib/sceneBackup.ts",
    "frontend/src/lib/scenes.ts",
)
MARKER = "camera-matched-diagnostic-v1"
PHASE = "({gpu:document.querySelector('.scene-board')?.dataset.gpu,lock:sessionStorage.getItem('mvhub.canvas.gpuLock')})"
PROBE = """(() => {
const p = window.__cameraDiag = {events:[], gaps:[], raf:[], wheel:[], idb:[], net:[]};
window.__cameraEvent = (name, value=0) => p.events.push([performance.now(),name,value]);
(function loop(prev) { requestAnimationFrame(t => {
  p.raf.push(t); if(prev && t-prev>33.4) p.gaps.push([prev,t]); loop(t);
}); })();
addEventListener('wheel', () => p.wheel.push(performance.now()), {capture:true,passive:true});
const tx = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function(names,mode,...args) {
  const result=tx.call(this,names,mode,...args);
  if(mode==='readwrite') { const row=[performance.now(),0]; p.idb.push(row);
    for(const ev of ['complete','abort','error']) result.addEventListener(ev,()=>{if(!row[1])row[1]=performance.now();}); }
  return result;
};
const fetchOriginal=window.fetch;
window.fetch=function(input,init) {
 const url=String(input?.url||input), row=[performance.now(),0];
 if(!url.includes('/api/scenes'))return fetchOriginal.apply(this,arguments);
 p.net.push(row); const result=fetchOriginal.apply(this,arguments);
 result.then(()=>row[1]=performance.now(),()=>row[1]=performance.now()); return result;
};
})();"""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(REPO), *args])


def fixture() -> dict:
    return {"id": "diagnostic", "name": "Synthetic 2000", "created_at": 1,
            "cards": [{"id": f"text-{i}", "kind": "text", "x": i % 50 * 380,
                       "y": i // 50 * 300, "w": 320, "h": 240,
                       "text": f"Card {i}\n" + "Synthetic camera measurement. " * 12}
                      for i in range(2000)], "edges": []}


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if text.count(old) != 1:
        raise ValueError(f"observation anchor is not unique: {path.name}: {old[:65]}")
    path.write_text(text.replace(old, new), encoding="utf-8")


def instrument(root: Path) -> None:
    # Identical safety change in disposable snapshots: never connect to real Resolve.
    replace_once(root / "backend/app/main.py", "            resolve_selection_monitor.start()",
                 "            pass  # diagnostic snapshot: real Resolve monitor disabled")
    event = lambda name, value="0": f'(window as any).__cameraEvent?.("{name}", {value});'
    store = root / RISK_FILES[2]
    anchor = re.search(r"function runStoreTx\([^\n]+\n  return enqueueTx\(async \(\) => \{", store.read_text(encoding="utf-8"))
    if anchor is None:
        raise ValueError("runStoreTx observation anchor missing")
    replace_once(store, anchor[0], anchor[0] + "\n    " + event("tx_start"))
    replace_once(store, "      flushListener?.(false);", "      " + event("tx_failure") + "\n      flushListener?.(false);")
    for anchor, name in (("function compactPending(): void {", "compact"),
                         ("function queuePlainFlush(): void {", "queue")):
        if anchor in store.read_text(encoding="utf-8"):
            replace_once(store, anchor, anchor + "\n  " + event(name))
    backup = root / RISK_FILES[3]
    text = backup.read_text(encoding="utf-8")
    sync = "async function syncNow(retry?: RetryGuard): Promise<void> {" if "interface RetryGuard" in text else "async function syncNow(): Promise<void> {"
    replace_once(backup, sync, sync + "\n  " + event("sync"))
    retry = "function fireRetry(guard: RetryGuard): void {"
    if retry in text:
        replace_once(backup, retry, retry + "\n  " + event("retry"))
    scenes = root / RISK_FILES[4]
    anchor = "  return writeScenePatch(projectId, key, sceneId, { camera },"
    replace_once(scenes, anchor, "  " + event("camera") + "\n" + anchor)
    gpu = root / RISK_FILES[0]
    replace_once(gpu, "        baked = r.baked;", "        baked = r.baked;\n        " + event("bake", "r.baked"))


def prepare(work: Path) -> dict:
    archive = git("archive", "--format=tar", CANDIDATE)
    paths = git("ls-tree", "-r", "-z", "--name-only", CANDIDATE).decode("utf-8").rstrip("\0").split("\0")
    meta = {"format": MARKER, "candidate": CANDIDATE,
            "control_revision": git("rev-parse", CONTROL).decode().strip(), "source": {}, "files": {}}
    modules = (REPO / "frontend/node_modules").resolve(strict=True)
    for variant in ("candidate", "control"):
        root = work / variant
        root.mkdir()  # Never replace or clear an existing directory.
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            if any(m.issym() or m.islnk() for m in source):
                raise ValueError("archive links are not supported")
            source.extractall(root, filter="data")
        if variant == "control":
            for path in RISK_FILES:
                (root / path).write_bytes(git("show", f"{CONTROL}:{path}"))
        meta["source"][variant] = {p: digest((root / p).read_bytes()) for p in paths}
        instrument(root)
        env = {k: v for k, v in os.environ.items() if k not in ("ELECTRON_RUN_AS_NODE", "NoDefaultCurrentDirectoryInExePath")}
        # The junction points only to installed dependencies; no install/update is run.
        subprocess.run(["cmd", "/c", "mklink", "/J", str(root / "frontend/node_modules"), str(modules)],
                       check=True, stdout=subprocess.DEVNULL)
        with (work / f"build-{variant}.log").open("wb") as log:
            subprocess.run([shutil.which("node") or "node", str(modules / "vite/bin/vite.js"), "build"],
                           cwd=root / "frontend", env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        built = [p for p in (root / "frontend/dist").rglob("*") if p.is_file()]
        meta["files"][variant] = {p: digest((root / p).read_bytes()) for p in paths}
        meta["files"][variant].update({p.relative_to(root).as_posix(): digest(p.read_bytes()) for p in built})
    differences = [p for p in paths if meta["source"]["candidate"][p] != meta["source"]["control"][p]]
    if set(differences) != set(RISK_FILES):
        raise ValueError(f"unexpected comparison sources: {differences}")
    meta["different_source_paths"] = differences
    (work / "manifest.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


def validate_prepared(work: Path) -> dict:
    meta = json.loads((work / "manifest.json").read_text(encoding="utf-8"))
    if meta.get("format") != MARKER or meta.get("candidate") != CANDIDATE:
        raise ValueError("not this diagnostic's snapshot")
    if set(meta["different_source_paths"]) != set(RISK_FILES):
        raise ValueError("incorrect comparison scope")
    for variant in ("candidate", "control"):
        root = work / variant
        for path, expected in meta["files"][variant].items():
            target = (root / path).resolve(strict=True)
            if root.resolve() not in target.parents or digest(target.read_bytes()) != expected:
                raise ValueError(f"snapshot changed: {variant}/{path}")
    return meta


def allowed_request(url: str, method: str, origins: set[str]) -> bool:
    parsed = urlsplit(url)
    if f"{parsed.scheme}://{parsed.netloc}" not in origins:
        return False
    if any(word in parsed.path for word in ("resolve", "gen-requests", "agent-chat", "update", "release", "assets/file")):
        return False
    return method in ("GET", "HEAD", "OPTIONS") or parsed.path.startswith("/api/scenes/")


def op_result(probe: dict, start: float, end: float) -> dict:
    wheels = [t for t in probe["wheel"] if start <= t <= end]
    a, z = (wheels[0], wheels[-1] + 100) if wheels else (start, end)
    names = ("tx_start", "tx_failure", "compact", "queue", "sync", "retry", "camera", "bake")
    return {"from": a, "to": z, "wheel_events": len(wheels),
            "animation_frames": sum(a <= t <= z for t in probe.get("raf", [])),
            "gaps33": sum(e >= a and s <= z for s, e in probe["gaps"]),
            "events": {name: sum(a <= t <= z and n == name for t, n, _ in probe["events"]) for name in names},
            "baked_frames": sum(a <= t <= z and n == "bake" and v > 0 for t, n, v in probe["events"]),
            "idb_overlap": sum((e or z) > a and s < z for s, e in probe["idb"]),
            "net_overlap": sum((e or z) > a and s < z for s, e in probe["net"])}


async def run_one(cn, Page, work: Path, root: Path) -> dict:
    work.mkdir()
    hub = cn.Hub(work)
    pids = []
    result = {"status": "incomplete", "processes": [], "blocked": []}

    class DiagnosticPage(Page):
        async def _read(self):
            async for raw in self.ws:
                msg = json.loads(raw)
                if "id" in msg:
                    future = self._pending.pop(msg["id"], None)
                    if future and not future.done():
                        future.set_result(msg)
                elif msg.get("method") == "Fetch.requestPaused":
                    asyncio.create_task(self.respond(msg["params"]))
                elif msg.get("method") == "Runtime.exceptionThrown":
                    result.setdefault("page_errors", []).append(msg["params"].get("exceptionDetails", {}).get("text", "exception"))
                elif msg.get("method") == "Page.javascriptDialogOpening":
                    asyncio.create_task(self._answer_dialog())

        async def respond(self, params):
            request = params["request"]
            if allowed_request(request["url"], request["method"], {hub.url, hub.shared.url}):
                await self.send("Fetch.continueRequest", requestId=params["requestId"])
            else:
                result["blocked"].append({"path": urlsplit(request["url"]).path, "method": request["method"]})
                await self.send("Fetch.failRequest", requestId=params["requestId"], errorReason="BlockedByClient")

    try:
        hub.start(root)
        pids.extend(p for p in (hub.proc, hub.shared.proc) if p)
        result["isolation"] = {k: v for k, v in hub.isolation.items() if "url" not in k}
        async with DiagnosticPage(0, work / "profile") as page:
            pids.append(page.proc)
            await page.send("Fetch.enable", patterns=[{"urlPattern": "*"}])
            bucket = f"acct:{hub.shared.email.lower()}::_none"
            storage = {"ch.activeAccount": hub.shared.email.lower(), "mvhub.canvas.gpuBoard": "1",
                       "ch.scenes": json.dumps({bucket: [fixture()]}),
                       "ch.scenes.active": json.dumps({bucket: "diagnostic"}), "ch.lib.filters": '{"tab":"compose"}'}
            # Keep the normal owned-hub WebSocket, but reject every other origin.
            websocket_guard = f"""const OriginalWS=window.WebSocket;
window.WebSocket=class extends OriginalWS {{constructor(url,protocols){{
 const u=new URL(url,location.href); if(u.origin!=={json.dumps(hub.url.replace('http:', 'ws:'))})throw new Error('External WebSocket blocked');
 super(url,...(protocols===undefined?[]:[protocols])); }} }};"""
            seed = f"if(location.origin==={json.dumps(hub.url)}){{{websocket_guard}for(const [k,v] of Object.entries({json.dumps(storage)}))localStorage.setItem(k,v);}}"
            await page.send("Page.addScriptToEvaluateOnNewDocument", source=PROBE + seed)
            await page.goto(hub.url, settle=1)
            await cn.Measurement.ensure_canvas(None, page)
            stored = cn.scene_rows(await page.eval(cn.READ_STORE), bucket)
            if len(stored) != 1 or len(stored[0].get("cards", [])) != 2000:
                raise RuntimeError("2,000-card fixture did not reach the browser store")
            result["stored_cards"] = 2000

            async def fit():
                if not await page.click("document.querySelector('.scene-minimap-fit')"):
                    raise RuntimeError("fit control unavailable")
                await asyncio.sleep(0.5)

            await fit()
            if not await page.wait("document.querySelector('.scene-board')?.dataset.gpu === 'gpu'", 40):
                result["phase"] = await page.eval(PHASE)
                raise RuntimeError("GPU entry precondition failed")
            await asyncio.sleep(10)
            box = await page.eval("(()=>{const r=document.querySelector('.scene-board').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()")
            await page.send("Emulation.setCPUThrottlingRate", rate=4)
            result["start"] = await page.eval(PHASE)
            await fit()
            await page.send("Input.dispatchMouseEvent", type="mouseMoved", **box)
            await asyncio.sleep(2.2)
            before = await page.eval("performance.now()")
            for _ in range(10):
                await page.send("Input.dispatchMouseEvent", type="mouseWheel", **box, deltaX=0, deltaY=100)
                await asyncio.sleep(0.08)
            after = await page.eval("performance.now()")
            await asyncio.sleep(5)
            probe = await page.eval("window.__cameraDiag")
            result.update({"end": await page.eval(PHASE), "low_out": op_result(probe, before, after), "raw": probe})
            await page.send("Emulation.setCPUThrottlingRate", rate=1)
            if result["low_out"]["wheel_events"] != 10:
                raise RuntimeError("not all ten wheel inputs reached the page")
            if result["low_out"]["animation_frames"] < 10:
                raise RuntimeError("insufficient animation-frame observations")
            if result.get("page_errors"):
                raise RuntimeError("unexpected page runtime errors")
            result["status"] = "measured" if result["end"]["gpu"] == "gpu" and not result["end"]["lock"] else "locked"
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        # The Hub owns S separately. Always stop both, including partial startup.
        for proc in (hub.proc, hub.shared.proc):
            if proc is not None and proc not in pids:
                pids.append(proc)
        try:
            hub.stop()
        finally:
            hub.shared.stop()
        result["processes"] = [{"pid": p.pid, "exit_code": p.poll()} for p in pids]
    return result


async def measure(work: Path, runs: int) -> Path:
    validate_prepared(work)
    # Import both H and S helpers from the frozen candidate, never the moving dev.
    sys.path.insert(0, str(work / "candidate/tools"))
    cn = importlib.import_module("browser_measure.canvas_notebook")
    Page = importlib.import_module("browser_measure.cdp").Page
    if cn.REPO.resolve() != (work / "candidate").resolve():
        raise RuntimeError("measurement helpers are not from the frozen candidate")
    base_env = cn.servers.server_env

    def env(parent, name, port, data):
        result = base_env(parent, name, port, data)
        result.update({"CONTENT_HUB_AGENT_CHAT": "0", "CONTENT_HUB_AGENT_CHAT_DIR": str(data / "agent-chat")})
        return result

    cn.servers.server_env = env
    output = work / f"run-{time.time_ns()}"
    output.mkdir()
    report = {"format": MARKER, "kind": "synthetic-headless-low-out-only", "formal_gate": "not evaluated",
              "driver_sha256": digest(Path(__file__).read_bytes()),
              "requested_pairs": runs, "fixture_sha256": digest(json.dumps(fixture(), sort_keys=True).encode()),
              "cards": 2000, "cpu_rate": 4, "rows": [], "helper_root": str(cn.REPO),
              "limits": ["text-only synthetic fixture, not the original scene", "headless, not hidden desktop",
                         "low_out prefix only; remaining four operations not executed", "fetch timing ends at response headers",
                         "owned-hub WebSocket allowed; Resolve monitor disabled in both snapshots"]}
    target = output / "report.json"
    try:
        for index in range(runs):
            order = ("control", "candidate") if index % 2 == 0 else ("candidate", "control")
            for variant in order:
                row = await run_one(cn, Page, output / f"{index:02}-{variant}", work / variant)
                report["rows"].append({"pair": index, "variant": variant, **row})
                target.write_text(json.dumps(report, indent=2), encoding="utf-8")
                print(json.dumps({"pair": index, "variant": variant, "status": row["status"],
                                  "gaps33": row.get("low_out", {}).get("gaps33"), "error": row.get("error")}), flush=True)
                if row["status"] == "incomplete":
                    raise RuntimeError("precondition failed; retained partial report")
        report["summary"] = {v: {"gaps33": [r["low_out"]["gaps33"] for r in report["rows"] if r["variant"] == v],
                                 "locked": sum(r["status"] == "locked" for r in report["rows"] if r["variant"] == v)}
                             for v in ("control", "candidate")}
        for item in report["summary"].values():
            item["median"] = statistics.median(item["gaps33"])
            item["total"] = sum(item["gaps33"])
    finally:
        target.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"REPORT {target}", flush=True)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", type=Path)
    parser.add_argument("--runs", type=int, default=10)
    args = parser.parse_args()
    if not 1 <= args.runs <= 30:
        parser.error("runs must be 1..30")
    work = args.prepared.resolve(strict=True) if args.prepared else Path(tempfile.mkdtemp(prefix="mvhub-camera-"))
    print(f"ARTIFACTS {work}", flush=True)
    if not args.prepared:
        prepare(work)
    asyncio.run(measure(work, args.runs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
