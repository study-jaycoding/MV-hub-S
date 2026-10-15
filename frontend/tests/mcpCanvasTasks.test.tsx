// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation, WorkspaceContext } from "../src/types";
import type { Scene } from "../src/lib/scenes";
const io = vi.hoisted(() => ({ http: vi.fn(), get: vi.fn(), write: vi.fn(), confirm: vi.fn(), working: [] as Scene[], saved: [] as Scene[], token: "a", account: "a" }));
vi.mock("../src/api", () => ({ api: { getGeneration: io.get } }));
vi.mock("../src/lib/http", () => ({ jsonFetch: io.http, jsonBody: JSON.stringify, getAuthToken: () => io.token }));
vi.mock("../src/lib/accountScope", () => ({ getAccountNamespace: () => io.account }));
vi.mock("../src/lib/sceneStore", async (original) => ({ ...await original<typeof import("../src/lib/sceneStore")>(), sceneStoreReady: () => true }));
vi.mock("../src/lib/scenes", async (original) => ({ ...await original<typeof import("../src/lib/scenes")>(), listScenes: () => io.working, listPersistedScenes: () => io.saved, updateScenesWith: io.write, confirmSceneWrite: io.confirm }));
import { attachMcpCanvasTask, useMcpCanvasTasks, type McpCanvasTask } from "../src/lib/mcpCanvasTasks";
import { readStoredScene } from "../src/lib/scenes";
const workspace: WorkspaceContext = { scope: "team", id: "w1", name: "작업 공간" };
const task: McpCanvasTask = { id: "task1", scene_id: "s1", workspace, generation_ids: ["g1"], status: "pending" };
const generation = { id: "g1", status: "done", prompt: "바나나", workspace_scope: "team", workspace_id: "w1" } as Generation;
const ports = { flushScenePending: vi.fn(), refreshSceneById: vi.fn() };
let root: Root | undefined, host: HTMLDivElement | undefined;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
beforeEach(async () => {
  vi.resetAllMocks(); io.token = "a"; io.account = "a";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", (await vi.importActual<{ webcrypto: Crypto }>("node:crypto")).webcrypto);
  io.working = [{ id: "s1", name: "Scene", created_at: 1, workspace: { id: "w1", name: "작업 공간" }, cards: [], edges: [] }]; io.saved = clone(io.working);
  io.get.mockResolvedValue(generation);
  io.write.mockImplementation((_project, mutate: (scenes: Scene[]) => Scene[] | null) => { const next = mutate(io.working); if (next) io.working = next; return true; });
  io.confirm.mockImplementation((fn: () => unknown) => { const value = fn(); io.saved = clone(io.working); return { value, confirmed: Promise.resolve(true) }; });
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; host = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("기존 생성물만 붙이고 재전달·동시 요청은 카드 하나와 영수증 하나로 합친다", async () => {
  const results = await Promise.all([attachMcpCanvasTask(task, workspace, ports, () => true), attachMcpCanvasTask(task, workspace, ports, () => true)]);
  expect(results).toEqual([true, true]); expect(io.saved[0].cards).toHaveLength(1);
  expect(io.saved[0].cards[0].genId).toBe("g1"); expect(io.saved[0].mcpAttachmentReceipts).toEqual(["task1"]);
  expect(readStoredScene(io.saved[0]).mcpAttachmentReceipts).toEqual(["task1"]);
  // ACK가 유실된 뒤 사용자가 지운 카드는 재전달로 되살리지 않는다.
  io.working[0].cards = []; io.saved = clone(io.working); io.get.mockClear();
  expect(await attachMcpCanvasTask(task, workspace, ports, () => true)).toBe(true);
  expect(io.working[0].cards).toEqual([]); expect(io.get).not.toHaveBeenCalled();
});

it("없는 씬·다른 공간·조회 도중 계정 변경은 카드와 완료 기록을 만들지 않는다", async () => {
  expect(await attachMcpCanvasTask({ ...task, scene_id: "missing" }, workspace, ports, () => true)).toBe(false);
  expect(await attachMcpCanvasTask(task, { ...workspace, id: "other" }, ports, () => true)).toBe(false);
  expect(io.get).not.toHaveBeenCalled();
  let fresh = true;
  io.get.mockImplementation(async () => { fresh = false; return generation; });
  expect(await attachMcpCanvasTask(task, workspace, ports, () => fresh)).toBe(false);
  expect(io.write).not.toHaveBeenCalled(); expect(io.saved[0].cards).toEqual([]);
});

it("저장이 실패하면 완료 처리하지 않으며 저장 대기 중 편집을 늦은 새로고침으로 덮지 않는다", async () => {
  let settle!: (ok: boolean) => void;
  io.confirm.mockImplementationOnce((fn: () => unknown) => ({ value: fn(), confirmed: new Promise<boolean>((resolve) => { settle = resolve; }) }));
  const pending = attachMcpCanvasTask(task, workspace, ports, () => true);
  await Promise.resolve(); await Promise.resolve();
  expect(ports.refreshSceneById).toHaveBeenCalledTimes(1);
  settle(false); expect(await pending).toBe(false);
  expect(ports.refreshSceneById).toHaveBeenCalledTimes(1); expect(io.saved[0].cards).toEqual([]);
});

it("상시 소비자는 ACK 실패 뒤 다시 확인하며 생성 API 없이 저장된 영수증으로 ACK한다", async () => {
  vi.useFakeTimers();
  let ack = 0;
  io.http.mockImplementation(async (url: string) => { if (url.endsWith("/complete")) { if (++ack === 1) throw new Error("lost ack"); return {}; } return { tasks: [task] }; });
  function Consumer() { useMcpCanvasTasks({ ...ports, authReady: true, authKey: "a", workspace }); return null; }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Consumer />));
  expect(ack).toBe(1); expect(io.saved[0].cards).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(ack).toBe(2); expect(io.get).toHaveBeenCalledTimes(1); expect(io.saved[0].cards).toHaveLength(1);
  expect(io.http.mock.calls.map(([url]) => String(url)).every((url) => url.startsWith("/api/mcp/v2/app/canvas-tasks"))).toBe(true);
});

