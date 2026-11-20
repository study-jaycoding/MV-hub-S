// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ http: vi.fn(), execute: vi.fn(), undo: vi.fn(), token: "token", account: "acct:a", connection: "hub", revision: 1 }));
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
const host = { scene: () => scene ? { sceneId: scene, snapshot: () => ({ cards: [], edges: [], groups: [] }) } : null } as ScreenHost;
function Consumer({ view = "A" }: { view?: string }) {
  const result = useMcpScreenActions({ ready: true, authKey: "auth", workspace, host, boardVisible: true, sceneId: scene, viewKey: view });
  return <><McpScreenControl /><McpScreenNotice {...result} /></>;
}
const tick = async (ms = 110) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const render = async (view = "A") => { await act(async () => root.render(<StrictMode><Consumer view={view} /></StrictMode>)); };
const wake = async (id = "action") => { await act(async () => dispatchAppEvent(APP_EVENTS.mcpScreenAction, { receiver_id: "receiver", action_id: id })); };
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); localStorage.clear(); scene = "scene"; epoch = 1;
  io.account = "acct:a"; io.token = "token"; io.connection = "hub"; io.revision = 1;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  setHubFeatures(["external_screen"]);
  io.http.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/health") return { mcp_bridge: { hub_id: "hub" } };
    if (url.endsWith("screen-presence")) {
      epoch = JSON.parse(String(init?.body)).epoch;
      return { receiver_id: "receiver", receiver_secret: "secret", multiple: false, selected: false };
    }
    if (url.endsWith("/claim")) return { token: "claim", name: "canvas.create_nodes", args: { scene_id: "scene" }, epoch, workspace: { scope: "personal", id: null }, client_name: "Claude Code" };
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

it.each(["hidden", "off", "scene", "edit", "account", "unmount"])("rejects a late claim after %s", async change => {
  await enabled();
  let resolve!: (value: unknown) => void;
  io.http.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await wake();
  const oldEpoch = epoch;
  if (change === "hidden") Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  if (change === "off") localStorage.setItem(screenStorageKey("hub", "acct:a"), "false");
  if (change === "scene") { scene = "B"; await render("B"); scene = "scene"; await render("A"); }
  if (change === "edit") io.revision += 1;
  if (change === "account") io.account = "acct:b";
  if (change === "unmount") { await act(async () => root.unmount()); root = createRoot(container); }
  await act(async () => resolve({ token: "claim", name: "canvas.create_nodes", args: {}, epoch: oldEpoch, workspace: { scope: "personal", id: null }, client_name: "Claude Code" }));
  expect(io.execute).not.toHaveBeenCalled();
});

it("does not show enabled after storage failure and stops polling while hidden", async () => {
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
  expect(io.http).not.toHaveBeenCalled();
});
