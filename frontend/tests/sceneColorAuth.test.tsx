// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Account, Generation } from "../src/types";

let root: Root | null;
let host: HTMLDivElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Real socket forbidden"); } });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Real HTTP forbidden"); }));
  localStorage.clear(); sessionStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; host.remove(); await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("auth-enabled 401 changes actual auth scope, unmounts through App gates and restarts after the same account signs in", async () => {
  const { useHubAuth } = await import("../src/lib/useHubAuth");
  const { useSceneGenData } = await import("../src/lib/useSceneGenData");
  const { getAuthToken, setAuthToken } = await import("../src/api");
  const { setAccountScope } = await import("../src/lib/accountScope");
  const { STORAGE_KEYS } = await import("../src/lib/storageKeys");
  const account: Account = { email: "synthetic-A", name: "A", status: "approved", global_roles: [],
    creator_uid: "uid-A", created_at: "", approved_at: null };
  const generation: Generation = {
    id: "a", color: "#ff5722", status: "done", prompt: "synthetic", worker_id: "worker", worker_name: null,
    display_prompt: null, model: null, params: {}, error: null, created_at: "2026-09-17", tags: [], auto_tags: [],
    assets: [], references: [], shared: false, parent_gen_id: null, is_source: false, source_name: null,
    comment: null, comment_count: 0, has_unread: false, local_only: false, creator_uid: null, creator_name: null,
    is_mine: true, workspace_scope: "personal", workspace_id: null, workspace_name: null, project_id: null, deleted: false,
  };
  setAuthToken("synthetic-token-A"); setAccountScope(account.email);
  localStorage.setItem(STORAGE_KEYS.activeAccount, account.email); // same-account path: no location.reload
  const reads: { token: string | null; reply: ReturnType<typeof deferred<Response>> }[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    if (url === "/api/auth/config") return Promise.resolve(response({ auth_enabled: true, has_accounts: true }));
    if (url === "/api/auth/me") return Promise.resolve(response(account));
    if (url === "/api/projects/my-finalize-roles") return Promise.resolve(response({ project_ids: [] }));
    if (url === "/api/generations/batch") {
      const reply = deferred<Response>(); reads.push({ token: new Headers(init.headers).get("Authorization"), reply });
      return reply.promise;
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  let auth!: ReturnType<typeof useHubAuth>;
  let data!: ReturnType<typeof useSceneGenData>;
  let authKey = "";
  function Data({ scopeKey, ready }: { scopeKey: string; ready: boolean }) {
    data = useSceneGenData([{ id: "card", kind: "generation", genId: "a", x: 0, y: 0 }],
      { sceneKey: "A", authKey: scopeKey, authReady: ready });
    return <output>{data.genData.a?.color}</output>;
  }
  function Host() {
    auth = useHubAuth();
    authKey = JSON.stringify([auth.hubAccount?.email, auth.account?.email, auth.account?.creator_uid, auth.sharedSrv?.url]);
    // App's auth-enabled render gates only; this fixture does not mount the complete App.
    if (auth.authPending) return null;
    if (auth.authConfig?.auth_enabled && !auth.account) return <span>Login</span>;
    return <Data scopeKey={authKey} ready={auth.authReady} />;
  }
  await act(async () => root!.render(<Host />));
  expect(auth.account?.email).toBe(account.email); expect(auth.authReady).toBe(true);
  expect(host.querySelector("output")).not.toBeNull();
  const initialReads = reads.length;
  expect(initialReads).toBeGreaterThan(0);
  const signedInKey = authKey;
  await act(async () => reads[initialReads - 1].reply.resolve(response({ detail: "synthetic expired" }, 401)));
  expect(getAuthToken()).toBeNull(); expect(auth.authReady).toBe(false);
  expect(authKey).not.toBe(signedInKey); expect(host.textContent).toBe("Login");
  const stoppedCount = reads.length;
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(reads).toHaveLength(stoppedCount);
  // Re-login transport is synthetic; actual public auth setters restart the gated child.
  await act(async () => { setAuthToken("synthetic-token-A2"); auth.setAccount(account); });
  expect(auth.authReady).toBe(true); expect(authKey).toBe(signedInKey);
  expect(reads).toHaveLength(stoppedCount + 1);
  expect(reads[reads.length - 1].token).toBe("Bearer synthetic-token-A2");
  await act(async () => reads[reads.length - 1].reply.resolve(response({ items: { a: generation }, materials: {}, missing: [] })));
  expect(data.genDataRef.current.a.color).toBe(generation.color);
  expect(host.textContent).toBe(generation.color);
});
