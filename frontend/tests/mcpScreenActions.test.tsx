// @vitest-environment jsdom
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ http: vi.fn(), fetch: vi.fn(), execute: vi.fn(), undo: vi.fn(), token: "token", account: "acct:a", connection: "hub", revision: 1, canvasWindow: false, detached: false }));
vi.mock("../src/lib/popupWindows", () => ({ isCanvasWindow: () => io.canvasWindow }));
vi.mock("../src/lib/http", () => ({ jsonFetch: io.http, jsonBody: JSON.stringify, getAuthToken: () => io.token,
  withRequestTimeout: (run: (signal: AbortSignal) => unknown) => run(new AbortController().signal) }));
vi.mock("../src/lib/accountScope", () => ({ getAccountNamespace: () => io.account, getConnectionKey: () => io.connection }));
vi.mock("../src/lib/agentScreenActions", () => ({ runScreenAction: io.execute, undoScreenAction: io.undo, sceneFingerprint: () => String(io.revision) }));
vi.mock("../src/lib/deactivated", () => ({ disabledGenStamp: () => String(io.revision) }));
import { changeScreenControl, screenEnabled, screenStorageKey, useMcpScreenActions } from "../src/lib/useMcpScreenActions";
import { McpScreenControl, McpScreenNotice } from "../src/components/mcp/McpScreenNotice";
import { setHubFeatures } from "../src/lib/hubFeatures";
import { APP_EVENTS, dispatchAppEvent } from "../src/lib/appEvents";
import type { ScreenHost } from "../src/lib/agentScreenActions";

