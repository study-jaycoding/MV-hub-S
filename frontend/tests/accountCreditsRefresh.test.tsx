// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountStatus } from "../src/lib/useAccountStatus";
import { APP_EVENTS } from "../src/lib/appEvents";
import { connectProgress } from "../src/lib/progressSocket";
import { setAuthToken } from "../src/lib/http";
import { setAccountScope, setConnectionKey } from "../src/lib/accountScope";
import type { WorkspaceContext } from "../src/types";

const api = vi.hoisted(() => ({ account: vi.fn(), workspaces: vi.fn() }));
vi.mock("../src/api", () => ({ api }));

const A: WorkspaceContext = { scope: "team", id: "a", name: "A" };
const B: WorkspaceContext = { scope: "team", id: "b", name: "B" };
const rows = (a = 100, b = 80) => [
  { id: "a", name: "A", credits: a, plan_type: "team", user_role: "owner", is_selected: true },
  { id: "b", name: "B", credits: b, plan_type: "team", user_role: "owner", is_selected: false },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let root: Root;
let element: HTMLDivElement;
let result: ReturnType<typeof useAccountStatus>;
function Picker({ workspace }: { workspace: WorkspaceContext }) {
  result = useAccountStatus(workspace);
  return <span>{result.account?.credits ?? "unknown"}</span>;
}
async function render(workspace = A) {
  await act(async () => { root.render(<Picker workspace={workspace} />); });
}
async function changed() {
  await act(async () => { window.dispatchEvent(new Event(APP_EVENTS.creditsChanged)); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setAccountScope("a@example.test");
  setConnectionKey("test-hub");
  setAuthToken("test-token-a");
  api.account.mockReset().mockResolvedValue({ connected: true, email: "a@example.test", credits: 999 });
  api.workspaces.mockReset().mockResolvedValue(rows());
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  element.remove();
  setAuthToken(null);
  vi.unstubAllGlobals();
});

describe("selected workspace credits refresh", () => {
  it("does not start background reads until queried, then coalesces completion events", async () => {
    await render();
    await changed();
    expect(api.workspaces).not.toHaveBeenCalled();
    await act(async () => { await result.checkAccount(); });
    expect(result.account?.credits).toBe(100);
    const pending = deferred<ReturnType<typeof rows>>();
    api.workspaces.mockReturnValue(pending.promise);
    await act(async () => {
      window.dispatchEvent(new Event(APP_EVENTS.creditsChanged));
      window.dispatchEvent(new Event(APP_EVENTS.creditsChanged));
      window.dispatchEvent(new Event(APP_EVENTS.creditsChanged));
    });
    expect(api.workspaces).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve(rows(75)); });
    expect(result.account?.credits).toBe(75);
    expect(api.workspaces).toHaveBeenCalledTimes(3); // 진행 중 알림은 후속 1회로 합친다.
  });

  it("preserves the previous number on failure and never invents account-level fallback credits", async () => {
    await render();
    await act(async () => { await result.checkAccount(); });
    api.workspaces.mockRejectedValue(new Error("offline"));
    await changed();
    expect(result.account?.credits).toBe(100);
    await render(B);
    await act(async () => { await result.checkAccount(); });
    expect(result.account?.credits).toBeNull();
  });
  it("keeps the same-account identity and balance on a disconnected 200 response, but clears them after identity switches", async () => {
    await render();
    await act(async () => { await result.checkAccount(); });
    api.account.mockResolvedValue({ connected: false, email: "", credits: null });
    api.workspaces.mockResolvedValue(rows(7));
    await changed();
    expect(result.account).toMatchObject({ connected: false, email: "a@example.test", credits: 100 });
    setAccountScope("b@example.test");
    setAuthToken("test-token-b");
    await render();
    expect(result.account).toBeNull();
    await act(async () => { await result.checkAccount(); });
    expect(result.account?.email).toBe("");
    expect(result.account?.connected).toBe(false);
  });

  it("rejects late responses after switching workspace or credentials", async () => {
    const old = deferred<ReturnType<typeof rows>>();
    api.workspaces.mockReturnValueOnce(old.promise);
    await render();
    await act(async () => { void result.checkAccount(); });
    await render(B);
    await act(async () => { await result.checkAccount(); });
    expect(result.account?.credits).toBe(80);
    await act(async () => { old.resolve(rows(1, 2)); });
    expect(result.account?.credits).toBe(80);
    const other = deferred<ReturnType<typeof rows>>();
    api.workspaces.mockReturnValueOnce(other.promise);
    await changed();
    setAuthToken("test-token-b");
    await act(async () => { other.resolve(rows(3, 4)); });
    expect(result.account?.credits).toBe(80);
  });

  it("only converts completion/transaction messages from current credentials into refresh events", () => {
    class Socket {
      static OPEN = 1;
      static instance: Socket;
      readyState = 1;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      constructor() { Socket.instance = this; }
      send() {}
      close() {}
    }
    vi.stubGlobal("WebSocket", Socket);
    const listener = vi.fn();
    window.addEventListener(APP_EVENTS.creditsChanged, listener);
    const disconnect = connectProgress(() => {});
    for (const message of [{ type: "synced" }, { type: "progress", status: "running" }]) {
      Socket.instance.onmessage?.({ data: JSON.stringify(message) });
    }
    expect(listener).not.toHaveBeenCalled();
    Socket.instance.onmessage?.({ data: JSON.stringify({ type: "credits_changed" }) });
    Socket.instance.onmessage?.({ data: JSON.stringify({ type: "progress", status: "done" }) });
    expect(listener).toHaveBeenCalledTimes(2);
    setAuthToken("different-token");
    Socket.instance.onmessage?.({ data: JSON.stringify({ type: "credits_changed" }) });
    expect(listener).toHaveBeenCalledTimes(2);
    disconnect();
    window.removeEventListener(APP_EVENTS.creditsChanged, listener);
  });

  it("shares workspace HTTP only within the same account and connection", async () => {
    const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
    const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(new Response(JSON.stringify(rows()), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const first = actual.api.workspaces();
    const same = actual.api.workspaces();
    expect(first).toBe(same);
    setAuthToken("test-token-new");
    const other = actual.api.workspaces();
    expect(other).not.toBe(first);
    pending.resolve(new Response(JSON.stringify(rows()), { status: 200 }));
    await Promise.all([first, same, other]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
