// @vitest-environment jsdom
import { act, StrictMode, useRef, useState } from "react";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Scene } from "../src/lib/scenes";
import type { ResolveSceneSelectionTarget } from "../src/lib/resolveSelection";
import { createRenderRoot, installPromptBoundaryMocks, settle } from "./seedanceRenderHarness";

const fixture: Scene = {
  id: "resolve-scene", name: "Resolve test", created_at: 1, edges: [],
  cards: [{ id: "results", kind: "generation", x: 0, y: 0, genId: "representative", genIds: ["representative", "target"] }],
};
const otherScene: Scene = {
  id: "other-scene", name: "Other scene", created_at: 9, edges: [],
  cards: [{ id: "other-results", kind: "generation", x: 400, y: 0, genId: "other", genIds: ["other", "other-target"] }],
};
let view: ReturnType<typeof createRenderRoot>;
let boundary: ReturnType<typeof installPromptBoundaryMocks>;
let style: HTMLStyleElement;
const request = (generation: string | string[] = "target", openPopup = true, nonce = 1, sceneId = fixture.id,
  extra: Partial<ResolveSceneSelectionTarget> = {}): ResolveSceneSelectionTarget =>
  ({ sceneId, generationId: Array.isArray(generation) ? generation[0] ?? "" : generation,
    ...(Array.isArray(generation) ? { generationIds: generation, selectedCount: generation.length } : {}),
    nonce, at: Date.now(), openPopup, ...extra });
const selectedIds = () => [...view.container.querySelectorAll<HTMLElement>(".scene-varpop-item.on")].map((el) => el.dataset.gid);
const resolveHighlightedIds = () => [...view.container.querySelectorAll<HTMLElement>(".scene-varpop-item.resolve-selected")].map((el) => el.dataset.gid);
const click = (element: Element, options: MouseEventInit = {}) => act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, ...options })); });
const tile = (generationId: string) => view.container.querySelector<HTMLElement>(`.scene-varpop-item[data-gid="${generationId}"]`)!;
const openResults = () => {
  const button = [...view.container.querySelectorAll("button")].find((el) => el.textContent === "▤ 2");
  expect(button).toBeTruthy();
  click(button!);
};

