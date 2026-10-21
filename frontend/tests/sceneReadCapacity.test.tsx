// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
import type { GenerationReadScope } from "../src/features/library/readModel";

vi.mock("../src/features/library/readModel", async () => {
  const actual = await vi.importActual<typeof import("../src/features/library/readModel")>("../src/features/library/readModel");
  return { ...actual, GenerationReadModel: class extends actual.GenerationReadModel {
    constructor(scope: GenerationReadScope) { super(scope, 2); }
  } };
});
const ids = ["known", "left", "right", "tail"];
const row = (id: string) => ({ id, status: "done", tags: [], auto_tags: [], color: null, assets: [], references: [] }) as unknown as Generation;
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(yes => { resolve = yes; }); return { promise, resolve };
}
const response = (value: unknown) => new Response(JSON.stringify(value));
let root: Root, host: HTMLDivElement;
let current: ReturnType<typeof import("../src/lib/useSceneGenData").useSceneGenData>;
let useData: typeof import("../src/lib/useSceneGenData").useSceneGenData;
let batches: ReturnType<typeof deferred>[];
let single: ReturnType<typeof deferred>;
function Harness() {
  current = useData(ids.map(id => ({ id, kind: "generation", genId: id, x: 0, y: 0 })), { sceneKey: "scene", authKey: "a", authReady: true });
  return <output>{Object.keys(current.genData).join(",")}</output>;
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("BroadcastChannel", undefined);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  batches = []; single = deferred();
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/generations/batch") { const reply = deferred(); batches.push(reply); return reply.promise; }
    if (url === "/api/generations/known") return single.promise;
    throw new Error(`Unexpected request: ${url}`);
  }));
  const models = await import("../src/features/library/api"); models.getGenerationReadModel("a", "lookup");
  // 첫 API의 인증 초기화가 캐시를 비워 용량 검증에 재조회가 섞이지 않게 한다.
  (await import("../src/app/operationContext")).configureOperationContext({ key: "a", serverOrigin: location.origin, authority: "local", ready: true });
  (await import("../src/lib/sceneGenDataStore")).putGen(row("known"));
  useData = (await import("../src/lib/useSceneGenData")).useSceneGenData;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.unstubAllGlobals();
});
it("[R4-4] keeps every done card without retiring the batch when the cache is smaller than the scene", async () => {
  await act(async () => root.render(<Harness />)); expect(batches).toHaveLength(1);
  const records = (await import("../src/features/library/api")).getGenerationReadModel("a", "lookup");
  const inFlight = records.beginRead();
  await act(async () => current.refreshGenerationAfter("known", Promise.resolve()));
  await act(async () => single.resolve(response({ ...row("known"), folder_path: "newer" })));
  expect(current.genData.known.folder_path).toBe("newer");
  const full = () => response({ items: Object.fromEntries(ids.map(id => [id, row(id)])), materials: {}, missing: [] });
  await act(async () => batches[0].resolve(full()));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(batches).toHaveLength(1);
  expect(Object.keys(current.genData).sort()).toEqual([...ids].sort());
  expect(current.genData.known.folder_path).toBe("newer");
  expect(current.genData.tail.status).toBe("done");
  expect(records.read("known")).toBeUndefined();
  expect(records.isCurrent(inFlight)).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(batches).toHaveLength(1);
});
