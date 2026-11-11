// 카메라만 기록하는 쓰기가 화면의 활성 씬 카드 배열을 갈아 끼우지 않는다 — 실제 훅으로(2026-11-10 R6,
// docs/status/캔버스_카메라저장뒤처리_2026-11-10.md). 판(SceneBoard)은 scene.cards 가 새 배열이면 카드 전부를 다시 그린다.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasTarget, createCanvasDocumentPort } from "../src/features/canvas/api";
import { listPersistedScenes, saveScenes, updateScene, updateSceneCamera, type Scene, type SceneCard } from "../src/lib/scenes";
import { setSceneWriteGate, settleSceneStoreForTest } from "../src/lib/sceneStore";
import { useSceneCoordination } from "../src/lib/useSceneCoordination";

vi.mock("../src/api", () => ({
  api: { locateAssets: async (tokens: string[]) => ({ fixed: [], unresolved: [], missing: [], local: [], open: tokens }) },
}));
const EMPTY_SKIPPED = vi.hoisted(() => new Set<string>());
vi.mock("../src/lib/sceneBackup", () => ({
  initSceneBackup: async () => false,
  countBackupOnlyScenes: async () => 0,
  importFromBackup: async () => 0,
  subscribeSceneRestore: () => () => {},
  subscribeSceneBackupSkipped: () => () => {},
  subscribeSceneBackupSkippedIds: () => () => {},
  getSceneBackupSkippedIds: () => EMPTY_SKIPPED,
  subscribeSceneBackupForked: () => () => {},
}));
// 카메라 전용 경로가 쓰기 뒤 목록(읽기 사본)을 만들지 않는지 세려고 읽기 함수만 감싼다(나머지는 진짜)
const readSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/lib/sceneStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/sceneStore")>();
  return { ...real, readWorkingBucket: (key: string) => { readSpy.calls++; return real.readWorkingBucket(key); } };
});
vi.mock("../src/lib/sceneCardLinks", () => ({
  initSceneCardLinks: () => {},
  mergeCardLinksIntoScenes: () => null,
  serverCardLinks: () => [],
  subscribeCardLinksLoaded: () => () => {},
}));

const card = (id: string) => ({ id, kind: "text", x: 0, y: 0, text: id }) as unknown as SceneCard;
const scene = (id: string): Scene => ({ id, name: id, cards: [card(`${id}-a`), card(`${id}-b`)], edges: [], created_at: 1 }) as Scene;

let root: Root;
let host: HTMLDivElement;
let coordination: ReturnType<typeof useSceneCoordination> | null = null;
function Coordination() {
  coordination = useSceneCoordination();
  return null;
}
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
const shown = (id: string) => coordination!.scenes.find((s) => s.id === id)!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  coordination = null;
});

