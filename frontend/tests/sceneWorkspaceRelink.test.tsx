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
  subscribeSceneBackupSkipped: () => () => {},
  subscribeSceneBackupForked: () => () => {},
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
let renders: string[] = []; // 렌더마다의 '활성 씬:프롬프트에 묶인 카드'
function Coordination() {
  coordination = useSceneCoordination();
  renders.push(`${coordination.activeSceneId}:${coordination.sceneBinding?.cardId ?? "-"}`);
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

// 2026-10-11 Codex 코드 리뷰: 씬을 바꾼 직후(보드가 선택 해제를 그리기 전)의 도크는 '새 씬 + 떠난 씬의 카드 id' 로 묶여 있었다 —
//  두 씬에 같은 id 의 카드가 있으면(가져온 씬) 그 틈의 프롬프트 입력·생성이 새 씬의 카드로 갔다.
describe("씬 전환과 프롬프트에 묶인 카드", () => {
  it("묶임은 그 카드의 씬이 활성일 때만 있다 — '새 씬 + 떠난 씬의 카드'로 묶인 렌더가 없고, 곧바로 돌아오면 묶임이 그대로다", async () => {
    saveScenes(null, [sceneWith("s1", A), sceneWith("s2", B)]);
    await act(async () => root.render(<Coordination />));
    await settle();
    await act(async () => coordination!.selectScene("s1"));
    await act(async () => coordination!.setSceneBinding({ sceneId: "s1", cardId: "c-s1", refs: [] })); // 보드가 알린 묶임(생성 카드 한 장 선택)
    expect(coordination!.sceneBinding?.cardId).toBe("c-s1");
    await act(async () => coordination!.selectScene("s1")); // 같은 탭을 다시 누름
    expect(coordination!.sceneBinding?.cardId).toBe("c-s1");

    renders = [];
    await act(async () => coordination!.selectScene("s2"));
    expect(renders).not.toContain("s2:c-s1"); // 보드가 선택 해제를 알리기 전에도
    expect(renders.at(-1)).toBe("s2:-");

    // 곧바로 돌아온다 — 보드의 선택은 그대로다(보드는 같은 카드를 다시 알리지 않는다). 묶임도 그대로여야 한다
    await act(async () => coordination!.selectScene("s1"));
    expect(coordination!.sceneBinding?.cardId).toBe("c-s1");
    // 한 갱신 안의 왕복(탭 연타가 한 번에 그려질 때)
    await act(async () => { coordination!.selectScene("s2"); coordination!.selectScene("s1"); });
    expect(coordination!.sceneBinding?.cardId).toBe("c-s1");
  });
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

  it("다른 탭이 지운 씬·같은 공간 다시 고름이면 묻지 않는다(Codex 코드 리뷰)", async () => {
    saveScenes(null, [{ ...sceneWith("s1", A), workspace: { id: "W0", name: "W0" } } as Scene]);
    await act(async () => root.render(<Coordination />));
    await settle();
    expect(locate).toHaveBeenCalledTimes(1);
    await act(async () => coordination!.setSceneWorkspace("gone", { id: "W1", name: "W1" }));
    await act(async () => coordination!.setSceneWorkspace("s1", { id: "W0", name: "다시 고름" }));
    await settle();
    expect(locate).toHaveBeenCalledTimes(1);
  });

  // 쓰기는 화면 값에 먼저 반영되고 저장소 확정은 뒤따른다 — 확정이 실패해도 화면은 새 공간(W1)을 보여 주므로
  // 레퍼런스도 그 공간으로 물어야 한다(안 물으면 화면의 공간과 표시가 어긋난다). 확정은 저장소가 다시 시도한다.
  it("저장소 확정이 실패해도 화면에 반영된 새 공간으로 묻는다", async () => {
    saveScenes(null, [{ ...sceneWith("s1", A), workspace: { id: "W0", name: "W0" } } as Scene]);
    await act(async () => root.render(<Coordination />));
    await settle();
    expect(locate).toHaveBeenCalledTimes(1);

    failSceneStoreWritesForTest(true); // 저장소 확정만 실패(씬은 IndexedDB 라 localStorage 가로채기로는 못 만든다)
    try {
      await act(async () => coordination!.setSceneWorkspace("s1", { id: "W1", name: "W1" }));
      await settle();
    } finally {
      failSceneStoreWritesForTest(false);
    }
    expect(coordination!.scenes[0].workspace?.id).toBe("W1");
    expect(locate.mock.calls[1]).toEqual([[A], "W1"]);
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
