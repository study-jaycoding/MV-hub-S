// @vitest-environment jsdom
// Comfy 결과를 받은 뒤 새로 고쳐도 되돌리기 기록이 남는다(최종 검토 A-09) — 진짜 저장소·진짜 보존 코드로 본다. 예약 함수를 가짜로 바꾸면 '저장 확정 전에 화면이 먼저 받는' 경합을 못 잡는다.
// 페이지 로드는 vi.resetModules 로, IndexedDB 칸은 sceneUndoPersistence 시험과 같은 메모리 칸으로 흉내 낸다.
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UndoBackend, UndoSlot } from "../src/lib/sceneUndoPersistence";
import type { Scene, SceneCard, SceneGroup } from "../src/lib/scenes";

const BUCKET = "local::_none";
const card = (id: string, x = 0, extra: object = {}) => ({ id, kind: "generation", x, y: 0, prompt: "before", ...extra });
const scene = (cards: object[]): Scene => ({ id: "s1", name: "s1", created_at: 1, edges: [], cards }) as never;
let slots: Map<string, UndoSlot>;
let root: Root | null;

function backend(plan: typeof import("../src/lib/sceneUndoPersistence").planUndoPut): UndoBackend {
  return {
    async put(slot, budget) {
      const decided = plan({ generation: 0, total: 0, previousSize: 0 }, slot, budget);
      if (decided.result === "ok") slots.set(slot.key, structuredClone(slot));
      return decided.result;
    },
    async get(key) { return slots.has(key) ? structuredClone(slots.get(key)!) : null; },
    async generation() { return 0; },
    async generations() { return {}; },
    async forget() { return 0; },
    async prune() {},
  };
}

async function pageLoad(cards: object[]) {
  vi.resetModules();
  const persist = await import("../src/lib/sceneUndoPersistence");
  persist.setUndoBackend(backend(persist.planUndoPut));
  const store = await import("../src/lib/sceneStore");
  let mark: Parameters<typeof store.initSceneStore>[1] = null;
  await store.initSceneStore(() => ({ [BUCKET]: [scene(cards)] as never }), mark, (next) => { mark = next; return true; });
  await store.settleSceneStoreForTest();
  const boot = await import("../src/lib/sceneBoot");
  await boot.restoreUndoHistories();
  return { persist, store, boot, data: await import("../src/lib/scenes"), undo: await import("../src/lib/sceneUndoStore") };
}

async function mount(page: Awaited<ReturnType<typeof pageLoad>>, sceneId = "s1") {
  const { useCanvasSession } = await import("../src/features/canvas/useCanvasSession");
  const target = { accountNamespace: "local", sceneId };
  const saved = page.data.listPersistedScenes(null).find((item) => item.id === sceneId)!;
  let session!: ReturnType<typeof useCanvasSession>;
  let receive!: (next: Scene) => void;
  let cardsNow!: () => SceneCard[];
  function Screen() {
    const [source, setSource] = useState(saved); receive = setSource;
    const [cards, setCards] = useState(saved.cards), [edges, setEdges] = useState(saved.edges), [groups, setGroups] = useState<SceneGroup[]>([]);
    const cardsRef = useRef(cards); cardsRef.current = cards;
    const edgesRef = useRef(edges); edgesRef.current = edges;
    const groupsRef = useRef(groups); groupsRef.current = groups;
    session = useCanvasSession({ sceneId, sourceScene: source, initialSnapshot: { cards: saved.cards, edges: saved.edges, groups: [] },
      cardsRef, edgesRef, groupsRef, setCards, setEdges, setGroups, sceneIdRef: useRef(sceneId), frozenRef: useRef(false),
      layerMoveRef: useRef(null), clearSelection: () => {}, onChange: (snapshot) => page.data.writeSceneSnapshot(target, snapshot) });
    cardsNow = () => cardsRef.current;
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Screen />));
  return { session: () => session, receive: (next: Scene) => act(async () => receive(next)), cards: () => cardsNow() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
// 결과 반영을 저장 관문으로 — 화면은 저장 확정 전에 작업본을 받는다(session.ts 의 changed)
function resultArrives(page: Awaited<ReturnType<typeof pageLoad>>, output: string) {
  page.data.updateScene(null, "s1", { cards: page.data.listScenes(null)[0].cards.map((item) => ({ ...item, text: output })) });
  return page.data.listScenes(null)[0];
}
const reloadAdopts = async (cards: object[]) => {
  const page = await pageLoad(cards);
  return page.undo.loadSceneHistory("s1");
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.clear();
  slots = new Map();
  root = null;
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  vi.restoreAllMocks();
});

