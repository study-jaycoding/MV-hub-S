// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const config = (features: string[] = []) => response({ auth_enabled: false, has_accounts: false, features });
let root: Root | null = null;
let host: HTMLDivElement;
let configRequest: (init?: RequestInit) => Promise<Response>;
let seen: { url: string; init?: RequestInit }[];
let listeners: [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); sessionStorage.clear();
  host = document.createElement("div"); document.body.append(host);
  seen = []; listeners = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((name, fn, options) => {
    listeners.push([name, fn, options]); add(name, fn, options);
  });
  configRequest = () => new Promise(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    if (url === "/api/auth/config") return configRequest(init);
    if (url === "/api/shared-server/status") return response({ configured: false, has_token: false });
    if (url === "/api/projects/my-finalize-roles") return response({ project_ids: [] });
    if (url.startsWith("/api/scenes/backup")) return response({ restore_generation: "r1", items: [] });
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; host.remove();
  for (const [name, fn, options] of listeners) window.removeEventListener(name, fn, options);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const backupRequests = () => seen.filter(({ url }) => url.startsWith("/api/scenes/backup"));
const configRequests = () => seen.filter(({ url }) => url === "/api/auth/config");
async function boot() {
  const features = await import("../src/lib/hubFeatures");
  const scope = await import("../src/lib/accountScope");
  scope.setAccountScope(null);
  const store = await import("../src/lib/sceneStore");
  await store.writeScenesStore({ "local::_none": [] });
  await store.settleSceneStoreForTest();
  const notebook = await import("../src/lib/sceneNotebook");
  const sync = vi.spyOn(notebook, "syncSceneNotebook").mockResolvedValue({ status: "ready", changed: false, visibleChanged: false });
  const backup = await import("../src/lib/sceneBackup");
  return { features, scope, store, backup, sync };
}
async function mountAuth() {
  const { useHubAuth } = await import("../src/lib/useHubAuth");
  let state!: ReturnType<typeof useHubAuth>;
  function Probe() { state = useHubAuth(); return null; }
  root = createRoot(host);
  await act(async () => root!.render(createElement(Probe)));
  return () => state;
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

it("does not read or write the mirror before features, then selects the notebook", async () => {
  const { backup, features, sync } = await boot();
  const pending = backup.initSceneBackup();
  await advance(2000);
  expect(backupRequests()).toHaveLength(0);
  expect(localStorage.getItem("mvhub.mirrorRecovery:local")).toBeNull();
  features.setHubFeatures(["scene_writer_confirm_v1"]);
  await pending;
  expect(sync).toHaveBeenCalledTimes(1);
  expect(backupRequests()).toHaveLength(0);
});

it("blocks explicit mirror entry points while features are unknown", async () => {
  const { backup } = await boot();
  expect(await backup.countBackupOnlyScenes()).toBe(0);
  expect(await backup.importFromBackup()).toBe(0);
  await expect(backup.resumeImportedMirror("local", "r1", new Map())).rejects.toThrow("캔버스 저장 상태");
  expect(backupRequests()).toHaveLength(0);
});

it("starts the legacy mirror once after an explicit empty feature list", async () => {
  const { backup, features } = await boot();
  const pending = backup.initSceneBackup();
  await advance(1000);
  expect(backupRequests()).toHaveLength(0);
  features.setHubFeatures([]);
  await pending;
  expect(backupRequests()).toHaveLength(1);
  expect(localStorage.getItem("mvhub.mirrorRecovery:local")).not.toBeNull();
});

it.each(["edit", "delete", "mismatch", "blocked", "notebook"])("preserves mirror provenance across feature wait: %s", async (mode) => {
  vi.stubGlobal("crypto", {});
  const { backup, features, store } = await boot();
  const scenes = await import("../src/lib/scenes");
  const { sha256Js } = await import("../src/lib/editShare");
  const hash = (text: string) => sha256Js(new TextEncoder().encode(text));
  scenes.saveScenes(null, [{ id: "s", name: "before", cards: [], edges: [], created_at: 1 }]);
  await store.settleSceneStoreForTest();
  const originalHash = hash(scenes.listPersistedSceneTexts(null)[0].text);
  const original = { generation: "old", scenes: [{ id: "held", text: "keep" }], ledger: [] };
  const record = {
    generation: "r1", blockedIds: mode === "blocked" ? ["s"] : [],
    originals: mode === "blocked" ? [original] : [],
    raws: { s: mode === "mismatch" ? "unrelated" : originalHash },
  };
  const key = "mvhub.mirrorRecovery:local", encoded = JSON.stringify(record);
  localStorage.setItem(key, encoded);
  const pending = backup.initSceneBackup();
  if (mode === "delete") scenes.saveScenes(null, []);
  else {
    expect(scenes.updateScene(null, "s", { name: "while waiting" }).ok).toBe(true);
    expect(scenes.updateSceneCamera(null, "s", { z: 2, x: 3, y: 4 }).ok).toBe(true);
  }
  await store.settleSceneStoreForTest();
  await advance(11000);
  expect(backupRequests()).toHaveLength(0);
  expect(localStorage.getItem(key)).toBe(encoded);
  features.setHubFeatures(mode === "notebook" ? ["scene_writer_confirm_v1"] : []);
  await pending;
  if (mode === "notebook") {
    expect(localStorage.getItem(key)).toBe(encoded);
    expect(backupRequests()).toHaveLength(0);
  } else if (mode === "mismatch" || mode === "blocked") {
    expect(backup.readMirrorRecovery()).toMatchObject({ blockedIds: ["s"], raws: record.raws });
    if (mode === "blocked") expect(backup.readMirrorRecovery()!.originals).toEqual([original]);
    else expect(backup.readMirrorRecovery()!.originals[0].scenes[0].text).toBe(scenes.listPersistedSceneTexts(null)[0].text);
    await advance(2500);
    expect(backupRequests().filter(({ init }) => init?.method === "PUT")).toHaveLength(0);
  } else {
    expect(backup.readMirrorRecovery()).toMatchObject({
      blockedIds: [], originals: [], raws: { s: mode === "delete" ? null : hash(scenes.listPersistedSceneTexts(null)[0].text) },
    });
    if (mode === "edit") {
      await advance(2500);
      const put = backupRequests().find(({ init }) => init?.method === "PUT");
      expect(put).toBeDefined();
      const body = JSON.parse(String(put!.init!.body));
      expect(JSON.parse(body.upserts[0].data)).toMatchObject({ name: "while waiting", camera: { z: 2, x: 3, y: 4 } });
    }
  }
}, 15000);

it("waiting init and online sync use the current account and leave old mirror records alone", async () => {
  const { backup, features, scope, store } = await boot();
  const oldRecord = JSON.stringify({ generation: "r1", blockedIds: [], originals: [], raws: {} });
  localStorage.setItem("mvhub.mirrorRecovery:local", oldRecord);
  const pending = backup.initSceneBackup();
  window.dispatchEvent(new Event("online"));
  await store.writeScenesStore({ "local::_none": [{ id: "s", name: "s", cards: [], edges: [], created_at: 1 }] });
  await store.settleSceneStoreForTest();
  await advance(3000);
  expect(backupRequests()).toHaveLength(0);
  expect(localStorage.getItem("mvhub.mirrorRecovery:local")).toBe(oldRecord);
  scope.setAccountScope("new@test");
  features.setHubFeatures([]);
  await pending; await advance(0);
  expect(backupRequests().length).toBeGreaterThan(0);
  expect(backupRequests().every(({ init }) => new Headers(init?.headers).get("X-MVHub-Expect-Account") === "acct:new@test")).toBe(true);
  expect(localStorage.getItem("mvhub.mirrorRecovery:local")).toBe(oldRecord);
});

it("the watchdog leaves unknown features blocked; a late first response selects the notebook", async () => {
  const { backup, features, sync } = await boot();
  const first = deferred<Response>(); configRequest = () => first.promise;
  const state = await mountAuth();
  const pending = backup.initSceneBackup();
  await advance(11000);
  expect(state().authPending).toBe(false);
  expect(features.hubFeaturesKnown()).toBe(false);
  expect(backupRequests()).toHaveLength(0);
  await act(async () => { first.resolve(config(["scene_writer_confirm_v1"])); });
  await pending;
  await advance(40000);
  expect(configRequests()).toHaveLength(1);
  expect(sync).toHaveBeenCalled();
  expect(backupRequests()).toHaveLength(0);
  expect(localStorage.getItem("mvhub.mirrorRecovery:local")).toBeNull();
});

it("a watchdog after a successful first response does not clear notebook features", async () => {
  const { features } = await boot();
  configRequest = async () => config(["scene_writer_confirm_v1"]);
  await mountAuth(); await advance(40000);
  expect(features.hubHasFeature("scene_writer_confirm_v1")).toBe(true);
  expect(configRequests()).toHaveLength(1);
});

it.each(["reject", "hang"])("feature-only retry resumes the old hub after first request %s", async (mode) => {
  const { backup, features } = await boot();
  let count = 0;
  configRequest = () => ++count === 1
    ? mode === "reject" ? Promise.reject(new TypeError("offline")) : new Promise(() => {})
    : Promise.resolve(response({ auth_enabled: true, has_accounts: true, features: [] }));
  const state = await mountAuth();
  const pending = backup.initSceneBackup();
  await advance(mode === "reject" ? 4999 : 14999);
  expect(features.hubFeaturesKnown()).toBe(false);
  expect(backupRequests()).toHaveLength(0);
  await advance(1); await pending;
  expect(features.hubFeaturesKnown()).toBe(true);
  expect(backupRequests()).toHaveLength(1);
  expect(state().authConfig?.auth_enabled).toBe(false); // 재조회는 인증 상태를 바꾸지 않는다.
  expect(seen.some(({ url }) => url === "/api/auth/me")).toBe(false);
  await advance(60000);
  expect(configRequests()).toHaveLength(2);
});

it.each(["fetch", "body"])("retry %s timeout aborts and backs off without overlapping; unmount stops it", async (phase) => {
  await boot();
  let count = 0, active = 0, maximum = 0, aborted = 0;
  configRequest = (init) => {
    if (++count === 1) return new Promise(() => {});
    active++; maximum = Math.max(maximum, active);
    const hanging = new Promise<never>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => {
        active--; aborted++; reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
    if (phase === "fetch") return hanging;
    const res = config();
    res.json = () => hanging;
    return Promise.resolve(res);
  };
  await mountAuth();
  await advance(15000); expect(count).toBe(2); expect(active).toBe(1);
  await advance(10000); expect(aborted).toBe(1); expect(active).toBe(0);
  await advance(9999); expect(count).toBe(2);
  await advance(1); expect(count).toBe(3);
  await advance(30000); expect(count).toBe(4); // 10초 요청 + 20초 간격
  await advance(40000); expect(count).toBe(5); // 이후 간격은 30초 상한
  await advance(40000); expect(count).toBe(6);
  expect(maximum).toBe(1);
  await act(async () => root!.unmount()); root = null;
  expect(active).toBe(0);
  await advance(60000); expect(count).toBe(6);
});

it("a late first success aborts an active retry and prevents later retries", async () => {
  const { features } = await boot();
  const first = deferred<Response>(); let calls = 0; let retrySignal: AbortSignal | null = null;
  configRequest = (init) => ++calls === 1 ? first.promise : new Promise((_resolve, reject) => {
    retrySignal = init!.signal!;
    retrySignal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  await mountAuth(); await advance(15000);
  expect(calls).toBe(2);
  await act(async () => { first.resolve(config(["scene_writer_confirm_v1"])); });
  expect(retrySignal!.aborted).toBe(true);
  expect(features.hubHasFeature("scene_writer_confirm_v1")).toBe(true);
  await advance(60000); expect(calls).toBe(2);
});
