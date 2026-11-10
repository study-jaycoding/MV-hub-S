// 카메라만 기록하는 쓰기가 화면의 활성 씬 카드 배열을 갈아 끼우지 않는다 — 실제 훅으로(2026-11-10 R6,
// docs/status/캔버스_카메라저장뒤처리_2026-11-10.md). 판(SceneBoard)은 scene.cards 가 새 배열이면 카드 전부를 다시 그린다.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasTarget, createCanvasDocumentPort } from "../src/features/canvas/api";
import { listPersistedScenes, saveScenes, updateScene, type Scene, type SceneCard } from "../src/lib/scenes";
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
