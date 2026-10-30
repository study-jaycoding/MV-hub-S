// @vitest-environment jsdom
// 실제 sceneStore 연산/확정 큐를 사용한다. IndexedDB 없는 jsdom의 메모리 IO 경로이며 브라우저 실측은 아니다.
import { afterEach, beforeEach, expect, it } from "vitest";
import { canvasTarget, createCanvasDocumentPort, type CanvasCommand } from "../src/features/canvas/api";
import { listPersistedScenes, listScenes, saveScenes, updateScene, writeSceneSnapshot, type Scene } from "../src/lib/scenes";
import { delaySceneStoreWritesForTest, failSceneStoreWritesForTest, settleSceneStoreForTest } from "../src/lib/sceneStore";
import { comfySceneFingerprints } from "../src/lib/sceneComfyInputs";
import { mergePatchedSceneList } from "../src/lib/useSceneCoordination";

const initial: Scene = { id: "scene", name: "Scene", created_at: 1, cards: [{ id: "card", kind: "generation", x: 0, y: 0, prompt: "before" }], edges: [] };

it("Comfy 예약·늦은 확정 통지는 표시 중인 카드 사본을 다시 전달하지 않는다", async () => {
  const scene: Scene = { ...initial, cards: [{ id: "c", kind: "comfy", x: 0, y: 0, comfyCfg: { content: "{}" } }] };
  saveScenes(null, [scene]); await settleSceneStoreForTest();
  let display = scene;
  const documentPort = createCanvasDocumentPort({ flushPending: () => {}, changed: (id, executionOnly) => {
    display = mergePatchedSceneList([display], listScenes(null), scene.id, executionOnly ? null : id)[0];
  } });
  const target = { ...canvasTarget(scene.id), originHubId: "h", originDeviceId: "d" };
  await documentPort.reserveComfyAttempt(target, { attemptId: "a", runGroupId: "g", copyIndex: 0, cardId: "c", ...comfySceneFingerprints(scene, "c")! });
  expect(display.cards).toBe(scene.cards);
  delaySceneStoreWritesForTest(20);
  const receipt = documentPort.commit(target, { type: "resolveComfy", canWrite: () => true, resolution: {
    attempt_id: "a", result_revision: 1, state: "saved", origin: { hub_id: "h", device_id: "d" },
    outputs: [{ output_key: "t", kind: "text", text: "done", state: "text" }],
  } });
  const delivered = display.cards;
  expect(delivered[0].comfyCfg?.outputs?.[0].text).toBe("done");
  await receipt.confirmed;
  expect(display.cards).toBe(delivered); // Board가 그 사이 친 입력을 덮을 새 카드 사본이 없다.
});

it("합쳐진 연속 저장은 최종 스냅샷의 영수증만 성공한다", async () => {
  delaySceneStoreWritesForTest(20);
  const snap = (prompt: string) => ({ cards: [{ ...initial.cards[0], prompt }], edges: [], groups: [] });
  const first = writeSceneSnapshot(canvasTarget("scene"), snap("one"));
  const last = writeSceneSnapshot(canvasTarget("scene"), snap("two"));
  expect(first.queued && last.queued).toBe(true);
  expect(await first.confirmed).toBe(false); expect(await last.confirmed).toBe(true);
  expect(listPersistedScenes(null)[0].cards[0].prompt).toBe("two");
});
it("늦은 저장의 영수증은 접수 시 복제한 스냅샷에 묶이고 뒤 편집과 섞이지 않는다", async () => {
  delaySceneStoreWritesForTest(20);
  const snap = { cards: [{ ...initial.cards[0], prompt: "captured" }], edges: [], groups: [] };
  const receipt = writeSceneSnapshot(canvasTarget("scene"), snap);
  snap.cards[0].prompt = "mutated-after-call";
  expect(await receipt.confirmed).toBe(true);
  expect(listPersistedScenes(null)[0].cards[0].prompt).toBe("captured");
  const next = writeSceneSnapshot(canvasTarget("scene"), snap);
  expect(await next.confirmed).toBe(true);
  expect(listPersistedScenes(null)[0].cards[0].prompt).toBe("mutated-after-call");
});
it("접수 실패와 실제 저장 실패는 그 편집의 영수증에서 실패한다", async () => {
  expect(await writeSceneSnapshot(canvasTarget("missing"), initial).confirmed).toBe(false);
  failSceneStoreWritesForTest(true);
  expect(await writeSceneSnapshot(canvasTarget("scene"), { ...initial, cards: [] }).confirmed).toBe(false);
});
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