async function mountBoard(initial: ResolveSceneSelectionTarget | null = null, initialScene = fixture) {
  const { SceneBoard } = await import("../src/components/scene/SceneBoard");
  let send!: (selection: ResolveSceneSelectionTarget) => void;
  let switchScene!: (scene: Scene) => void;
  const onChange = vi.fn();
  function Host() {
    const [selection, setSelection] = useState(initial);
    const [scene, setScene] = useState(initialScene);
    send = setSelection;
    switchScene = setScene;
    return <SceneBoard scene={scene} onChange={onChange} resolveSelection={selection}
      onResolveSelectionConsumed={() => setSelection(null)} />;
  }
  act(() => view.root.render(<StrictMode><Host /></StrictMode>));
  await settle();
  return { send, switchScene, onChange };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  boundary = installPromptBoundaryMocks();
  boundary.api.getGenerationsBatch.mockResolvedValue({ materials: {}, missing: [], items: Object.fromEntries(
    ["representative", "target", "other", "other-target"].map((id) => [id, { id, status: "done", prompt: id, assets: [], tags: [] }]),
  ) } as never);
  // 실제 Last viewed 저장소는 사용하고, 그 조회 응답만 고정한다. PUT은 허용하지 않는다.
  boundary.fetch.mockImplementation((...args: unknown[]) => {
    const [url, options] = args as [string, RequestInit | undefined];
    if (url.startsWith("/api/generation-views?") && !options?.method) {
      return Promise.resolve(new Response(JSON.stringify({ card: { results: "representative" }, last_card_id: "results" }))) as never;
    }
    return Promise.reject(new Error(`예상 밖 HTTP 요청: ${url}`));
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  style = document.createElement("style");
  style.textContent = readFileSync(new NodeURL("../src/styles/scene.css", import.meta.url), "utf8");
  document.head.appendChild(style);
  view = createRenderRoot();
});

afterEach(() => {
  view?.dispose();
  style.remove();
  for (const args of boundary.fetch.mock.calls as unknown as [string, RequestInit?][]) {
    expect(args[0]).toMatch(/^\/api\/generation-views\?/);
    expect(args[1]?.method).toBeUndefined();
  }
  vi.restoreAllMocks();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
});

it("StrictMode에서 캔버스를 처음 열어도 Resolve 선택 신호 한 번으로 선택 표시한다", async () => {
  const { onChange } = await mountBoard(request());
  expect(view.container.querySelectorAll(".scene-varpop-item")).toHaveLength(2);
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual(["target"]);
  expect(getComputedStyle(tile("target")).borderColor).toBe("rgb(255, 48, 79)");
  expect(getComputedStyle(tile("target")).boxShadow).toContain("18px 6px");
  expect(view.container.querySelector<HTMLElement>(".scene-varpop-item.rep")?.dataset.gid).toBe("representative");
  expect(view.container.querySelector<HTMLElement>(".scene-varpop-item .last-viewed-badge")?.parentElement?.dataset.gid).toBe("representative");
  expect(onChange).not.toHaveBeenCalled();
});

it("연동 해제 상태에서는 창을 열지 않고, 나중에 수동으로 열어도 과거 신호가 재생되지 않는다", async () => {
  await mountBoard(request("target", false));
  expect(view.container.querySelector(".scene-varpop-item")).toBeNull();
  openResults();
  await settle();
  expect(view.container.querySelectorAll(".scene-varpop-item")).toHaveLength(2);
  expect(selectedIds()).toEqual([]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("연동 해제 상태에서는 열린 창의 일치 항목만 선택하고, 일치하지 않으면 이전 Resolve 선택을 지운다", async () => {
  const { send } = await mountBoard();
  openResults();
  act(() => send(request("target", false)));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual(["target"]);
  act(() => send(request("unrelated", false, 2)));
  await settle();
  expect(selectedIds()).toEqual([]);
  expect(resolveHighlightedIds()).toEqual([]);
  expect(view.container.querySelectorAll(".scene-varpop-item")).toHaveLength(2);
  act(() => send(request("representative", false, 3)));
  await settle();
  expect(selectedIds()).toEqual(["representative"]);
  expect(resolveHighlightedIds()).toEqual(["representative"]);
});

it("체크 OFF에서 다른 묶음의 단일 항목을 고르면 빨강만 지우고 직접 라임 선택은 유지한다", async () => {
  const { send, onChange } = await mountBoard(request("target", false), {
    ...fixture, cards: [...fixture.cards, ...otherScene.cards],
  });
  openResults();
  act(() => send(request("target", false, 2)));
  await settle();
  expect(resolveHighlightedIds()).toEqual(["target"]);
  act(() => send(request("other", false, 3)));
  await settle();
  expect(selectedIds()).toEqual([]);
  expect(resolveHighlightedIds()).toEqual([]);
  expect(tile("target")).toBeTruthy();
  expect(tile("other")).toBeNull();
  click(tile("target"));
  act(() => send(request("other-target", false, 4)));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
  expect(getComputedStyle(tile("target")).boxShadow).toBe("0 0 0 3px var(--accent)");
  expect(onChange).not.toHaveBeenCalled();
});

it("직접 선택은 라임 링만 쓰고, Resolve 강조 항목을 다시 클릭해도 글로우를 해제한다", async () => {
  const { send, onChange } = await mountBoard();
  openResults();
  click(tile("target"));
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
  expect(getComputedStyle(tile("target")).boxShadow).toBe("0 0 0 3px var(--accent)");
  act(() => send(request()));
  await settle();
  expect(resolveHighlightedIds()).toEqual(["target"]);
  click(tile("target"));
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
  expect(getComputedStyle(tile("target")).boxShadow).toBe("0 0 0 3px var(--accent)");
  expect(onChange).not.toHaveBeenCalled();
});

it.each([{ ctrlKey: true }, { shiftKey: true }])("직접 복수 선택 %j 뒤에는 Resolve 강조가 남지 않는다", async (options) => {
  await mountBoard(request());
  click(tile("representative"), options);
  expect(selectedIds().sort()).toEqual(["representative", "target"]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("팝업 배경 클릭으로 선택을 지우면 Resolve 강조도 해제한다", async () => {
  await mountBoard(request());
  const grid = view.container.querySelector(".scene-varpop-grid")!;
  act(() => {
    grid.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  });
  expect(selectedIds()).toEqual([]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("다른 씬으로 이동하며 같은 카드 ID가 재사용돼도 첫 선택이 새 씬에 적용된다", async () => {
  const { send, switchScene } = await mountBoard(request("representative"));
  const nextScene = { ...fixture, id: "another-scene", cards: [...fixture.cards] };
  act(() => {
    switchScene(nextScene);
    send(request("target", true, 2, nextScene.id));
  });
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual(["target"]);
  act(() => switchScene(fixture));
  await settle();
  expect(selectedIds()).toEqual([]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("빠른 연속 선택은 마지막 항목만 남기고 닫힌 창을 오래된 신호로 다시 열지 않는다", async () => {
  const { send } = await mountBoard();
  act(() => {
    send(request("representative"));
    send(request("target", true, 2));
  });
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  const close = view.container.querySelector(".scene-varpop button");
  expect(close).toBeTruthy();
  click(close!);
  await settle();
  expect(view.container.querySelector(".scene-varpop-item")).toBeNull();
  openResults();
  await settle();
  expect(selectedIds()).toEqual([]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("같은 묶음의 복수 항목 모두 빨강 링·글로우로 표시하며 대표·Last viewed를 보존한다", async () => {
  const { onChange } = await mountBoard(request(["target", "representative"]));
  expect(selectedIds()).toEqual(["representative", "target"]);
  expect(resolveHighlightedIds()).toEqual(selectedIds());
  for (const id of selectedIds()) {
    expect(getComputedStyle(tile(id!)).borderColor).toBe("rgb(255, 48, 79)");
    expect(getComputedStyle(tile(id!)).boxShadow).toContain("18px 6px");
  }
  expect(view.container.querySelector<HTMLElement>(".scene-varpop-item.rep")?.dataset.gid).toBe("representative");
  expect(view.container.querySelector<HTMLElement>(".scene-varpop-item .last-viewed-badge")?.parentElement?.dataset.gid).toBe("representative");
  expect(onChange).not.toHaveBeenCalled();
});

it("열린 창을 우선하여 다른 묶음과 섞인 복수 선택의 교집합만 표시한다", async () => {
  const { send } = await mountBoard(request("target"), { ...fixture, cards: [...fixture.cards, ...otherScene.cards] });
  act(() => send(request(["other", "target"], true, 2)));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual(["target"]);
  expect(tile("other")).toBeNull();
  expect(view.container.querySelectorAll(".scene-varpop")).toHaveLength(1);
  act(() => send(request(["other", "other-target"], true, 3)));
  await settle();
  expect(selectedIds()).toEqual([]);
  expect(tile("representative")).toBeTruthy();
  expect(tile("other")).toBeNull();
  click(tile("target"));
  act(() => send(request(["other", "other-target"], true, 4)));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("서로 다른 묶음 복수 선택도 창이 닫혀 있으면 우선순위에 맞는 한 묶음만 연다", async () => {
  await mountBoard(request(["target", "other"]), { ...fixture, cards: [...fixture.cards, ...otherScene.cards] });
  expect(view.container.querySelectorAll(".scene-varpop")).toHaveLength(1);
  expect(selectedIds()).toEqual(["other"]);
  expect(resolveHighlightedIds()).toEqual(["other"]);
  expect(tile("target")).toBeNull();
});

it("원본 선택 수가 복수이면 검증된 ID가 하나여도 열린 묶음을 바꾸지 않는다", async () => {
  const { send } = await mountBoard(request(), { ...fixture, cards: [...fixture.cards, ...otherScene.cards] });
  act(() => send(request(["other"], true, 2, fixture.id, { selectedCount: 2 })));
  await settle();
  expect(selectedIds()).toEqual([]);
  expect(tile("target")).toBeTruthy();
  expect(tile("other")).toBeNull();
});

it("선택 해제는 빨강 선택만 지우며 창과 이후 직접 고른 라임 선택을 유지한다", async () => {
  const { send } = await mountBoard(request(["representative", "target"]));
  act(() => send(request([], true, 2)));
  await settle();
  expect(selectedIds()).toEqual([]);
  expect(resolveHighlightedIds()).toEqual([]);
  expect(tile("target")).toBeTruthy();
  click(tile("target"));
  act(() => send(request([], true, 3)));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("복수 빨강 선택 뒤 직접 클릭하면 빨강을 모두 지우고 라임 단일 선택으로 돌아간다", async () => {
  await mountBoard(request(["representative", "target"]));
  click(tile("target"));
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("실시간 체크 OFF 복수 선택은 닫힌 창에서 소비하고 열린 창의 교집합만 표시한다", async () => {
  const { send } = await mountBoard(request(["representative", "target"], false));
  expect(tile("target")).toBeNull();
  openResults();
  await settle();
  expect(selectedIds()).toEqual([]);
  act(() => send(request(["target", "other"], false, 2)));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual(["target"]);
});

it("상한 초과 신호는 창을 자동으로 열지 않고 열린 창의 교집합만 강조한다", async () => {
  const { send } = await mountBoard(request(["target"], true, 1, fixture.id, { truncated: true }));
  expect(tile("target")).toBeNull();
  openResults();
  await settle();
  expect(selectedIds()).toEqual([]);
  act(() => send(request(["target", "other"], true, 2, fixture.id, { truncated: true })));
  await settle();
  expect(resolveHighlightedIds()).toEqual(["target"]);
});

it("복수 선택으로 새 씬을 열고 단일 선택으로 바뀌면 마지막 선택만 남는다", async () => {
  const { send, switchScene } = await mountBoard();
  act(() => {
    switchScene(otherScene);
    send(request(["other", "other-target"], true, 1, otherScene.id));
  });
  await settle();
  expect(resolveHighlightedIds()).toEqual(["other", "other-target"]);
  act(() => send(request("other-target", true, 2, otherScene.id)));
  await settle();
  expect(selectedIds()).toEqual(["other-target"]);
  expect(resolveHighlightedIds()).toEqual(["other-target"]);
});

// App의 실제 라우팅·이벤트 수신과 SceneBoard를 함께 시험한다. IO와 주변 화면만 대체한다.
function installAppBoundaries(appScenes = [fixture], initialSceneId = fixture.id) {
  const noop = () => {};
  for (const [path, names] of [
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
  vi.doMock("../src/components/TopBar", () => ({
    TopBar: ({ filters }: { filters: { tab: string } }) => <output data-testid="tab">{filters.tab}</output>,
  }));
  vi.doMock("../src/lib/useHubAuth", () => ({
    useHubAuth: () => ({ authPending: false, authReady: true, authConfig: { auth_enabled: true },
      account: { email: "fixture@example.invalid" }, hubAccount: null, finalizeProjects: new Set<string>(), sharedSrv: null, logout: noop, setAccount: noop }),
  }));
  for (const name of ["useGenerationProgress", "useGenerationAutoRefresh", "useCommentBadgePoll", "useSceneCompletionWatcher"]) {
    vi.doMock(`../src/lib/${name}`, () => ({ [name]: noop }));
  }
  vi.doMock("../src/lib/useWorkspaceFilterOptions", () => ({
    useWorkspaceFilterOptions: () => ({ options: [], loading: false, failed: false, reload: noop }),
  }));
  vi.doMock("../src/lib/useSceneCoordination", () => ({
    useSceneCoordination: () => {
      const [activeSceneId, setActiveSceneId] = useState(initialSceneId);
      return { scenes: appScenes, activeSceneId, activeScene: appScenes.find((scene) => scene.id === activeSceneId),
      sceneBinding: null, setSceneBinding: noop, sceneSelGens: [], setSceneSelGens: noop,
      sceneActionRef: useRef(null), flushScenePending: noop, patchSceneById: noop, patchActiveScene: noop,
      selectScene: setActiveSceneId, addScene: noop, importSceneSnapshot: noop, renameScene: noop, removeSceneById: noop,
      reorderScenes: noop, setSceneWorkspace: noop, backupOnly: 0, importBackupScenes: noop };
    },
  }));
  vi.doMock("../src/lib/useGenerationLibraryData", () => ({
    useGenerationLibraryData: () => ({
      gens: [], setGens: noop, gensRef: useRef([]), facets: { tags: [], auto_tags: [], models: [] }, setFacets: noop,
      filtersRef: useRef({ tab: "my" }), projectsLoadedRef: useRef(true), projects: [],
      stats: { has_unread: false, failed_count: 0, unread_count: 0 }, loading: false, loadingMore: false,
      hasMore: false, loadError: null, archivedCount: 0, unassignedCount: 0, loadMore: noop, beginComposeList: noop,
      reload: noop, reloadIfStale: noop,
    }),
  }));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
}

it.each(["my", "team"])("%s 탭: 해제 시 유지하고 체크 시 첫 Resolve 신호로 캔버스와 선택을 함께 표시한다", async (tab) => {
  installAppBoundaries();
  localStorage.setItem("ch.lib.filtersV2", JSON.stringify({ tab, __v: "2" }));
  const settings = await import("../src/lib/resolveSelectionSettings");
  settings.saveResolveSelectionFollow(false);
  const { default: App } = await import("../src/App");
  act(() => view.root.render(<StrictMode><App /></StrictMode>));
  await settle();
  const send = (selectionId: string) => window.dispatchEvent(new CustomEvent("ch:resolve-selection", { detail: { generationId: "target", selectionId } }));
  act(() => send("off"));
  await settle();
  expect(view.container.querySelector('[data-testid="tab"]')?.textContent).toBe(tab);
  expect(view.container.querySelector(".scene-varpop-item")).toBeNull();
  act(() => settings.saveResolveSelectionFollow(true));
  act(() => send("on"));
  await settle();
  expect(view.container.querySelector('[data-testid="tab"]')?.textContent).toBe("compose");
  expect(selectedIds()).toEqual(["target"]);
});

async function mountApp(tab = "compose") {
  installAppBoundaries([fixture, otherScene]);
  localStorage.setItem("ch.lib.filtersV2", JSON.stringify({ tab, __v: "2" }));
  const { default: App } = await import("../src/App");
  act(() => view.root.render(<StrictMode><App /></StrictMode>));
  await settle();
  let sequence = 0;
  return (generationIds: string[], extra: Record<string, unknown> = {}) => window.dispatchEvent(
    new CustomEvent("ch:resolve-selection", { detail: {
      generationId: generationIds[0] ?? "", generationIds, selectedCount: generationIds.length,
      selectionId: `app-${++sequence}`, ...extra,
    } }),
  );
}

it("App: 다른 씬에만 복수 선택이 있어도 열린 창·씬을 유지하고 단일 선택 이동은 보존한다", async () => {
  const send = await mountApp();
  act(() => send(["target"]));
  await settle();
  act(() => send(["other", "other-target"]));
  await settle();
  expect(tile("target")).toBeTruthy();
  expect(tile("other")).toBeNull();
  expect(resolveHighlightedIds()).toEqual([]);
  act(() => send(["other-target"], { selectedCount: 2 }));
  await settle();
  expect(tile("target")).toBeTruthy();
  expect(tile("other-target")).toBeNull();
  act(() => send(["other-target"]));
  await settle();
  expect(tile("target")).toBeNull();
  expect(resolveHighlightedIds()).toEqual(["other-target"]);
});

it("App: 열린 창이 없으면 복수 선택의 현재 씬 일치를 첫 ID보다 우선한다", async () => {
  const send = await mountApp();
  act(() => send(["other", "target"]));
  await settle();
  expect(resolveHighlightedIds()).toEqual(["target"]);
  expect(tile("other")).toBeNull();
  expect(view.container.querySelectorAll(".scene-varpop")).toHaveLength(1);
});

it("App: 현재 씬 일치와 열린 창이 없으면 복수 선택의 다른 씬 한 묶음만 연다", async () => {
  const send = await mountApp("my");
  act(() => send(["other", "other-target"]));
  await settle();
  expect(view.container.querySelector('[data-testid="tab"]')?.textContent).toBe("compose");
  expect(resolveHighlightedIds()).toEqual(["other", "other-target"]);
  expect(view.container.querySelectorAll(".scene-varpop")).toHaveLength(1);
});

it.each(["my", "team"])("App %s: 빈 배열과 상한 초과 신호는 자동 탭·씬 이동이나 창 열기가 없다", async (tab) => {
  const send = await mountApp(tab);
  act(() => send([], { generationId: "target" }));
  await settle();
  expect(view.container.querySelector('[data-testid="tab"]')?.textContent).toBe(tab);
  act(() => send(["other", "other-target"], { truncated: true, selectedCount: 201 }));
  await settle();
  expect(view.container.querySelector('[data-testid="tab"]')?.textContent).toBe(tab);
  expect(view.container.querySelector(".scene-varpop")).toBeNull();
  act(() => send(["target"]));
  await settle();
  expect(resolveHighlightedIds()).toEqual(["target"]);
});

it("App: 상한 초과 신호도 열린 창에서는 교집합을 표시하고 빈 배열은 라임 선택을 보존한다", async () => {
  const send = await mountApp();
  act(() => send(["target"]));
  await settle();
  act(() => send(["representative", "target", "other"], { truncated: true, selectedCount: 201 }));
  await settle();
  expect(resolveHighlightedIds()).toEqual(["representative", "target"]);
  expect(tile("other")).toBeNull();
  act(() => send([]));
  await settle();
  expect(selectedIds()).toEqual([]);
  click(tile("target"));
  act(() => send([]));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("App: 복수 신호로 창을 닫은 뒤에는 예전 popup 알림이 다른 씬의 새 선택을 막지 않는다", async () => {
  const send = await mountApp();
  act(() => send(["representative", "target"]));
  await settle();
  click(view.container.querySelector(".scene-varpop button")!);
  await settle();
  act(() => send(["other", "other-target"]));
  await settle();
  expect(resolveHighlightedIds()).toEqual(["other", "other-target"]);
  expect(tile("target")).toBeNull();
});

it.each([{}, { generationIds: ["target"], truncated: true, selectedCount: 201 }])(
  "App: 탭 이동 직전 연달아 도착한 해제·상한 초과 신호는 이전 자동 열기 대기를 취소한다: %j", async (extra) => {
    const send = await mountApp("my");
    act(() => {
      send(["target", "representative"]);
      send([], extra);
    });
    await settle();
    expect(view.container.querySelector(".scene-varpop")).toBeNull();
    openResults();
    await settle();
    expect(selectedIds()).toEqual([]);
  },
);

it("App: 체크를 바꾸는 같은 렌더에 남은 이전 설정의 신호는 열린 창에도 재생하지 않는다", async () => {
  const send = await mountApp();
  act(() => send(["target"]));
  await settle();
  const settings = await import("../src/lib/resolveSelectionSettings");
  act(() => settings.saveResolveSelectionFollow(false));
  await settle();
  click(tile("representative"));
  act(() => {
    send(["target"]);
    settings.saveResolveSelectionFollow(true);
  });
  await settle();
  expect(selectedIds()).toEqual(["representative"]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("App: 체크 OFF에서 다른 씬의 단일 선택은 현재 창의 빨강만 지우며 라임·씬·창을 유지한다", async () => {
  const send = await mountApp();
  act(() => send(["target"]));
  await settle();
  const settings = await import("../src/lib/resolveSelectionSettings");
  act(() => settings.saveResolveSelectionFollow(false));
  await settle();
  expect(resolveHighlightedIds()).toEqual(["target"]);
  act(() => send(["other"]));
  await settle();
  expect(selectedIds()).toEqual([]);
  expect(resolveHighlightedIds()).toEqual([]);
  expect(tile("target")).toBeTruthy();
  expect(tile("other")).toBeNull();
  click(tile("target"));
  act(() => send(["other-target"]));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
  expect(tile("other-target")).toBeNull();
});