let root: Root, container: HTMLDivElement, scene: string | null, epoch: number;
const workspace = { scope: "personal" as const, id: null, name: null };
const host = { scene: () => scene && !io.detached ? { sceneId: scene, snapshot: () => ({ cards: [], edges: [], groups: [] }) } : null } as ScreenHost;
function Consumer({ view = "A", restoreHandle = false }: { view?: string; restoreHandle?: boolean }) {
  const result = useMcpScreenActions({ ready: true, authKey: "auth", workspace, host, boardVisible: true, sceneId: scene, viewKey: view });
  useLayoutEffect(() => { if (restoreHandle) io.detached = false; });
  return <><McpScreenControl /><McpScreenNotice {...result} /></>;
}
const tick = async (ms = 110) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const render = async (view = "A") => { await act(async () => root.render(<StrictMode><Consumer view={view} /></StrictMode>)); };
const wake = async (id = "action") => { await act(async () => dispatchAppEvent(APP_EVENTS.mcpScreenAction, { receiver_id: "receiver", action_id: id })); };
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); localStorage.clear(); scene = "scene"; epoch = 1;
  io.account = "acct:a"; io.token = "token"; io.connection = "hub"; io.revision = 1; io.canvasWindow = false; io.detached = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", io.fetch);
  io.fetch.mockResolvedValue({ ok: true, status: 200 });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  setHubFeatures(["external_screen"]);
  io.http.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/health") return { mcp_bridge: { hub_id: "hub" } };
    if (url.endsWith("screen-presence")) {
      epoch = JSON.parse(String(init?.body)).epoch;
      return { receiver_id: "receiver", receiver_secret: "secret", multiple: false, selected: false };
    }
    if (url.endsWith("/claim")) return { token: "claim", name: "canvas.create_nodes", args: { scene_id: "scene" }, epoch, workspace: { scope: "personal", id: null }, client_name: "Claude Code", remaining_ms: 30_000 };
    return { accepted: true };
  });
  io.execute.mockReturnValue({ ok: true, summary: "made", data: {}, undo: { kind: "canvas" } });
  io.undo.mockReturnValue({ ok: true, message: "되돌렸어요" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function enabled() {
  await render(); await act(async () => changeScreenControl(true)); await tick();
}

it("does not register or claim from a detached canvas window without embed", async () => {
  io.canvasWindow = true;
  localStorage.setItem(screenStorageKey("hub", "acct:a"), JSON.stringify({ enabled: true, change: "opt-in" }));
  await render(); await tick(); await wake();
  expect(io.http).not.toHaveBeenCalled();
  expect(io.execute).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
});

it.each([403, 404])("reregisters within 100ms after an existing receiver is rejected with %s", async status => {
  await enabled();
  io.http.mockClear();
  io.http.mockRejectedValueOnce({ status });
  await tick(10_000);
  expect(io.http).toHaveBeenCalledTimes(1);
  await tick(100);
  const registrations = io.http.mock.calls.filter(([u]) => u.endsWith("screen-presence"));
  expect(registrations).toHaveLength(2);
  expect(JSON.parse(String(registrations[0][1].body)).receiver_id).toBe("receiver");
  expect(JSON.parse(String(registrations[1][1].body)).receiver_id).toBeUndefined();
  await wake(); expect(io.execute).toHaveBeenCalledTimes(1);
});

it("backs off if the immediate replacement registration is also rejected", async () => {
  await enabled();
  const original = io.http.getMockImplementation()!;
  io.http.mockClear();
  io.http.mockImplementation((url, init) => url.endsWith("screen-presence") ? Promise.reject({ status: 403 }) : original(url, init));
  await tick(10_000); await tick(100);
  const attempts = () => io.http.mock.calls.filter(([u]) => u.endsWith("screen-presence"));
  expect(attempts()).toHaveLength(2);
  await tick(29_000); expect(attempts()).toHaveLength(2);
  await tick(1000); expect(attempts()).toHaveLength(3);
});

it("defaults off and stores opt-in for this hub/account only; StrictMode registers one receiver", async () => {
  await render(); await tick();
  expect(container.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
  expect(io.http.mock.calls.filter(([u]) => u.endsWith("screen-presence"))).toHaveLength(0);
  await act(async () => changeScreenControl(true)); await tick();
  expect(screenEnabled(screenStorageKey("hub", "acct:a"))).toBe(true);
  expect(screenEnabled(screenStorageKey("other", "acct:a"))).toBe(false);
  expect(screenEnabled(screenStorageKey("hub", "acct:b"))).toBe(false);
  expect(io.http.mock.calls.filter(([u]) => u.endsWith("screen-presence"))).toHaveLength(1);
});

it("keeps a receipt before a failed result report, deduplicates wakeups, and supports undo/dismiss", async () => {
  await enabled();
  const original = io.http.getMockImplementation()!;
  io.http.mockImplementation((url, init) => url.endsWith("/result") ? Promise.reject(new Error("offline")) : original(url, init));
  await wake(); await wake();
  expect(io.execute).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("made");
  expect(container.textContent).toContain("화면 결과를 앱에 전달하지 못했어요");
  const undo = [...container.querySelectorAll("button")].find(b => b.textContent === "되돌리기")!;
  await act(async () => undo.click()); expect(io.undo).toHaveBeenCalledTimes(1);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="알림 닫기"]')!.click());
  expect(container.textContent).not.toContain("made");
});

it.each(["off", "scene", "edit", "account", "unmount"])("rejects a late claim after %s", async change => {
  await enabled();
  let resolve!: (value: unknown) => void;
  io.http.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await wake();
  const oldEpoch = epoch;
  if (change === "off") localStorage.setItem(screenStorageKey("hub", "acct:a"), "false");
  if (change === "scene") { scene = "B"; await render("B"); scene = "scene"; await render("A"); }
  if (change === "edit") io.revision += 1;
  if (change === "account") io.account = "acct:b";
  if (change === "unmount") { await act(async () => root.unmount()); root = createRoot(container); }
  await act(async () => resolve({ token: "claim", name: "canvas.create_nodes", args: { scene_id: "scene" }, epoch: oldEpoch, workspace: { scope: "personal", id: null }, client_name: "Claude Code", remaining_ms: 30_000 }));
  expect(io.execute).not.toHaveBeenCalled();
});

it("does not show enabled after storage failure and keeps heartbeats while hidden", async () => {
  await render();
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await act(async () => changeScreenControl(true));
  expect(container.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
  expect(container.textContent).toContain("저장하지 못했어요"); write.mockRestore();
  await act(async () => changeScreenControl(true)); await tick();
  io.http.mockClear(); await tick(60_000);
  expect(io.http.mock.calls.filter(([u]) => u.endsWith("screen-presence"))).toHaveLength(6);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => document.dispatchEvent(new Event("visibilitychange"))); await tick();
  io.http.mockClear(); await tick(60_000);
  expect(io.http.mock.calls.filter(([u]) => u.endsWith("screen-presence"))).toHaveLength(6);
  await act(async () => changeScreenControl(false)); await tick();
  io.http.mockClear(); await tick(60_000);
  expect(io.http).not.toHaveBeenCalled();
});

const visibility = async (value: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
};

it("registers while hidden, executes without a heartbeat wake, and reports hidden changes once", async () => {
  await visibility("hidden"); await enabled();
  const registeredEpoch = epoch;
  const flashes: string[] = [];
  const flash = (event: Event) => flashes.push((event as CustomEvent<string>).detail);
  window.addEventListener(APP_EVENTS.flash, flash);
  try {
    await wake("one"); await wake("two");
    expect(io.execute).toHaveBeenCalledTimes(2);
    expect(flashes).toHaveLength(0);
    expect(container.textContent).toContain("made");
    await visibility("visible"); await tick();
    expect(epoch).toBe(registeredEpoch);
    expect(flashes).toEqual(["가려진 동안 바깥 앱이 화면을 2번 바꿨어요"]);
    await visibility("hidden"); await visibility("visible");
    expect(flashes).toHaveLength(1);
  } finally { window.removeEventListener(APP_EVENTS.flash, flash); }
});

it("preserves a pending claim across visibility changes", async () => {
  await enabled();
  const response = await io.http.getMockImplementation()!("/claim");
  let resolve!: (value: unknown) => void;
  io.http.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await wake(); await visibility("hidden"); await tick();
  expect(epoch).toBe(response.epoch);
  await act(async () => resolve(response));
  expect(io.execute).toHaveBeenCalledTimes(1);
});

it("does not execute a claim received after expiry even when timeout callbacks did not run", async () => {
  await enabled();
  const response = await io.http.getMockImplementation()!("/claim");
  let resolve!: (value: unknown) => void;
  io.http.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await wake();
  vi.setSystemTime(Date.now() + 30_001);
  await act(async () => resolve(response));
  expect(io.execute).not.toHaveBeenCalled();
  const report = io.http.mock.calls.find(([url]) => url.endsWith("/result"));
  expect(JSON.parse(String(report![1].body)).ok).toBe(false);
});

it.each([false, true])("releases on pagehide (persisted=%s) with keepalive and stops claims", async persisted => {
  await enabled();
  io.http.mockClear();
  await act(async () => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted })));
  const [url, init] = io.fetch.mock.calls[0];
  expect(url).toContain("screen-presence");
  expect(init.keepalive).toBe(true);
  expect(init.headers.Authorization).toBe("Bearer token");
  expect(JSON.parse(String(init.body))).toMatchObject({ receiver_id: "receiver", secret: "secret", enabled: false, release: true });
  io.http.mockClear(); await wake(); await tick(60_000);
  expect(io.http).not.toHaveBeenCalled();
  expect(io.execute).not.toHaveBeenCalled();
});

