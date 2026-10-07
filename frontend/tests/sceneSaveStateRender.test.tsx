// 저장이 안 될 때·옛 창과 엇갈렸을 때 화면이 무엇을 보여 주는가 — 실제 훅(useSceneCoordination)과 탭 줄로 본다.
// 저장소 함수만 따로 부르면 화면에 잇는 줄을 빠뜨려도 통과하므로, 훅을 띄워 탭 줄이 그리는 것을 본다(2026-10-07).
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBar } from "../src/components/scene/SceneBar";
import { resetRelinkSessionForTest } from "../src/lib/sceneAssetRelink";
import { listPersistedScenes, type Scene } from "../src/lib/scenes";
import {
  absorbLegacyScenes,
  failSceneStoreWritesForTest,
  initSceneStore,
  settleSceneStoreForTest,
} from "../src/lib/sceneStore";
import { useSceneCoordination } from "../src/lib/useSceneCoordination";

// 서버를 부르는 곁가지는 조용한 가짜로 — 이 시험은 저장 상태와 탭 목록만 본다.
vi.mock("../src/api", () => ({
  api: { locateAssets: async (tokens: string[]) => ({ fixed: [], unresolved: [], missing: [], local: [], open: tokens }) },
}));
vi.mock("../src/lib/sceneBackup", () => ({
  initSceneBackup: async () => false,
  countBackupOnlyScenes: async () => 0,
  importFromBackup: async () => 0,
  subscribeSceneRestore: () => () => {},
}));
vi.mock("../src/lib/sceneCardLinks", () => ({
  initSceneCardLinks: () => {},
  mergeCardLinksIntoScenes: () => null,
  serverCardLinks: () => [],
  subscribeCardLinksLoaded: () => () => {},
}));

const BUCKET = "local::_none"; // 로그인 없는 로컬 계정의 버킷
const mk = (id: string, name = id): Scene => ({ id, name, cards: [], edges: [], created_at: 1 });

let root: Root;
let host: HTMLDivElement;
let coordination: ReturnType<typeof useSceneCoordination> | null = null;
const flash = vi.fn();
const exported = vi.fn();

function Screen() {
  const c = useSceneCoordination(flash);
  coordination = c;
  return (
    <SceneBar
      scenes={c.scenes}
      activeId={c.activeSceneId}
      workspaceContext={{ scope: "personal", id: null, name: null }}
      onSelect={c.selectScene}
      onAdd={c.addScene}
      onRename={c.renameScene}
      onDelete={c.removeSceneById}
      onReorder={c.reorderScenes}
      onAssignWorkspace={c.setSceneWorkspace}
      saveFailing={c.sceneSaveFailing}
      onExportAll={exported}
    />
  );
}
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
const tabNames = () => Array.from(host.querySelectorAll(".scene-tab-name")).map((el) => el.textContent);
const unsavedChip = () => host.querySelector<HTMLButtonElement>(".scene-unsaved");
const flashed = () => flash.mock.calls.map(([message]) => String(message));

// 이관을 마친 상태(옛 저장소 = scenes)에서 화면을 띄운다.
async function open(...scenes: Scene[]) {
  let mark: Parameters<typeof initSceneStore>[1] = null;
  await initSceneStore(
    () => ({ [BUCKET]: scenes }),
    mark,
    (next) => {
      mark = next;
      return true;
    },
  );
  await act(async () => root.render(<Screen />));
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.clear();
  resetRelinkSessionForTest();
  flash.mockReset();
  exported.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  coordination = null;
  failSceneStoreWritesForTest(false);
  await settleSceneStoreForTest(); // '저장 실패 중' 상태가 다음 시험으로 넘어가지 않게
});

it("저장이 안 되는 동안 '저장 안 됨'이 계속 떠 있고, 편집은 화면에 남는다 — 풀리면 사라지고 저장된다", async () => {
  await open(mk("s1", "처음"));
  expect(unsavedChip()).toBeNull();

  failSceneStoreWritesForTest(true);
  await act(async () => coordination!.renameScene("s1", "막힌 동안 바꾼 이름"));
  await settle();
  expect(tabNames()).toEqual(["막힌 동안 바꾼 이름"]); // 화면을 되돌리지 않는다
  expect(listPersistedScenes(null).map((s) => s.name)).toEqual(["처음"]);
  expect(unsavedChip()).not.toBeNull();
  expect(flashed().some((message) => message.includes("저장하지 못하고"))).toBe(true);

  flash.mockReset(); // 다른 알림이 덮어도 표시는 남는다 — 알림과 따로다
  expect(unsavedChip()).not.toBeNull();
  await act(async () => unsavedChip()!.click());
  expect(exported).toHaveBeenCalledTimes(1); // 그 자리에서 파일로 건진다

  failSceneStoreWritesForTest(false);
  await act(async () => {
    await settleSceneStoreForTest();
  });
  await settle();
  expect(unsavedChip()).toBeNull();
  expect(listPersistedScenes(null).map((s) => s.name)).toEqual(["막힌 동안 바꾼 이름"]); // 잃지 않았다
  expect(flashed().some((message) => message.includes("다시 정상"))).toBe(true);
});

it("옛 창과 엇갈린 씬은 묻지 않고 새 탭으로 살리고 알린다", async () => {
  await open(mk("s1", "원래"), mk("s2"));
  await act(async () => coordination!.renameScene("s1", "이 창에서 고침"));
  await settle();

  // 옛 판 창이 같은 씬을 다르게 고쳐 옛 저장소에 썼다(sceneBoot 가 storage 이벤트로 받아 흡수한다).
  await act(async () => {
    await absorbLegacyScenes({ [BUCKET]: [mk("s1", "옛 창에서 고침"), mk("s2")] });
  });
  await settle();
  // 탭은 이름을 12자에서 자른다 — 표식이 앞에 있어 잘려도 어느 탭이 사본인지 보인다.
  expect(tabNames()).toEqual(["이 창에서 고침", "s2", "[옛 창] 옛 창에서 …"]);
  expect(coordination!.scenes.map((s) => s.name)).toEqual(["이 창에서 고침", "s2", "[옛 창] 옛 창에서 고침"]);
  expect(flashed().filter((message) => message.includes("새 탭"))).toHaveLength(1);
});

it("앱을 켤 때 이미 보관돼 있던 엇갈림도 새 탭으로 살린다", async () => {
  let mark: Parameters<typeof initSceneStore>[1] = null;
  const write = (next: NonNullable<typeof mark>) => {
    mark = next;
    return true;
  };
  await initSceneStore(() => ({ [BUCKET]: [mk("s1", "원래")] }), mark, write);
  // 이 창에서 고친 뒤 창을 닫았고, 그사이 옛 판 창이 같은 씬을 고쳤다 → 다음 실행의 재대조가 엇갈림을 보관한다.
  const { updateScene } = await import("../src/lib/scenes");
  updateScene(null, "s1", { name: "지난번에 이 창에서 고침" });
  await settleSceneStoreForTest();
  await initSceneStore(() => ({ [BUCKET]: [mk("s1", "옛 창에서 고침")] }), mark, write);

  await act(async () => root.render(<Screen />));
  await settle();
  expect(coordination!.scenes.map((s) => s.name)).toEqual(["지난번에 이 창에서 고침", "[옛 창] 옛 창에서 고침"]);
});
