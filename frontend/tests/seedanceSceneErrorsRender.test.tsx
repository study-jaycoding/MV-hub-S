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
// 씬 저장이 실패하는 상황(저장소 꽉 참)을 흉내 낸다 — App 의 생성 준비 가드가 실제로 막는지 본다.
let sceneSaveFails = false;
// 화면 값에는 들어갔는데 저장소 확정이 실패하는 상황(쓰기는 두 박자다 — 화면 먼저, 확정은 뒤따른다).
let sceneConfirmFails = false;
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
    // 이 시험의 씬 저장소는 가짜다 — 확정본은 화면 값과 같고, 확정 실패는 sceneConfirmFails 로 만든다.
    listPersistedScenes: () => (sceneConfirmFails ? [fixtureScene()] : [scene]),
    confirmSceneWrite: <T,>(run: () => T) => ({ value: run(), confirmed: Promise.resolve(!sceneConfirmFails) }),
  }));
  vi.doMock("../src/lib/useSceneCoordination", () => ({
    useRelinkOnWorkspaceChange: noop,
    useSceneCoordination: () => {
      const [, bump] = useState(0);
      const sceneActionRef = useRef(null);
      // 반환 = 저장됐나. 실제 구현과 같은 계약이어야 한다 — 호출부(생성 준비)가 이 값을 보고 제출을
      // 멈추므로, undefined 를 돌려주면 "저장 실패" 로 읽혀 요청이 아예 안 나간다.
      const patchSceneById = useCallback((_id: string, patch: Partial<Scene>) => {
        if (sceneSaveFails) return false; // 저장소가 거부 — 편집이 남지 않았다
        scene = { ...scene, ...patch };
        bump((value) => value + 1);
        return true;
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
  sceneSaveFails = false;
  sceneConfirmFails = false;
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
  // 시간 제한 20초 — App 전체를 StrictMode 로 렌더하는 첫 마운트라 단독 1.4~1.8초인데, 전체 실행(파일 병렬·jsdom 기동 경합)에서는 기본 5초를 넘는다.
  // 2026-09-20 실측: 시험 파일이 하나 늘 때마다 넘었고 단독으로는 3/3 통과. 이 시험에만 올린다(전역 제한은 그대로 — 다른 시험의 무한 대기를 가리지 않게).
  it("실제 Ctrl+K로 숨긴 뒤 오류 두 줄을 띄우고 유효 카드의 배치 두 건만 제출한다", { timeout: 20_000 }, async () => {
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

  // 저장소가 꽉 차서 '어느 카드 것인지' 표식을 못 남기면, 생성 요청을 아예 보내지 않아야 한다.
  // 보내 버리면 응답 전에 창이 닫혔을 때 결과를 카드에 이어 붙일 근거가 없다(적대 리뷰 r2 P1).
  // ★여기서 실제로 도는 것은 App 의 prepareCanvasGenerationBatch 가드다 — 그 한 줄을 지우면 이 시험이 깨진다.
  it("씬 저장이 실패하면 생성 요청을 아예 보내지 않는다", { timeout: 20_000 }, async () => {
    sceneSaveFails = true;
    const { default: App } = await import("../src/App");
    act(() => view.root.render(<App />));
    await settle();

    click(button(view.container, "시험 씬 일괄 생성"));
    await settle();

    expect(boundary.api.prepareCreate).not.toHaveBeenCalled();
    // 반쯤 쓰다 만 표식도 남지 않아야 한다 — 남으면 '생성 중'으로 보이는 유령 카드가 된다.
    for (const card of scene.cards) expect(card.pendingGenerationAttempts || []).toHaveLength(0);
  });

  // 표식이 화면 값에만 들어가고 저장소 확정에 실패한 경우도 같다 — 보내지 않는다. 그리고 **내 표식은 걷어낸다**:
  // 남겨 두면 저장소가 나중에 다시 시도해 확정하고, 보내지도 않은 생성의 표식이 유령으로 살아난다.
  it("표식이 저장소에 확정되지 못하면 생성 요청을 보내지 않고 내 표식만 걷어낸다", { timeout: 20_000 }, async () => {
    sceneConfirmFails = true;
    const { default: App } = await import("../src/App");
    act(() => view.root.render(<App />));
    await settle();

    click(button(view.container, "시험 씬 일괄 생성"));
    await settle();
    await act(async () => { await sceneRun; });

    expect(boundary.api.prepareCreate).not.toHaveBeenCalled();
    for (const card of scene.cards) expect(card.pendingGenerationAttempts || []).toHaveLength(0);
  });
});
