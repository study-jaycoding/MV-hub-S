import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
const root = resolve(import.meta.dirname, "../../backend/app/resources/resolve_panel/com.mvhub.resolve");
const rules = createRequire(import.meta.url)(resolve(root, "rules.js"));

it.each(["http://127.0.0.1:8010", "http://localhost:5173/", "http://localhost:80"])("loopback URL 허용 %s", value => {
  expect(rules.hubOrigin(value)).toBe(new URL(value).origin);
});
it.each(["http://127.0.0.1:8010@evil.example", "http://localhost.evil.example:8010", "https://localhost:8010", "http://localhost", "http://localhost/", "http://localhost:8010/path", "http://localhost:8010/?x", "http://localhost:8010/#x", "http://u:p@localhost:8010", "http://127.1:8010", "http://2130706433:8010", "http://[::1]:8010", "http://localhost:0", "http://localhost:65536", "file:///tmp/x", " http://localhost:8010", "http://localhost:8010/../", "http://localhost:8010?", "http://localhost:8010#"])("URL 거절 %s", value => {
  expect(rules.hubOrigin(value)).toBeNull();
  expect(rules.createHubState().set(value)).toBe("http://127.0.0.1:8010");
});
it("현재 출처 한 곳을 이동·IPC·hello가 함께 따름", () => {
  const state = rules.createHubState(), owner = {}, frame = { url: "http://127.0.0.1:8010/?embed=resolve-panel" };
  const input = { sender: owner, owner, frame, mainFrame: frame };
  expect(state.hello(input)).toEqual({ origin: "http://127.0.0.1:8010", supported: true });
  expect(state.ipc({ ...input, sender: {} })).toBe(false);
  expect(state.ipc({ ...input, mainFrame: {} })).toBe(false);
  expect(state.hello({ ...input, frame: undefined }).supported).toBe(false);
  state.set("http://localhost:5173");
  expect(state.navigation(frame.url)).toBe(false); expect(state.ipc(input)).toBe(false);
  frame.url = "http://localhost:5173/?embed=resolve-panel";
  expect(state.navigation(frame.url)).toBe(true);
  expect(state.hello(input)).toEqual({ origin: "http://localhost:5173", supported: true });
  const brokenFrame = { get url() { throw Error("frame closed"); } };
  expect(state.ipc({ ...input, frame: brokenFrame, mainFrame: brokenFrame })).toBe(false);
});
it("판 정수·절대 경로·일반 파일·매체 확장자", () => {
  expect(rules.acceptsProtocol(1)).toBe(true);
  for (const value of [0, 2, 1.5, "1", null]) expect(rules.acceptsProtocol(value)).toBe(false);
  const file = () => ({ isFile: () => true });
  for (const value of ["Z:\\cut\\clip.mp4", "\\\\nas\\share\\sound.WAV", "C:/image.png"]) expect(rules.dragPath(value, file)).toBe(true);
  for (const value of ["clip.mp4", "C:clip.mp4", "\\clip.mp4", "C:/run.exe", "C:/clip.mp4\0"]) expect(rules.dragPath(value, file)).toBe(false);
  expect(rules.dragPath("C:/image.png", () => ({ isFile: () => false }))).toBe(false);
  expect(rules.dragPath("C:/image.png", () => { throw Error("missing"); })).toBe(false);
});
it("prepare 원본 캐시의 매체 확장자 목록과 일치", () => {
  const source = readFileSync(resolve(root, "../../../services/media_types.py"), "utf8");
  const supported = [...source.matchAll(/^(?:IMAGE|VIDEO|AUDIO)_EXTENSIONS = \((.+)\)/gm)]
    .flatMap(match => [...match[1].matchAll(/"(\.[a-z0-9]+)"/g)].map(item => item[1]));
  expect([...rules.MEDIA_EXTENSIONS].sort()).toEqual(supported.sort());
});
it("화면 안 창 자리만 복원", () => {
  const screens = [{ x: -1920, y: 0, width: 1920, height: 1080 }];
  const saved = { x: -1800, y: 100, width: 540, height: 820 };
  expect(rules.restoreBounds(saved, screens)).toEqual(saved);
  for (const value of [null, { ...saved, x: 10 }, { ...saved, height: 2000 }, { ...saved, width: NaN }]) expect(rules.restoreBounds(value, screens)).toBeNull();
});
it("main/preload는 닫힌 출처·sandbox·답 먼저 끌기 약속", () => {
  const main = readFileSync(resolve(root, "main.js"), "utf8"), preload = readFileSync(resolve(root, "preload.js"), "utf8");
  expect(main).toContain('contextIsolation: true, nodeIntegration: false, sandbox: true');
  expect(main).toContain('action: "deny"'); expect(main).toContain('"will-redirect"'); expect(main).toContain('"will-navigate"');
  expect(main.indexOf("event.returnValue = true")).toBeLessThan(main.indexOf("event.sender.startDrag"));
  expect(main).toContain('retry = setTimeout(loadHub, 3000)'); expect(main).toContain('"offline.html"');
  expect(main + preload).not.toMatch(/WorkflowIntegration|additionalArguments|process\.argv/);
  expect(preload).toContain('ipcRenderer.sendSync("mvhub:hello")');
  expect(preload).toContain('hello.supported && window === window.top && window.location.origin === hello.origin');
  expect(readFileSync(resolve(root, "manifest.xml"), "utf8")).toContain('<Id>com.mvhub.resolve</Id>');
  expect(readFileSync(resolve(root, "img/drag.png")).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
});

it("실행 모의: 답 true 한 번 뒤 startDrag, 예외 뒤 답을 바꾸지 않음", () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const order: unknown[] = [];
  const frame = { url: "http://127.0.0.1:8010/?embed=resolve-panel" };
  const contents = { mainFrame: frame, setWindowOpenHandler() {}, on() {}, startDrag() { order.push("drag"); throw Error("gone"); } };
  class FakeWindow {
    webContents = contents;
    on() {} isDestroyed() { return false; }
    loadURL() { return Promise.resolve(); }
  }
  const electron = { app: { whenReady: () => ({ then: (fn: () => void) => fn() }), on() {} }, BrowserWindow: FakeWindow,
    screen: { getAllDisplays: () => [] }, ipcMain: { on: (name: string, fn: (...args: unknown[]) => void) => { handlers[name] = fn; } } };
  runInNewContext(readFileSync(resolve(root, "main.js"), "utf8"), {
    require: (name: string) => name === "electron" ? electron : name === "fs" ? { readFileSync: () => "{}", statSync: () => ({ isFile: () => true }) } : name === "./rules" ? rules : createRequire(import.meta.url)(name),
    __dirname: root, process: { env: { LOCALAPPDATA: "C:/isolated" } }, clearTimeout() {}, setTimeout() {}, console: { error() { order.push("logged"); } },
  });
  const event = { sender: contents, senderFrame: frame, set returnValue(value: boolean) { order.push(value); } };
  handlers["mvhub:drag"](event, "C:/clip.mp4", { protocol: 1 });
  expect(order).toEqual([true, "drag", "logged"]);
  order.length = 0; handlers["mvhub:drag"](event, "C:/clip.mp4", { protocol: 2 }); expect(order).toEqual([false]);
  const closed = { sender: contents, get senderFrame() { throw Error("frame closed"); }, set returnValue(value: unknown) { order.push(value); } };
  order.length = 0; handlers["mvhub:hello"](closed);
  expect(order).toEqual([{ origin: "http://127.0.0.1:8010", supported: false }]);
  order.length = 0; handlers["mvhub:drag"](closed, "C:/clip.mp4", { protocol: 1 });
  expect(order).toEqual([false]);
});
