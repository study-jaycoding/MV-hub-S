"""헤드리스 Chrome 을 DevTools 프로토콜로 모는 작은 드라이버 (표준 라이브러리 + venv 의 websockets, 새 패키지 설치 없음).

격리 브라우저 실측 전용이다 — 절차는 docs/TESTING.md "격리 브라우저 실측". 페이지 하나를 열고 다음을 모은다:
  console   : console.error/warning · 잡히지 않은 예외 · 실패한 리소스
  network   : 실패했거나 400 이상인 응답
  mutations : GET 이 아닌 모든 요청 — "생성 요청(POST /api/gen-requests)이 0건이었다"를 증거로 남기기 위해서
  dialogs   : 네이티브 alert/confirm/prompt 문구. ★처리하지 않으면 페이지가 멈춰 모든 명령이 시간초과한다(삭제의 confirm() 등)
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

import websockets


def find_browser() -> str:
    """Chrome 을 먼저, 없으면 Edge. 설치 위치는 PC 마다 달라 환경변수의 폴더들에서 찾는다."""
    roots = [os.environ.get(k) for k in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")]
    tails = (r"Google\Chrome\Application\chrome.exe", r"Microsoft\Edge\Application\msedge.exe")
    for tail in tails:
        for root in filter(None, roots):
            candidate = Path(root) / tail
            if candidate.is_file():
                return str(candidate)
    found = shutil.which("chrome") or shutil.which("msedge")
    if not found:
        raise RuntimeError("Chrome/Edge 를 찾지 못했다")
    return found


class Page:
    def __init__(self, port: int, profile: Path, size: tuple[int, int] = (1680, 1000)):
        self.port, self.profile, self.size = port, profile, size
        self.proc: subprocess.Popen | None = None
        self.ws = None
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._req: dict[str, dict] = {}
        self._reader: asyncio.Task | None = None
        self.console: list[dict] = []
        self.network: list[dict] = []
        self.mutations: list[str] = []
        self.dialogs: list[dict] = []
        self.accept_dialogs = True  # confirm() 을 거절해야 하는 동작 직전에 False 로 바꾼다

    async def __aenter__(self) -> "Page":
        self.profile.mkdir(parents=True, exist_ok=True)
        self.proc = subprocess.Popen([
            find_browser(), "--headless=new", f"--remote-debugging-port={self.port}", f"--user-data-dir={self.profile}",
            f"--window-size={self.size[0]},{self.size[1]}", "--no-first-run", "--no-default-browser-check",
            "--disable-extensions", "--remote-allow-origins=*", "--disable-background-networking", "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        target = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/list", timeout=2) as r:
                    pages = [t for t in json.loads(r.read()) if t.get("type") == "page"]
                if pages:
                    target = pages[0]
                    break
            except Exception:  # noqa: BLE001 — 아직 뜨는 중
                pass
            await asyncio.sleep(0.5)
        if not target:
            raise RuntimeError("브라우저가 뜨지 않았다")
        self.ws = await websockets.connect(target["webSocketDebuggerUrl"], max_size=64 * 1024 * 1024)
        self._reader = asyncio.create_task(self._read())
        for domain in ("Page", "Runtime", "Network", "Log"):
            await self.send(f"{domain}.enable")
        return self

    async def __aexit__(self, *exc) -> None:
        try:
            if self._reader:
                self._reader.cancel()
            if self.ws:
                await self.ws.close()
        finally:
            if self.proc:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=10)
                except Exception:  # noqa: BLE001
                    self.proc.kill()

    async def _read(self) -> None:
        async for raw in self.ws:
            msg = json.loads(raw)
            if "id" in msg:
                fut = self._pending.pop(msg["id"], None)
                if fut and not fut.done():
                    fut.set_result(msg)
                continue
            m, p = msg.get("method"), msg.get("params", {})
            if m == "Runtime.consoleAPICalled" and p.get("type") in ("error", "warning", "assert"):
                text = " ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", []))
                self.console.append({"kind": p["type"], "text": text[:500]})
            elif m == "Runtime.exceptionThrown":
                d = p.get("exceptionDetails", {})
                self.console.append({"kind": "exception", "text": (d.get("exception", {}).get("description") or d.get("text", ""))[:500]})
            elif m == "Log.entryAdded" and p.get("entry", {}).get("level") == "error":
                e = p["entry"]
                self.console.append({"kind": "log-error", "text": f"{e.get('text', '')} {e.get('url', '')}"[:500]})
            elif m == "Page.javascriptDialogOpening":
                self.dialogs.append({"type": p.get("type"), "message": p.get("message", "")[:300], "accepted": self.accept_dialogs})
                asyncio.create_task(self._answer_dialog())
            elif m == "Network.requestWillBeSent":
                req = p["request"]
                self._req[p["requestId"]] = {"url": req["url"], "method": req["method"]}
                if req["method"] not in ("GET", "HEAD", "OPTIONS"):
                    self.mutations.append(f"{req['method']} {req['url'].split('://', 1)[-1].split('/', 1)[-1][:120]}")
            elif m == "Network.responseReceived" and p["response"]["status"] >= 400:
                r = self._req.get(p["requestId"], {})
                self.network.append({"status": p["response"]["status"], "method": r.get("method"), "url": p["response"]["url"][:200]})
            elif m == "Network.loadingFailed" and not p.get("canceled"):
                r = self._req.get(p["requestId"], {})
                self.network.append({"status": "FAILED", "method": r.get("method"), "url": r.get("url", "")[:200], "err": p.get("errorText")})

    async def _answer_dialog(self) -> None:
        try:
            await self.send("Page.handleJavaScriptDialog", accept=self.accept_dialogs)
        except Exception:  # noqa: BLE001
            pass

    async def send(self, method: str, **params):
        self._id += 1
        fut = asyncio.get_running_loop().create_future()
        self._pending[self._id] = fut
        await self.ws.send(json.dumps({"id": self._id, "method": method, "params": params}))
        msg = await asyncio.wait_for(fut, timeout=60)
        if "error" in msg:
            raise RuntimeError(f"{method}: {msg['error']}")
        return msg.get("result", {})

    async def eval(self, js: str):
        r = await self.send("Runtime.evaluate", expression=js, returnByValue=True, awaitPromise=True, userGesture=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description", str(r["exceptionDetails"]))[:400])
        return r.get("result", {}).get("value")

    async def goto(self, url: str, settle: float = 2.0) -> None:
        await self.send("Page.navigate", url=url)
        await self.wait("document.readyState === 'complete'", 30)
        await asyncio.sleep(settle)

    async def wait(self, js_cond: str, timeout: float = 15) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            try:
                if await self.eval(f"!!({js_cond})"):
                    return True
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(0.3)
        return False

    async def shot(self, path: Path) -> None:
        """★파일 이름은 ASCII 로 — 한글 이름은 이미지 리더가 못 여는 환경이 있다."""
        r = await self.send("Page.captureScreenshot", format="png")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(r["data"]))

    async def click_xy(self, x: float, y: float, button: str = "left", count: int = 1, modifiers: int = 0) -> None:
        for kind in ("mousePressed", "mouseReleased"):
            await self.send("Input.dispatchMouseEvent", type=kind, x=x, y=y, button=button, clickCount=count, modifiers=modifiers)

    async def click(self, js_element: str, button: str = "left", count: int = 1, modifiers: int = 0) -> bool:
        """js_element = Element 로 평가되는 JS 식. 요소 중앙에 진짜 마우스 이벤트를 보낸다. modifiers: Alt=1 Ctrl=2 Meta=4 Shift=8."""
        box = await self.eval(
            f"(() => {{ const e = {js_element}; if (!e) return null; e.scrollIntoView({{block: 'center', inline: 'center'}});"
            " const r = e.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height}; })()")
        if not box or not box["w"] or not box["h"]:
            return False
        await self.send("Input.dispatchMouseEvent", type="mouseMoved", x=box["x"], y=box["y"])
        await self.click_xy(box["x"], box["y"], button, count, modifiers)
        return True

    async def key(self, key: str, code: str | None = None, modifiers: int = 0, text: str | None = None, vk: int | None = None) -> None:
        params = {"key": key, "code": code or key, "modifiers": modifiers}
        if vk is not None:
            params["windowsVirtualKeyCode"] = vk
        await self.send("Input.dispatchKeyEvent", type="keyDown", **params, **({"text": text} if text else {}))
        await self.send("Input.dispatchKeyEvent", type="keyUp", **params)

    async def type(self, text: str) -> None:
        await self.send("Input.insertText", text=text)

    def drain(self) -> dict:
        out = {"console": self.console[:], "network": self.network[:], "mutations": self.mutations[:], "dialogs": self.dialogs[:]}
        for bucket in (self.console, self.network, self.mutations, self.dialogs):
            bucket.clear()
        return out
