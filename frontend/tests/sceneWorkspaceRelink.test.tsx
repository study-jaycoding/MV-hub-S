// 워크스페이스를 바꾸면 레퍼런스를 다시 묻는다 — 실제 훅으로(2026-10-01 점검 R2-2).
// 도우미 함수만 직접 부르면 훅이 부르는 것을 빠뜨려도 통과하므로 useSceneCoordination 을 띄워 setSceneWorkspace 를 누른다.
// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRelinkSessionForTest } from "../src/lib/sceneAssetRelink";
import { saveScenes, type Scene } from "../src/lib/scenes";
import { failSceneStoreWritesForTest } from "../src/lib/sceneStore";
import { STORAGE_KEYS } from "../src/lib/storageKeys";
import { useRelinkOnWorkspaceChange, useSceneCoordination } from "../src/lib/useSceneCoordination";

const locate = vi.fn();
vi.mock("../src/api", () => ({
  api: { locateAssets: (tokens: string[], ws?: string) => locate(tokens, ws) },
}));
// 씬 백업·카드 소속은 서버를 부르니 조용한 가짜로 — 이 시험은 자동 복구가 무엇을 묻는지만 본다
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

const A = "asset:P|CH/a.png";
const B = "asset:P|CH/b.png";
const sceneWith = (id: string, token: string): Scene =>
  ({ id, name: id, edges: [], cards: [{ id: `c-${id}`, kind: "reference", x: 0, y: 0, refs: [{ type: "image", file_path: token }] }] }) as unknown as Scene;

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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  resetRelinkSessionForTest();
  locate.mockReset();
  locate.mockImplementation(async (tokens: string[]) => ({ fixed: [], unresolved: [], missing: [], local: [], open: tokens }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  coordination = null;
});

describe("탭 워크스페이스 지정·해제", () => {
  it("그 씬만 새 공간으로 다시 묻는다 — 세션 안에서 이미 물은 공간으로 되돌려도", async () => {
    saveScenes(null, [sceneWith("s1", A), sceneWith("s2", B)]);
    await act(async () => root.render(<Coordination />));
    await settle();
    expect(locate.mock.calls).toEqual([[[A, B], ""]]); // 앱 시작 복구

    await act(async () => coordination!.setSceneWorkspace("s1", { id: "W1", name: "W1" }));
    await settle();
    expect(locate.mock.calls[1]).toEqual([[A], "W1"]);

    await act(async () => coordination!.setSceneWorkspace("s1", null)); // 되돌림 — 예전엔 '확인 중'에 멈췄다
    await settle();
    expect(locate.mock.calls[2]).toEqual([[A], ""]);
    expect(locate).toHaveBeenCalledTimes(3); // 다른 씬(s2)은 다시 묻지 않는다
  });

  it("다른 탭이 지운 씬·같은 공간 다시 고름·저장 실패면 묻지 않는다(Codex 코드 리뷰)", async () => {
    saveScenes(null, [{ ...sceneWith("s1", A), workspace: { id: "W0", name: "W0" } } as Scene]);
    await act(async () => root.render(<Coordination />));
    await settle();
    expect(locate).toHaveBeenCalledTimes(1);
    await act(async () => coordination!.setSceneWorkspace("gone", { id: "W1", name: "W1" }));
    await act(async () => coordination!.setSceneWorkspace("s1", { id: "W0", name: "다시 고름" }));
    await settle();
    expect(locate).toHaveBeenCalledTimes(1);

    failSceneStoreWritesForTest(true); // 씬 저장만 실패(씬은 IndexedDB 라 localStorage 가로채기로는 못 만든다)
    const quota = { mockRestore: () => failSceneStoreWritesForTest(false) };
    await act(async () => coordination!.setSceneWorkspace("s1", { id: "W1", name: "W1" })); // 저장 실패 — 옛 값 W0 그대로
    await settle();
    quota.mockRestore();
    expect(locate).toHaveBeenCalledTimes(1);
  });
});

describe("씬 파일의 공간 힌트", () => {
  it("힌트와 같은 공간을 지정·해제해도 판정 열쇠가 그대로면 묻지 않고, 다른 공간이면 묻는다(Codex 코드 재리뷰)", async () => {
    saveScenes(null, [{ ...sceneWith("s1", A), refWorkspaceHint: { id: "W0", name: "W0" } } as Scene]);
    await act(async () => root.render(<Coordination />));
    await settle();
    expect(locate.mock.calls).toEqual([[[A], "W0"]]);
    await act(async () => coordination!.setSceneWorkspace("s1", { id: "W0", name: "W0" }));
    await act(async () => coordination!.setSceneWorkspace("s1", null));
    await settle();
    expect(locate).toHaveBeenCalledTimes(1);
    await act(async () => coordination!.setSceneWorkspace("s1", { id: "W1", name: "W1" }));
    await settle();
    expect(locate.mock.calls[1]).toEqual([[A], "W1"]);
  });
});

describe("위에서 고른 워크스페이스가 바뀌면 한 번 다시 묻는다", () => {
  const relink = vi.fn();
  function Follow({ workspace }: { workspace: string }) {
    useRelinkOnWorkspaceChange(workspace, relink);
    return null;
  }
  beforeEach(() => relink.mockReset());

  it("첫 mount·같은 공간은 건너뛰고, 바뀔 때마다 한 번", async () => {
    await act(async () => root.render(<Follow workspace="team:W0" />));
    await act(async () => root.render(<Follow workspace="team:W0" />)); // 이름만 보완돼 다시 그려짐
    expect(relink).not.toHaveBeenCalled();
    await act(async () => root.render(<Follow workspace="team:W1" />));
    await act(async () => root.render(<Follow workspace="personal:" />));
    expect(relink).toHaveBeenCalledTimes(2);
  });

  it("StrictMode 의 효과 재실행에도 첫 mount 에 부르지 않는다", async () => {
    await act(async () => root.render(<StrictMode><Follow workspace="team:W0" /></StrictMode>));
    expect(relink).not.toHaveBeenCalled();
    await act(async () => root.render(<StrictMode><Follow workspace="team:W1" /></StrictMode>));
    expect(relink).toHaveBeenCalledTimes(1);
  });
});
