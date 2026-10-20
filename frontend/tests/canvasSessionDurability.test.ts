// @vitest-environment jsdom
// 실제 sceneStore 연산/확정 큐를 사용한다. IndexedDB 없는 jsdom의 메모리 IO 경로이며 브라우저 실측은 아니다.
import { afterEach, beforeEach, expect, it } from "vitest";
import { canvasTarget, createCanvasDocumentPort, type CanvasCommand } from "../src/features/canvas/api";
import { listPersistedScenes, listScenes, saveScenes, updateScene, type Scene } from "../src/lib/scenes";
import { delaySceneStoreWritesForTest, failSceneStoreWritesForTest, settleSceneStoreForTest } from "../src/lib/sceneStore";

const initial: Scene = { id: "scene", name: "Scene", created_at: 1, cards: [{ id: "card", kind: "generation", x: 0, y: 0, prompt: "before" }], edges: [] };
beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear();
  saveScenes(null, [initial]); await settleSceneStoreForTest();
});
afterEach(async () => {
  delaySceneStoreWritesForTest(0); failSceneStoreWritesForTest(false); await settleSceneStoreForTest();
});

it("T10: 조립부의 Board 투영도 바깥 flush가 실제 확정할 때까지 기다린다", async () => {
  let port: ReturnType<typeof createCanvasDocumentPort>;
  const target = canvasTarget("scene");
  port = createCanvasDocumentPort({
    write: (id, patch) => updateScene(null, id, patch).ok,
    flushPending: () => { updateScene(null, target.sceneId, { cards: [{ ...initial.cards[0], prompt: "typed" }], edges: [] }); },
  });
  delaySceneStoreWritesForTest(20);
  const receipt = port.flush(target);
  expect(receipt.queued).toBe(true);
  expect(listScenes(null)[0].cards[0].prompt).toBe("typed");
  expect(listPersistedScenes(null)[0].cards[0].prompt).toBe("before");
  expect(await receipt.confirmed).toBe(true);
  expect(listPersistedScenes(null)[0].cards[0].prompt).toBe("typed");
});

it("T10: 저장 실패는 화면 표식을 보존하지만 확정 성공으로 보고하지 않는다", async () => {
  failSceneStoreWritesForTest(true);
  const port = createCanvasDocumentPort({ flushPending: () => {} });
  const receipt = port.commit(canvasTarget("scene"), { type: "reserveGeneration", createdAt: 1,
    links: [{ scene_id: "scene", card_id: "card", attempt_id: "attempt", generation_id: "result" }] });
  expect(receipt.queued).toBe(true); expect(await receipt.confirmed).toBe(false);
  expect(listScenes(null)[0].cards[0].genId).toBe("result");
  expect(listPersistedScenes(null)[0].cards[0].genId).toBeUndefined();
});

it("외부 명령 포트는 전체 Board 사본 교체를 받지 않는다", async () => {
  const port = createCanvasDocumentPort({ flushPending: () => {} });
  const receipt = port.commit(canvasTarget("scene"), { type: "commitBoardSnapshot", cards: [], edges: [] } as unknown as CanvasCommand);
  expect(receipt.queued).toBe(false); expect(await receipt.confirmed).toBe(false);
  expect(listScenes(null)[0].cards).toEqual(initial.cards);
});
