// @vitest-environment jsdom
import { act, forwardRef, StrictMode, useCallback, useRef, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Scene } from "../src/lib/scenes";
import type { ResolveSceneSelectionTarget } from "../src/lib/resolveSelection";
import type { Filters, Generation, GenQuery, Project } from "../src/types";
import { isLocatedQuery, type GenerationLocation, type GenerationLocationRequest } from "../src/lib/resolveLibraryLocation";
import type { SpotlightPromptHandle } from "../src/components/SpotlightPrompt";
import type { PromptProps } from "./seedanceRenderHarness";
import { createRenderRoot, installPromptBoundaryMocks, settle } from "./seedanceRenderHarness";

const variantScroll = vi.hoisted(() => vi.fn());
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: variantScroll }));
    return <>{props.data.map(props.children)}</>;
  }) };
});

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
let locateGenerations: ReturnType<typeof vi.fn<(request: GenerationLocationRequest) => Promise<GenerationLocation>>>;
let gridSnapshot: ComponentProps<typeof import("../src/components/ThumbnailGrid").ThumbnailGrid> | null;
let promptSnapshot: PromptProps | null;
let librarySnapshot: { filters: Filters; genQuery: GenQuery; projectWorkspaceId?: string } | null;
let sidebarSnapshot: ComponentProps<typeof import("../src/components/FilterSidebar").FilterSidebar> | null;
let canvasSidebarSnapshot: ComponentProps<typeof import("../src/components/sidebar/CanvasFolderSidebar").CanvasFolderSidebar> | null;
let refreshProjects: () => void;
const relinkOnWorkspaceChange = vi.fn();
const beginList = vi.fn(); // 목록 훅의 beginComposeList — 폴더 창을 열고 닫을 때 목록을 비우는지 본다
let setStaleList: (on: boolean) => void; // 목록 훅의 staleList(닫은 직후 옛 첫 쪽을 보이는 중)를 시험이 켜고 끈다
let setLoadingList: (on: boolean) => void; // 목록 훅의 loading(받는 중)
let autoRefreshSnapshot: { paused?: boolean } | null = null; // 자동 새로고침 훅이 받은 인자
let gridClass = "gen-grid"; // 가짜 격자의 클래스 — 비우면 "격자가 아직 없다"(빈 목록·실패)를 흉내 낸다
const libraryHighlightedIds = () => [...(gridSnapshot?.resolveHighlightedIds || [])];
const libraryGeneration = (id: string): Generation => ({
  id, status: "done", prompt: id, assets: [], tags: [], auto_tags: [], references: [],
  shared: true, deleted: false, is_mine: true, workspace_scope: "team", workspace_id: "view-workspace",
  project_id: id.startsWith("other") ? "other-project" : "resolve-project",
  project_name: id.startsWith("other") ? "Other project" : "Resolve project",
  folder_path: "episode/shot", created_at: "2026-09-16T00:00:00Z",
} as Generation);
const request = (generation: string | string[] = "target", openPopup = true, nonce = 1, sceneId = fixture.id,
  extra: Partial<ResolveSceneSelectionTarget> = {}): ResolveSceneSelectionTarget =>
  ({ sceneId, generationId: Array.isArray(generation) ? generation[0] ?? "" : generation,
    ...(Array.isArray(generation) ? { generationIds: generation, selectedCount: generation.length } : {}),
    nonce, at: Date.now(), openPopup, ...extra });
// 캔버스 '생성 결과' 창은 라이브러리 격자를 쓴다 — 셀(.gen-cell[data-id]) 안 카드(.card)의 selected / resolve-highlighted 를 본다.
//  (빨강 링·라임 링의 모양은 라이브러리 카드의 것 — tests/resolveLibraryUi.test.tsx 가 본다)
const cells = () => [...view.container.querySelectorAll<HTMLElement>(".scene-varwin .gen-cell")];
const selectedIds = () => cells().filter((cell) => cell.querySelector(".card.selected")).map((cell) => cell.dataset.id);
const resolveHighlightedIds = () => cells().filter((cell) => cell.querySelector(".card.resolve-highlighted")).map((cell) => cell.dataset.id);
const click = (element: Element, options: MouseEventInit = {}) => act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, ...options })); });
const tile = (generationId: string) => view.container.querySelector<HTMLElement>(`.scene-varwin .gen-cell[data-id="${generationId}"]`)!;
// 격자의 선택 = 누르고(mousedown) 떼기(window mouseup)
const pick = (cell: Element, options: MouseEventInit = {}) => act(() => {
  cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ...options }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
});
// 격자는 다빈치가 고른 카드로 다음 프레임에 옮기고, 그 카드를 Shift 범위의 기준으로 삼는다
const nextFrame = () => act(async () => { await new Promise<void>((done) => requestAnimationFrame(() => done())); });
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
  localStorage.setItem("ch.workspaceContext", JSON.stringify({ scope: "team", id: "view-workspace", name: "View workspace" }));
  boundary = installPromptBoundaryMocks();
  gridSnapshot = null; promptSnapshot = null; librarySnapshot = null; sidebarSnapshot = null; canvasSidebarSnapshot = null;
  refreshProjects = () => {};
  locateGenerations = vi.fn().mockImplementation(async ({ gen_ids, workspace_ids, workspace_scope }: GenerationLocationRequest) => {
    const first = gen_ids[0] ? libraryGeneration(gen_ids[0]) : null;
    const items = first ? gen_ids.map(libraryGeneration).filter((item) => item.project_id === first.project_id) : [];
    return { items, focus_ids: items.map((item) => item.id), project_id: first?.project_id || null, folder_path: first?.folder_path || null,
      ...(workspace_ids?.length || workspace_scope ? { workspace_filter_applied: true } : {}) };
  });
  Object.assign(boundary.api, { locateGenerations });
  boundary.api.getGenerationsBatch.mockResolvedValue({ materials: {}, missing: [], items: Object.fromEntries(
    ["representative", "target", "other", "other-target"].map((id) => [id, { id, status: "done", prompt: id, assets: [], tags: [] }]),
  ) } as never);
  // 실제 Last viewed 저장소는 사용하고, 그 조회 응답만 고정한다. PUT은 허용하지 않는다.
  boundary.fetch.mockImplementation((...args: unknown[]) => {
    const [url, options] = args as [string, RequestInit | undefined];
    if (url.startsWith("/api/generation-views?") && !options?.method) {
      return Promise.resolve(new Response(JSON.stringify({ card: { results: "representative" }, last_card_id: "results" }))) as never;
    }
    // 결과 창의 격자(라이브러리 부품)가 읽는 목록의 '마지막으로 본'(씬 없음) — 창은 씬의 것을 쓰므로 비어 있어도 된다
    if (url === "/api/generation-views" && !options?.method) {
      return Promise.resolve(new Response(JSON.stringify({ card: {}, last_card_id: null }))) as never;
    }
    return Promise.reject(new Error(`예상 밖 HTTP 요청: ${url}`));
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: vi.fn() }); // jsdom 에 없다 — 격자가 목록이 바뀌면 맨 위로 올린다
  variantScroll.mockClear();
  view = createRenderRoot();
});

