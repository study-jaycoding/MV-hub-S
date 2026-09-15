// @vitest-environment jsdom
import { act, useCallback, useRef, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Scene, SceneCard } from "../src/lib/scenes";
import type { Generation } from "../src/types";
import type { SceneBoard } from "../src/components/scene/SceneBoard";
import { button, click, createRenderRoot, deferred, installPromptBoundaryMocks, installPromptStyles, required, settle } from "./seedanceRenderHarness";

// 실물: App → generateCards/submitGenJobs → sceneGenerationInputs/spotlightSubmit/
// executeSceneGenerationBatch, SpotlightPrompt의 setError/onErrorChange, App의 sl-error-float,
// usePromptDock(Ctrl+K), 캔버스 생성 연결/실패 표식 정리 함수.
// 가짜: SceneBoard의 조작 UI(아래 버튼만), 주변 화면, 로그인/정책/조회·제출 API,
// 씬 저장소와 라이브러리 목록 IO. App의 제출·오류 로직은 시험 안에 복사하지 않는다.
let view: ReturnType<typeof createRenderRoot>;
let boundary: ReturnType<typeof installPromptBoundaryMocks>;
let scene: Scene;
let style: HTMLStyleElement;
let sceneRun: Promise<void> | undefined;
const noop = () => {};
const reload = vi.fn(async () => {});

function fixtureScene(): Scene {
  const card = (id: string, extra: Partial<SceneCard>): SceneCard => ({ id, kind: "generation", x: 0, y: 0, ...extra });
  return {
    id: "seedance-errors", name: "Seedance 오류 시험", created_at: 0,
    cards: [
      card("edit", { prompt: "고칠 영상 누락" }),
      card("extension", { prompt: "이어붙일 영상 누락" }),
      card("valid", { prompt: "정상 텍스트 영상" }),
      ...["video_edit", "video_extension", "t2v"].map((mode, index) => card(`model-${index}`, {
        kind: "model", modelCfg: { model: "seedance_2_5", type: "video", params: { mode, duration: 5, aspect_ratio: "auto" } },
      })),
    ],
    edges: ["edit", "extension", "valid"].map((to, index) => ({ id: `edge-${index}`, from: `model-${index}`, to, role: "model" })),
  };
}

function installAppBoundaries() {
  // 주변 화면은 렌더 비용/관계없는 API만 제거. 아래 SceneBoard 버튼은 App이 전달한 실제 콜백을 호출한다.
  for (const [path, names] of [
    ["../src/components/TopBar", ["TopBar"]],
    ["../src/components/FilterSidebar", ["FilterSidebar"]],
    ["../src/components/sidebar/CanvasFolderSidebar", ["CanvasFolderSidebar"]],
    ["../src/components/LibraryToolbar", ["LibraryToolbar"]],
    ["../src/components/ThumbnailGrid", ["ThumbnailGrid"]],
    ["../src/components/scene/SceneBar", ["SceneBar"]],
    ["../src/components/app/AppOverlays", ["AppOverlays"]],
    ["../src/components/app/SelectionActionBar", ["BoardSelectionActionBar", "LibrarySelectionActionBar"]],
    ["../src/components/edit/PartialEditHost", ["PartialEditHost"]],
  ] as const) {
    vi.doMock(path, () => Object.fromEntries(names.map((name) => [name, () => null])));
  }
  vi.doMock("../src/components/scene/SceneBoard", () => ({
    SceneBoard: ({ onRenderCards }: Pick<ComponentProps<typeof SceneBoard>, "onRenderCards">) => (
      <button onClick={() => {
        if (!onRenderCards) throw new Error("App이 일괄 생성 콜백을 연결하지 않았습니다.");
        sceneRun = Promise.resolve(onRenderCards(["edit", "extension", "valid"], 2));
      }}>
        시험 씬 일괄 생성
      </button>
    ),
  }));
  vi.doMock("../src/lib/useHubAuth", () => ({
    useHubAuth: () => ({
      authPending: false, authReady: true, authConfig: { auth_enabled: true },
      account: { email: "fixture@example.invalid" }, hubAccount: null,
      finalizeProjects: new Set<string>(), sharedSrv: null, logout: noop, setAccount: noop,
    }),
  }));
  // WebSocket/백그라운드 폴링은 이 시험 대상이 아니다.
  for (const name of ["useGenerationProgress", "useGenerationAutoRefresh", "useCommentBadgePoll", "useSceneCompletionWatcher"]) {
    vi.doMock(`../src/lib/${name}`, () => ({ [name]: noop }));
  }
  vi.doMock("../src/lib/useWorkspaceFilterOptions", () => ({
    useWorkspaceFilterOptions: () => ({ options: [], loading: false, failed: false, reload: noop }),
  }));
  vi.doMock("../src/lib/scenes", async () => ({
    ...await vi.importActual<typeof import("../src/lib/scenes")>("../src/lib/scenes"),
    listScenes: () => [scene],
  }));
  vi.doMock("../src/lib/useSceneCoordination", () => ({
    useSceneCoordination: () => {
      const [, bump] = useState(0);
      const sceneActionRef = useRef(null);
      const patchSceneById = useCallback((_id: string, patch: Partial<Scene>) => {
        scene = { ...scene, ...patch };
        bump((value) => value + 1);
      }, []);
      return {
        scenes: [scene], activeSceneId: scene.id, activeScene: scene,
        sceneBinding: null, setSceneBinding: noop, sceneSelGens: [], setSceneSelGens: noop,
        sceneActionRef, flushScenePending: noop, patchSceneById, patchActiveScene: noop,
        selectScene: noop, addScene: noop, importSceneSnapshot: noop, renameScene: noop,
        removeSceneById: noop, reorderScenes: noop, setSceneWorkspace: noop,
        backupOnly: 0, importBackupScenes: noop,
      };
    },
  }));
  vi.doMock("../src/lib/useGenerationLibraryData", () => ({
    useGenerationLibraryData: () => {
      const [gens, setGens] = useState<Generation[]>([]);
      const [facets, setFacets] = useState({ tags: [], auto_tags: [], models: [] });
      const gensRef = useRef(gens);
      gensRef.current = gens;
      const filtersRef = useRef({ tab: "compose" });
      const projectsLoadedRef = useRef(true);
      return {
        gens, setGens, gensRef, facets, setFacets, filtersRef, projectsLoadedRef,
        projects: [], stats: { has_unread: false, failed_count: 0, unread_count: 0 },
        loading: false, loadingMore: false, hasMore: false, loadError: null,
        archivedCount: 0, unassignedCount: 0, loadMore: noop, beginComposeList: noop,
        reload, reloadIfStale: reload,
      };
    },
  }));
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem("ch.lib.filtersV2", JSON.stringify({ tab: "compose", __v: "2" }));
  localStorage.setItem("ch.workspaceContext", JSON.stringify({ scope: "personal", id: null, name: null }));
  boundary = installPromptBoundaryMocks();
  scene = fixtureScene();
  sceneRun = undefined;
  reload.mockClear();
  installAppBoundaries();
  style = installPromptStyles();
  view = createRenderRoot();
});

