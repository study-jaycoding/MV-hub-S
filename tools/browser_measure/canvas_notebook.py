"""Canvas notebook measurements on a NEW isolated hub and two NEW Chrome profiles.

Run with the repository venv, after building frontend/dist:
  python tools/browser_measure/canvas_notebook.py --case cross_browser
  python tools/browser_measure/canvas_notebook.py --case performance --baseline-report <json>
    --max-slowdown <explicit-ratio>   e.g. a reviewer-selected ratio; no default acceptance margin
  python tools/browser_measure/canvas_notebook.py --case performance --baseline-checkout <built-dcb9f49-checkout>
    produces a baseline-only report with 20 identical UI-to-IDB samples, not a contract PASS
  python tools/browser_measure/canvas_notebook.py --case rollback --old-checkout <isolated-checkout>

No default/source DB is opened or copied. Artifacts remain in a newly allocated
temporary directory, printed on exit. Only this process's server/Chrome are stopped.
Exit 0 = all required evidence passed, 1 = failed/unverified. BFCache not used by
Chrome, a missing old checkout/baseline, or missing evidence never counts as success.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import platform
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import AsyncExitStack
from contextlib import closing
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
from browser_measure import servers
from browser_measure.cdp import Page, find_browser
import websockets
from verify_canvas_notebook_measure import CASES, verify

REPO = TOOLS.parent
BUCKET = "local::_none"
FORBIDDEN_PORTS = {8010, 8012}
BASELINE_REVISION = "dcb9f49fea0428cf757e2c2cac6067b38e626e1a"
LATENCY_METHOD = "CDP rename interaction to durable IndexedDB"
MEASURE_SCRIPT = """(() => {
  window.__measureNetwork = []; window.__measureLeaseTokens = []; window.__measurePageShows = [];
  addEventListener('pageshow', event => window.__measurePageShows.push({persisted:event.persisted}));
  const original = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const parsed = new URL(url, location.href), path = parsed.pathname + parsed.search;
    if (!parsed.pathname.startsWith('/api/scenes/')) return original.apply(this, arguments);
    const row = {path, method:init?.method || 'GET', start:performance.timeOrigin+performance.now()};
    if (typeof init?.body === 'string') { try { row.upserts = JSON.parse(init.body).upserts?.length || 0; } catch {} }
    window.__measureNetwork.push(row);
    return original.apply(this, arguments).then(response => {
      response.clone().text().then(text => {
        row.end=performance.timeOrigin+performance.now(); row.status=response.status;
        if (parsed.pathname === '/api/scenes/writer') { try { const data=JSON.parse(text); if(data.token) window.__measureLeaseTokens.push(data.token); } catch {} }
      }).catch(() => { row.failed=true; });
      return response;
    }, error => { row.failed=true; throw error; });
  };
})()"""
READ_STORE = """(async () => {
  if (!(await indexedDB.databases()).some(db => db.name === 'mvhub-scenes')) return [];
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open('mvhub-scenes');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('kv', 'readonly'), store = tx.objectStore('kv');
      const keys = store.getAllKeys(), values = store.getAll();
      tx.oncomplete = () => { const rows = keys.result.map((key, i) => [key, values.result[i]]); db.close(); resolve(rows); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
})()"""


def fresh_port() -> int:
    for _ in range(20):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        if port not in FORBIDDEN_PORTS:
            return port
    raise RuntimeError("no isolated port available")


def validate_checkout(path: Path) -> Path:
    path = path.resolve(strict=True)
    # Running a checkout is explicit, but a live installation/source is not a test checkout.
    forbidden = {"mv-hub-s-dev", "mv-hub-s-release", "mv-hub-s", "data", "data_test"}
    if any(part.casefold() in forbidden for part in path.parts):
        raise ValueError("live/source checkout is forbidden; provide a separate old checkout")
    if not (path / "backend" / "serve.py").is_file() or not (path / "frontend" / "dist" / "index.html").is_file():
        raise ValueError("checkout needs backend/serve.py and built frontend/dist/index.html")
    return path


def make_env(data: Path, port: int, checkout: Path = REPO, *, legacy: bool = False) -> dict[str, str]:
    if port in FORBIDDEN_PORTS or not 1024 <= port <= 65535:
        raise ValueError("unsafe measurement port")
    env = servers.server_env(os.environ, "H", port, data.resolve())
    env["CONTENT_HUB_FRONTEND_DIST"] = str(checkout / "frontend" / "dist")
    if not legacy:
        env["CONTENT_HUB_SCENE_WRITER_TEST"] = "1"
    return env


def fixture(*, performance: bool = False) -> list[dict]:
    result = []
    for i in range(10 if performance else 3):
        cards = [{"id": f"card-{j}", "kind": "text", "x": (j % 20) * 380, "y": (j // 20) * 320,
                  "w": 320, "h": 240, "text": "synthetic"} for j in range(357 if performance and i == 0 else 1)]
        item = {"id": f"measure-{i}", "name": f"measure-{i}", "created_at": 1, "cards": cards, "edges": []}
        if performance:
            item["cards"][-1]["text"] += "x" * max(0, 150 * 1024 - len(json.dumps(item).encode()))
        result.append(item)
    return result


def scene_rows(entries: list) -> list[dict]:
    values = dict(entries)
    order = values.get(json.dumps(["o", BUCKET], separators=(",", ":")), [])
    return [values[json.dumps(["s", BUCKET, sid], separators=(",", ":"))] for sid in order
            if json.dumps(["s", BUCKET, sid], separators=(",", ":")) in values]


def percentile(values: list[float], q: float) -> float:
    return sorted(values)[min(len(values) - 1, int((len(values) - 1) * q))]


def sync_window(records: list[dict]) -> dict:
    writes = [r for r in records if r.get("method") == "PUT" and r.get("path") == "/api/scenes/backup" and r.get("status") == 200 and "end" in r]
    if not writes or sum(r.get("upserts", 0) for r in writes) < 10:
        raise ValueError("ten dirty scenes were not observed in token PUT requests")
    reads = [r for r in records if r.get("path", "").startswith("/api/scenes/notebook?") and r.get("status") == 200 and "end" in r]
    before = [r for r in reads if r["start"] <= writes[0]["start"]]
    after = [r for r in reads if r["start"] >= writes[-1]["end"]]
    if not before or not after:
        raise ValueError("before-upload and after-upload notebook GET evidence missing")
    first, last = before[-1], after[0]
    return {"sync_ms": last["end"] - first["start"], "start_ms": first["start"], "end_ms": last["end"], "upserts": sum(r.get("upserts", 0) for r in writes)}


def retained_rows(work: Path) -> list[dict]:
    database = (work / "hub" / "db" / "content_hub.db").resolve(strict=True)
    if work.resolve() not in database.parents:
        raise ValueError("retained-row inspection must stay inside the owned measurement directory")
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        connection.execute("PRAGMA query_only=ON")
        return [{"scene_id": sid, "reason": reason, "name": name, "data": json.loads(data)}
                for sid, reason, name, data in connection.execute("SELECT scene_id,reason,name,data FROM scene_archive")]


def controlled_launcher(checkout: Path, control_token: str) -> str:
    """Only the owned isolated process gets this fault-injection route, never product files."""
    return f"""import runpy, sys
from fastapi import Request, HTTPException
from app.main import app
from app import active_account
from app.routers.publish import _switch_account_db
@app.post('/api/__measure/account-aba')
async def account_aba(request: Request):
    if request.client.host not in ('127.0.0.1', '::1') or request.headers.get('X-Measure-Control') != {control_token!r}:
        raise HTTPException(403, 'isolated measurement control only')
    before = active_account.account_epoch()
    with active_account.transition_lock:
        _switch_account_db('measure-b@localhost.invalid', 'measure-b')
        active_account.clear_active()
    return {{'before': before, 'after': active_account.account_epoch(), 'account': active_account.account_key()}}
app.router.routes.insert(0, app.router.routes.pop())
sys.argv = [{str(checkout / 'backend' / 'serve.py')!r}]
runpy.run_path(sys.argv[0], run_name='__main__')
"""


class AttachedPage(Page):
    """CDP connection to a floating window in an existing owned Chrome process."""
    def __init__(self, parent: Page, target: dict):
        super().__init__(parent.port, parent.profile)
        self.target = target

    async def __aenter__(self):
        self.ws = await websockets.connect(self.target["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024)
        self._reader = asyncio.create_task(self._read())
        for domain in ("Page", "Runtime", "Network", "Log"):
            await self.send(f"{domain}.enable")
        return self


class Hub:
    def __init__(self, work: Path, *, controls: bool = False):
        self.work, self.port = work, fresh_port()
        self.proc: subprocess.Popen | None = None
        self.log = None
        self.isolation: dict = {}
        self.control_token = secrets.token_urlsafe(32) if controls else None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def request(self, path: str, body: dict | None = None, method: str | None = None):
        if not path.startswith("/api/"):
            raise ValueError("API path required")
        headers = {"Content-Type": "application/json"}
        if path.startswith("/api/__measure/") and self.control_token:
            headers["X-Measure-Control"] = self.control_token
        req = urllib.request.Request(self.url + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method or ("POST" if body is not None else "GET"), headers=headers)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(req, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def start(self, checkout: Path = REPO, *, legacy: bool = False) -> None:
        if self.proc is not None:
            raise RuntimeError("owned server already running")
        data = self.work / "hub"
        data.mkdir(exist_ok=True)
        self.log = (self.work / ("old-server.log" if legacy else "server.log")).open("a", encoding="utf-8")
        command = [sys.executable, "-c", controlled_launcher(checkout, self.control_token)] if self.control_token and not legacy else [sys.executable, str(checkout / "backend" / "serve.py")]
        self.proc = subprocess.Popen(command,
            cwd=checkout / "backend", env=make_env(data, self.port, checkout, legacy=legacy),
            stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            if not servers.wait_ready(self.port, proc=self.proc):
                raise RuntimeError("isolated server did not become ready; inspect owned server.log")
            health = self.request("/api/health")[1]
            shared = self.request("/api/shared-server/status")[1]
            self.isolation = {"shared_url": shared.get("url"), "has_token": shared.get("has_token"),
                              "cli_available": health.get("cli_available")}
            if self.isolation != {"shared_url": servers.DEAD_URL, "has_token": False, "cli_available": False}:
                raise RuntimeError("shared-server URL/token or CLI isolation failed")
            if not legacy and "scene_writer_v1" not in self.request("/api/auth/config")[1].get("features", []):
                raise RuntimeError("isolated scene_writer_v1 feature missing")
        except BaseException:
            self.stop()
            raise

    def stop(self) -> None:
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
            self.proc = None
        if self.log is not None:
            self.log.close()
            self.log = None


class Measurement:
    def __init__(self, case: str, work: Path):
        self.case, self.work, self.hub = case, work, Hub(work, controls=case == "lease_races")
        self.report = {"format": "mvhub-canvas-notebook-measure-v1", "case": case,
            "profiles": [str(work / "chrome-a"), str(work / "chrome-b")], "checks": {}, "errors": [],
            "forbidden_requests": [], "machine": platform.node(), "platform": platform.platform()}

    def check(self, key: str, actual, expected, passed: bool | None = None) -> None:
        result = {"status": "passed" if (actual == expected if passed is None else passed) else "failed",
                  "actual": actual if passed is None else passed, "expected": expected if passed is None else True}
        if passed is not None:
            result["evidence"] = {"observed": actual, "criterion": expected}
        self.report["checks"][key] = result

    async def open(self, stack: AsyncExitStack, name: str, seed: list[dict] | None = None) -> Page:
        page = await stack.enter_async_context(Page(0, self.work / f"chrome-{name}"))
        await page.send("Page.addScriptToEvaluateOnNewDocument", source=MEASURE_SCRIPT)
        if seed is not None:
            # Seed legacy storage before first app boot, only on our exact origin, once per profile.
            script = f"""if (location.origin === {json.dumps(self.hub.url)} && !localStorage.getItem('measure-seeded')) {{
                localStorage.setItem('ch.scenes', {json.dumps(json.dumps({BUCKET: seed}))});
                localStorage.setItem('ch.scenes.active', {json.dumps(json.dumps({BUCKET: seed[0]['id'] if seed else None}))});
                localStorage.setItem('ch.lib.filters', '{{"tab":"compose"}}');
                localStorage.setItem('measure-seeded', '1'); }}"""
            await page.send("Page.addScriptToEvaluateOnNewDocument", source=script)
        await page.goto(self.hub.url, settle=0.2)
        if not await page.wait("document.querySelector('.scene-tab, .canvas-away')", 30):
            # A library landing page may ignore an old filter shape; use the real tab control.
            await page.click("[...document.querySelectorAll('button')].find(e => e.innerText.trim() === '캔버스')")
        if not await page.wait("document.querySelector('.scene-tab, .canvas-away')", 15):
            raise RuntimeError("canvas UI unavailable; no synthetic success")
        return page

    async def local(self, page: Page) -> list[dict]:
        return scene_rows(await page.eval(READ_STORE))

    async def wait_local(self, page: Page, predicate, timeout: float = 20) -> list[dict]:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            rows = await self.local(page)
            if predicate(rows):
                return rows
            await asyncio.sleep(0.05)
        raise RuntimeError("durable browser scene condition timed out")

    async def synced(self, page: Page, timeout: float = 20) -> dict:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            _, book = self.hub.request("/api/scenes/notebook")
            local = await self.local(page)
            remote = [json.loads(row["data"]) for row in book.get("items", []) if not row.get("deleted_at")]
            if local and {s["id"]: s for s in local} == {s["id"]: s for s in remote}:
                return book
            await asyncio.sleep(0.1)
        raise RuntimeError("browser and hub did not converge")

    async def rename(self, page: Page, name: str, sid: str = "measure-0", *, enter: bool = True) -> None:
        selector = json.dumps(f'[data-scene-tab="{sid}"] .scene-tab')
        if not await page.click(f"document.querySelector({selector})", count=2):
            raise RuntimeError("scene rename target missing")
        if not await page.wait("document.querySelector('.scene-name-input')", 3):
            raise RuntimeError("scene name input missing")
        await page.key("a", "KeyA", modifiers=2, vk=65)
        await page.type(name)
        if enter:
            await page.key("Enter", "Enter", vk=13)
            await self.wait_local(page, lambda rows: any(s["id"] == sid and s["name"] == name for s in rows))

    async def text_input(self, page: Page, text: str) -> None:
        if not await page.click("document.querySelector('.scene-card[data-id=\"card-0\"] .scene-textview-inline')", count=2):
            raise RuntimeError("text card editor target missing")
        if not await page.wait("document.querySelector('.scene-textedit[contenteditable]')", 3):
            raise RuntimeError("text card contenteditable missing")
        await page.click("document.querySelector('.scene-textedit[contenteditable]')")
        await page.key("a", "KeyA", modifiers=2, vk=65)
        await page.type(text)  # no blur/Enter/settle: receiver takes over while input is still pending

    async def latency_samples(self, page: Page) -> list[float]:
        samples = []
        for i in range(20):
            begin = time.perf_counter()
            await self.rename(page, f"latency-{i}")
            samples.append((time.perf_counter() - begin) * 1000)
        return samples

    async def wait_legacy(self, predicate, timeout: float = 20) -> list[dict]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status, result = self.hub.request("/api/scenes/backup?include_data=true")
            rows = result.get("items", [])
            if status == 200 and predicate(rows):
                return rows
            await asyncio.sleep(.1)
        raise RuntimeError("old hub backup write did not settle")

    async def take(self, page: Page) -> float:
        start = time.monotonic()
        if not await page.click("document.querySelector('.canvas-away button')"):
            raise RuntimeError("takeover button missing")
        if not await page.wait("!document.querySelector('.canvas-away') && document.querySelector('.scene-tab')", 15):
            raise RuntimeError("takeover did not finish")
        return (time.monotonic() - start) * 1000

    async def close_then_open(self, page: Page, stack: AsyncExitStack, seed: list[dict]) -> Page:
        # Page.close runs normal beforeunload/pagehide, unlike the crash case's process termination.
        # The second profile does not exist yet; no request/take/force can hide a broken close path.
        await page.send("Page.close")
        released = False
        for _ in range(50):
            code, status = self.hub.request("/api/scenes/writer", {"action": "status"})
            if code == 200 and status.get("writer") is None:
                released = True
                break
            await asyncio.sleep(.1)
        await page._kill()  # release was observed after the normal document close; owned process cleanup only
        self.check("closed_before_open", released, True)
        if not released:
            raise RuntimeError("normal close did not release the lease; takeover is not substituted")
        receiver = await self.open(stack, "b", seed)
        if not await receiver.wait("!document.querySelector('.canvas-away') && document.querySelector('.scene-tab')", 20):
            raise RuntimeError("newly opened browser did not claim and reconcile automatically")
        return receiver

    async def delete(self, page: Page, sid: str) -> None:
        selector = json.dumps(f'[data-scene-tab="{sid}"] .scene-del')
        if not await page.click(f"document.querySelector({selector})"):
            raise RuntimeError("delete button missing")
        if not await page.click("document.querySelector('.host-exit-actions button')"):
            raise RuntimeError("delete confirmation missing")
        await self.wait_local(page, lambda rows: all(s["id"] != sid for s in rows))

    async def drag(self, page: Page, source: str, target: str | None = None, *, release: bool = True) -> None:
        async def box(selector):
            return await page.eval(f"(() => {{ const e=document.querySelector({json.dumps(selector)}); if(!e)throw Error('drag target missing'); const r=e.getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+8}}; }})()")
        start = await box(source)
        end = await box(target) if target else {"x": start["x"] + 100, "y": start["y"] + 60}
        if target:
            end["x"] -= 20  # tab insertion before the target, rather than its right half
        await page.send("Input.dispatchMouseEvent", type="mousePressed", **start, button="left", clickCount=1)
        for i in range(1, 6):
            await page.send("Input.dispatchMouseEvent", type="mouseMoved", x=start["x"] + (end["x"] - start["x"]) * i / 5,
                            y=start["y"] + (end["y"] - start["y"]) * i / 5, buttons=1, button="left")
        if release:
            await page.send("Input.dispatchMouseEvent", type="mouseReleased", **end, button="left", clickCount=1)

    async def run(self, args) -> dict:
        browser = find_browser()
        self.report["browser_kind"] = "chrome" if Path(browser).name.casefold() in {"chrome.exe", "chrome"} else "other"
        if self.report["browser_kind"] != "chrome":
            raise RuntimeError("Chrome required, Edge fallback not accepted for this measurement")
        self.report["browser_version"] = browser
        self.hub.start()
        self.report["isolation"] = self.hub.isolation
        async with AsyncExitStack() as stack:
            seeds = fixture(performance=self.case == "performance")
            self.report["fixture_sha256"] = hashlib.sha256(json.dumps(seeds, sort_keys=True).encode()).hexdigest()
            a = await self.open(stack, "a", seeds)
            await self.synced(a)
            book_initial = self.hub.request("/api/scenes/notebook")[1]
            status_initial = self.hub.request("/api/scenes/writer", {"action": "status"})[1]
            other_seed = [{**seeds[0], "id": "prior-b", "name": "prior-b"}]
            b = None if self.case == "cross_browser" else await self.open(stack, "b", other_seed)
            self.report["browser_version"] = await a.eval("navigator.userAgent")

            if self.case == "cross_browser":
                await self.rename(a, "cross-edited")
                await self.delete(a, "measure-1")
                await self.drag(a, '[data-scene-tab="measure-2"] .scene-tab', '[data-scene-tab="measure-0"] .scene-tab')
                source = await self.wait_local(a, lambda rows: [s["id"] for s in rows] == ["measure-2", "measure-0"])
                self.check("order_changed", [s["id"] for s in source], ["measure-2", "measure-0"])
                b = await self.close_then_open(a, stack, other_seed)
                received = await self.local(b)
                self.check("content", received, source)
                self.check("order", [s["id"] for s in received], [s["id"] for s in source])
                self.check("deletion", any(s["id"] == "measure-1" for s in received), False)

            elif self.case == "normal_handoff":
                await self.text_input(a, "pending-text-input")
                elapsed = await self.take(b)
                received = await self.local(b)
                self.check("input_flush", received[0]["cards"][0].get("text"), "pending-text-input")
                self.check("within_five_seconds", elapsed, "<=5000ms", elapsed <= 5000)
                self.check("normal_notice", await b.eval("document.body.innerText.includes('넘겨받았습니다') && !document.body.innerText.includes('강제로 넘겨받았습니다')"), True)
                self.check("content", received, await self.local(a))
                await self.take(a)
                before = (await self.local(a))[0]["cards"][0]
                await self.drag(a, '.scene-card[data-id="card-0"] .scene-card-hd', release=False)
                await self.take(b)
                after = (await self.local(b))[0]["cards"][0]
                self.check("drag_flush", [after["x"], after["y"]], "moved before pointer release", [after["x"], after["y"]] != [before["x"], before["y"]])

            elif self.case in {"crash_takeover", "delete_crash"}:
                await a.send("Network.emulateNetworkConditions", offline=True, latency=0, downloadThroughput=-1, uploadThroughput=-1)
                if self.case == "delete_crash":
                    await self.delete(a, "measure-1")
                    entries = await a.eval(READ_STORE)
                    self.check("intent_durable", any(json.loads(k)[0] == "d" for k, _ in entries if isinstance(k, str) and k.startswith("[")), True)
                else:
                    await self.rename(a, "offline-before-crash")
                await a._kill()  # Owned Chrome process only; no pagehide/beacon.
                await self.take(b)
                if self.case == "crash_takeover":
                    self.check("forced_notice", await b.eval("document.body.innerText.includes('강제로 넘겨받았습니다')"), True)
                    await self.rename(b, "new-owner")
                await self.synced(b)
                restarted = await self.open(stack, "a")
                await self.take(restarted)
                final = await self.synced(restarted)
                rows = await self.local(restarted)
                if self.case == "delete_crash":
                    self.check("absent_after_restart", any(s["id"] == "measure-1" for s in rows), False)
                    self.check("tombstone", any(r["id"] == "measure-1" and bool(r.get("deleted_at")) for r in final["items"]), True)
                else:
                    self.check("offline_copy", any(s["id"] != "measure-0" and "offline-before-crash" in s["name"] for s in rows), True)
                    self.check("original_preserved", next(s["name"] for s in rows if s["id"] == "measure-0"), "new-owner")

            elif self.case == "offline":
                self.hub.stop()
                await self.rename(a, "while-hub-off")
                self.check("local_edit", (await self.local(a))[0]["name"], "while-hub-off")
                self.check("no_save_failure", await a.eval("!!document.querySelector('.scene-unsaved')"), False)
                self.hub.start()
                final = await self.synced(a, 40)
                status = self.hub.request("/api/scenes/writer", {"action": "status"})[1]
                self.check("new_token", status.get("writer", {}).get("generation"), "different generation", status.get("writer", {}).get("generation") != status_initial["writer"]["generation"])
                self.check("automatic_upload", json.loads(final["items"][0]["data"])["name"], "while-hub-off")

            elif self.case == "bootstrap":
                self.check("first_canvas", [r["id"] for r in book_initial["items"]], [s["id"] for s in seeds])
                await self.take(b)
                archive = [v for k, v in await b.eval(READ_STORE) if isinstance(k, str) and k.startswith('["na",')]
                self.check("archive", bool(archive) and any(s["id"] == "prior-b" for s in archive[0]["scenes"].get(BUCKET, [])), True)
                self.check("no_merge", any(s["id"] == "prior-b" for s in await self.local(b)), False)
                await b.goto(self.hub.url, settle=1)
                after = [v for k, v in await b.eval(READ_STORE) if isinstance(k, str) and k.startswith('["na",')]
                self.check("archive_unchanged", after, archive)

            elif self.case == "lease_races":
                # Fault injection is separate from product API evidence; never export the control credential.
                self.report["fault_injection"] = "owned-process loopback control invokes real account DB switch and clear_active; not login UI coverage"
                old_token = await a.eval("window.__measureLeaseTokens.at(-1)")
                if not old_token:
                    raise RuntimeError("actual browser lease token observation missing")
                code, _ = self.hub.request("/api/scenes/writer", {"action": "claim", "browser_id": "third", "tab_id": "third"})
                self.check("third_party", code, 409)
                await self.take(b)
                code, _ = self.hub.request("/api/scenes/writer", {"action": "release", "token": old_token})
                self.check("late_release", code, 409)
                code, _ = self.hub.request("/api/scenes/backup", {"token": old_token, "request_id": "late", "upserts": []}, "PUT")
                self.check("late_write", code, 409)
                current_token = await b.eval("window.__measureLeaseTokens.at(-1)")
                code, epoch = self.hub.request("/api/__measure/account-aba", {})
                stale, _ = self.hub.request("/api/scenes/backup", {"token": current_token, "request_id": "aba-late", "upserts": []}, "PUT")
                self.check("account_aba", {"control_status": code, "epoch_advanced": epoch.get("after", 0) > epoch.get("before", 0), "returned_to_a": epoch.get("account") in (None, ""), "old_token_status": stale},
                           {"control_status": 200, "epoch_advanced": True, "returned_to_a": True, "old_token_status": 409})
                self.hub.stop(); self.hub.start()
                await a.goto(self.hub.url, settle=1)
                if await a.eval("!!document.querySelector('.canvas-away button')"):
                    await self.take(a)
                await self.synced(a, 40)
                status = self.hub.request("/api/scenes/writer", {"action": "status"})[1]
                self.check("restart", status["boot_id"] != status_initial["boot_id"], True)
                before = await self.local(a)
                history = await a.send("Page.getNavigationHistory")
                entry = history["entries"][history["currentIndex"]]["id"]
                await a.goto("about:blank", settle=.1)
                await a.send("Page.navigateToHistoryEntry", entryId=entry)
                if not await a.wait("location.origin === " + json.dumps(self.hub.url), 10):
                    raise RuntimeError("history return failed")
                persisted = await a.eval("window.__measurePageShows?.some(event=>event.persisted) === true")
                await self.synced(a, 40)
                self.check("bfcache", {"persisted": persisted, "content_kept": await self.local(a) == before}, {"persisted": True, "content_kept": True})
                if not persisted:
                    self.report["checks"]["bfcache"]["status"] = "unverified"
                    self.report["checks"]["bfcache"]["reason"] = "Chrome did not restore this document from BFCache"
                # Open a real floating canvas using the app's middle-click path.
                if not await a.click("[...document.querySelectorAll('nav button')].find(e => e.innerText.trim() === '캔버스')", button="middle"):
                    raise RuntimeError("floating canvas control missing")
                target = None
                for _ in range(30):
                    with urllib.request.urlopen(f"http://127.0.0.1:{a.port}/json/list", timeout=2) as response:
                        targets = json.load(response)
                    target = next((t for t in targets if t.get("type") == "page" and "embed=canvas" in t.get("url", "")), None)
                    if target:
                        break
                    await asyncio.sleep(.2)
                if not target:
                    raise RuntimeError("floating canvas CDP target missing")
                floating = await stack.enter_async_context(AttachedPage(a, target))
                if not await floating.wait("document.querySelector('.scene-tab')", 10):
                    raise RuntimeError("floating scene UI unavailable")
                parent_target = (await a.send("Target.getTargetInfo"))["targetInfo"]["targetId"]
                frozen = self.hub.request("/api/scenes/notebook")[1]
                await a.send("Target.closeTarget", targetId=parent_target)
                await asyncio.sleep(2)
                await self.rename(floating, "floating-local-only")
                await asyncio.sleep(11)
                live = self.hub.request("/api/scenes/notebook")[1]
                status = self.hub.request("/api/scenes/writer", {"action": "status"})[1]
                self.check("floating_only", {"local_name": (await self.local(floating))[0]["name"], "hub_unchanged": live["items"] == frozen["items"], "no_writer": status.get("writer") is None},
                           {"local_name": "floating-local-only", "hub_unchanged": True, "no_writer": True})

            elif self.case == "performance":
                samples = await self.latency_samples(a)
                await a.send("Network.emulateNetworkConditions", offline=True, latency=0, downloadThroughput=-1, uploadThroughput=-1)
                for i in range(10):
                    await self.rename(a, f"batch-{i}", sid=f"measure-{i}")
                await a.eval("window.__measureNetwork=[]")
                await a.send("Network.emulateNetworkConditions", offline=False, latency=0, downloadThroughput=-1, uploadThroughput=-1)
                handoff_ms = await self.take(b)
                await self.synced(b)
                transport = sync_window(await a.eval("window.__measureNetwork"))
                sync_ms = transport["sync_ms"]
                self.report["timing"] = {"samples_ms": samples, "p50_ms": percentile(samples, .5), "p95_ms": percentile(samples, .95), "sync_ms": sync_ms,
                    "handoff_ms": handoff_ms, "sync_window": transport,
                    "sync_method": "writer first notebook GET start through post-PUT notebook GET body completion; ten dirty scene payloads required",
                    "method": LATENCY_METHOD}
                self.check("fixture", {"scenes": len(seeds), "largest_cards": max(len(s["cards"]) for s in seeds)}, {"scenes": 10, "largest_cards": 357})
                self.check("samples", len(samples), 20)
                self.check("sync_under_second", sync_ms, "<1000ms", sync_ms < 1000)
                if args.baseline_report:
                    baseline = json.loads(args.baseline_report.read_text(encoding="utf-8"))
                    same = (baseline.get("machine") == self.report["machine"]
                        and baseline.get("browser_version") == self.report["browser_version"]
                        and baseline.get("fixture_sha256") == self.report["fixture_sha256"]
                        and baseline.get("format") == "mvhub-canvas-notebook-baseline-v1"
                        and baseline.get("verdict") == "baseline_measured" and not baseline.get("errors")
                        and baseline.get("revision") == BASELINE_REVISION
                        and baseline.get("timing", {}).get("method") == self.report["timing"]["method"])
                    self.check("baseline", same, True)
                    prior = {key: baseline.get("timing", {}).get(key, 0) for key in ("p50_ms", "p95_ms")}
                    if not all(type(value) in (int, float) and math.isfinite(value) and value > 0 for value in prior.values()):
                        raise ValueError("baseline timing values are invalid")
                    ratios = {key: self.report["timing"][key] / prior[key] for key in prior}
                    self.report["timing"]["baseline_ratios"] = ratios
                    self.report["timing"]["max_slowdown"] = args.max_slowdown
                    if args.max_slowdown is not None:
                        self.check("latency", ratios, {"max_slowdown": args.max_slowdown},
                                   same and all(ratio <= args.max_slowdown for ratio in ratios.values()))

            elif self.case == "rollback" and args.old_checkout:
                old = validate_checkout(args.old_checkout)
                self.check("old_checkout", str(old), "separate explicitly supplied checkout", old != REPO.resolve())
                self.hub.stop(); self.hub.start(old, legacy=True)
                await a.goto(self.hub.url, settle=3)
                await self.rename(a, "legacy-overwrite")
                old_rows = await self.wait_legacy(lambda rows: any("legacy-overwrite" in r.get("data", "") for r in rows))
                self.check("old_write", any("legacy-overwrite" in r.get("data", "") for r in old_rows), True)
                await self.rename(a, "legacy-Y1", sid="measure-1")
                await self.wait_legacy(lambda rows: any(r["id"] == "measure-1" and "legacy-Y1" in r.get("data", "") for r in rows))
                await self.delete(a, "measure-1")
                await self.wait_legacy(lambda rows: all(r["id"] != "measure-1" for r in rows))
                self.hub.stop(); self.hub.start()
                await a.goto(self.hub.url, settle=3)
                final = await self.synced(a, 40)
                names = [json.loads(r["data"]).get("name") for r in final["items"] if not r.get("deleted_at")]
                self.check("new_recovery", "legacy-overwrite" in names, True)
                self.check("retained", any(name and "measure-0" in name for name in names), True)
                retained = retained_rows(self.work)
                history = {(row["reason"], row["data"].get("name")) for row in retained if row["scene_id"] == "measure-1"}
                self.report["rollback_archive"] = retained
                self.check("overwrite_then_delete_retained", sorted(history), "X1 overwrite and Y1 delete bodies retained",
                           ("legacy_overwrite", "measure-1") in history and ("legacy_delete", "legacy-Y1") in history)
                self.check("deleted_original_absent", any(row["id"] == "measure-1" and not row.get("deleted_at") for row in final["items"]), False)

            for label, page in (("a", a), ("b", b)):
                if page.proc and page.proc.poll() is None:
                    try:
                        await page.shot(self.work / f"{label}-final.png")
                    except Exception:
                        pass  # crash/last-main-window cases deliberately close the page target
                forbidden = [request for request in page.mutations if "/api/gen-requests" in "/" + request or "/api/comfy/run" in "/" + request]
                self.report["forbidden_requests"].extend(forbidden)
        return self.report


async def execute(args) -> int:
    # Never accept an existing data/profile directory. No recursive deletion is used.
    work = Path(tempfile.mkdtemp(prefix="mvhub-canvas-notebook-"))
    measurement = Measurement(args.case, work)
    revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True, check=False)
    measurement.report["revision"] = revision.stdout.strip() if revision.returncode == 0 else "unknown"
    try:
        await measurement.run(args)
    except Exception as exc:
        measurement.report["errors"].append(f"{type(exc).__name__}: {exc}")
    finally:
        measurement.hub.stop()
    for key in CASES[args.case] - measurement.report["checks"].keys():
        measurement.report["checks"][key] = {"status": "unverified", "reason": "not measured; required prerequisite or scenario coverage missing"}
    problems = verify(measurement.report)
    measurement.report["verdict"] = "failed" if problems else "passed"
    measurement.report["verification_errors"] = problems
    path = work / "report.json"
    path.write_text(json.dumps(measurement.report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{measurement.report['verdict']}: {path}")
    return int(bool(problems))


async def execute_baseline(args) -> int:
    checkout = validate_checkout(args.baseline_checkout)
    revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=checkout, capture_output=True, text=True, check=False)
    changes = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=checkout, capture_output=True, text=True, check=False)
    if revision.returncode or revision.stdout.strip() != BASELINE_REVISION or changes.returncode or changes.stdout.strip():
        raise ValueError("baseline requires a clean separate checkout at dcb9f49fea0428cf757e2c2cac6067b38e626e1a")
    work = Path(tempfile.mkdtemp(prefix="mvhub-canvas-baseline-"))
    measurement = Measurement("performance", work)
    report = {"format": "mvhub-canvas-notebook-baseline-v1", "revision": BASELINE_REVISION,
              "machine": platform.node(), "platform": platform.platform(), "errors": [], "verdict": "unverified"}
    try:
        if Path(find_browser()).name.casefold() not in {"chrome.exe", "chrome"}:
            raise RuntimeError("Chrome required for baseline")
        measurement.hub.start(checkout, legacy=True)
        report["isolation"] = measurement.hub.isolation
        seeds = fixture(performance=True)
        report["fixture_sha256"] = hashlib.sha256(json.dumps(seeds, sort_keys=True).encode()).hexdigest()
        async with AsyncExitStack() as stack:
            page = await measurement.open(stack, "a", seeds)
            await measurement.wait_local(page, lambda rows: len(rows) == 10)
            report["browser_version"] = await page.eval("navigator.userAgent")
            samples = await measurement.latency_samples(page)
            report["timing"] = {"samples_ms": samples, "p50_ms": percentile(samples, .5), "p95_ms": percentile(samples, .95), "method": LATENCY_METHOD}
            report["verdict"] = "baseline_measured"  # never a feature/contract PASS
    except Exception as exc:
        report["errors"].append(f"{type(exc).__name__}: {exc}")
    finally:
        measurement.hub.stop()
    path = work / "baseline.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{report['verdict']}: {path}")
    return int(bool(report["errors"]))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=sorted(CASES), required=True)
    baseline = parser.add_mutually_exclusive_group()
    baseline.add_argument("--baseline-report", type=Path)
    baseline.add_argument("--baseline-checkout", type=Path)
    parser.add_argument("--max-slowdown", type=float, help="explicit p50/p95 ratio limit; omitted means latency is unverified")
    parser.add_argument("--old-checkout", type=Path)
    args = parser.parse_args()
    if (args.baseline_report or args.baseline_checkout or args.max_slowdown is not None) and args.case != "performance":
        parser.error("baseline and slowdown options require --case performance")
    if args.max_slowdown is not None and (not math.isfinite(args.max_slowdown) or args.max_slowdown <= 0):
        parser.error("--max-slowdown must be a positive finite ratio")
    if args.baseline_checkout and args.max_slowdown is not None:
        parser.error("baseline production does not accept a slowdown threshold")
    return asyncio.run(execute_baseline(args) if args.baseline_checkout else execute(args))


if __name__ == "__main__":
    raise SystemExit(main())