afterEach(() => {
  view?.dispose();
  for (const args of boundary.fetch.mock.calls as unknown as [string, RequestInit?][]) {
    expect(args[0]).toMatch(/^\/api\/generation-views(\?|$)/); // 씬의 것(?scene_id=) · 결과 창 격자가 읽는 목록의 것(질의 없음)
    expect(args[1]?.method).toBeUndefined();
  }
  vi.restoreAllMocks();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
  vi.unstubAllGlobals();
});

// 시간 제한 20초 — App 전체를 StrictMode 로 렌더하는 첫 마운트라 단독 1.4~1.8초인데, 전체 실행(파일 병렬·jsdom 기동 경합)에서는 기본 5초를 넘는다.
// 2026-09-20 실측: 시험 파일이 하나 늘 때마다 넘었고 단독으로는 3/3 통과. 이 시험에만 올린다(전역 제한은 그대로 — 다른 시험의 무한 대기를 가리지 않게).
it("StrictMode에서 캔버스를 처음 열어도 Resolve 선택 신호 한 번으로 선택 표시한다", { timeout: 20_000 }, async () => {
  const { onChange } = await mountBoard(request());
  expect(cells()).toHaveLength(2);
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual(["target"]);
  // 대표는 카드 위 '★ 대표', 나머지는 '대표' 지정 단추
  expect(tile("representative").querySelector(".gen-cell-head .scene-varpop-cur")).toBeTruthy();
  expect(tile("target").querySelector(".scene-varpop-cur")).toBeNull();
  expect(view.container.querySelector<HTMLElement>(".scene-varwin .last-viewed-badge")?.closest<HTMLElement>(".gen-cell")?.dataset.id).toBe("representative");
  // 고른 카드로 격자를 한 번 옮긴다
  await nextFrame();
  expect(variantScroll).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();
});

it("연동 해제 상태에서는 창을 열지 않고, 나중에 수동으로 열어도 과거 신호가 재생되지 않는다", async () => {
  await mountBoard(request("target", false));
  expect(view.container.querySelector(".scene-varwin")).toBeNull();
  openResults();
  await settle();
  expect(cells()).toHaveLength(2);
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
  expect(cells()).toHaveLength(2);
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
  pick(tile("target"));
  act(() => send(request("other-target", false, 4)));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
  expect(onChange).not.toHaveBeenCalled();
});

it("직접 선택은 라임 링만 쓰고, Resolve 강조 항목을 다시 클릭해도 글로우를 해제한다", async () => {
  const { send, onChange } = await mountBoard();
  openResults();
  pick(tile("target"));
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
  act(() => send(request()));
  await settle();
  expect(resolveHighlightedIds()).toEqual(["target"]);
  pick(tile("target"));
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
  expect(onChange).not.toHaveBeenCalled();
});

