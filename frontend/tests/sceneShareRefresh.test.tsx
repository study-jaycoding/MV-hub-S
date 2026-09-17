// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
import type { Scene } from "../src/lib/scenes";

let root: Root | null;
let host: HTMLDivElement;
let apiModule: typeof import("../src/api");
let cache: typeof import("../src/lib/sceneGenDataStore");
let scopeModule: typeof import("../src/lib/accountScope");
let Board: typeof import("../src/components/scene/SceneBoard").SceneBoard;
let data: ReturnType<typeof import("../src/lib/useSceneGenData").useSceneGenData>;
let scene: Scene;
let authKey: string;
let ready: boolean;
let onPublish: ReturnType<typeof vi.fn<(g: Generation) => Promise<void>>>;
let polls: ReturnType<typeof deferred<Response>>[];
let singles: ReturnType<typeof deferred<Response>>[];
let saves: ReturnType<typeof deferred<Response>>[];
const base = "#777777", red = "#ff5722", blue = "#2196f3";
function generation(id = "a"): Generation {
  return { id, color: base, status: "done", prompt: "synthetic", is_mine: true,
    worker_id: "worker", worker_name: null, display_prompt: null, model: null, params: {}, error: null,
    created_at: "2026-09-17", tags: [], auto_tags: [], assets: [], references: [], shared: false,
    parent_gen_id: null, is_source: false, source_name: null, comment: null, comment_count: 0,
    has_unread: false, local_only: false, creator_uid: null, creator_name: null,
    workspace_scope: "personal", workspace_id: null, workspace_name: null, project_id: null, deleted: false };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });
const color = () => host.querySelector<HTMLElement>(".linb-colorbar")?.style.background;
async function render() {
  await act(async () => root!.render(<Board scene={scene} onChange={() => {}}
    onPublish={onPublish} authKey={authKey} authReady={ready} />));
}
async function mountAndConfirm() {
  await render();
  const card = host.querySelector<HTMLElement>(".scene-card")!;
  act(() => {
    card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    [...host.querySelectorAll<HTMLButtonElement>(".linb-ov-top button")].find(el => el.textContent === "S")!.click();
  });
  await act(async () => vi.advanceTimersByTimeAsync(230));
  const yes = [...host.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === "Yes");
  expect(yes).toBeDefined(); await act(async () => yes!.click());
  expect(onPublish).toHaveBeenCalledTimes(1);
}
async function changeScope(kind: string) {
  if (kind === "token") apiModule.setAuthToken("synthetic-B");
  else if (kind === "namespace") scopeModule.setAccountScope("synthetic-B");
  else if (kind === "account") authKey = "account-B";
  else if (kind === "ready") ready = false;
  else scene = { ...scene, id: "scene-B" }; // same gid survives the scene transition
  await render();
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Real socket forbidden"); } });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Real HTTP forbidden"); }));
  localStorage.clear(); sessionStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  apiModule = await import("../src/api"); cache = await import("../src/lib/sceneGenDataStore");
  scopeModule = await import("../src/lib/accountScope");
  const hook = await import("../src/lib/useSceneGenData");
  const original = hook.useSceneGenData;
  vi.spyOn(hook, "useSceneGenData").mockImplementation((cards, scope) => {
    data = original(cards, scope); return data;
  });
  Board = (await import("../src/components/scene/SceneBoard")).SceneBoard;
  apiModule.setAuthToken("synthetic-A"); scopeModule.setAccountScope("synthetic-A");
  cache.putGen(generation());
  scene = { id: "scene-A", name: "Synthetic", created_at: 0, edges: [],
    cards: [{ id: "card", kind: "generation", genId: "a", x: 0, y: 0 }] };
  authKey = "account-A"; ready = true; polls = []; singles = []; saves = [];
  onPublish = vi.fn(async () => {});
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/generations/batch") { const reply = deferred<Response>(); polls.push(reply); return reply.promise; }
    if (url === "/api/generations/a") { const reply = deferred<Response>(); singles.push(reply); return reply.promise; }
    if (url === "/api/generations/colors/batch") { const reply = deferred<Response>(); saves.push(reply); return reply.promise; }
    if (url.startsWith("/api/generation-views?")) return Promise.resolve(response({ card: {}, last_card_id: null }));
    if (url.startsWith("/api/models")) return Promise.resolve(response([]));
    throw new Error(`Unexpected request ${url}`);
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; host.remove(); await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each([false, true])("actual share-confirm refresh preserves color and cache, old reply after save=%s", async late => {
  await mountAndConfirm(); expect(singles).toHaveLength(1);
  const fresh = { ...generation(), shared: true, folder_path: "fresh" };
  if (!late) await act(async () => singles[0].resolve(response(fresh)));
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
  expect(saves).toHaveLength(1);
  await act(async () => saves[0].resolve(response({ succeeded: ["a"], failed: [] })));
  if (late) await act(async () => singles[0].resolve(response(fresh)));
  expect(color()).toBe("rgb(255, 87, 34)");
  expect(data.genDataRef.current.a.color).toBe(red); expect(cache.hydrateGen(["a"]).a.color).toBe(red);
  expect(data.genData.a.folder_path).toBe("fresh");
  expect(cache.hydrateGen(["a"]).a.folder_path).toBe("fresh");
});
it.each(["token", "namespace", "account", "ready", "scene"])("%s change while the share action waits prevents the single GET", async kind => {
  const action = deferred<void>(); onPublish.mockImplementation(() => action.promise);
  await mountAndConfirm(); expect(singles).toHaveLength(0);
  await changeScope(kind); await act(async () => action.resolve());
  expect(singles).toHaveLength(0);
});
it.each(["token", "namespace", "account", "ready", "scene"])("%s change while the single GET waits prevents response writes", async kind => {
  await mountAndConfirm(); expect(singles).toHaveLength(1);
  await changeScope(kind);
  const previous = data.genDataRef.current.a; const cached = cache.hydrateGen(["a"]).a;
  await act(async () => singles[0].resolve(response({ ...generation(), color: blue, folder_path: "stale" })));
  expect(data.genDataRef.current.a).toEqual(previous); expect(cache.hydrateGen(["a"]).a).toEqual(cached);
});
it("a pruned card is not recreated by its single response", async () => {
  await mountAndConfirm(); scene = { ...scene, cards: [] }; await render();
  expect(data.genData.a).toBeUndefined();
  await act(async () => singles[0].resolve(response({ ...generation(), color: blue })));
  expect(data.genData.a).toBeUndefined(); expect(cache.hydrateGen(["a"]).a.color).toBe(base);
});
it("pending color is kept while fresh sharing fields are accepted and cached", async () => {
  await mountAndConfirm();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
  await act(async () => singles[0].resolve(response({ ...generation(), shared: true, is_held: true })));
  expect(data.genData.a.color).toBe(red); expect(data.genData.a.is_held).toBe(true);
  expect(cache.hydrateGen(["a"]).a.is_held).toBe(true);
});
it("a color completed during the share action does not pin the later GET to its old action-time color", async () => {
  const action = deferred<void>(); onPublish.mockImplementation(() => action.promise);
  await mountAndConfirm();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
  await act(async () => saves[0].resolve(response({ succeeded: ["a"], failed: [] })));
  await act(async () => action.resolve());
  await act(async () => singles[0].resolve(response({ ...generation(), color: blue, shared: true })));
  expect(data.genDataRef.current.a.color).toBe(blue); expect(cache.hydrateGen(["a"]).a.color).toBe(blue);
});
it("a GET that starts while color is pending keeps that color even after the save finishes", async () => {
  const action = deferred<void>(); onPublish.mockImplementation(() => action.promise);
  await mountAndConfirm();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true })));
  await act(async () => action.resolve());
  expect(singles).toHaveLength(1);
  await act(async () => saves[0].resolve(response({ succeeded: ["a"], failed: [] })));
  await act(async () => singles[0].resolve(response({ ...generation(), shared: true })));
  expect(data.genDataRef.current.a.color).toBe(red); expect(cache.hydrateGen(["a"]).a.color).toBe(red);
});
it("single response aliases keep the requested state key and populate both cache keys", async () => {
  await mountAndConfirm();
  await act(async () => singles[0].resolve(response({ ...generation("canonical"), shared: true, color: blue })));
  expect(data.genData.a.id).toBe("canonical"); expect(data.genData.canonical).toBeUndefined();
  expect(cache.hydrateGen(["a", "canonical"]).a.color).toBe(blue);
  expect(cache.hydrateGen(["canonical"]).canonical.color).toBe(blue);
});
it("an async action rejection is consumed and still refreshes the server state", async () => {
  const action = deferred<void>(); onPublish.mockImplementation(() => action.promise);
  await mountAndConfirm(); await act(async () => action.reject(new Error("synthetic action failure")));
  expect(singles).toHaveLength(1);
  await act(async () => singles[0].resolve(response({ ...generation(), shared: false })));
  expect(data.genData.a.shared).toBe(false); expect(cache.hydrateGen(["a"]).a.shared).toBe(false);
});
it("single GET failure remains quiet without changing the last cached record", async () => {
  await mountAndConfirm(); const previous = cache.hydrateGen(["a"]).a;
  await act(async () => singles[0].reject(new Error("synthetic transient read")));
  expect(cache.hydrateGen(["a"]).a).toEqual(previous); expect(data.genData.a.shared).toBe(true);
});
it("an unrelated card added while the action waits does not cancel its single refresh", async () => {
  const action = deferred<void>(); onPublish.mockImplementation(() => action.promise);
  await mountAndConfirm(); cache.putGen(generation("b"));
  scene = { ...scene, cards: [...scene.cards, { id: "card-b", kind: "generation", genId: "b", x: 100, y: 0 }] };
  await render(); await act(async () => action.resolve());
  expect(singles).toHaveLength(1);
  await act(async () => singles[0].resolve(response({ ...generation(), shared: false, color: blue })));
  expect(data.genData.a.shared).toBe(false); expect(cache.hydrateGen(["a"]).a.color).toBe(blue);
});
it.each(["scene", "ready"])("observed %s ABA still rejects the old action refresh", async kind => {
  const action = deferred<void>(); onPublish.mockImplementation(() => action.promise);
  await mountAndConfirm(); await changeScope(kind);
  if (kind === "scene") scene = { ...scene, id: "scene-A" }; else ready = true;
  await render(); await act(async () => action.resolve()); expect(singles).toHaveLength(0);
});
it("unmount during an action prevents the later GET", async () => {
  const action = deferred<void>(); onPublish.mockImplementation(() => action.promise);
  await mountAndConfirm(); await act(async () => root!.unmount()); root = null;
  await act(async () => action.resolve()); expect(singles).toHaveLength(0);
});
it("unmount while the single GET is in flight prevents ref and cache writes", async () => {
  await mountAndConfirm(); expect(singles).toHaveLength(1);
  const ref = data.genDataRef, previous = ref.current, cached = cache.hydrateGen(["a"]).a;
  await act(async () => root!.unmount()); root = null;
  const put = vi.spyOn(cache, "putGen");
  await act(async () => singles[0].resolve(response({ ...generation(), color: blue, folder_path: "late" })));
  expect(ref.current).toBe(previous); expect(cache.hydrateGen(["a"]).a).toBe(cached);
  expect(put).not.toHaveBeenCalled();
});
it("an actual batch missing response takes deletion priority over an older single GET without rewriting the cache", async () => {
  await mountAndConfirm(); expect(polls).toHaveLength(1); expect(singles).toHaveLength(1);
  // Per-item deletion uses HTTP 200 + missing; a whole-batch HTTP 404/410 is not this contract.
  await act(async () => polls[0].resolve(response({ items: {}, materials: {}, missing: ["a"] })));
  expect(data.genData.a).toBeUndefined(); expect(data.missingIds.has("a")).toBe(true);
  expect(cache.hydrateMissing(["a"]).has("a")).toBe(true);
  expect(cache.hydrateGen(["a"])).toEqual({});
  const ref = data.genDataRef.current, put = vi.spyOn(cache, "putGen");
  await act(async () => singles[0].resolve(response({ ...generation(), shared: true, color: blue })));
  expect(data.genDataRef.current).toBe(ref); expect(data.genData.a).toBeUndefined();
  expect(cache.hydrateGen(["a"])).toEqual({}); expect(put).not.toHaveBeenCalled();
  expect(cache.hydrateMissing(["a"]).has("a")).toBe(true);
});
it.each([404, 410])("single GET HTTP %s stays quiet and does not declare deletion", async status => {
  await mountAndConfirm(); const previous = data.genDataRef.current, cached = cache.hydrateGen(["a"]).a;
  const put = vi.spyOn(cache, "putGen");
  await act(async () => singles[0].resolve(response({ detail: "synthetic absent" }, status)));
  expect(data.genDataRef.current).toBe(previous); expect(cache.hydrateGen(["a"]).a).toBe(cached);
  expect(data.missingIds.has("a")).toBe(false); expect(cache.hydrateMissing(["a"]).has("a")).toBe(false);
  expect(put).not.toHaveBeenCalled();
});
it.each([404, 410])("whole batch HTTP %s preserves the card and retries instead of declaring deletion", async status => {
  await mountAndConfirm(); const previous = data.genDataRef.current, cached = cache.hydrateGen(["a"]).a;
  await act(async () => polls[0].resolve(response({ detail: "synthetic batch failure" }, status)));
  expect(data.genDataRef.current).toBe(previous); expect(cache.hydrateGen(["a"]).a).toBe(cached);
  expect(data.missingIds.has("a")).toBe(false); expect(cache.hydrateMissing(["a"]).has("a")).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(2499)); expect(polls).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(1)); expect(polls).toHaveLength(2);
  await act(async () => singles[0].resolve(response({ ...generation(), shared: true, color: blue })));
  expect(data.genDataRef.current.a.color).toBe(blue); expect(cache.hydrateGen(["a"]).a.color).toBe(blue);
});
it.each([undefined, "invalid", "preserved"])("single GET 401 uses the common auth policy (%s) while its local catch stays quiet", async header => {
  const { APP_EVENTS } = await import("../src/lib/appEvents");
  const authRequired = vi.fn(), flash = vi.fn();
  window.addEventListener(APP_EVENTS.authRequired, authRequired);
  window.addEventListener(APP_EVENTS.flash, flash);
  try {
    await mountAndConfirm(); const previous = data.genDataRef.current, cached = cache.hydrateGen(["a"]).a;
    const put = vi.spyOn(cache, "putGen");
    await act(async () => singles[0].resolve(response({ detail: "synthetic expired" }, 401,
      header ? { "X-MVHub-Auth-State": header } : undefined)));
    expect(apiModule.getAuthToken()).toBe(header === "preserved" ? "synthetic-A" : null);
    expect(authRequired).toHaveBeenCalledTimes(header === "preserved" ? 0 : 1);
    expect(flash).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    expect(data.genDataRef.current).toBe(previous); expect(cache.hydrateGen(["a"]).a).toBe(cached);
    // This Board fixture has no App auth gate: event delivery, not full App unmount, is asserted here.
    await act(async () => vi.advanceTimersByTimeAsync(3000)); expect(singles).toHaveLength(1);
  } finally {
    window.removeEventListener(APP_EVENTS.authRequired, authRequired);
    window.removeEventListener(APP_EVENTS.flash, flash);
  }
});
it.each(["success", "blocked", "http-failure", "reload-failure"])("actual publish action %s broadcasts only a successful publish and the DOM listener debounces a batch poll", async outcome => {
  const { useGenerationShareActions } = await import("../src/lib/useGenerationShareActions");
  const { APP_EVENTS } = await import("../src/lib/appEvents");
  const broadcast = await import("../src/lib/libraryBroadcast");
  const post = vi.spyOn(broadcast, "postLibraryChanged"), changed = vi.fn();
  const originalFetch = globalThis.fetch, publish = deferred<Response>();
  const requests: RequestInit[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/publish-to-shared") { requests.push(init!); return publish.promise; }
    return originalFetch(url, init);
  }));
  const reload = vi.fn(async () => { if (outcome === "reload-failure") throw new Error("synthetic reload failure"); });
  const bumpBoard = vi.fn(), flash = vi.fn();
  // This existing action factory has no React hooks; it and its real HTTP/broadcast helpers are not mocked.
  const actions = useGenerationShareActions({ reload, bumpBoard, flash });
  onPublish.mockImplementation(actions.onPublish);
  window.addEventListener(APP_EVENTS.libraryChanged, changed);
  try {
    await mountAndConfirm(); expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST"); expect(JSON.parse(String(requests[0].body))).toEqual({ gen_ids: ["a"] });
    expect(singles).toHaveLength(0); expect(polls).toHaveLength(1);
    await act(async () => publish.resolve(outcome === "http-failure"
      ? response({ detail: "synthetic publish failure" }, 503)
      : response({ ok: true, published: outcome === "blocked" ? 0 : 1,
        blocked: outcome === "blocked" ? 1 : 0, remote: {} })));
    const broadcasts = outcome === "success" || outcome === "reload-failure" ? 1 : 0;
    expect(post).toHaveBeenCalledTimes(broadcasts); expect(changed).toHaveBeenCalledTimes(broadcasts);
    expect(reload).toHaveBeenCalledTimes(1); expect(bumpBoard).toHaveBeenCalledTimes(outcome === "reload-failure" ? 0 : 1);
    expect(singles).toHaveLength(1); // actual callback catches failures, then the quiet single refresh still runs
    await act(async () => vi.advanceTimersByTimeAsync(299)); expect(polls).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1)); expect(polls).toHaveLength(1 + broadcasts);
    if (broadcasts) {
      const batchCalls = vi.mocked(originalFetch).mock.calls.filter(([url]) => url === "/api/generations/batch");
      expect(JSON.parse(String(batchCalls[1][1]?.body))).toEqual({ gen_ids: ["a"] });
    }
  } finally { window.removeEventListener(APP_EVENTS.libraryChanged, changed); }
});
