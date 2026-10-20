import { createCanvasDocumentPort } from "../src/features/canvas/api";
// @vitest-environment jsdom
// 실제 훅·표식 변환을 검증한다. 저장소 확정과 HTTP는 제어 가능한 IO 대역이며 실제 IndexedDB·전체 앱 실측은 아니다.
import { act, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";
import type { Scene, SceneCard } from "../src/lib/scenes";
import { prepareCanvasGenerationLinks, type CanvasGenerationLink } from "../src/lib/canvasGenerationRecovery";
import { useCanvasGenerationLinks } from "../src/lib/useCanvasGenerationLinks";
import { executeSceneGenerationBatch } from "../src/lib/sceneGenerationSubmission";

const io = vi.hoisted(() => ({
  scenes: [] as Scene[],
  persisted: [] as Scene[],
  confirmed: Promise.resolve(true),
  resolve: vi.fn(), batch: vi.fn(), repair: vi.fn(), seed: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}));
vi.mock("../src/api", () => ({ api: {
  resolveCanvasGenerationLinks: io.resolve,
  getGenerationsBatch: io.batch,
  repairCanvasGenerationLinks: io.repair,
} }));
vi.mock("../src/lib/sceneRecentDoneStore", () => ({ seedPending: io.seed }));
vi.mock("../src/lib/scenes", async () => ({
  ...await vi.importActual<typeof import("../src/lib/scenes")>("../src/lib/scenes"),
  listScenes: () => io.scenes,
  listPersistedScenes: () => io.persisted,
  confirmSceneWrite: <T,>(run: () => T) => ({ value: run(), confirmed: io.confirmed }),
  subscribeSceneSaveState: io.subscribe,
}));

const link = (suffix = "mine", cardId = "card-a"): CanvasGenerationLink => ({
  scene_id: "scene-a", card_id: cardId, attempt_id: `attempt-${suffix}`, generation_id: `generation-${suffix}`,
});
const card = (id = "card-a"): SceneCard => ({ id, kind: "generation", x: 0, y: 0 });
const scene = (cards = [card()]): Scene => ({ id: "scene-a", name: "시험", created_at: 1, cards, edges: [] });
const generation = (id: string) => ({ id, status: "pending", assets: [], tags: [] }) as unknown as Generation;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: Root;
let host: HTMLDivElement;
let mounted: boolean;
let links: ReturnType<typeof useCanvasGenerationLinks>;
let gens: Generation[];
let events: string[];
const flush = vi.fn((sceneId: string) => { events.push(`flush:${sceneId}`); });
const patch = vi.fn((sceneId: string, value: Partial<Scene>) => {
  events.push(`patch:${sceneId}`);
  const found = io.scenes.some((item) => item.id === sceneId);
  if (found) io.scenes = io.scenes.map((item) => item.id === sceneId ? { ...item, ...value } : item);
  return found;
});
const setGens = vi.fn((next: SetStateAction<Generation[]>) => {
  gens = typeof next === "function" ? next(gens) : next;
});
const canvasDocument = createCanvasDocumentPort({ flushPending: flush, write: patch });
function Harness({ authReady }: { authReady: boolean }) {
  links = useCanvasGenerationLinks({ authReady, scenes: io.scenes, canvasDocument, setGens });
  return null;
}
const show = async (authReady = false) => {
  await act(async () => { root.render(<Harness authReady={authReady} />); });
};
const currentCard = (id = "card-a") => io.scenes[0].cards.find((item) => item.id === id)!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected HTTP in hook test"))));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.clearAllMocks();
  io.scenes = [scene()];
  io.persisted = [scene()];
  io.confirmed = Promise.resolve(true);
  io.resolve.mockResolvedValue({ links: [] });
  io.batch.mockResolvedValue({ items: {} });
  io.repair.mockResolvedValue({ links: [] });
  gens = [];
  events = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
});
afterEach(() => {
  if (mounted) act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("확정 실패는 빈 링크를 돌려주고 자신이 만든 표식만 걷는다", async () => {
  const other = link("other");
  io.scenes = [scene(prepareCanvasGenerationLinks([card()], [other]).cards)];
  io.persisted = io.scenes;
  const confirmation = deferred<boolean>();
  io.confirmed = confirmation.promise;
  await show();
  const mine = link();
  let result!: CanvasGenerationLink[];
  const run = links.prepareCanvasGenerationBatch("scene-a", ["card-a"], [mine]).then((value) => { result = value; });
  expect(currentCard().pendingGenerationAttempts?.map((item) => item.attemptId)).toEqual([other.attempt_id, mine.attempt_id]);
  expect(io.seed).not.toHaveBeenCalled();
  await act(async () => { confirmation.resolve(false); await run; });
  expect(result).toEqual([]);
  expect(currentCard().pendingGenerationAttempts?.map((item) => item.attemptId)).toEqual([other.attempt_id]);
  expect(currentCard().genIds).toEqual([other.generation_id]);
  expect(io.seed).not.toHaveBeenCalled();
  expect(events).toEqual(["flush:scene-a", "patch:scene-a", "flush:scene-a", "patch:scene-a"]);
});

it("확정 중 대상 카드가 사라지면 성공 응답이어도 링크를 반환하지 않는다", async () => {
  const confirmation = deferred<boolean>();
  io.confirmed = confirmation.promise;
  await show();
  const run = links.prepareCanvasGenerationBatch("scene-a", ["card-a"], [link()]);
  io.scenes = [scene([])];
  io.persisted = io.scenes;
  let result: CanvasGenerationLink[] | undefined;
  await act(async () => { confirmation.resolve(true); result = await run; });
  expect(result).toEqual([]);
  expect(io.scenes[0].cards).toEqual([]);
  expect(io.seed).not.toHaveBeenCalled();
});

it("다른 씬·카드를 가리키는 고정 링크는 저장 전에 거절한다", async () => {
  await show();
  expect(await links.prepareCanvasGenerationBatch("scene-a", ["card-a"], [link("wrong", "card-b")])).toEqual([]);
  expect(flush).not.toHaveBeenCalled();
  expect(patch).not.toHaveBeenCalled();
  expect(io.seed).not.toHaveBeenCalled();
});

it("취소는 지정한 시도의 표식만 제거하고 다른 시도·기존 결과는 유지한다", async () => {
  const mine = link();
  const other = link("other");
  io.scenes = [scene(prepareCanvasGenerationLinks([{ ...card(), genId: "old", genIds: ["old"] }], [mine, other]).cards)];
  await show();
  act(() => links.discardCanvasGeneration(mine));
  expect(currentCard().pendingGenerationAttempts?.map((item) => item.attemptId)).toEqual([other.attempt_id]);
  expect(currentCard().genIds).toEqual(["old", other.generation_id]);
  expect(events).toEqual(["flush:scene-a", "patch:scene-a"]);
  expect(setGens).not.toHaveBeenCalled();
});

it("표식 확정과 확정본 재검사 뒤에만 준비된 링크를 돌려주고 settle은 결과를 중복 추가하지 않는다", async () => {
  const confirmation = deferred<boolean>();
  io.confirmed = confirmation.promise;
  await show();
  let completed = false;
  const mine = link();
  const run = links.prepareCanvasGenerationBatch("scene-a", ["card-a"], [mine]).then((value) => { completed = true; return value; });
  await act(async () => { await Promise.resolve(); });
  expect(completed).toBe(false);
  expect(io.seed).not.toHaveBeenCalled();
  io.persisted = io.scenes;
  let result: CanvasGenerationLink[] | undefined;
  await act(async () => { confirmation.resolve(true); result = await run; });
  expect(result).toEqual([mine]);
  expect(io.seed).toHaveBeenCalledWith([mine.generation_id]);
  act(() => {
    links.settleCanvasGeneration(mine, generation(mine.generation_id));
    links.settleCanvasGeneration(mine, generation(mine.generation_id));
  });
  expect(currentCard().pendingGenerationAttempts).toBeUndefined();
  expect(currentCard().genIds).toEqual([mine.generation_id]);
  expect(gens.map((item) => item.id)).toEqual([mine.generation_id]);
});

it("복구 조회 오류는 오래된 표식도 보존하고 다음 주기에 다시 확인한다", async () => {
  const mine = link();
  io.scenes = [scene(prepareCanvasGenerationLinks([card()], [mine], Date.now() - 180_000).cards)];
  const original = io.scenes[0].cards;
  io.resolve.mockRejectedValue(new Error("offline"));
  await show(true);
  expect(io.resolve).toHaveBeenCalledTimes(1);
  expect(io.scenes[0].cards).toBe(original);
  expect(patch).not.toHaveBeenCalled();
  expect(io.repair).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(2499); });
  expect(io.resolve).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(io.resolve).toHaveBeenCalledTimes(2);
  expect(io.scenes[0].cards).toBe(original);
  expect(patch).not.toHaveBeenCalled();
});