it.each([{ ctrlKey: true }, { shiftKey: true }])("직접 복수 선택 %j 뒤에는 Resolve 강조가 남지 않는다", async (options) => {
  await mountBoard(request());
  await nextFrame(); // 다빈치가 고른 카드가 Shift 범위의 기준이 된 뒤
  pick(tile("representative"), options);
  expect(selectedIds().sort()).toEqual(["representative", "target"]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("팝업 배경 클릭으로 선택을 지우면 Resolve 강조도 해제한다", async () => {
  await mountBoard(request());
  const grid = view.container.querySelector(".scene-varwin .gen-grid")!;
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
  const close = view.container.querySelector(".scene-varwin .folder-peek-x");
  expect(close).toBeTruthy();
  click(close!);
  await settle();
  expect(view.container.querySelector(".scene-varwin")).toBeNull();
  openResults();
  await settle();
  expect(selectedIds()).toEqual([]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("같은 묶음의 복수 항목 모두 빨강 링·글로우로 표시하며 대표·Last viewed를 보존한다", async () => {
  const { onChange } = await mountBoard(request(["target", "representative"]));
  expect(selectedIds()).toEqual(["representative", "target"]);
  expect(resolveHighlightedIds()).toEqual(selectedIds());
  expect(tile("representative").querySelector(".gen-cell-head .scene-varpop-cur")).toBeTruthy();
  expect(view.container.querySelector<HTMLElement>(".scene-varwin .last-viewed-badge")?.closest<HTMLElement>(".gen-cell")?.dataset.id).toBe("representative");
  expect(onChange).not.toHaveBeenCalled();
});

it("열린 창을 우선하여 다른 묶음과 섞인 복수 선택의 교집합만 표시한다", async () => {
  const { send } = await mountBoard(request("target"), { ...fixture, cards: [...fixture.cards, ...otherScene.cards] });
  act(() => send(request(["other", "target"], true, 2)));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual(["target"]);
  expect(tile("other")).toBeNull();
  expect(view.container.querySelectorAll(".scene-varwin")).toHaveLength(1);
  act(() => send(request(["other", "other-target"], true, 3)));
  await settle();
  expect(selectedIds()).toEqual([]);
  expect(tile("representative")).toBeTruthy();
  expect(tile("other")).toBeNull();
  pick(tile("target"));
  act(() => send(request(["other", "other-target"], true, 4)));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("서로 다른 묶음 복수 선택도 창이 닫혀 있으면 우선순위에 맞는 한 묶음만 연다", async () => {
  await mountBoard(request(["target", "other"]), { ...fixture, cards: [...fixture.cards, ...otherScene.cards] });
  expect(view.container.querySelectorAll(".scene-varwin")).toHaveLength(1);
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
  pick(tile("target"));
  act(() => send(request([], true, 3)));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("복수 빨강 선택 뒤 직접 클릭하면 빨강을 모두 지우고 라임 단일 선택으로 돌아간다", async () => {
  await mountBoard(request(["representative", "target"]));
  pick(tile("target"));
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
function installAppBoundaries(appScenes = [fixture], initialSceneId = fixture.id, initialProjects: Project[] = []) {
  const noop = () => {};
  for (const [path, names] of [
    ["../src/components/LibraryToolbar", ["LibraryToolbar"]],
    ["../src/components/scene/SceneBar", ["SceneBar"]],
    ["../src/components/app/AppOverlays", ["AppOverlays"]],
    ["../src/components/app/SelectionActionBar", ["BoardSelectionActionBar", "LibrarySelectionActionBar"]],
    ["../src/components/edit/PartialEditHost", ["PartialEditHost"]],
  ] as const) {
    vi.doMock(path, () => Object.fromEntries(names.map((name) => [name, () => null])));
  }
  vi.doMock("../src/components/sidebar/CanvasFolderSidebar", () => ({ CanvasFolderSidebar: (props: NonNullable<typeof canvasSidebarSnapshot>) => {
    canvasSidebarSnapshot = props;
    return null;
  } }));
  vi.doMock("../src/components/FilterSidebar", () => ({ FilterSidebar: (props: NonNullable<typeof sidebarSnapshot>) => {
    sidebarSnapshot = props;
    return <output data-testid="viewed-folder">{JSON.stringify(props.viewedFolder)}</output>;
  } }));
  vi.doMock("../src/components/ThumbnailGrid", () => ({ ThumbnailGrid: (props: NonNullable<typeof gridSnapshot>) => {
    // 캔버스 '생성 결과' 창도 이 격자를 쓴다('대표' 칸 cellHeader 로 구분) — 그쪽은 셀만 그려 선택·강조를 보이고, 목록 격자만 담는다.
    if (props.cellHeader) return <>{props.generations.map((g) => (
      <div className="gen-cell" data-id={g.id} key={g.id} onMouseDown={() => props.onSelectedChange(new Set([g.id]))}>
        <div className={"card" + (props.selectedIds.has(g.id) ? " selected" : "") + (props.resolveHighlightedIds?.has(g.id) ? " resolve-highlighted" : "")} />
      </div>
    ))}</>;
    gridSnapshot = props;
    // 실제 격자처럼 초점을 받을 수 있는 .gen-grid — 폴더 창을 닫은 뒤의 초점 복원을 본다
    return <output data-testid="library-highlight" className={gridClass} tabIndex={0}>{JSON.stringify([...props.resolveHighlightedIds || []])}</output>;
  } }));
  vi.doMock("../src/components/SpotlightPrompt", async () => {
    const actual = await vi.importActual<typeof import("../src/components/SpotlightPrompt")>("../src/components/SpotlightPrompt");
    return { ...actual, SpotlightPrompt: forwardRef<SpotlightPromptHandle, PromptProps>((props, ref) => {
      promptSnapshot = props;
      return <actual.SpotlightPrompt {...props} ref={ref} />;
    }) };
  });
  vi.doMock("../src/components/TopBar", () => ({
    TopBar: ({ filters }: { filters: { tab: string } }) => <output data-testid="tab">{filters.tab}</output>,
  }));
  vi.doMock("../src/lib/useHubAuth", () => ({
    useHubAuth: () => ({ authPending: false, authReady: true, authConfig: { auth_enabled: true },
      account: { email: "fixture@example.invalid" }, hubAccount: null, finalizeProjects: new Set<string>(), sharedSrv: null, logout: noop, setAccount: noop }),
  }));
  for (const name of ["useGenerationProgress", "useCommentBadgePoll", "useSceneCompletionWatcher"]) {
    vi.doMock(`../src/lib/${name}`, () => ({ [name]: noop }));
  }
  vi.doMock("../src/lib/useGenerationAutoRefresh", () => ({
    useGenerationAutoRefresh: (args: NonNullable<typeof autoRefreshSnapshot>) => { autoRefreshSnapshot = args; },
  }));
  vi.doMock("../src/lib/useWorkspaceFilterOptions", () => ({
    useWorkspaceFilterOptions: () => ({ options: [], loading: false, failed: false, reload: noop }),
  }));
  relinkOnWorkspaceChange.mockClear();
  vi.doMock("../src/lib/useSceneCoordination", () => ({
    useRelinkOnWorkspaceChange: relinkOnWorkspaceChange,
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
    useGenerationLibraryData: (args: NonNullable<typeof librarySnapshot>) => {
      librarySnapshot = args;
      const [gens, setGens] = useState<Generation[]>([]);
      const [location, setLocation] = useState<{ tab: "my" | "team"; value: GenerationLocation } | null>(null);
      const [projects, setProjects] = useState(initialProjects);
      const [staleList, setStale] = useState(false);
      setStaleList = setStale;
      const [loading, setLoad] = useState(false);
      setLoadingList = setLoad;
      refreshProjects = () => setProjects((previous) => [...previous]);
      const revealLocated = useCallback((tab: "my" | "team", value: GenerationLocation) => {
        setLocation({ tab, value }); setGens(value.items);
      }, []);
      const filtersRef = useRef(args.filters); filtersRef.current = args.filters;
      const gensRef = useRef(gens); gensRef.current = gens;
      return {
      gens, setGens, gensRef, facets: { tags: [], auto_tags: [], models: [] }, setFacets: noop,
      filtersRef, projectsLoadedRef: useRef(true), projects,
      revealLocated, locatedVisibleIds: new Set(gens.map((item) => item.id)),
      isLocatedView: !!location && isLocatedQuery(args.genQuery, location.tab, location.value),
      stats: { has_unread: false, failed_count: 0, unread_count: 0 }, loading, loadingMore: false,
      hasMore: false, loadError: null, archivedCount: 0, unassignedCount: 0, loadMore: noop, beginComposeList: beginList,
      reload: noop, reloadIfStale: noop, staleList,
    };
    },
  }));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
}

it.each(["my", "team"])("%s 탭: 체크 시 캔버스 대신 현재 탭의 대상 폴더와 카드를 표시한다", async (tab) => {
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
  expect(view.container.querySelector(".scene-varwin")).toBeNull();
  act(() => settings.saveResolveSelectionFollow(true));
  act(() => send("on"));
  await settle();
  expect(view.container.querySelector('[data-testid="tab"]')?.textContent).toBe(tab);
  expect(view.container.querySelector(".scene-varwin")).toBeNull();
  expect(libraryHighlightedIds()).toEqual(["target"]);
  expect(librarySnapshot?.filters).toEqual({ tab, project_id: "resolve-project", folder_path: "episode/shot" });
  expect(gridSnapshot?.resolveScrollRequest?.generationId).toBe("target");
  expect(gridSnapshot?.selectedIds.size).toBe(0);
  expect(locateGenerations).toHaveBeenLastCalledWith(expect.objectContaining({ tab, gen_ids: ["target"] }));
});

it("App: 자동 조회는 모든 보기 필터만 해제하며 없는 프로젝트의 위치와 기존 생성 설정을 유지한다", async () => {
  installAppBoundaries([fixture], fixture.id, [{ id: "generation-project", name: "생성 프로젝트", count: 0 } as Project]);
  const generationScope = { project_id: "generation-project", folder_path: "next/clip" };
  const armedFolder = { projectId: "generation-project", path: "next/clip" };
  const workspace = { scope: "team", id: "generation-workspace", name: "생성 팀" };
  localStorage.setItem("ch.workspaceContext", JSON.stringify(workspace));
  localStorage.setItem("ch.lib.filtersV2", JSON.stringify({
    tab: "my", ...generationScope, q: "hidden", model: "hidden-model", creator_uid: "hidden-creator",
    workspace_ids: ["hidden-workspace"], deleted_only: true, include_deleted: true, __v: "2",
  }));
  localStorage.setItem("ch.lib.armedFolder", JSON.stringify(armedFolder));
  localStorage.setItem("ch.lib.armedAutoTags", JSON.stringify(["다음 생성 태그"]));
  localStorage.setItem("ch.lib.colorFilter", JSON.stringify(["red"]));
  localStorage.setItem("ch.lib.tagFilter", JSON.stringify(["hidden-tag"]));
  localStorage.setItem("ch.lib.typeFilter", "video");
  for (const key of ["sharedOnly", "commentOnly", "finalOnly", "grayOn"]) localStorage.setItem(`ch.lib.${key}`, "1");
  const { default: App } = await import("../src/App");
  act(() => view.root.render(<StrictMode><App /></StrictMode>));
  await settle();
  expect(promptSnapshot?.activeProjectId).toBe("generation-project");
  // 위에서 고른 워크스페이스가 바뀌면 레퍼런스를 다시 묻는 훅에 공간 열쇠를 넘긴다(2026-10-01 점검 R2-2)
  expect(relinkOnWorkspaceChange.mock.calls.map((call) => call[0])).toContain("team:generation-workspace");
  act(() => window.dispatchEvent(new CustomEvent("ch:resolve-selection", { detail: { generationId: "target", selectionId: "scope-follow" } })));
  await settle();
  const locatedFilters = { tab: "my", project_id: "resolve-project", folder_path: "episode/shot" };
  expect(librarySnapshot?.filters).toEqual(locatedFilters);
  expect(librarySnapshot?.genQuery).toMatchObject({ ...locatedFilters, colors: [], tags: [], auto_tags: [] });
  const { tab: _tab, project_id: _project, folder_path: _folder, ...queryFilters } = librarySnapshot!.genQuery;
  expect(Object.values(queryFilters).every((value) => Array.isArray(value) ? value.length === 0 : !value)).toBe(true);
  expect(libraryHighlightedIds()).toEqual(["target"]);
  expect(sidebarSnapshot?.viewedFolder).toMatchObject({ projectId: "resolve-project", projectName: "Resolve project", path: "episode/shot" });
  // 현재 생성 워크스페이스의 프로젝트 목록에는 조회 프로젝트가 없다. 재조회가 도착해도 지우지 않는다.
  expect(sidebarSnapshot?.projects.some((project) => project.id === "resolve-project")).toBe(false);
  act(() => refreshProjects());
  await settle();
  expect(librarySnapshot?.filters).toEqual(locatedFilters);
  expect(libraryHighlightedIds()).toEqual(["target"]);
  expect(librarySnapshot?.projectWorkspaceId).toBe("generation-workspace");
  expect(promptSnapshot?.activeProjectId).toBe("generation-project");
  expect(promptSnapshot?.armedFolder).toEqual(armedFolder);
  expect(promptSnapshot?.armedAutoTags).toEqual(["다음 생성 태그"]);
  expect(promptSnapshot?.workspace).toEqual(workspace);
  expect(JSON.parse(localStorage.getItem("ch.lib.generationScopeV1")!)).toEqual(generationScope);
  expect(JSON.parse(localStorage.getItem("ch.lib.filterAutoTagsV1")!)).toEqual([]);
  expect(JSON.parse(localStorage.getItem("ch.lib.armedAutoTags")!)).toEqual(["다음 생성 태그"]);
  for (const key of ["sharedOnly", "commentOnly", "finalOnly", "grayOn"]) expect(localStorage.getItem(`ch.lib.${key}`)).toBe("0");
  expect(boundary.api.prepareCreate).not.toHaveBeenCalled();
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
  expect(view.container.querySelectorAll(".scene-varwin")).toHaveLength(1);
});

it("App 작업 공간: 복수 선택도 캔버스를 열지 않고 해당 폴더에서 모두 강조한다", async () => {
  const send = await mountApp("my");
  act(() => send(["other", "other-target"]));
  await settle();
  expect(view.container.querySelector('[data-testid="tab"]')?.textContent).toBe("my");
  expect(libraryHighlightedIds()).toEqual(["other", "other-target"]);
  expect(librarySnapshot?.filters).toEqual({ tab: "my", project_id: "other-project", folder_path: "episode/shot" });
  expect(view.container.querySelectorAll(".scene-varwin")).toHaveLength(0);
});

it("App 공유·리뷰: 공간 미확인은 안내와 전체 보기 버튼을 표시하고 명시 선택 뒤에만 조회한다", async () => {
  localStorage.removeItem("ch.workspaceContext");
  const send = await mountApp("team");
  expect(gridSnapshot).toBeNull();
  expect(view.container.querySelector('[role="status"]')?.textContent).toContain("워크스페이스를 확인한 뒤");
  act(() => send(["target"]));
  await settle();
  expect(locateGenerations).not.toHaveBeenCalled();
  const showAll = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "전체 보기");
  expect(showAll).toBeTruthy();
  click(showAll!);
  await settle();
  expect(gridSnapshot).not.toBeNull();
  act(() => send(["target"]));
  await settle();
  expect(libraryHighlightedIds()).toEqual(["target"]);
  expect(locateGenerations.mock.calls.at(-1)?.[0].workspace_ids).toBeUndefined();
});

it.each([false, true])("App 휴지통: 회색필터 OFF에도 공간 밖 페이지를 당기며 상한을 지킨다 (cap=%s)", async (hitCap) => {
  installAppBoundaries();
  vi.doUnmock("../src/lib/useGenerationLibraryData");
  const trash = Array.from({ length: hitCap ? 2400 : 400 }, (_, index) => ({
    ...libraryGeneration(`hidden-${index}`), deleted: true, workspace_scope: "unknown" as const, workspace_id: null,
  }));
  trash.push({ ...libraryGeneration("target"), deleted: true });
  const listTrash = vi.fn(async (_search: string | undefined, offset = 0) => trash.slice(offset, offset + 200));
  Object.assign(boundary.api, {
    listTrash, listGenerations: vi.fn(async () => []),
    projects: vi.fn(async () => ({ projects: [], unassigned: 0 })),
    facets: vi.fn(async () => ({ tags: [], auto_tags: [], models: [] })),
    generationStats: vi.fn(async () => ({ failed_count: 0, has_unread: false })),
  });
  vi.doMock("../src/api", () => ({ api: boundary.api, GEN_PAGE: 200 }));
  localStorage.setItem("ch.lib.filtersV2", JSON.stringify({ tab: "team", __v: "2" }));
  const { default: App } = await import("../src/App");
  act(() => view.root.render(<StrictMode><App /></StrictMode>)); await settle();
  act(() => sidebarSnapshot!.onChange({ deleted_only: true }));
  for (let step = 0; step < 15; step++) await settle();
  const offsets = listTrash.mock.calls.map((call) => call[1]);
  expect(offsets).toEqual(Array.from({ length: hitCap ? 11 : 3 }, (_, index) => index * 200));
  expect(gridSnapshot?.generations.map((g) => g.id)).toEqual(hitCap ? [] : ["target"]);
  expect(gridSnapshot?.hasMore).toBe(hitCap);
});

it("App 공유·리뷰: 미공유 응답은 이전 빨강만 지우고 탭·폴더·직접 선택을 그대로 둔다", async () => {
  const send = await mountApp("team");
  act(() => send(["target"]));
  await settle();
  act(() => gridSnapshot!.onSelectedChange(new Set(["target"])));
  const filters = librarySnapshot!.filters;
  locateGenerations.mockResolvedValueOnce({
    items: [{ ...libraryGeneration("other"), shared: false }], focus_ids: ["other"],
    project_id: "other-project", folder_path: "episode/shot", workspace_filter_applied: true,
  });
  act(() => send(["other"]));
  await settle();
  expect(librarySnapshot?.filters).toEqual(filters);
  expect(libraryHighlightedIds()).toEqual([]);
  expect(gridSnapshot?.selectedIds).toEqual(new Set(["target"]));
  expect(gridSnapshot?.resolveScrollRequest).toBeNull();
  expect(view.container.querySelector('[data-testid="tab"]')?.textContent).toBe("team");
  expect(view.container.querySelector(".scene-varwin")).toBeNull();
});

it("App 작업 공간 체크 OFF: 지금 보이는 카드만 강조하고 다른 위치는 열지 않는다", async () => {
  const send = await mountApp("my");
  act(() => send(["target"]));
  await settle();
  const settings = await import("../src/lib/resolveSelectionSettings");
  act(() => settings.saveResolveSelectionFollow(false));
  await settle();
  const filters = librarySnapshot!.filters;
  act(() => send(["target"]));
  await settle();
  expect(libraryHighlightedIds()).toEqual(["target"]);
  expect(gridSnapshot?.resolveScrollRequest).toBeNull();
  act(() => send(["other"]));
  await settle();
  expect(libraryHighlightedIds()).toEqual([]);
  expect(librarySnapshot?.filters).toEqual(filters);
  expect(gridSnapshot?.generations.map((item) => item.id)).toEqual(["target"]);
  expect(view.container.querySelector(".scene-varwin")).toBeNull();
});

it.each(["my", "team"])("App %s: 빈 배열과 상한 초과 신호는 자동 탭·씬 이동이나 창 열기가 없다", async (tab) => {
  const send = await mountApp(tab);
  act(() => send([], { generationId: "target" }));
  await settle();
  expect(view.container.querySelector('[data-testid="tab"]')?.textContent).toBe(tab);
  act(() => send(["other", "other-target"], { truncated: true, selectedCount: 201 }));
  await settle();
  expect(view.container.querySelector('[data-testid="tab"]')?.textContent).toBe(tab);
  expect(view.container.querySelector(".scene-varwin")).toBeNull();
  act(() => send(["target"]));
  await settle();
  expect(libraryHighlightedIds()).toEqual(["target"]);
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
  pick(tile("target"));
  act(() => send([]));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
});

it("App: 복수 신호로 창을 닫은 뒤에는 예전 popup 알림이 다른 씬의 새 선택을 막지 않는다", async () => {
  const send = await mountApp();
  act(() => send(["representative", "target"]));
  await settle();
  click(view.container.querySelector(".scene-varwin .folder-peek-x")!);
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
    expect(view.container.querySelector(".scene-varwin")).toBeNull();
    expect(view.container.querySelector('[data-testid="tab"]')?.textContent).toBe("my");
    expect(libraryHighlightedIds()).toEqual([]);
    expect(librarySnapshot?.filters.project_id).toBeUndefined();
  },
);

it("App: 체크를 바꾸는 같은 렌더에 남은 이전 설정의 신호는 열린 창에도 재생하지 않는다", async () => {
  const send = await mountApp();
  act(() => send(["target"]));
  await settle();
  const settings = await import("../src/lib/resolveSelectionSettings");
  act(() => settings.saveResolveSelectionFollow(false));
  await settle();
  pick(tile("representative"));
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
  pick(tile("target"));
  act(() => send(["other-target"]));
  await settle();
  expect(selectedIds()).toEqual(["target"]);
  expect(resolveHighlightedIds()).toEqual([]);
  expect(tile("other-target")).toBeNull();
});

it("App: 캔버스의 '생성 결과' 창과 '폴더 보기' 창은 겹쳐 두지 않는다 — 나중에 연 쪽만 남는다", async () => {
  // 두 창 모두 라이브러리 격자를 쓴다 — 같이 떠 있으면 격자 둘이 같은 바깥 끌기·키를 받는다
  const send = await mountApp();
  act(() => send(["target"]));
  await settle();
  expect(view.container.querySelector(".scene-varwin")).toBeTruthy();
  act(() => canvasSidebarSnapshot!.onArmFolder("resolve-project", "episode/shot")); // 사이드바에서 폴더를 누른다
  await settle();
  expect(document.querySelector(".folder-peek")).toBeTruthy();
  expect(view.container.querySelector(".scene-varwin")).toBeNull();
  act(() => send(["representative"])); // 다빈치 선택이 결과 창을 다시 연다
  await settle();
  expect(view.container.querySelector(".scene-varwin")).toBeTruthy();
  expect(document.querySelector(".folder-peek")).toBeNull();
});

// ── 목록 탭의 '폴더 보기' 창(카드의 폴더 이름표, 2026-10-07) — 캔버스 창과 같은 원리: 목록 조회가 그 폴더로 바뀌고 하나뿐인 격자를 창에 그린다 ──
const peekWindow = () => document.querySelector<HTMLElement>(".folder-peek");
const gridOutputs = () => [...document.querySelectorAll('[data-testid="library-highlight"]')];
const pressEscapeInPeek = () => act(() => {
  peekWindow()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
});

it.each(["my", "team"])("App %s 탭: 폴더 이름표를 누르면 조회가 그 폴더로 바뀌고 격자를 창에 그린다 — 사이드바 필터·다음 생성 위치는 그대로", async (tab) => {
  localStorage.setItem("ch.lib.generationScopeV1", JSON.stringify({ project_id: "generation-project", folder_path: "next/clip" }));
  await mountApp(tab);
  beginList.mockClear();
  act(() => sidebarSnapshot!.onChange({ search: "cat", creator_uid: "someone" })); // 창에서는 안 보이는 조건
  act(() => gridSnapshot!.onSelectedChange(new Set(["target"])));
  await settle();
  expect(promptSnapshot?.topSlot).toBeTruthy(); // 본 목록에서는 선택 막대가 프롬프트 위에 뜬다
  const filtersBefore = librarySnapshot!.filters;
  const scopeBefore = localStorage.getItem("ch.lib.generationScopeV1");
  const backKey = JSON.stringify(librarySnapshot!.genQuery); // 창 조건이 섞이기 전의 본 목록 조회
  expect(gridSnapshot!.onOpenFolder).toBeTypeOf("function");
  expect(peekWindow()).toBeNull();

  act(() => gridSnapshot!.onOpenFolder!(libraryGeneration("target")));
  await settle();
  expect(peekWindow()!.querySelector(".folder-peek-title")!.textContent).toBe("Resolve project / episode/shot");
  expect(gridOutputs()).toHaveLength(1); // 격자는 하나뿐 — 뒤 목록 자리에는 그리지 않는다
  expect(peekWindow()!.contains(gridOutputs()[0])).toBe(true);
  expect(librarySnapshot!.genQuery).toMatchObject({ tab, project_id: "resolve-project", folder_path: "episode/shot" });
  expect(gridSnapshot!.resetKey).toContain("episode/shot"); // 조회 키도 그 폴더 — 이 키가 바뀌어야 목록을 다시 받는다
  expect(librarySnapshot!.genQuery.search).toBeUndefined();
  expect(librarySnapshot!.genQuery.creator_uid).toBeUndefined();
  expect(librarySnapshot!.filters).toBe(filtersBefore); // 사이드바 필터는 건드리지 않는다(patch 는 다음 생성 위치까지 바꾼다)
  expect(localStorage.getItem("ch.lib.generationScopeV1")).toBe(scopeBefore);
  expect(promptSnapshot?.activeProjectId).toBe("generation-project");
  expect(beginList).toHaveBeenCalledTimes(1); // 본 목록 카드가 창에 비치지 않게 비우고 시작
  expect(beginList).toHaveBeenLastCalledWith({ keep: backKey }); // 닫을 때 먼저 보일 본 목록 첫 쪽을 그 조회의 키로 담아 둔다
  expect(gridSnapshot!.selectedIds.size).toBe(0); // 본 목록의 선택을 창으로 들고 가지 않는다
  expect(gridSnapshot!.onOpenFolder).toBeUndefined(); // 창 안 격자에는 이름표를 달지 않는다
  expect(gridSnapshot!.openedFromId).toBe("target"); // 이름표를 누른 그 카드를 창 안에서 표시하고('방금 누른 카드')
  expect(gridSnapshot!.resolveScrollRequest).toEqual({ generationId: "target", nonce: 0 }); // 아래쪽에 있으면 그 카드로 내려간다
  expect(document.activeElement).toBe(peekWindow());
  expect(document.querySelector(".body")!.hasAttribute("inert")).toBe(true); // 뒤 화면은 키보드로도 닿지 않는다

  // Esc: 선택이 있으면 선택부터 풀고, 없으면 창을 닫는다 — 닫으면 본 목록 조회로 돌아간다.
  //  선택 막대는 창에만: 창이 떠 있는 동안 프롬프트 위·화면 위쪽의 바깥 막대는 그리지 않는다.
  act(() => gridSnapshot!.onSelectedChange(new Set(["target"])));
  expect(promptSnapshot?.topSlot).toBeUndefined();
  // 실제 브라우저에서는 창의 키 처리가 끝난 직후, 같은 Esc 가 window 에 닿기 전에 React 가 다시 그리고 effect 까지 돌린다 —
  //  그 순서를 문서 리스너의 flushSync 로 강제한다(React 루트 → document → window 순으로 올라간다). 선택을 푼 그 자리에서
  //  전역 Esc 훅(선택이 없을 때만 켜짐)이 켜지므로, 같은 키로 창까지 닫히면 안 된다(2026-10-07 브라우저 실측으로 발견).
  const flushBetweenListeners = () => flushSync(() => {});
  document.addEventListener("keydown", flushBetweenListeners);
  pressEscapeInPeek();
  document.removeEventListener("keydown", flushBetweenListeners);
  expect(gridSnapshot!.selectedIds.size).toBe(0);
  expect(peekWindow()).not.toBeNull();
  pressEscapeInPeek();
  await settle();
  expect(peekWindow()).toBeNull();
  expect(document.querySelector(".body")!.hasAttribute("inert")).toBe(false);
  expect(gridOutputs()).toHaveLength(1);
  expect(librarySnapshot!.genQuery).toMatchObject({ tab, search: "cat", creator_uid: "someone" });
  expect(librarySnapshot!.genQuery.folder_path).toBeUndefined();
  expect(beginList).toHaveBeenCalledTimes(2); // 창의 카드가 뒤 목록 자리에 비치지 않게 닫을 때도 비운다
  expect(beginList).toHaveBeenLastCalledWith({ restore: backKey }); // 같은 키 — 담아 둔 첫 쪽을 먼저 그린다(빈 화면 없음)
  expect(gridSnapshot!.onOpenFolder).toBeTypeOf("function");
  expect(gridSnapshot!.openedFromId).toBeUndefined(); // 본 목록에는 표시도, 자동 이동도 남지 않는다
  expect(gridSnapshot!.resolveScrollRequest).toBeNull();
});

it("App: 폴더 창을 닫은 직후 옛 첫 쪽을 보이는 동안에는 고르지도 따라가지도 못한다 — 새 목록이 오면 풀린다", async () => {
  // 그 카드들은 낡았을 수 있다(창에서 지우거나 공유를 바꿨을 수 있다) — 보이기만 하고, 삭제·공유가 걸릴 입구를 모두 막는다
  const send = await mountApp("team");
  act(() => send(["target"]));
  await settle();
  const filtersBefore = librarySnapshot!.filters;
  act(() => setStaleList(true));
  const main = document.querySelector("main.main")!;
  expect(main.hasAttribute("inert")).toBe(true); // 카드의 클릭·키
  expect(main.getAttribute("aria-busy")).toBe("true");
  expect(gridSnapshot!.selectLocked).toBe(true); // 바깥(상단바·사이드바 여백)에서 시작하는 끌기 선택
  expect(autoRefreshSnapshot!.paused).toBe(true); // 자동 새로고침도 쉰다 — 끼어들면 받던 새 첫 쪽이 버려져 잠금이 길어진다
  expect(gridSnapshot!.loading).toBe(false); // 격자가 '받는 중'을 안다(비어 있을 때 "항목이 없습니다" 대신 "불러오는 중…")
  act(() => gridSnapshot!.onSelectedChange(new Set(["target"]))); // 그래도 들어온 선택 결과
  expect(gridSnapshot!.selectedIds.size).toBe(0);
  expect(promptSnapshot?.topSlot).toBeUndefined(); // 선택이 없으니 선택 막대도 없다
  act(() => send(["other"])); // 다빈치 신호 — 사본 위에 목록을 갈아 끼우지 않는다
  await settle();
  expect(librarySnapshot!.filters).toEqual(filtersBefore);

  act(() => setStaleList(false));
  expect(main.hasAttribute("inert")).toBe(false);
  expect(main.hasAttribute("aria-busy")).toBe(false);
  expect(gridSnapshot!.selectLocked).toBe(false);
  expect(autoRefreshSnapshot!.paused).toBe(false);
  act(() => gridSnapshot!.onSelectedChange(new Set(["target"])));
  expect(gridSnapshot!.selectedIds).toEqual(new Set(["target"]));
});

it("App: 폴더 창을 닫으면 본 목록이 조작 가능해진 뒤 초점이 격자로 돌아온다 — 남의 초점은 빼앗지 않는다", async () => {
  // 창이 사라지면 초점이 BODY 로 떨어져, 격자의 키(Ctrl+A·방향키…)가 격자에 초점을 다시 줄 때까지 먹지 않았다(2026-10-07 실측)
  await mountApp("my");
  const grid = () => document.querySelector<HTMLElement>("main.main .gen-grid");
  const open = async () => {
    act(() => gridSnapshot!.onOpenFolder!(libraryGeneration("target")));
    await settle();
    expect(document.activeElement).toBe(peekWindow());
  };
  const elsewhere = document.createElement("input");
  document.body.appendChild(elsewhere);
  // 목록 훅처럼: 닫을 때(restore) 옛 첫 쪽을 먼저 보이며 잠근다
  const lockOnClose = (back?: { restore?: string }) => { if (back?.restore !== undefined) setStaleList(true); };
  try {
    // 1) 잠금 중에는 옮기지 않고(main 이 inert), 풀리면 격자로
    beginList.mockImplementation(lockOnClose);
    await open();
    pressEscapeInPeek();
    await settle();
    expect(peekWindow()).toBeNull();
    expect(document.activeElement).toBe(document.body);
    act(() => setStaleList(false));
    expect(grid()).not.toBeNull();
    expect(document.activeElement).toBe(grid());

    // 2) 그사이 초점이 다른 곳으로 갔으면 그만둔다 — 그 요소가 사라져 초점이 다시 비어도 돌려주지 않는다(메뉴에서 설정 창을 연 직후 등)
    await open();
    pressEscapeInPeek();
    await settle();
    elsewhere.focus();
    elsewhere.blur();
    expect(document.activeElement).toBe(document.body);
    act(() => setStaleList(false));
    expect(document.activeElement).toBe(document.body);

    // 3) 닫는 순간 초점이 창 밖에 있었으면(크게 보기의 [부분 수정] 등) 돌려주지 않는다 — 나중에 초점이 비어도
    await open();
    elsewhere.focus();
    act(() => { window.dispatchEvent(new CustomEvent("ch:partial-edit", { detail: { genId: "target" } })); });
    await settle();
    expect(peekWindow()).toBeNull();
    elsewhere.blur();
    act(() => setStaleList(false));
    expect(document.activeElement).toBe(document.body);

    // 4) 기다리는 사이 문맥이 바뀌었으면(보던 위치) 돌려주지 않는다 — 되돌아와도 살리지 않는다
    await open();
    pressEscapeInPeek();
    await settle();
    const before = librarySnapshot!.filters.project_id;
    act(() => sidebarSnapshot!.onChange({ project_id: "other-project" }));
    act(() => sidebarSnapshot!.onChange({ project_id: before }));
    act(() => setStaleList(false));
    expect(document.activeElement).toBe(document.body);

    // 4-2) 한 번만 — 조작 가능해진 순간 격자가 없었으면(빈 목록·실패) 그대로 끝내고, 나중에 격자가 생겨도 옮기지 않는다
    await open();
    pressEscapeInPeek();
    await settle();
    gridClass = "";
    act(() => setStaleList(false));
    gridClass = "gen-grid";
    act(() => setLoadingList(true));
    act(() => setLoadingList(false));
    expect(grid()).not.toBeNull();
    expect(document.activeElement).toBe(document.body);

    // 5) 사본 없이 빈 채로 받는 경우(잠금 없음)에는 목록이 온 뒤에
    beginList.mockImplementation((back?: { restore?: string }) => { if (back?.restore !== undefined) setLoadingList(true); });
    await open();
    pressEscapeInPeek();
    await settle();
    expect(document.activeElement).toBe(document.body);
    act(() => setLoadingList(false));
    expect(document.activeElement).toBe(grid());
  } finally {
    gridClass = "gen-grid";
    beginList.mockReset();
    elsewhere.remove();
  }
});

it("App 작업 공간: 바깥 막·✕ 로 닫히고, 보던 위치가 바뀌거나 부분 수정으로 넘어가도 닫힌다 — 휴지통 보기에는 이름표가 없다", async () => {
  const send = await mountApp("my");
  // 창이 없을 때의 부분 수정은 목록을 건드리지 않는다(닫기는 열려 있을 때만 일한다 — 아니면 부분 수정마다 본 목록이 비워진다)
  beginList.mockClear();
  act(() => { window.dispatchEvent(new CustomEvent("ch:partial-edit", { detail: { genId: "target" } })); });
  expect(beginList).not.toHaveBeenCalled();
  const open = async () => {
    act(() => gridSnapshot!.onOpenFolder!(libraryGeneration("target")));
    await settle();
    expect(peekWindow()).not.toBeNull();
  };
  await open();
  act(() => gridSnapshot!.onSelectedChange(new Set(["target"])));
  act(() => { document.querySelector(".folder-peek-catcher")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  await settle();
  expect(peekWindow()).toBeNull();
  expect(gridSnapshot!.selectedIds.size).toBe(0); // 창의 선택을 본 목록으로 들고 나오지 않는다

  await open();
  act(() => peekWindow()!.querySelector<HTMLButtonElement>(".folder-peek-x")!.click());
  await settle();
  expect(peekWindow()).toBeNull();

  // 초점이 창 밖에 있을 때의 Esc 도 닫는다(전역 훅). 초점이 창 안이면 전역 훅은 손을 떼고 창의 키 처리에 맡긴다
  //  (그 이유인 '같은 Esc 로 선택 해제 + 창 닫힘' 은 위 "폴더 이름표를 누르면" 시험이 순서를 강제해 재현한다).
  await open();
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  await settle();
  expect(peekWindow()).not.toBeNull();
  act(() => (document.activeElement as HTMLElement).blur());
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  await settle();
  expect(peekWindow()).toBeNull();

  // 프로젝트 없는 폴더 — 제목은 경로만, 조회는 project_id=none
  act(() => gridSnapshot!.onOpenFolder!({ ...libraryGeneration("target"), project_id: null, project_name: null }));
  await settle();
  expect(peekWindow()!.querySelector(".folder-peek-title")!.textContent).toBe("episode/shot");
  expect(librarySnapshot!.genQuery).toMatchObject({ project_id: "none", folder_path: "episode/shot" });
  pressEscapeInPeek();
  await settle();

  // 보던 위치·탭이 바뀌면 닫힌다(자동 조회·뒤로 가기 등). 원래 위치로 돌아와도 다시 열리지 않는다
  for (const [change, back] of [
    [{ folder_path: "somewhere/else" }, { folder_path: undefined }],
    [{ project_id: "none" }, { project_id: undefined }],
    [{ tab: "compose" }, { tab: "my" }], // my↔compose 는 공간 열쇠가 같아 탭으로만 구분된다
    [{ deleted_only: true }, { deleted_only: undefined }], // 휴지통 조회에는 폴더 조건이 없다 — 창에 휴지통 전체가 뜨면 안 된다
  ] as const) {
    await open();
    act(() => sidebarSnapshot!.onChange(change));
    await settle();
    expect(peekWindow()).toBeNull();
    expect(librarySnapshot!.filters).toMatchObject(change);
    act(() => sidebarSnapshot!.onChange(back));
    await settle();
    expect(peekWindow()).toBeNull();
  }

  // 창이 떠 있는 동안 다빈치 선택 따라가기는 위치를 옮기지 않는다(창의 목록을 다른 폴더 카드로 갈아 끼우지 않는다). 닫은 뒤에는 다시 따라간다
  await open();
  const filtersInPeek = librarySnapshot!.filters;
  act(() => send(["other", "other-target"]));
  await settle();
  expect(peekWindow()).not.toBeNull();
  expect(librarySnapshot!.filters).toBe(filtersInPeek);
  expect(librarySnapshot!.genQuery).toMatchObject({ project_id: "resolve-project", folder_path: "episode/shot" });
  pressEscapeInPeek();
  await settle();
  act(() => send(["other", "other-target"]));
  await settle();
  expect(librarySnapshot!.filters).toMatchObject({ project_id: "other-project", folder_path: "episode/shot" });
  act(() => sidebarSnapshot!.onChange({ project_id: undefined, folder_path: undefined }));
  await settle();

  // 프롬프트를 숨기면(Ctrl+K) 선택 막대는 화면 위쪽에 뜬다 — 그 막대도 창이 떠 있는 동안에는 그리지 않는다
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })); });
  act(() => gridSnapshot!.onSelectedChange(new Set(["target"])));
  expect(document.querySelector(".selbar-top-float")).not.toBeNull();
  await open();
  act(() => gridSnapshot!.onSelectedChange(new Set(["target"])));
  expect(document.querySelector(".selbar-top-float")).toBeNull();
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })); });
  act(() => { document.querySelector(".folder-peek-catcher")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  await settle();

  // 크게 보기의 [부분 수정]으로 넘어가면 닫히고, 창에서 고른 선택을 본 목록으로 들고 나오지 않는다
  await open();
  act(() => gridSnapshot!.onSelectedChange(new Set(["target"])));
  act(() => { window.dispatchEvent(new CustomEvent("ch:partial-edit", { detail: { genId: "target" } })); });
  await settle();
  expect(peekWindow()).toBeNull();
  expect(gridSnapshot!.selectedIds.size).toBe(0);

  act(() => sidebarSnapshot!.onChange({ deleted_only: true }));
  await settle();
  expect(gridSnapshot!.onOpenFolder).toBeUndefined();
});
