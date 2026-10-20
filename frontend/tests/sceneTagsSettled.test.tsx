// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
import type { SceneColorScope } from "../src/lib/useSceneGenData";
import { readGenerationTagsSettled } from "../src/lib/appEvents";

let data: typeof import("../src/lib/useSceneGenData");
let store: typeof import("../src/lib/sceneGenDataStore");
let http: typeof import("../src/lib/http");
let account: typeof import("../src/lib/accountScope");
let current: ReturnType<typeof data.useSceneGenData>;
let root: Root;
let host: HTMLDivElement;
let ids: string[];
let scope: SceneColorScope;
let reads: { ids: string[]; reply: ReturnType<typeof deferred<Response>> }[];
let singles: ReturnType<typeof deferred<Response>>[];
const row = (id: string, patch: Partial<Generation> = {}) => ({
  id, status: "done", tags: ["old"], auto_tags: ["auto"], color: "red", assets: [], references: [], ...patch,
} as Generation);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (body: unknown) => new Response(JSON.stringify(body));
function Harness() {
  current = data.useSceneGenData(ids.map(id => ({ id, kind: "generation", genId: id, x: 0, y: 0 })), scope);
  return <output>{JSON.stringify(current.genData)}</output>;
}
const render = () => act(async () => { root.render(<Harness />); });
const advance = (ms = 300) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
async function settleTags(detail: unknown = { ids: ["a"], fields: ["tags"] }) {
  await act(async () => { window.dispatchEvent(new CustomEvent("ch:generation-tags-settled", { detail })); });
  await advance();
}
async function read(index: number, items?: Record<string, Generation>, extra = {}) {
  await act(async () => reads[index].reply.resolve(response({
    items: items ?? Object.fromEntries(reads[index].ids.map(id => [id, row(id)])), materials: {}, missing: [], ...extra,
  })));
}
async function ready(items?: Record<string, Generation>) { await render(); await read(0, items); }
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("BroadcastChannel", undefined);
  localStorage.clear(); sessionStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  reads = []; singles = []; ids = ["a", "b"];
  scope = { sceneKey: "A", authKey: "A", authReady: true };
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    const reply = deferred<Response>();
    if (url === "/api/generations/batch") reads.push({ ids: JSON.parse(String(init.body)).gen_ids, reply });
    else if (url === "/api/generations/a") singles.push(reply);
    else throw new Error(`Unexpected request: ${url}`);
    return reply.promise;
  }));
  data = await import("../src/lib/useSceneGenData");
  store = await import("../src/lib/sceneGenDataStore");
  http = await import("../src/lib/http"); account = await import("../src/lib/accountScope");
  http.setAuthToken("synthetic-A"); account.setAccountScope("synthetic-A");
  (await import("../src/app/operationContext")).configureOperationContext({ key: "account-A", serverOrigin: location.origin, authority: "local", ready: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("requests only intersecting ids and patches only announced fields in UI, ref and cache", async () => {
  await ready();
  await settleTags({ ids: ["a", "outside", "a"], fields: ["tags"] });
  expect(reads[1].ids).toEqual(["a"]);
  await read(1, { a: row("a", { tags: ["saved"], auto_tags: ["stale"], color: "blue", status: "pending" }) });
  for (const value of [current.genData.a, current.genDataRef.current.a, store.hydrateGen(["a"]).a]) {
    expect(value).toMatchObject({ tags: ["saved"], auto_tags: ["auto"], color: "red", status: "done" });
  }
  expect(current.genData.b.tags).toEqual(["old"]);
  await advance(2500); expect(reads).toHaveLength(2);
});

it("empty and outside ids request nothing; malformed legacy event retains full refresh", async () => {
  await ready();
  await settleTags({ ids: [], fields: ["tags"] });
  await settleTags({ ids: ["outside"], fields: ["tags"] });
  expect(reads).toHaveLength(1);
  await settleTags(null); expect(reads[1].ids).toEqual(["a", "b"]);
});

it("waits for initial full read, then refreshes the queued tag ids", async () => {
  await render(); await settleTags(); expect(reads).toHaveLength(1);
  await read(0); await advance(0);
  expect(reads[1].ids).toEqual(["a"]);
  await read(1, { a: row("a", { tags: ["saved"] }) });
  expect(current.genData.a.tags).toEqual(["saved"]);
});

it("broad read preempts a partial and requeues its ids after full completion", async () => {
  await ready(); await settleTags();
  await act(async () => { window.dispatchEvent(new Event("ch:library-changed")); });
  await advance(); expect(reads[2].ids).toEqual(["a", "b"]);
  await read(1, { a: row("a", { tags: ["discard"] }) });
  expect(current.genData.a.tags).toEqual(["old"]);
  await read(2); await advance(0);
  expect(reads[3].ids).toEqual(["a"]);
  await read(3, { a: row("a", { tags: ["final"] }) });
  expect(current.genData.a.tags).toEqual(["final"]);
});

it("events arriving during partial read are retained for a subsequent read", async () => {
  await ready(); await settleTags();
  await settleTags({ ids: ["b"], fields: ["auto_tags"] });
  expect(reads).toHaveLength(2);
  await read(1, { a: row("a", { tags: ["a-new"] }) }); await advance(0);
  expect(reads[2].ids).toEqual(["b"]);
  await read(2, { b: row("b", { tags: ["stale"], auto_tags: ["b-new"] }) });
  expect(current.genData.b).toMatchObject({ tags: ["old"], auto_tags: ["b-new"] });
});

it("tag refresh leaves unrelated running-card poll alive", async () => {
  await ready({ a: row("a"), b: row("b", { status: "pending" }) });
  await settleTags(); await read(1, { a: row("a", { tags: ["new"] }) });
  await advance(2200); expect(reads[2].ids).toEqual(["b"]);
});

it("earlier single GET blocks partial until completion, then partial wins", async () => {
  await ready();
  await act(async () => current.refreshGenerationAfter("a", undefined));
  expect(singles).toHaveLength(1);
  await settleTags(); expect(reads).toHaveLength(1);
  await act(async () => singles[0].resolve(response(row("a")))); await advance(0);
  expect(reads[1].ids).toEqual(["a"]);
  await read(1, { a: row("a", { tags: ["saved"] }) });
  expect(current.genData.a.tags).toEqual(["saved"]);
});

it("later single GET neither invalidates nor repeats a partial", async () => {
  await ready(); await settleTags();
  await act(async () => current.refreshGenerationAfter("a", undefined));
  await read(1, { a: row("a", { tags: ["saved"] }) });
  expect(current.genData.a.tags).toEqual(["saved"]);
  await act(async () => singles[0].resolve(response(row("a", { tags: ["saved"], shared: true }))));
  await advance(2500); expect(reads).toHaveLength(2);
  expect(current.genData.a).toMatchObject({ tags: ["saved"], shared: true });
});

it("old scene single GET cannot block new scene tags or decrement its new single counter", async () => {
  await ready(); await act(async () => current.refreshGenerationAfter("a", undefined));
  scope = { ...scope, sceneKey: "B" }; await render(); await read(1);
  await settleTags(); expect(reads[2].ids).toEqual(["a"]); await read(2);
  await act(async () => current.refreshGenerationAfter("a", undefined));
  await settleTags(); expect(reads).toHaveLength(3);
  await act(async () => singles[0].resolve(response(row("a", { tags: ["old-scope"] }))));
  expect(reads).toHaveLength(3);
  await act(async () => singles[1].resolve(response(row("a")))); await advance(0);
  expect(reads[3].ids).toEqual(["a"]);
});

it("missing preserves current record and unavailable retries without deletion", async () => {
  await ready(); await settleTags();
  await read(1, {}, { missing: ["a"] });
  expect(current.genData.a.tags).toEqual(["old"]); expect(current.missingIds.has("a")).toBe(false);
  await advance(2500); expect(reads).toHaveLength(2);
  await settleTags(); await read(2, {}, { unavailable: ["a"] });
  expect(current.genData.a.tags).toEqual(["old"]);
  await advance(2500); expect(reads[3].ids).toEqual(["a"]);
});

it("hidden and failed partial reads retry without losing the requested fields", async () => {
  await ready();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await settleTags(); expect(reads).toHaveLength(1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await advance(2500); expect(reads[1].ids).toEqual(["a"]);
  await act(async () => reads[1].reply.resolve(new Response("{}", { status: 500 })));
  expect(current.genData.a.tags).toEqual(["old"]);
  await advance(2500); expect(reads[2].ids).toEqual(["a"]);
  await read(2, { a: row("a", { tags: ["retry"] }) }); expect(current.genData.a.tags).toEqual(["retry"]);
});

it("scene/account switch discards old partial response and queued retry", async () => {
  await ready(); await settleTags();
  scope = { sceneKey: "B", authKey: "B", authReady: true };
  http.setAuthToken("synthetic-B"); account.setAccountScope("synthetic-B");
  (await import("../src/app/operationContext")).configureOperationContext({ key: "account-B", serverOrigin: location.origin, authority: "local", ready: true });
  await render(); await read(2, { a: row("a", { tags: ["B"] }), b: row("b") });
  await read(1, { a: row("a", { tags: ["A-late"] }) });
  await advance(2500); expect(reads).toHaveLength(3);
  expect(current.genData.a.tags).toEqual(["B"]);
});

it("detail parser rejects malformed payloads and accepts a deduplicated empty or complete payload", () => {
  const parse = (detail: unknown) => readGenerationTagsSettled(new CustomEvent("test", { detail }));
  for (const detail of [null, {}, [], { ids: "a", fields: ["tags"] }, { ids: [1], fields: ["tags"] },
    { ids: [" "], fields: ["tags"] }, { ids: Array(1), fields: ["tags"] }, { ids: ["a"], fields: Array(1) },
    { ids: ["a"], fields: [] }, { ids: ["a"], fields: ["color"] }]) expect(parse(detail)).toBeNull();
  expect(parse({ ids: [], fields: ["tags"] })).toEqual({ ids: [], fields: ["tags"] });
  expect(parse({ ids: ["a", "a"], fields: ["tags", "auto_tags", "tags"] })).toEqual({ ids: ["a"], fields: ["tags", "auto_tags"] });
});

it("full read finishing before stale partial still triggers a replacement partial", async () => {
  await ready(); await settleTags();
  await act(async () => { window.dispatchEvent(new Event("ch:library-changed")); });
  await advance(); await read(2, { a: row("a", { tags: ["full"] }), b: row("b") });
  await read(1, { a: row("a", { tags: ["stale"] }) }); await advance(0);
  expect(current.genData.a.tags).toEqual(["full"]); expect(reads[3].ids).toEqual(["a"]);
  await read(3, { a: row("a", { tags: ["latest"] }) });
  expect(store.hydrateGen(["a"]).a.tags).toEqual(["latest"]);
});

it("different-field burst retains each id field, and both fields on the same id", async () => {
  await ready();
  await act(async () => {
    for (const detail of [{ ids: ["a"], fields: ["tags"] }, { ids: ["b"], fields: ["auto_tags"] }, { ids: ["a"], fields: ["auto_tags"] }]) {
      window.dispatchEvent(new CustomEvent("ch:generation-tags-settled", { detail }));
    }
  });
  await advance(); expect(reads[1].ids).toEqual(["a", "b"]);
  await read(1, { a: row("a", { tags: ["A"], auto_tags: ["AA"] }), b: row("b", { tags: ["stale"], auto_tags: ["BB"] }) });
  expect(current.genData.a).toMatchObject({ tags: ["A"], auto_tags: ["AA"] });
  expect(current.genData.b).toMatchObject({ tags: ["old"], auto_tags: ["BB"] });
});

it("partial does not create a missing local record or change missing/materials ownership", async () => {
  await render(); await read(0, { b: row("b") }, { missing: ["a"] });
  await settleTags(); await read(1, { a: row("a", { tags: ["reborn"] }) }, { materials: { a: ["new-parent"] } });
  expect(current.genData.a).toBeUndefined(); expect(store.hydrateGen(["a"]).a).toBeUndefined();
  expect(current.missingIds.has("a")).toBe(true); expect(current.refParents.a).toEqual([]);
});

it("failed single GET releases the pending tag read", async () => {
  await ready(); await act(async () => current.refreshGenerationAfter("a", undefined));
  await settleTags(); expect(reads).toHaveLength(1);
  await act(async () => singles[0].resolve(new Response("{}", { status: 500 })));
  expect(reads[1].ids).toEqual(["a"]);
});

it("unmounted partial cannot write cache or start a retry", async () => {
  await ready(); await settleTags();
  await act(async () => root.render(null));
  await read(1, { a: row("a", { tags: ["late"] }) }); await advance(2500);
  expect(store.hydrateGen(["a"]).a.tags).toEqual(["old"]); expect(reads).toHaveLength(2);
});

it("old full finally cannot unblock tags while its preempting full is still reading", async () => {
  await render();
  await act(async () => { window.dispatchEvent(new Event("ch:library-changed")); });
  await advance(); await settleTags(); expect(reads).toHaveLength(2);
  await read(0); expect(reads).toHaveLength(2);
  await read(1); expect(reads[2].ids).toEqual(["a"]);
});

it("scheduled running-card poll invalidates a slow partial without losing its tag work", async () => {
  await ready({ a: row("a"), b: row("b", { status: "pending" }) });
  await settleTags(); await advance(2200); expect(reads[2].ids).toEqual(["b"]);
  await read(1, { a: row("a", { tags: ["discard"] }) });
  expect(current.genData.a.tags).toEqual(["old"]);
  await read(2, { b: row("b") }); expect(reads[3].ids).toEqual(["a"]);
  await read(3, { a: row("a", { tags: ["final"] }) });
  expect(current.genData.a.tags).toEqual(["final"]);
});