it.each(["throw", "refuse"] as const)("카드 patch가 %s여도 성공 결과를 보존하고 반영 실패만 집계한다", async (failure) => {
  const mine = link();
  io.scenes = [scene(prepareCanvasGenerationLinks([card()], [mine]).cards)];
  await show();
  patch.mockImplementationOnce(() => {
    if (failure === "throw") throw new Error("scene write failed");
    return false;
  });
  const summary = await executeSceneGenerationBatch(
    [{ cardId: mine.card_id, input: mine }],
    async (input) => input,
    async () => generation(mine.generation_id),
    ({ result }) => links.settleCanvasGeneration(mine, result),
  );
  expect(gens.map((item) => item.id)).toEqual([mine.generation_id]);
  expect(summary).toMatchObject({ buildFail: 0, submitFail: 0, submitUnknown: 0, applyFail: 1 });
  expect(summary.successes).toHaveLength(1);
  expect(currentCard().pendingGenerationAttempts).toHaveLength(1);
});

it("같은 카드 배치가 역순 완료돼도 먼저 온 결과를 즉시 반영하고 다른 표식과 입력 순서를 보존한다", async () => {
  const first = link("first");
  const second = link("second");
  io.scenes = [scene(prepareCanvasGenerationLinks([card()], [first, second]).cards)];
  await show();
  const responses = [deferred<Generation>(), deferred<Generation>()];
  const running = executeSceneGenerationBatch(
    [first, second].map((input, index) => ({ cardId: input.card_id, input: index })),
    async (index) => ({ index }),
    async ({ index }) => responses[index].promise,
    ({ cardId, result }) => links.settleCanvasGeneration({ scene_id: first.scene_id, card_id: cardId }, result),
  );
  await act(async () => { responses[1].resolve(generation(second.generation_id)); });
  expect(gens.map((item) => item.id)).toEqual([second.generation_id]);
  expect(currentCard().pendingGenerationAttempts?.map((item) => item.attemptId)).toEqual([first.attempt_id]);
  let summary!: Awaited<typeof running>;
  await act(async () => { responses[0].resolve(generation(first.generation_id)); summary = await running; });
  expect(summary.successes.map((item) => item.result.id)).toEqual([first.generation_id, second.generation_id]);
  expect(summary.applyFail).toBe(0);
  expect(currentCard().pendingGenerationAttempts).toBeUndefined();
  expect(currentCard().genIds).toEqual([first.generation_id, second.generation_id]);
  expect(new Set(gens.map((item) => item.id))).toEqual(new Set([first.generation_id, second.generation_id]));
});