it("reregisters on bfcache restoration and ignores a pre-pagehide claim", async () => {
  await enabled();
  const response = await io.http.getMockImplementation()!("/claim");
  let resolve!: (value: unknown) => void;
  io.http.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await wake("old");
  await act(async () => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  io.http.mockClear();
  await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  const registration = io.http.mock.calls.find(([url]) => url.endsWith("screen-presence"));
  expect(JSON.parse(String(registration![1].body)).receiver_id).toBeUndefined();
  await act(async () => resolve(response));
  expect(io.execute).not.toHaveBeenCalled();
  await wake("new"); expect(io.execute).toHaveBeenCalledTimes(1);
});

it("ignores a handle mismatch repaired within layout but invalidates a real detach", async () => {
  await enabled();
  const registeredEpoch = epoch;
  io.detached = true;
  await act(async () => root.render(<StrictMode><Consumer restoreHandle /></StrictMode>));
  await tick();
  expect(epoch).toBe(registeredEpoch);
  await wake("stable"); expect(io.execute).toHaveBeenCalledTimes(1);
  io.detached = true; await render(); await tick();
  expect(epoch).toBeGreaterThan(registeredEpoch);
  await wake("detached"); expect(io.execute).toHaveBeenCalledTimes(1);
});

it.each(["pagehide", "unmount", "token"])("cancels an unconfirmed registration on %s with the captured credentials", async change => {
  await render();
  let resolve!: (value: unknown) => void;
  io.http.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => changeScreenControl(true)); await tick();
  const request = io.http.mock.calls.find(([url]) => url.endsWith("screen-presence"))!;
  const registration = JSON.parse(String(request[1].body)).registration;
  expect(registration).toMatch(/^[a-f0-9]{48}$/);
  if (change === "pagehide") await act(async () => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  if (change === "unmount") { await act(async () => root.unmount()); root = createRoot(container); }
  if (change === "token") { io.token = "new-token"; await render(); }
  const [url, init] = io.fetch.mock.calls[0];
  expect(url).toContain("screen-presence");
  expect(init.keepalive).toBe(true);
  expect(init.headers.Authorization).toBe("Bearer token");
  expect(init.headers["X-MVHub-Expect-Account"]).toBe("acct:a");
  expect(JSON.parse(String(init.body))).toMatchObject({ registration, release: true, enabled: false, select: false });
  await act(async () => resolve({ receiver_id: "late", receiver_secret: "late-secret", multiple: false, selected: false }));
  await wake(); expect(io.execute).not.toHaveBeenCalled();
});

it.each(["token", "account", "connection"])("releases a receiver with old credentials unless the %s change moves to another hub", async change => {
  await enabled();
  io.fetch.mockClear();
  if (change === "token") io.token = "new-token";
  if (change === "account") io.account = "acct:b";
  if (change === "connection") io.connection = "other-hub";
  await render();
  if (change === "connection") expect(io.fetch).not.toHaveBeenCalled();
  else {
    const init = io.fetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer token");
    expect(init.headers["X-MVHub-Expect-Account"]).toBe("acct:a");
    expect(JSON.parse(String(init.body))).toMatchObject({ receiver_id: "receiver", secret: "secret", release: true });
  }
});

it.each(["timeout", "lost-response"])("immediately cancels a registration after %s and retains it until cancellation succeeds", async failure => {
  await render();
  let reject!: (reason: unknown) => void;
  let accepted!: (value: unknown) => void;
  io.http.mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r; }));
  io.fetch.mockImplementation(() => new Promise(r => { accepted = r; }));
  await act(async () => changeScreenControl(true)); await tick();
  const registration = JSON.parse(String(io.http.mock.calls.find(([url]) => url.endsWith("screen-presence"))![1].body)).registration;
  await act(async () => reject(new Error(failure)));
  expect(io.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(io.fetch.mock.calls[0][1].body)).registration).toBe(registration);
  await act(async () => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  expect(io.fetch).toHaveBeenCalledTimes(2);
  await act(async () => accepted({ ok: true, status: 200 }));
  io.fetch.mockClear();
  await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  expect(io.fetch).not.toHaveBeenCalled();
});