it.each(["missing scene", "generation 404"])("%s 작업은 완료하지 않고 15/30/60/120초 간격으로 재확인하며 복구하면 간격을 되돌린다", async (failure) => {
  vi.useFakeTimers();
  const scene = clone(io.working);
  if (failure === "missing scene") io.working = [];
  else io.get.mockRejectedValue(new Error("404"));
  let polls = 0;
  io.http.mockImplementation(async (url: string) => {
    if (url.endsWith("/complete")) return {};
    polls += 1; return { tasks: [task] };
  });
  function Consumer() { useMcpCanvasTasks({ ...ports, authReady: true, authKey: "a", workspace }); return null; }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Consumer />));
  expect(polls).toBe(1);
  for (const delay of [15_000, 30_000, 60_000, 120_000, 120_000]) {
    const previous = polls;
    await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
    expect(polls).toBe(previous);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(polls).toBe(previous + 1);
  }
  expect(io.write).not.toHaveBeenCalled();
  expect(io.http.mock.calls.some(([url]) => String(url).endsWith("/complete"))).toBe(false);
  io.working = scene; io.get.mockResolvedValue(generation);
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(io.saved[0].cards).toHaveLength(1);
  const recovered = polls;
  await act(async () => vi.advanceTimersByTimeAsync(14_999));
  expect(polls).toBe(recovered);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(polls).toBe(recovered + 1);
  io.http.mockRejectedValueOnce(new Error("temporary network failure"));
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(polls).toBe(recovered + 2);
});

it("앞 작업의 조회 실패가 뒤의 정상 작업 저장과 완료를 막지 않는다", async () => {
  const broken = { ...task, id: "broken", generation_ids: ["missing"] };
  io.get.mockImplementation(async (id: string) => { if (id === "missing") throw new Error("404"); return generation; });
  io.http.mockImplementation(async (url: string) => url.endsWith("/complete") ? {} : { tasks: [broken, task] });
  function Consumer() { useMcpCanvasTasks({ ...ports, authReady: true, authKey: "a", workspace }); return null; }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Consumer />));
  expect(io.saved[0].mcpAttachmentReceipts).toEqual(["task1"]);
  expect(io.http.mock.calls.filter(([url]) => String(url).endsWith("/complete")).map(([url]) => url)).toEqual(["/api/mcp/v2/app/canvas-tasks/task1/complete"]);
});

it("소비자가 생성물을 기다리는 중 실제 계정이 바뀌면 저장과 ACK를 중단한다", async () => {
  let finish!: (value: Generation) => void;
  io.get.mockReturnValueOnce(new Promise<Generation>((resolve) => { finish = resolve; }));
  io.http.mockResolvedValue({ tasks: [task] });
  function Consumer({ ready }: { ready: boolean }) { useMcpCanvasTasks({ ...ports, authReady: ready, authKey: io.account, workspace }); return null; }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Consumer ready />));
  expect(io.get).toHaveBeenCalledTimes(1);
  io.account = "b"; io.token = "b";
  await act(async () => root!.render(<Consumer ready={false} />));
  await act(async () => finish(generation));
  expect(io.write).not.toHaveBeenCalled();
  expect(io.http.mock.calls.some(([url]) => String(url).endsWith("/complete"))).toBe(false);
});