describe("카메라만 기록하는 쓰기(R6)", () => {
  it("두 번 써도 활성 씬의 카드·연결 배열은 그대로이고 카메라만 새 값 — 저장본에도 카메라", async () => {
    saveScenes(null, [scene("s1"), scene("s2")]);
    await act(async () => root.render(<Coordination />));
    await settle();
    await act(async () => coordination!.selectScene("s1"));
    const target = canvasTarget("s1");
    // 첫 쓰기 뒤 저장소의 씬 객체가 바뀌어, 다음 읽기 사본은 새 배열이다 — 옛 길은 두 번째 쓰기에서 화면 배열을 갈아 끼웠다
    await act(async () => void coordination!.canvasDocument.commit(target, { type: "recordCamera", camera: { z: 1, x: 10, y: 20 } }));
    await settle();
    const before = shown("s1");
    await act(async () => void coordination!.canvasDocument.commit(target, { type: "recordCamera", camera: { z: 2, x: 30, y: 40 } }));
    await settle();
    const after = shown("s1");
    expect(after.cards).toBe(before.cards);
    expect(after.edges).toBe(before.edges);
    expect(after.camera).toEqual({ z: 2, x: 30, y: 40 });
    expect(listPersistedScenes(null).find((s) => s.id === "s1")?.camera).toEqual({ z: 2, x: 30, y: 40 });
    expect(listPersistedScenes(null).find((s) => s.id === "s1")?.cards.map((c) => c.id)).toEqual(["s1-a", "s1-b"]);
  });

  it("활성 아닌 씬의 카메라 쓰기는 그 씬에 카메라가 남고 활성 씬은 그대로", async () => {
    saveScenes(null, [scene("s1"), scene("s2")]);
    await act(async () => root.render(<Coordination />));
    await settle();
    await act(async () => coordination!.selectScene("s1"));
    const active = shown("s1");
    await act(async () => void coordination!.canvasDocument.commit(canvasTarget("s2"), { type: "recordCamera", camera: { z: 3, x: 1, y: 2 } }));
    await settle();
    expect(shown("s1")).toBe(active);
    expect(shown("s2").camera).toEqual({ z: 3, x: 1, y: 2 });
    expect(listPersistedScenes(null).find((s) => s.id === "s2")?.camera).toEqual({ z: 3, x: 1, y: 2 });
  });

  it("카메라 전용 경로 — 두 번째 입력 확정·전체 읽기 없이: 같은 값이면 쓰기 없이 접수, 없는 씬은 거절, 미설정 카메라는 쓴다, 계정이 바뀐 대상은 읽지도 않는다", () => {
    const flushPending = vi.fn();
    const write = vi.fn(() => true);
    let now: { exists: boolean; camera?: { z: number; x: number; y: number } } = { exists: true, camera: { z: 1, x: 2, y: 3 } };
    const readCamera = vi.fn(() => now);
    const port = createCanvasDocumentPort({ flushPending, write, readCamera });
    expect(port.commit(canvasTarget("s1"), { type: "recordCamera", camera: { z: 1, x: 2, y: 3 } }).queued).toBe(true);
    expect(write).not.toHaveBeenCalled();
    now = { exists: false };
    expect(port.commit(canvasTarget("s1"), { type: "recordCamera", camera: { z: 1, x: 2, y: 3 } }).queued).toBe(false);
    now = { exists: true }; // 카메라 미설정
    expect(port.commit(canvasTarget("s1"), { type: "recordCamera", camera: { z: 2, x: 0, y: 0 } }).queued).toBe(true);
    expect(write).toHaveBeenCalledWith("s1", { camera: { z: 2, x: 0, y: 0 } });
    expect(flushPending).not.toHaveBeenCalled(); // 보드가 앞에서 확정했다 — 카메라 커밋은 다시 확정하지 않는다
    readCamera.mockClear();
    const otherAccount = Object.freeze({ accountNamespace: "acct:someone-else", sceneId: "s1" });
    expect(port.commit(otherAccount, { type: "recordCamera", camera: { z: 3, x: 0, y: 0 } }).queued).toBe(false);
    expect(readCamera).not.toHaveBeenCalled();
  });

  it("조율 경로 — 카메라 기록은 쓰기 뒤 목록(읽기 사본)을 만들지 않고, 접수되면 그 씬 카메라만 바꾼다(활성·비활성 씬 카드 참조 그대로)", async () => {
    saveScenes(null, [scene("s1"), scene("s2")]);
    await act(async () => root.render(<Coordination />));
    await settle();
    await act(async () => coordination!.selectScene("s1"));
    const s1 = shown("s1"), s2 = shown("s2");
    await act(async () => {
      readSpy.calls = 0;
      expect(coordination!.canvasDocument.commit(canvasTarget("s2"), { type: "recordCamera", camera: { z: 2, x: 5, y: 6 } }).queued).toBe(true);
      expect(readSpy.calls).toBe(0);
    });
    await settle();
    expect(shown("s2").camera).toEqual({ z: 2, x: 5, y: 6 });
    expect(shown("s2").cards).toBe(s2.cards);
    expect(shown("s1")).toBe(s1);
    expect(listPersistedScenes(null).find((s) => s.id === "s2")?.camera).toEqual({ z: 2, x: 5, y: 6 });
  });

  it("창 쓰기 권한이 막혀 거절되면 화면 목록의 카메라를 저장된 것처럼 바꾸지 않는다", async () => {
    saveScenes(null, [scene("s1")]);
    await act(async () => root.render(<Coordination />));
    await settle();
    await act(async () => coordination!.selectScene("s1"));
    setSceneWriteGate(() => true);
    try {
      await act(async () => {
        expect(coordination!.canvasDocument.commit(canvasTarget("s1"), { type: "recordCamera", camera: { z: 3, x: 1, y: 1 } }).queued).toBe(false);
      });
      await settle();
      expect(shown("s1").camera).toBeUndefined();
    } finally {
      setSceneWriteGate(() => false);
    }
  });

  it("내용·카메라 패치가 저장 전에 번갈아 와도(카메라는 따로 슬롯 — 별도 연산으로 순서대로 재생) 세 필드가 다 남는다", async () => {
    saveScenes(null, [scene("s1")]);
    updateScene(null, "s1", { name: "renamed" });
    updateSceneCamera(null, "s1", { z: 4, x: 1, y: 2 });
    updateScene(null, "s1", { cards: [card("s1-x")] });
    await settleSceneStoreForTest();
    const saved = listPersistedScenes(null).find((s) => s.id === "s1")!;
    expect([saved.name, saved.camera, saved.cards.map((c) => c.id)]).toEqual(["renamed", { z: 4, x: 1, y: 2 }, ["s1-x"]]);
    expect(updateSceneCamera(null, "gone", { z: 1, x: 0, y: 0 })).toEqual({ ok: false, reason: "missing" }); // 지운·없는 씬을 되살리지 않는다
  });

  it("지금 씬과 같은 카메라는 카메라 패치를 쓰지 않고 접수로 끝낸다 — 외부에서 다른 카메라를 받은 뒤 옛 값으로 돌아오면 쓴다", () => {
    saveScenes(null, [{ ...scene("s1"), camera: { z: 1, x: 5, y: 6 } }]);
    const write = vi.fn((id: string, patch: Partial<Scene>) => updateScene(null, id, patch).ok);
    const port = createCanvasDocumentPort({ flushPending: () => {}, write });
    expect(port.commit(canvasTarget("s1"), { type: "recordCamera", camera: { z: 1, x: 5, y: 6 } }).queued).toBe(true);
    expect(write).not.toHaveBeenCalled(); // 같은 값 — 쓰기 0
    updateScene(null, "s1", { camera: { z: 2, x: 0, y: 0 } }); // 다른 브라우저의 카메라를 공책으로 받음(C2)
    expect(port.commit(canvasTarget("s1"), { type: "recordCamera", camera: { z: 1, x: 5, y: 6 } }).queued).toBe(true); // 내 C1 으로
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][1]).toEqual({ camera: { z: 1, x: 5, y: 6 } });
  });

  it("recordCamera 패치는 camera 하나, 다른 명령의 패치에는 cards 가 그대로 든다", () => {
    saveScenes(null, [scene("s1")]);
    const write = vi.fn((id: string, patch: Partial<Scene>) => updateScene(null, id, patch).ok);
    const port = createCanvasDocumentPort({ flushPending: () => {}, write });
    expect(port.commit(canvasTarget("s1"), { type: "recordCamera", camera: { z: 1, x: 0, y: 0 } }).queued).toBe(true);
    expect(Object.keys(write.mock.calls[0][1])).toEqual(["camera"]);
    expect(port.commit(canvasTarget("s1"), { type: "appendTaskCards", cards: [card("s1-c")], receiptId: "r1" }).queued).toBe(true);
    expect(write.mock.calls[1][1].cards?.map((c) => c.id)).toEqual(["s1-a", "s1-b", "s1-c"]);
    expect(write.mock.calls[1][1]).toHaveProperty("edges");
  });
});
