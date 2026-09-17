// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useManageCaps } from "../src/lib/useManageCaps";
import { api } from "../src/api";
import { sharedApi } from "../src/lib/sharedApi";
import { APP_EVENTS, dispatchAppEvent } from "../src/lib/appEvents";
import { STORAGE_KEYS } from "../src/lib/storageKeys";
import { getAuthToken, setAuthToken } from "../src/lib/http";

vi.mock("../src/api", () => ({ api: { authConfig: vi.fn(), me: vi.fn(), members: vi.fn() } }));
vi.mock("../src/lib/sharedApi", () => ({ sharedApi: { sharedServerStatus: vi.fn() } }));
let host: HTMLDivElement;
let root: Root;
function Harness({ signal }: { signal: number }) {
  const caps = useManageCaps(signal);
  return <div data-key={caps.contextKey}>{caps.loaded ? `${caps.viewerUid}:${caps.readAll}:${caps.authOff}` : "loading"}</div>;
}
function render(signal = 0) { act(() => root.render(<Harness signal={signal} />)); }
async function settle() { await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); }); }
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function proxyStatus(roles: string[] = []) { return { configured: true, has_token: true, roles } as never; }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); vi.clearAllMocks(); setAuthToken(null);
  vi.mocked(api.authConfig).mockResolvedValue({ auth_enabled: false } as never);
  vi.mocked(api.me).mockResolvedValue({ creator_uid: "me" } as never);
  vi.mocked(sharedApi.sharedServerStatus).mockResolvedValue(proxyStatus(["admin"]));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("refreshes permissions using the existing manage reload signal without changing an identical context", async () => {
  render(); await settle(); expect(host.textContent).toBe("me:true:false");
  const firstKey = host.firstElementChild?.getAttribute("data-key");
  render(1); await settle(); expect(host.firstElementChild?.getAttribute("data-key")).toBe(firstKey);
  vi.mocked(sharedApi.sharedServerStatus).mockResolvedValue(proxyStatus([]));
  render(2); await settle(); expect(host.textContent).toBe("me:false:false");
  expect(host.firstElementChild?.getAttribute("data-key")).not.toBe(firstKey);
});

it("invalidates immediately on account change and ignores the older account response", async () => {
  const old = deferred<Awaited<ReturnType<typeof api.me>>>();
  vi.mocked(api.me).mockReturnValueOnce(old.promise);
  render(); await settle();
  vi.mocked(api.me).mockResolvedValue({ creator_uid: "new" } as never);
  act(() => dispatchAppEvent(APP_EVENTS.accountUpdated)); await settle();
  expect(host.textContent).toBe("new:true:false");
  old.resolve({ creator_uid: "old" } as never); await settle();
  expect(host.textContent).toBe("new:true:false");
});

it("clears the old capabilities while a replacement account is being verified", async () => {
  render(); await settle();
  const next = deferred<Awaited<ReturnType<typeof api.me>>>();
  vi.mocked(api.me).mockReturnValue(next.promise);
  act(() => dispatchAppEvent(APP_EVENTS.accountUpdated));
  expect(host.textContent).toBe("loading");
  next.resolve({ creator_uid: "new" } as never); await settle();
  expect(host.textContent).toBe("new:true:false");
});

it("uses newly stored credentials in the independent manage window", async () => {
  render(); await settle();
  localStorage.setItem(STORAGE_KEYS.authToken, "new-test-token");
  localStorage.setItem(STORAGE_KEYS.activeAccount, "synthetic-new-account");
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.activeAccount })));
  expect(host.textContent).toBe("loading"); expect(getAuthToken()).toBe("new-test-token");
  await settle(); expect(host.textContent).toBe("me:true:false");
});

it("does not start an immediate authentication retry loop after auth-required", async () => {
  render(); await settle(); const calls = vi.mocked(api.authConfig).mock.calls.length;
  act(() => dispatchAppEvent(APP_EVENTS.authRequired)); await settle();
  expect(host.textContent).toBe("loading"); expect(api.authConfig).toHaveBeenCalledTimes(calls);
});

it("does not mistake a failed or logged-out shared connection for unrestricted local mode", async () => {
  vi.mocked(sharedApi.sharedServerStatus).mockRejectedValueOnce(new Error("offline"));
  render(); await settle(); expect(host.textContent).toBe("null:false:false");
  vi.mocked(sharedApi.sharedServerStatus).mockResolvedValue({ configured: true, has_token: false } as never);
  render(1); await settle(); expect(host.textContent).toBe("null:false:false");
});