it("생성물만 남은 orphan은 서버 연결표를 복구한 뒤 원래 씬·카드의 표식만 정산한다", async () => {
  const mine = link();
  const other = link("other", "card-b");
  io.scenes = [scene(prepareCanvasGenerationLinks([card(), card("card-b")], [mine, other]).cards)];
  io.batch.mockResolvedValue({ items: { [mine.generation_id]: generation(mine.generation_id) } });
  const repair = deferred<{ links: CanvasGenerationLink[] }>();
  io.repair.mockReturnValue(repair.promise);
  await show(true);
  expect(io.resolve).toHaveBeenCalledWith([mine.attempt_id, other.attempt_id]);
  expect(io.batch).toHaveBeenCalledWith([mine.generation_id, other.generation_id]);
  expect(io.repair).toHaveBeenCalledWith([mine]);
  expect(patch).not.toHaveBeenCalled();
  expect(currentCard().pendingGenerationAttempts).toHaveLength(1);
  await act(async () => { repair.resolve({ links: [mine] }); });
  expect(currentCard().pendingGenerationAttempts).toBeUndefined();
  expect(currentCard().genIds).toEqual([mine.generation_id]);
  expect(currentCard("card-b").pendingGenerationAttempts?.map((item) => item.attemptId)).toEqual([other.attempt_id]);
  expect(events).toEqual(["flush:scene-a", "patch:scene-a"]);
  expect(gens.map((item) => item.id)).toEqual([mine.generation_id]);
});

it.each(["lookup", "repair"] as const)("언마운트 후 늦은 %s 응답은 카드 갱신·후속 복구·타이머를 남기지 않는다", async (phase) => {
  const mine = link();
  io.scenes = [scene(prepareCanvasGenerationLinks([card()], [mine]).cards)];
  const response = deferred<{ links: CanvasGenerationLink[] }>();
  io.batch.mockResolvedValue({ items: { [mine.generation_id]: generation(mine.generation_id) } });
  if (phase === "lookup") io.resolve.mockReturnValue(response.promise);
  else io.repair.mockReturnValue(response.promise);
  await show(true);
  act(() => root.unmount());
  mounted = false;
  patch.mockClear();
  setGens.mockClear();
  const calls = io.resolve.mock.calls.length;
  await act(async () => {
    response.resolve({ links: [mine] });
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(patch).not.toHaveBeenCalled();
  expect(setGens).not.toHaveBeenCalled();
  expect(currentCard().pendingGenerationAttempts).toHaveLength(1);
  expect(io.resolve).toHaveBeenCalledTimes(calls);
  if (phase === "lookup") expect(io.repair).not.toHaveBeenCalled();
});