async function editedBoard() {
  const page = await pageLoad([card("c", 0)]);
  const board = await mount(page);
  await act(async () => { board.session().commit({ type: "editCardPrompt", cardId: "c", prompt: "after" }); board.session().flush(); await page.store.settleSceneStoreForTest(); });
  await settle();
  expect(slots.size).toBe(1);
  return { page, board };
}

it("저장 확정 전에 화면이 받은 결과도 — 편집 없이 새로 고치면 지문이 맞아 기록이 채택된다", async () => {
  const { page, board } = await editedBoard();
  page.store.delaySceneStoreWritesForTest(30);
  const next = resultArrives(page, "결과");
  await board.receive(next); // 저장 확정 전이다 — 곧바로 끝나는 영수증이면 지문이 어긋나 쓰이지 않는다
  await new Promise((resolve) => setTimeout(resolve, 60));
  await page.store.settleSceneStoreForTest();
  await settle();
  page.store.delaySceneStoreWritesForTest(0);
  const saved = page.data.listPersistedScenes(null)[0].cards;
  expect(saved[0].text).toBe("결과");
  if (root) act(() => root!.unmount());
  root = null;
  const history = await reloadAdopts(saved);
  expect(history?.undo).toHaveLength(1);
  expect(history?.lastCommit.cards[0].text).toBe("결과");
});

it("다른 씬으로 바꾸며 받은 씬은 수신이 아니다 — 씬 전환은 예약하지 않는다", async () => {
  const page = await pageLoad([card("c", 0)]);
  page.data.saveScenes(null, [...page.data.listScenes(null), { ...scene([card("d", 0)]), id: "s2", name: "s2" }]);
  await page.store.settleSceneStoreForTest();
  const board = await mount(page);
  await act(async () => { board.session().commit({ type: "editCardPrompt", cardId: "c", prompt: "after" }); board.session().flush(); await page.store.settleSceneStoreForTest(); });
  await settle();
  const before = [...slots.values()].map((slot) => slot.sceneId);
  await board.receive(page.data.listScenes(null)[1]);
  await settle();
  expect([...slots.values()].map((slot) => slot.sceneId)).toEqual(before);
});

it("저장이 실패하면 기록을 쓰지 않는다", async () => {
  const { page, board } = await editedBoard();
  const before = structuredClone([...slots.values()][0]);
  page.store.failSceneStoreWritesForTest(true);
  await board.receive(resultArrives(page, "결과"));
  await settle();
  await settle();
  expect([...slots.values()][0].snapFp).toBe(before.snapFp);
  page.store.failSceneStoreWritesForTest(false);
  await page.store.settleSceneStoreForTest(); // 다음 시험의 칸에 늦게 쓰지 않게
  await settle();
});

it("저장이 잠깐 실패했다가 다시 시도로 성공하면 기록을 쓴다 — 그 씬은 화면에 다시 오지 않는다", async () => {
  const { page, board } = await editedBoard();
  page.store.failSceneStoreWritesForTest(true);
  await board.receive(resultArrives(page, "결과"));
  await page.store.settleSceneWrites(20);
  await settle();
  page.store.failSceneStoreWritesForTest(false);
  await page.store.settleSceneStoreForTest();
  await settle();
  const saved = page.data.listPersistedScenes(null)[0].cards;
  expect(saved[0].text).toBe("결과");
  if (root) act(() => root!.unmount());
  root = null;
  expect((await reloadAdopts(saved))?.lastCommit.cards[0].text).toBe("결과");
});

it("일반 편집의 첫 저장이 실패하고 재시도로 저장되면 더 고치지 않고 새로 고쳐도 기록이 채택된다", async () => {
  const { page, board } = await editedBoard();
  const before = [...slots.values()][0].snapFp;
  page.store.failSceneStoreWritesForTest(true);
  await act(async () => { board.session().commit({ type: "editCardPrompt", cardId: "c", prompt: "다시" }); board.session().flush(); });
  await page.store.settleSceneWrites(20);
  await settle();
  expect([...slots.values()][0].snapFp).toBe(before); // 저장이 실패하는 동안에는 쓰지 않는다
  page.store.failSceneStoreWritesForTest(false);
  await page.store.settleSceneStoreForTest();
  await settle();
  const saved = page.data.listPersistedScenes(null)[0].cards;
  expect(saved[0].prompt).toBe("다시");
  if (root) act(() => root!.unmount());
  root = null;
  const history = await reloadAdopts(saved);
  expect(history?.undo).toHaveLength(2);
  expect(history?.lastCommit.cards[0].prompt).toBe("다시");
});