afterEach(() => {
  view?.dispose();
  style?.remove();
  vi.unstubAllGlobals();
  expect(boundary.fetch).not.toHaveBeenCalled();
});

describe("App: 프롬프트 숨김 상태에서 씬의 부분 성공과 카드별 오류", () => {
  it("실제 Ctrl+K로 숨긴 뒤 오류 두 줄을 띄우고 유효 카드의 배치 두 건만 제출한다", async () => {
    // 유효 카드의 응답은 붙잡아 둔다. 느린 성공 응답을 기다리지 않고 오류가 표시되는지도 확인한다.
    const submitted = deferred<void>();
    const submit = vi.fn(async (id: string) => {
      await submitted.promise;
      return { id, prompt: "정상 텍스트 영상", model: "seedance_2_5", status: "pending", assets: [], tags: [] } as unknown as Generation;
    });
    boundary.api.prepareCreate.mockImplementation((_body, _workspace, link) => () => submit(link!.generation_id));
    const { default: App } = await import("../src/App");
    act(() => view.root.render(<App />));
    await settle();
    expect(view.container.querySelector(".sl-hidden")).toBeNull();
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true, cancelable: true })); });
    await settle();
    const panel = required(view.container, ".sl-dockbar.sl-hidden .sl-panel");
    expect(getComputedStyle(panel).display).toBe("none");
    expect(view.container.querySelector(".sl-error-float")).toBeNull();

    click(button(view.container, "시험 씬 일괄 생성"));
    await settle();
    expect(boundary.api.prepareCreate).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);
    for (const [body, , link] of boundary.api.prepareCreate.mock.calls) {
      expect(link?.card_id).toBe("valid");
      expect(body.params).toMatchObject({ mode: "t2v", duration: 5, aspect_ratio: "1:1" });
      expect(body.prompt).toBe("정상 텍스트 영상");
    }
    const errors = [
      "생성 카드 1: 고칠 영상을 1개 넣어 주세요 — 영상 고치기 모드는 영상 레퍼런스가 정확히 1개 필요합니다.",
      "생성 카드 2: 이어붙일 영상을 넣어 주세요.",
    ];
    const floating = required(view.container, ".sl-error-float");
    expect(floating.textContent?.split("\n").sort()).toEqual([...errors].sort());
    expect(getComputedStyle(floating).whiteSpace).toBe("pre-line");
    expect(floating.closest(".sl-hidden")).toBeNull();
    expect(required(view.container, ".sl-error").textContent).toBe(floating.textContent);

    // 마지막에 성공 응답을 돌려줘도 오류 이유가 지워지지 않고 정상 카드에만 결과가 붙는다.
    expect(sceneRun).toBeDefined();
    await act(async () => { submitted.resolve(); await sceneRun; });
    await settle();
    expect(required(view.container, ".sl-error-float").textContent?.split("\n").sort()).toEqual([...errors].sort());
    expect(scene.cards.find((card) => card.id === "valid")?.genIds).toHaveLength(2);
    for (const id of ["edit", "extension"]) {
      const card = scene.cards.find((item) => item.id === id)!;
      expect(card.genIds || []).toHaveLength(0);
      expect(card.pendingGenerationAttempts || []).toHaveLength(0);
    }
  });
});
