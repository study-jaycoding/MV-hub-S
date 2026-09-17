// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
import type { SceneCard } from "../src/lib/scenes";
import type { SceneColorScope } from "../src/lib/useSceneGenData";

let dataModule: typeof import("../src/lib/useSceneGenData");
let actionsModule: typeof import("../src/lib/useSceneColorActions");
let store: typeof import("../src/lib/sceneGenDataStore");
let http: typeof import("../src/lib/http");
let account: typeof import("../src/lib/accountScope");
let language: typeof import("../src/lib/i18n");
let current: ReturnType<typeof dataModule.useSceneGenData>;
let actions: ReturnType<typeof actionsModule.useSceneColorActions>;
let root: Root | null;
let host: HTMLDivElement;
let server: Record<string, Generation>;
let reads: { ids: string[]; token: string | null; reply: ReturnType<typeof deferred<Response>> }[];
let writes: { items: { id: string; color: string | null }[]; token: string | null; reply: ReturnType<typeof deferred<Response>> }[];
let flashes: string[];
let ids: string[];
let scope: SceneColorScope;
let strict: boolean;
const base = "#777777", red = "#ff5722", green = "#4caf50", blue = "#2196f3";
const generation = (id: string, color: string | null = base): Generation => ({
  id, color, status: "done", prompt: "synthetic", worker_id: "worker", worker_name: null,
  display_prompt: null, model: null, params: {}, error: null, created_at: "2026-09-17",
  tags: [], auto_tags: [], assets: [], references: [], shared: false, folder_path: null,
  parent_gen_id: null, is_source: false, source_name: null, comment: null, comment_count: 0,
  has_unread: false, local_only: false, creator_uid: null, creator_name: null, is_mine: true,
  workspace_scope: "personal", workspace_id: null, workspace_name: null, project_id: null, deleted: false,
});
const response = (body: unknown) => new Response(JSON.stringify(body));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function Harness() {
  const cards: SceneCard[] = ids.map(id => ({ id: `card-${id}`, kind: "generation", genId: id, x: 0, y: 0 }));
  current = dataModule.useSceneGenData(cards, scope);
  actions = actionsModule.useSceneColorActions(current.colors, current.genDataRef);
  return <output>{ids.map(id => `${id}:${current.genData[id]?.color ?? "none"}`).join("|")}</output>;
}
async function render() {
  await act(async () => { root!.render(strict ? <StrictMode><Harness /></StrictMode> : <Harness />); });
}
function seed(keys = ["a", "b"]) {
  for (const id of keys) { server[id] = generation(id); store.putGen(server[id], id); }
}
async function read(index: number, items?: Record<string, Generation>, missing: string[] = []) {
  const request = reads[index];
  const rows = items ?? Object.fromEntries(request.ids.filter(id => !!server[id]).map(id => [id, server[id]]));
  await act(async () => request.reply.resolve(response({ items: rows, materials: {}, missing })));
}
async function save(index: number, failed: string[] = []) {
  const request = writes[index];
  for (const item of request.items) if (!failed.includes(item.id) && server[item.id]) {
    server[item.id] = { ...server[item.id], color: item.color };
  }
  await act(async () => request.reply.resolve(response({ succeeded: request.items.map(item => item.id).filter(id => !failed.includes(id)), failed })));
}
const value = (id = "a") => current.genDataRef.current[id]?.color;
const cached = (id = "a") => store.hydrateGen([id])[id]?.color;
async function paint(keys = ["a"], color = red) {
  await act(async () => actions.applyColorToGids(keys, color));
}
const onFlash = (event: Event) => flashes.push((event as CustomEvent<string>).detail);
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Real socket forbidden"); } });
  localStorage.clear(); sessionStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  reads = []; writes = []; flashes = []; server = {};
  ids = ["a", "b"]; scope = { sceneKey: "A", authKey: "account-A", authReady: true }; strict = false;
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    const token = new Headers(init.headers).get("Authorization");
    const body = JSON.parse(String(init.body));
    const reply = deferred<Response>();
    if (url === "/api/generations/batch") reads.push({ ids: body.gen_ids, token, reply });
    else if (url === "/api/generations/colors/batch") writes.push({ items: body.items, token, reply });
    else throw new Error(`Unexpected request: ${url}`);
    return reply.promise;
  }));
  dataModule = await import("../src/lib/useSceneGenData");
  actionsModule = await import("../src/lib/useSceneColorActions");
  store = await import("../src/lib/sceneGenDataStore");
  http = await import("../src/lib/http");
  account = await import("../src/lib/accountScope");
  language = await import("../src/lib/i18n");
  http.setAuthToken("synthetic-A"); account.setAccountScope("synthetic-A"); language.setLang("ko");
  window.addEventListener("ch:flash", onFlash);
  seed(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove(); window.removeEventListener("ch:flash", onFlash);
  await vi.advanceTimersByTimeAsync(0); // jsdom storage-event delivery, not a product retry
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("old poll after successful save preserves UI, ref and cache but accepts fresh non-color fields", async () => {
  await render(); await paint(); await save(0);
  await read(0, { a: { ...generation("a"), shared: true, folder_path: "fresh" }, b: server.b });
  expect(value()).toBe(red); expect(cached()).toBe(red); expect(host.textContent).toContain(`a:${red}`);
  expect(current.genData.a.shared).toBe(true); expect(current.genData.a.folder_path).toBe("fresh");
});
it("a poll started while pending keeps color even if the save finishes before its response", async () => {
  await render(); await read(0); await paint();
  await act(async () => { window.dispatchEvent(new Event("ch:library-changed")); await vi.advanceTimersByTimeAsync(300); });
  await save(0); await read(1, { a: generation("a"), b: server.b });
  expect(value()).toBe(red); expect(cached()).toBe(red);
});
it("a new poll after pending ends accepts server color again, rather than pinning forever", async () => {
  await render(); await read(0); await paint(); await save(0);
  await act(async () => { window.dispatchEvent(new Event("ch:library-changed")); await vi.advanceTimersByTimeAsync(300); });
  await read(1, { a: generation("a", blue), b: server.b });
  expect(value()).toBe(blue); expect(cached()).toBe(blue);
});
it("same-event input order is serialized and the toggle sees its immediate mirror", async () => {
  await render(); await read(0);
  act(() => { actions.applyColorToGids(["a"], red); actions.applyColorToGids(["a"], red); actions.applyColorToGids(["a"], green); });
  await act(async () => {});
  expect(value()).toBe(green); expect(writes).toHaveLength(1);
  await save(0); await save(1); await save(2);
  expect(writes.map(w => w.items[0].color)).toEqual([red, null, green]);
  expect(server.a.color).toBe(green); expect(cached()).toBe(green);
});
it("alias toggles by request key while preserving the canonical Generation.id", async () => {
  server.a = generation("canonical", red); store.putGen(server.a, "a");
  await render(); await read(0); await paint(["a", "a", "missing"]);
  expect(writes[0].items).toEqual([{ id: "a", color: null }]);
  expect(current.genData.a.id).toBe("canonical"); expect(cached("canonical")).toBeNull();
  await save(0);
});
it("an unrelated gid edit during recovery does not cancel the failed gid recovery", async () => {
  await render(); await read(0); await paint(); await save(0, ["a"]);
  expect(reads[1].ids).toEqual(["a"]);
  await paint(["b"], blue); await read(1);
  expect(value()).toBe(base); expect(value("b")).toBe(blue);
  await save(1); expect(server.b.color).toBe(blue);
  expect(flashes).toHaveLength(1);
});
it("same-gid newer intent wins over older recovery and no other fields are rolled back", async () => {
  await render(); await read(0); await paint(); await save(0, ["a"]);
  await paint(["a"], green);
  await read(1, { a: { ...server.a, shared: true, folder_path: "old-recovery" } });
  expect(value()).toBe(green); expect(cached()).toBe(green);
  expect(current.genData.a.shared).toBe(false); expect(current.genData.a.folder_path).toBeNull();
  await save(1);
});
it("partial failure only re-reads failed ids, not the current selection or successful siblings", async () => {
  await render(); await read(0); await paint(["a", "b"]); await save(0, ["b"]);
  expect(reads[1].ids).toEqual(["b"]);
  await read(1); expect(value()).toBe(red); expect(value("b")).toBe(base);
});
it.each(["ko", "en"] as const)("recovery read failure reports uncertainty in %s, never restored", async lang => {
  language.setLang(lang);
  await render(); await read(0); await paint(); await save(0, ["a"]);
  await act(async () => reads[1].reply.reject(new Error("synthetic transient")));
  expect(flashes).toHaveLength(1);
  expect(flashes[0]).toContain(lang === "ko" ? "확인하지 못했습니다" : "could not verify");
  expect(flashes[0]).not.toContain(lang === "ko" ? "되돌렸습니다" : "restored");
});
it("scene A→B→A keeps same-account queued writes but replaces the ledger generation", async () => {
  await render(); await read(0);
  await paint(["a"], red); await paint(["b"], green);
  scope = { ...scope, sceneKey: "B" }; await render();
  const newer = current.colors.begin(["a"], blue)!;
  expect(newer.gen.pending.get("a")).toBe(1);
  await save(0); expect(writes).toHaveLength(2);
  expect(newer.gen.pending.get("a")).toBe(1);
  await save(1);
  scope = { ...scope, sceneKey: "A" }; await render();
  const returned = current.colors.begin(["a"], green)!;
  expect(returned.gen).not.toBe(newer.gen);
  current.colors.end(newer); expect(returned.gen.pending.get("a")).toBe(1);
  current.colors.end(returned);
  expect(writes.map(w => w.token)).toEqual(["Bearer synthetic-A", "Bearer synthetic-A"]);
});
it("authReady true→false→true permanently rejects older queued tickets without flash", async () => {
  await render(); await read(0); await paint(["a"]); await paint(["b"]);
  scope = { ...scope, authReady: false }; await render();
  scope = { ...scope, authReady: true }; await render();
  await save(0); expect(writes).toHaveLength(1); expect(flashes).toEqual([]);
  await read(1); expect(value("b")).toBe(base);
});
it("!authReady performs no optimistic write, poll, enqueue or flash", async () => {
  scope = { ...scope, authReady: false }; await render(); await paint();
  expect(value()).toBe(base); expect(cached()).toBe(base);
  expect(reads).toHaveLength(0); expect(writes).toHaveLength(0); expect(flashes).toEqual([]);
});
it.each(["token", "namespace"])("unrendered %s change rejects subsequent transmission and recovery", async change => {
  await render(); await read(0); await paint(["a"]); await paint(["b"]);
  if (change === "token") http.setAuthToken("synthetic-B"); else account.setAccountScope("synthetic-B");
  await save(0, ["a"]);
  expect(writes).toHaveLength(1); expect(reads).toHaveLength(1); expect(flashes).toEqual([]);
});
it("mixed-generation errors count auth-live failures but only recover the current generation", async () => {
  await render(); await read(0); await paint(["a"]); await paint(["b"]);
  await save(0, ["a"]); // second operation is in flight; first error retained in the queue
  scope = { ...scope, sceneKey: "B" }; await render();
  await paint(["a"], blue); await save(1, ["b"]); await save(2, ["a"]);
  expect(reads[reads.length - 1].ids).toEqual(["a"]);
  await read(reads.length - 1);
  expect(flashes).toEqual(["컬러 저장 2건 실패 — 서버 상태 반영 1건"]);
});
it("a failed intent superseded by a successful same-generation intent stays quiet", async () => {
  await render(); await read(0); await paint(); await paint(["a"], blue);
  await save(0, ["a"]); await save(1);
  expect(reads).toHaveLength(1); expect(flashes).toEqual([]);
  expect(value()).toBe(blue); expect(cached()).toBe(blue); expect(server.a.color).toBe(blue);
});
it("same-account old-scene failure is reported without a recovery request or write", async () => {
  await render(); await read(0); await paint();
  scope = { ...scope, sceneKey: "B" }; await render();
  const before = cached(); const count = reads.length;
  await save(0, ["a"]);
  expect(reads).toHaveLength(count); expect(cached()).toBe(before);
  expect(flashes).toEqual(["컬러 저장 1건 실패 — 서버 상태 반영 0건"]);
});
it("same-account scene change during recovery reports uncertainty without applying the old response", async () => {
  await render(); await read(0); await paint(); await save(0, ["a"]);
  scope = { ...scope, sceneKey: "B" }; await render();
  const before = cached(); await read(1);
  expect(cached()).toBe(before);
  expect(flashes).toEqual(["컬러 저장 1건 실패 — 서버 상태를 확인하지 못했습니다"]);
});
it("a newer queued intent suppresses the old notice, and its own later failure is still reported", async () => {
  await render(); await read(0); await paint(); await save(0, ["a"]);
  await paint(["a"], blue);
  expect(writes).toHaveLength(1); // new revision exists, but the new write has not been sent
  await read(1); expect(flashes).toEqual([]); expect(value()).toBe(blue);
  expect(writes).toHaveLength(2);
  await save(1, ["a"]); await read(2);
  expect(value()).toBe(base); expect(cached()).toBe(base);
  expect(flashes).toEqual(["컬러 저장 1건 실패 — 서버 상태 반영 1건"]);
});
it.each(["ko", "en"] as const)("missing recovery rows count zero applied colors in %s", async lang => {
  language.setLang(lang);
  await render(); await read(0); await paint(); await save(0, ["a"]);
  await read(1, {}, ["a"]);
  expect(value()).toBe(red); expect(cached()).toBe(red); // recovery does not own deletion
  expect(flashes).toEqual([lang === "ko" ? "컬러 저장 1건 실패 — 서버 상태 반영 0건"
    : "Failed to save colors for 1 items — Applied server state to 0 items"]);
});
it("scope change during failure recovery silently discards response and flash", async () => {
  await render(); await read(0); await paint(); await save(0, ["a"]);
  const before = cached();
  scope = { ...scope, authKey: "B" }; await render();
  await read(1); expect(cached()).toBe(before); expect(flashes).toEqual([]);
});
it("removing then re-adding the same gid cannot reuse an old recovery revision", async () => {
  await render(); await read(0); await paint(); await save(0, ["a"]);
  ids = ["b"]; await render(); ids = ["a", "b"]; await render();
  await paint(["a"], blue);
  await read(1); expect(value()).toBe(blue); expect(cached()).toBe(blue);
  await save(1);
});
it("404 remains deletion-first and older failure recovery cannot resurrect the card", async () => {
  await render(); await read(0); await paint(); await save(0, ["a"]);
  await act(async () => { window.dispatchEvent(new Event("ch:library-changed")); await vi.advanceTimersByTimeAsync(300); });
  await read(2, { b: server.b }, ["a"]);
  await read(1, { a: generation("a") });
  expect(current.genData.a).toBeUndefined(); expect(cached()).toBeUndefined();
});
it("unmount rejects old poll, queued save and recovery writes to state/ref/cache", async () => {
  await render(); await paint(["a"]); await paint(["b"]);
  const old = current.genDataRef.current;
  await act(async () => root!.unmount()); root = null;
  await save(0, ["a"]); await read(0);
  expect(current.genDataRef.current).toBe(old); expect(cached()).toBe(red);
  expect(writes).toHaveLength(1); expect(flashes).toEqual([]);
});
it("StrictMode stays live after effect replay and a queued failure group recovers once", async () => {
  strict = true; await render();
  expect(reads).toHaveLength(2);
  await read(1); await read(0);
  await paint(["a"]); await paint(["b"]);
  await save(0, ["a"]); await save(1, ["b"]);
  expect(reads).toHaveLength(3); expect(reads[2].ids).toEqual(["a", "b"]);
  await read(2); expect(flashes).toHaveLength(1); expect(value()).toBe(base);
});
it("only current loaded card ids may begin, while another scene's cached ids are ignored", async () => {
  seed(["off-scene"]); await render(); await read(0);
  await paint(["off-scene", "missing", "a", "a"]);
  expect(writes[0].items.map(item => item.id)).toEqual(["a"]);
  expect(cached("off-scene")).toBe(base); await save(0);
});
it("a newer refresh invalidates the older poll before it touches UI or cache", async () => {
  await render();
  await act(async () => { window.dispatchEvent(new Event("ch:library-changed")); await vi.advanceTimersByTimeAsync(300); });
  await read(1, { a: generation("a", blue), b: server.b });
  await read(0, { a: generation("a"), b: server.b });
  expect(value()).toBe(blue); expect(cached()).toBe(blue);
});
it("auth-key A→B→A cannot revive a ticket even when its key string becomes identical", async () => {
  await render(); await read(0); await paint(["a"]); await paint(["b"]);
  scope = { ...scope, authKey: "B" }; await render();
  scope = { ...scope, authKey: "account-A" }; await render();
  await save(0); expect(writes).toHaveLength(1); expect(flashes).toEqual([]);
});
it("direct stale recovery/end operate only on their owned generation, not the new same-gid ledger", async () => {
  await render(); await read(0);
  let old!: ReturnType<typeof current.colors.begin>;
  act(() => { old = current.colors.begin(["a"], red); });
  scope = { ...scope, sceneKey: "B" }; await render();
  let next!: ReturnType<typeof current.colors.begin>;
  act(() => { next = current.colors.begin(["a"], green); });
  expect(current.colors.applyRecovered(old!, { a: base })).toEqual([]);
  current.colors.end(old!);
  expect(value()).toBe(green); expect(cached()).toBe(green);
  expect(next!.gen.pending.get("a")).toBe(1);
  current.colors.end(next!);
});
it("removing a pending gid does not let old end decrement a new request's whole pending count", async () => {
  await render(); await read(0);
  let old!: ReturnType<typeof current.colors.begin>;
  act(() => { old = current.colors.begin(["a"], red); });
  ids = ["b"]; await render(); ids = ["a", "b"]; await render();
  let next!: ReturnType<typeof current.colors.begin>;
  act(() => { next = current.colors.begin(["a"], blue); });
  expect(next!.revisions.a).toBeGreaterThan(old!.revisions.a);
  current.colors.end(old!);
  expect(next!.gen.pending.get("a")).toBe(1);
  current.colors.end(next!); expect(next!.gen.pending.has("a")).toBe(false);
});
it.each([501, 1200])("actual color hook passes its guard into every save chunk (%i ids)", async count => {
  ids = Array.from({ length: count }, (_, i) => `bulk-${i}`); seed(ids);
  await render(); await paint(ids);
  expect(writes[0].items).toHaveLength(500);
  http.setAuthToken("synthetic-B"); await save(0);
  expect(writes).toHaveLength(1);
  expect(writes[0].token).toBe("Bearer synthetic-A"); expect(flashes).toEqual([]);
  for (let i = 0; i < reads.length; i++) await read(i);
  expect(cached(ids[0])).toBe(red);
});
it("recovery uses the guarded three-worker API and suppresses a scope-change error after 1501 failures", async () => {
  ids = Array.from({ length: 1501 }, (_, i) => `recover-${i}`); seed(ids);
  await render();
  for (let i = 0; i < 4; i++) await read(i);
  await paint(ids);
  for (let i = 0; i < 4; i++) await save(i, writes[i].items.map(item => item.id));
  expect(reads).toHaveLength(7); // original 4 + first recovery workers 3
  expect(reads.slice(4).map(request => request.ids.length)).toEqual([500, 500, 500]);
  http.setAuthToken("synthetic-B");
  for (let i = 4; i < 7; i++) await read(i);
  expect(reads).toHaveLength(7); expect(flashes).toEqual([]);
  expect(cached(ids[0])).toBe(red);
});