it("앞 예약이 기다리는 사이의 다음 편집이 저장되면 최신 기록이 쓰인다", async () => {
  const { page, board } = await editedBoard();
  page.store.failSceneStoreWritesForTest(true);
  await act(async () => { board.session().commit({ type: "editCardPrompt", cardId: "c", prompt: "둘째" }); board.session().flush(); });
  await page.store.settleSceneWrites(20);
  await act(async () => { board.session().commit({ type: "editCardPrompt", cardId: "c", prompt: "셋째" }); board.session().flush(); });
  page.store.failSceneStoreWritesForTest(false);
  await page.store.settleSceneStoreForTest();
  await settle();
  await settle();
  const saved = page.data.listPersistedScenes(null)[0].cards;
  expect(saved[0].prompt).toBe("셋째");
  if (root) act(() => root!.unmount());
  root = null;
  expect((await reloadAdopts(saved))?.lastCommit.cards[0].prompt).toBe("셋째");
});

it("카드에서 지운 결과는 보존 슬롯의 옛 단계에서도 빠져 새로 고친 뒤 되돌려도 돌아오지 않는다", async () => {
  const outputs = [{ kind: "image", url: "/media/comfy/a.png", saved_generation_id: "g1" }, { kind: "image", url: "/media/comfy/b.png", saved_generation_id: "g2" }];
  const page = await pageLoad([card("c", 0, { kind: "comfy", genIds: ["g1", "g2"], genId: "g2", comfyCfg: { name: "wf", content: "{}", outputs } })]);
  const board = await mount(page);
  await act(async () => { board.session().commit({ type: "editCardPrompt", cardId: "c", prompt: "after" }); board.session().flush(); await page.store.settleSceneStoreForTest(); });
  await settle();
  await act(async () => { board.session().commit({ type: "removeCardVariants", cardId: "c", removedIds: ["g1"] }); board.session().flush(); await page.store.settleSceneStoreForTest(); });
  await settle();
  const saved = page.data.listPersistedScenes(null)[0].cards;
  expect(saved[0].comfyCfg?.outputs).toEqual([outputs[1]]);
  if (root) act(() => root!.unmount());
  root = null;
  const history = await reloadAdopts(saved);
  expect(history?.undo).toHaveLength(1);
  expect(history?.undo[0].cards[0].comfyCfg?.outputs).toEqual([outputs[1]]);
  expect(history?.undo[0].cards[0].genIds).toEqual(["g2"]);
});

it("값이 같은 새 객체를 받으면 예약하지 않는다", async () => {
  const { page, board } = await editedBoard();
  const before = [...slots.values()][0].savedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await board.receive(structuredClone(page.data.listScenes(null)[0]));
  await settle();
  expect([...slots.values()][0].savedAt).toBe(before);
});

it("끄는 중에 받고 움직임 없이 놓아도 끝날 때 예약돼 다음 부팅에 채택된다", async () => {
  const { page, board } = await editedBoard();
  const move = board.session().gestures.beginCardMove(["c"], []);
  await board.receive(resultArrives(page, "결과"));
  await page.store.settleSceneStoreForTest();
  await settle();
  const during = [...slots.values()][0].snapFp;
  await act(async () => move.finish());
  await settle();
  expect([...slots.values()][0].snapFp).not.toBe(during);
  const saved = page.data.listPersistedScenes(null)[0].cards;
  if (root) act(() => root!.unmount());
  root = null;
  expect((await reloadAdopts(saved))?.undo).toHaveLength(1);
});

it("기록이 비어 있으면 받아도 쓰지 않는다", async () => {
  const page = await pageLoad([card("c", 0)]);
  const board = await mount(page);
  await board.receive(resultArrives(page, "결과"));
  await page.store.settleSceneStoreForTest();
  await settle();
  expect(slots.size).toBe(0);
});
