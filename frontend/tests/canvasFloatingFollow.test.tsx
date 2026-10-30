// 캔버스가 다른 창에 떠 있는 동안(useSceneCoordination 의 followStore) 메인 창의 씬 — 활성 씬도 저장본을 따르고 알리지 않는다.
// 떠 있던 창이 닫히면 그 창이 마지막으로 연 씬으로 돌아온다(2026-10-30, docs/status/캔버스_떠있는창_2026-10-30.md).
// 다른 창의 저장은 sceneStore 의 시험 도우미로 흉내 낸다(sceneSaveStateRender 와 같은 준비).
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetRelinkSessionForTest } from "../src/lib/sceneAssetRelink";
import { setActiveSceneId, type Scene } from "../src/lib/scenes";
import {
  initSceneStore,
  refreshSceneStoreForTest,
  settleSceneStoreForTest,
  writeSceneStoreAsOtherWindowForTest,
} from "../src/lib/sceneStore";
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
// 카드 소속 합치기·레퍼런스 복구가 떠 있는 동안 씬을 쓰지 않는지 본다(2026-10-30 두 창 함께 쓰기 ①) — 듣는 함수를 붙잡고 쓰기 함수를 센다
const background = vi.hoisted(() => ({
  cardLinksLoaded: null as null | (() => void),
  restoreCardLinks: vi.fn(() => false),
  relink: vi.fn(async () => 0),
  sync: vi.fn(async () => {}),
}));
vi.mock("../src/lib/sceneCardLinks", () => ({
  initSceneCardLinks: () => {},
  mergeCardLinksIntoScenes: () => null,
  serverCardLinks: () => [],
  subscribeCardLinksLoaded: (listener: () => void) => {
    background.cardLinksLoaded = listener;
    return () => {};
  },
}));
vi.mock("../src/features/canvas/api", async (original) => ({
  ...await original<typeof import("../src/features/canvas/api")>(),
  restoreCanvasCardLinks: background.restoreCardLinks,
}));
vi.mock("../src/lib/sceneAssetRelink", async (original) => ({
  ...await original<typeof import("../src/lib/sceneAssetRelink")>(),
  relinkSceneAssetRefs: background.relink,
  syncSceneAssetReferences: background.sync,
}));

const BUCKET = "local::_none";
const mk = (id: string, name = id): Scene => ({ id, name, cards: [], edges: [], created_at: 1 });

let root: Root;
let host: HTMLDivElement;
let coordination: ReturnType<typeof useSceneCoordination> | null = null;
const flash = vi.fn();

function Screen({ follow }: { follow: boolean }) {
  coordination = useSceneCoordination(flash, follow);
  return null;
}
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
const changedNotices = () => flash.mock.calls.map(([message]) => String(message)).filter((m) => m.includes("다른 탭에서 이 씬이 변경"));

async function open(...scenes: Scene[]) {
  let mark: Parameters<typeof initSceneStore>[1] = null;
  await initSceneStore(() => ({ [BUCKET]: scenes }), mark, (next) => {
    mark = next;
    return true;
  });
  await act(async () => root.render(<Screen follow={false} />));
  await settle();
  await act(async () => coordination!.selectScene("s1"));
}
const follow = (on: boolean) => act(async () => root.render(<Screen follow={on} />));
// 떠 있는 캔버스 창이 씬을 고쳐 저장했다 — 이 창은 BroadcastChannel 알림을 받아 저장소를 다시 읽는다
async function renameInOtherWindow(id: string, name: string) {
  writeSceneStoreAsOtherWindowForTest((all) => {
    all[BUCKET] = all[BUCKET].map((scene) => (scene.id === id ? { ...scene, name } : scene));
  });
  await act(async () => {
    await refreshSceneStoreForTest();
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.clear();
  resetRelinkSessionForTest();
  flash.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  coordination = null;
  await settleSceneStoreForTest();
});

it("따르기가 아니면 지금처럼 — 다른 창이 고친 활성 씬은 내 것을 지키고 알린다", async () => {
  await open(mk("s1", "처음"), mk("s2"));
  await renameInOtherWindow("s1", "다른 창에서 고침");
  expect(coordination!.activeScene?.name).toBe("처음");
  expect(changedNotices()).toHaveLength(1);
});

it("캔버스가 떠 있는 동안은 다른 창이 고친 활성 씬을 그대로 받고 알리지 않는다", async () => {
  await open(mk("s1", "처음"), mk("s2"));
  await follow(true);
  await renameInOtherWindow("s1", "떠 있는 창에서 고침");
  expect(coordination!.activeScene?.name).toBe("떠 있는 창에서 고침");
  expect(changedNotices()).toHaveLength(0);
});

it("떠 있던 창이 닫히면 그 창이 마지막으로 연 씬과 저장본으로 돌아온다", async () => {
  await open(mk("s1", "처음"), mk("s2", "둘째"));
  await follow(true);
  setActiveSceneId(null, "s2"); // 떠 있는 창에서 씬 2 를 골랐다('마지막 연 씬')
  await renameInOtherWindow("s2", "떠 있는 창에서 고친 둘째");
  expect(coordination!.activeSceneId).toBe("s1"); // 떠 있는 동안은 옮기지 않는다
  await follow(false);
  await settle();
  expect(coordination!.activeSceneId).toBe("s2");
  expect(coordination!.activeScene?.name).toBe("떠 있는 창에서 고친 둘째");
  await renameInOtherWindow("s2", "돌아온 뒤 다른 창이 또 고침"); // 돌아온 뒤에는 다시 내 활성 씬을 지킨다
  expect(coordination!.activeScene?.name).toBe("떠 있는 창에서 고친 둘째");
});

it("떠 있는 동안 레퍼런스 복구·카드 소속 합치기가 씬을 쓰지 않는다 — 돌아오면 다시 한다(두 창 함께 쓰기 ①)", async () => {
  let mark: Parameters<typeof initSceneStore>[1] = null;
  await initSceneStore(() => ({ [BUCKET]: [mk("s1")] }), mark, (next) => { mark = next; return true; });
  background.relink.mockClear();
  background.sync.mockClear();
  background.restoreCardLinks.mockClear();
  await act(async () => root.render(<Screen follow={true} />)); // 캔버스가 떠 있는 채로 메인 창을 켰다(새로 고침)
  await settle();
  expect(background.relink).not.toHaveBeenCalled(); // 앱 시작 복구
  expect(background.sync).not.toHaveBeenCalled(); // 5초 주기의 첫 회
  act(() => background.cardLinksLoaded?.());
  expect(background.restoreCardLinks).not.toHaveBeenCalled();

  await follow(false); // 캔버스 창을 닫았다
  act(() => background.cardLinksLoaded?.());
  expect(background.restoreCardLinks).toHaveBeenCalled();
  await act(async () => { await coordination!.relinkSceneRefsNow(); });
  expect(background.relink).toHaveBeenCalled();
});
