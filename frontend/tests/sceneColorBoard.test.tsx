// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import { api } from "../src/api";
import { KEY_COLORS } from "../src/lib/appConstants";
import { hydrateGen, putGen } from "../src/lib/sceneGenDataStore";
import type { Generation } from "../src/types";
import type { Scene } from "../src/lib/scenes";
import * as sceneData from "../src/lib/useSceneGenData";

const base = "#777777";
let root: Root;
let host: HTMLDivElement;
let serial = 0;
let gid: string;
let row: Generation;
let scene: Scene;
let polls: ReturnType<typeof deferred<Response>>[];
let saves: { items: { id: string; color: string | null }[]; reply: ReturnType<typeof deferred<Response>> }[];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const batch = (g: Generation) => ({ items: { [gid]: g }, materials: {}, missing: [] });
const color = () => host.querySelector<HTMLElement>(".linb-colorbar")?.style.background;
const key = (name: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
async function mount() {
  await act(async () => root.render(<SceneBoard scene={scene} onChange={() => {}} />));
  const card = host.querySelector<HTMLElement>(".scene-card")!;
  expect(card).not.toBeNull();
  act(() => {
    card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  });
  expect(card.classList.contains("sel")).toBe(true);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Network forbidden"); } });
  localStorage.clear(); sessionStorage.clear();
  gid = `board-color-${++serial}`;
  row = { id: gid, color: base, status: "done", prompt: "synthetic", shared: false, is_mine: true,
    tags: [], auto_tags: [], assets: [], references: [], created_at: "2026-09-17",
    worker_id: "worker", worker_name: null, display_prompt: null, model: null, params: {}, error: null,
    parent_gen_id: null, is_source: false, source_name: null, comment: null, comment_count: 0,
    has_unread: false, local_only: false, creator_uid: null, creator_name: null,
    workspace_scope: "personal", workspace_id: null, workspace_name: null, project_id: null, deleted: false };
  putGen(row);
  scene = { id: `scene-${serial}`, name: "Synthetic", created_at: 0, edges: [],
    cards: [{ id: "card", kind: "generation", genId: gid, x: 0, y: 0 }] };
  polls = []; saves = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/generations/batch") { const reply = deferred<Response>(); polls.push(reply); return reply.promise; }
    if (url === "/api/generations/colors/batch" || url === `/api/generations/${gid}/color`) {
      const body = JSON.parse(String(init?.body));
      const reply = deferred<Response>();
      saves.push({ items: body.items ?? [{ id: gid, color: body.color }], reply });
      return reply.promise;
    }
    if (url.startsWith("/api/generation-views?")) return Promise.resolve(response({ card: {}, last_card_id: null }));
    if (url.startsWith("/api/models")) return Promise.resolve(response([]));
    throw new Error(`Unexpected synthetic HTTP: ${url}`);
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("real SceneBoard preserves a successful newer color when its old poll returns", async () => {
  await mount();
  await act(async () => { key("r"); });
  expect(saves).toHaveLength(1);
  await act(async () => saves[0].reply.resolve(response({ succeeded: [gid], failed: [] })));
  await act(async () => polls[0].resolve(response(batch({ ...row, shared: true }))));
  expect(color()).toBe("rgb(255, 87, 34)");
  expect(hydrateGen([gid])[gid].color).toBe(KEY_COLORS.r);
  expect(host.querySelector(".linb-sf")?.textContent).toBe("S"); // non-color fields remain fresh
});
it("real key handlers synchronously mirror same-event repeated toggle and serialize its requests", async () => {
  await mount();
  await act(async () => { key("r"); key("r"); });
  expect(saves).toHaveLength(1);
  expect(color()).toBeUndefined();
  await act(async () => saves[0].reply.resolve(response({ succeeded: [gid], failed: [] })));
  expect(saves).toHaveLength(2);
  expect(saves.map(s => s.items[0].color)).toEqual([KEY_COLORS.r, null]);
  await act(async () => saves[1].reply.resolve(response({ succeeded: [gid], failed: [] })));
  expect(hydrateGen([gid])[gid].color).toBeNull();
});
it("real board publishes the optimistic color to its remount cache immediately", async () => {
  await mount();
  await act(async () => { key("b"); });
  expect(hydrateGen([gid])[gid].color).toBe(KEY_COLORS.b);
});
it("the old-response-before-click control remains usable", async () => {
  await mount();
  await act(async () => polls[0].resolve(response(batch(row))));
  await act(async () => { key("r"); });
  expect(color()).toBe("rgb(255, 87, 34)");
});
it("setColorsBatch checks each later chunk before transmission", async () => {
  const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
  let current = true;
  const transport = vi.fn(async () => { current = false; return response({ succeeded: [], failed: [] }); });
  vi.stubGlobal("fetch", transport);
  await expect(api.setColorsBatch(ids, KEY_COLORS.r, () => {
    if (!current) throw new Error("scope changed");
  })).rejects.toThrow("scope changed");
  expect(transport).toHaveBeenCalledTimes(1);
});
it("getGenerationsBatch guards the single-page path before transmission", async () => {
  const transport = vi.fn(async () => response(batch(row)));
  vi.stubGlobal("fetch", transport);
  await expect(api.getGenerationsBatch([gid], () => { throw new Error("scope changed"); })).rejects.toThrow("scope changed");
  expect(transport).not.toHaveBeenCalled();
});
it("real scene transition passes cardsSceneId with the actual cards and its current key handler uses new ids", async () => {
  const observed: { sceneKey: string; ids: string[] }[] = [];
  const original = sceneData.useSceneGenData;
  vi.spyOn(sceneData, "useSceneGenData").mockImplementation((cards, scope) => {
    observed.push({ sceneKey: scope!.sceneKey, ids: cards.flatMap(card => card.genId ? [card.genId] : []) });
    return original(cards, scope);
  });
  await mount();
  await act(async () => { key("r"); });
  const newId = `${gid}-next`;
  putGen({ ...row, id: newId });
  const nextScene: Scene = { ...scene, id: `${scene.id}-next`, cards: [{ ...scene.cards[0], genId: newId }] };
  await act(async () => root.render(<SceneBoard scene={nextScene} onChange={() => {}} />));
  expect(observed.some(item => item.sceneKey === nextScene.id && item.ids.includes(gid))).toBe(false);
  expect(observed.some(item => item.sceneKey === scene.id && item.ids.includes(gid))).toBe(true);
  expect(observed.some(item => item.sceneKey === nextScene.id && item.ids.includes(newId))).toBe(true);
  const card = host.querySelector<HTMLElement>(".scene-card")!;
  act(() => {
    card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  });
  await act(async () => { key("g"); });
  expect(saves).toHaveLength(1);
  await act(async () => saves[0].reply.resolve(response({ succeeded: [gid], failed: [] })));
  expect(saves[1].items).toEqual([{ id: newId, color: KEY_COLORS.g }]);
  await act(async () => polls[0].resolve(response(batch(row))));
  expect(hydrateGen([newId])[newId].color).toBe(KEY_COLORS.g);
});
it("real SceneBoard authReady transition rejects old queued keyboard input after same-account relogin", async () => {
  await mount();
  await act(async () => { key("r"); key("g"); });
  await act(async () => root.render(<SceneBoard scene={scene} onChange={() => {}} authReady={false} />));
  const previous = hydrateGen([gid])[gid].color;
  await act(async () => { key("b"); });
  expect(hydrateGen([gid])[gid].color).toBe(previous);
  await act(async () => root.render(<SceneBoard scene={scene} onChange={() => {}} authReady />));
  await act(async () => saves[0].reply.resolve(response({ succeeded: [gid], failed: [] })));
  expect(saves).toHaveLength(1);
});