it.each([429, "network"])("retries cancellation after %s and pauses new registrations when four remain unknown", async failure => {
  await render();
  const original = io.http.getMockImplementation()!;
  io.http.mockImplementation((url, init) => url.endsWith("screen-presence") ? Promise.reject(new Error("lost")) : original(url, init));
  if (failure === "network") io.fetch.mockRejectedValue(new Error("offline"));
  else io.fetch.mockResolvedValue({ ok: false, status: failure });
  await act(async () => changeScreenControl(true)); await tick();
  await tick(240_000);
  const registrations = () => io.http.mock.calls.filter(([url]) => url.endsWith("screen-presence"));
  expect(registrations()).toHaveLength(4);
  const values = new Set(registrations().map(([, init]) => JSON.parse(String(init.body)).registration));
  expect(values.size).toBe(4);
  expect(io.fetch.mock.calls.length).toBeGreaterThan(4);
  await tick(120_000); expect(registrations()).toHaveLength(4);
  io.fetch.mockResolvedValue({ ok: true, status: 200 });
  await tick(120_000);
  expect(registrations().length).toBeGreaterThan(4);
});

it.each([403, 422])("forgets explicitly rejected cancellations (%s) and can register again", async status => {
  await render();
  const original = io.http.getMockImplementation()!;
  io.http.mockImplementation((url, init) => url.endsWith("screen-presence") ? Promise.reject(new Error("lost")) : original(url, init));
  io.fetch.mockResolvedValue({ ok: false, status });
  await act(async () => changeScreenControl(true)); await tick();
  await tick(300_000);
  const registrations = io.http.mock.calls.filter(([url]) => url.endsWith("screen-presence"));
  expect(registrations.length).toBeGreaterThan(4);
  const count = io.fetch.mock.calls.length;
  await act(async () => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  expect(io.fetch).toHaveBeenCalledTimes(count);
});

it("does not cancel a registration that was explicitly rejected", async () => {
  await render();
  io.http.mockRejectedValueOnce({ status: 422 });
  await act(async () => changeScreenControl(true)); await tick();
  await act(async () => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  expect(io.fetch).not.toHaveBeenCalled();
});
