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
let topBarOnTab: ((tab: Filters["tab"]) => void) | null; // 상단바 모의가 잡아 둔 탭 누름(2026-10-13 ① 공유 탭의 마지막 자리)
let canvasSidebarSnapshot: ComponentProps<typeof import("../src/components/sidebar/CanvasFolderSidebar").CanvasFolderSidebar> | null;
let refreshProjects: () => void;
const relinkOnWorkspaceChange = vi.fn();
const beginList = vi.fn(); // 목록 훅의 beginComposeList — 폴더 창을 열고 닫을 때 목록을 비우는지 본다
let setStaleList: (on: boolean) => void; // 목록 훅의 staleList(닫은 직후 옛 첫 쪽을 보이는 중)를 시험이 켜고 끈다
let setLoadingList: (on: boolean) => void; // 목록 훅의 loading(받는 중)
let setListBehind: (on: boolean) => void; // 목록 훅의 listBehind(화면의 목록이 아직 옛 조회의 것)
let bumpListRevision: () => void; // 목록 훅의 listRevision — 새 첫 쪽을 적용했다(조회가 바뀌어 받았든 같은 조회를 다시 받았든)
let setLibraryGens: (next: Generation[]) => void; // 목록 훅의 gens — 다시 받아 목록이 바뀐 것을 시험이 만든다
let startAuthPending = false; // 인증 훅을 '확인 중'으로 시작한다(새로 고친 직후) — 기본은 처음부터 끝난 상태
let setAuthPending: (on: boolean) => void; // 인증 확인이 끝났다고 알린다
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
  gridSnapshot = null; promptSnapshot = null; librarySnapshot = null; sidebarSnapshot = null; canvasSidebarSnapshot = null; topBarOnTab = null;
  startAuthPending = false;
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
    // 캔버스 '생성 결과' 창도 이 격자를 쓴다 — 그쪽은 셀만 그려 선택·강조를 보이고, 목록 격자만 담는다.
    //  구분은 그 창만 주는 lastViewedId 로 한다: '대표' 칸(cellHeader)은 공유 탭의 폴더 창 격자도 쓴다.
    if (props.cellHeader && props.lastViewedId !== undefined) return <>{props.generations.map((g) => (
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
    TopBar: ({ filters, inert, onTab }: { filters: { tab: string }; inert?: boolean; onTab: (tab: Filters["tab"]) => void }) => {
      topBarOnTab = onTab;
      return <output data-testid="tab" data-inert={inert || undefined}>{filters.tab}</output>;
    },
  }));
  vi.doMock("../src/lib/useHubAuth", () => ({
    useHubAuth: () => {
      const [authPending, setPending] = useState(startAuthPending);
      setAuthPending = setPending;
      return { authPending, authReady: !authPending, authConfig: { auth_enabled: true },
        account: { email: "fixture@example.invalid" }, hubAccount: null, finalizeProjects: new Set<string>(), sharedSrv: null, logout: noop, setAccount: noop };
    },
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
      // patchSceneById 의 반환은 '저장됐나' 다 — noop(undefined)이면 호출부가 저장 실패로 읽는다.
      sceneActionRef: useRef(null), flushScenePending: noop, patchSceneById: () => true, patchActiveScene: noop,
      selectScene: setActiveSceneId, addScene: noop, importSceneSnapshot: noop, renameScene: noop, removeSceneById: noop,
      reorderScenes: noop, setSceneWorkspace: noop, backupOnly: 0, importBackupScenes: noop };
    },
  }));
  vi.doMock("../src/lib/useGenerationLibraryData", () => ({
    useGenerationLibraryData: (args: NonNullable<typeof librarySnapshot>) => {
      librarySnapshot = args;
      const [gens, setGens] = useState<Generation[]>([]);
      setLibraryGens = setGens;
      const [location, setLocation] = useState<{ tab: "my" | "team"; value: GenerationLocation } | null>(null);
      const [projects, setProjects] = useState(initialProjects);
      const [staleList, setStale] = useState(false);
      setStaleList = setStale;
      const [loading, setLoad] = useState(false);
      setLoadingList = setLoad;
      const [listBehind, setBehind] = useState(false);
      setListBehind = setBehind;
      const [listRevision, setRevision] = useState(0);
      bumpListRevision = () => setRevision((revision) => revision + 1);
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
      reload: noop, reloadIfStale: noop, staleList, listBehind, listRevision,
    };
    },
  }));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
}

// 2026-10-13 Jay ①②(공유 탭 컷 카드 요청): 공유 탭을 떠났다 **직접 눌러** 돌아오면 같은 문맥(계정·서버·확정된 자동 공간)의 마지막 자리로. 사이드바·컷 카드로
//  들어간 자리는 브라우저 기록 한 칸 — 뒤로 가기가 들어가기 전 목록으로 돌아온다. 보는 자리만 되살린다(다음 생성 위치는 그대로).
it("공유 탭을 떠났다 직접 눌러 돌아오면 마지막 자리로, 사이드바로 들어간 폴더는 뒤로 가기로 돌아온다 — 첫 기록부터 자리를 싣고, 뒤로 가면 생성 위치도 그 자리로", async () => {
  // 틀의 프로젝트 목록에는 사이드바로 들어갈 프로젝트만 둔다 — 목록에 없는 "archived-project" 는 기억에서 그대로 되살아나야 한다(아래)
  installAppBoundaries([fixture], fixture.id, [{ id: "resolve-project", name: "Resolve" } as unknown as Project]);
  localStorage.setItem("ch.workspaceContext", JSON.stringify({ scope: "team", id: "view-workspace", name: "View workspace" }));
  localStorage.setItem("ch.lib.filtersV2", JSON.stringify({ tab: "team", project_id: "resolve-project", __v: "2", __view: JSON.stringify(["team", "view-workspace"]) }));
  localStorage.setItem("ch.lib.generationScopeV1", JSON.stringify({ project_id: "create", folder_path: "dest" }));
  const { default: App } = await import("../src/App");
  act(() => view.root.render(<StrictMode><App /></StrictMode>));
  await settle();
  const loc = () => (window.history.state as { chv: { loc?: { project_id?: string; folder_path?: string; ctx: string } } }).chv.loc;
  expect(librarySnapshot!.filters).toMatchObject({ tab: "team", project_id: "resolve-project" });
  expect(loc()?.project_id).toBe("resolve-project"); // 첫 기록부터 자리를 싣는다(프로젝트 맨 위 = 폴더 없음)
  const top = window.history.state;
  const before = window.history.length;
  act(() => sidebarSnapshot!.onChange({ project_id: "resolve-project", folder_path: "episode" })); // 사이드바 폴더 — 명시적 이동
  await settle();
  expect([librarySnapshot!.filters.folder_path, window.history.length - before, loc()?.folder_path]).toEqual(["episode", 1, "episode"]);
  const enteredEntry = window.history.state; // 폴더에 들어간 기록
  expect(JSON.parse(localStorage.getItem("ch.lib.teamLocationV1")!)).toMatchObject({ project_id: "resolve-project", folder_path: "episode" });
  expect(JSON.parse(localStorage.getItem("ch.lib.generationScopeV1")!)).toEqual({ project_id: "resolve-project", folder_path: "episode" }); // 눌러 들어가면 생성 위치도(전과 같다)
  act(() => topBarOnTab!("my")); // 다른 탭 — 자리가 지워진다(전처럼 — 생성 위치도 비워진다)
  await settle();
  expect([librarySnapshot!.filters.tab, librarySnapshot!.filters.project_id, loc()?.project_id]).toEqual(["my", undefined, undefined]);
  expect(JSON.parse(localStorage.getItem("ch.lib.generationScopeV1")!)).toEqual({});
  act(() => topBarOnTab!("team")); // 공유 탭을 직접 누름 — 마지막 자리
  await settle();
  expect(librarySnapshot!.filters).toMatchObject({ tab: "team", project_id: "resolve-project", folder_path: "episode" });
  expect(loc()).toMatchObject({ project_id: "resolve-project", folder_path: "episode" }); // 탭 기록의 자리도 되살린 자리로 고쳐 적혔다
  expect(JSON.parse(localStorage.getItem("ch.lib.generationScopeV1")!)).toEqual({}); // 되살리기는 보는 자리만 — 생성 위치는 건드리지 않는다(눌러 들어간 것이 아니다)
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: top }))); // 뒤로 — 폴더에 들어가기 전의 기록
  await settle();
  expect([librarySnapshot!.filters.tab, librarySnapshot!.filters.project_id, librarySnapshot!.filters.folder_path]).toEqual(["team", "resolve-project", undefined]);
  // 뒤로 가기로 자리가 바뀌면 다음 생성 위치도 그 자리로 — 눌러 들어간 것과 같다(Jay 2026-10-13 오후: 화면은 e035 인데 사이드바 표시는 C0110 이던 것)
  expect(JSON.parse(localStorage.getItem("ch.lib.generationScopeV1")!)).toEqual({ project_id: "resolve-project" });
  // 다른 문맥(공간)의 기록은 자리를 되살리지 않는다
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: { chv: { tab: "team", focusId: null, ov: null, key: 0, loc: { project_id: "other", folder_path: "x", ctx: "다른 문맥" } } } })));
  await settle();
  expect(librarySnapshot!.filters.project_id).toBe("resolve-project");
  // 휴지통 보기 — 자리에 실리고(기록 한 칸), 기억은 덮이지 않으며, 뒤로 가면 일반 목록
  const beforeTrash = window.history.length;
  act(() => sidebarSnapshot!.onChange({ deleted_only: true, project_id: undefined, include_deleted: undefined }));
  await settle();
  expect([librarySnapshot!.filters.deleted_only, window.history.length - beforeTrash, loc()?.deleted_only]).toEqual([true, 1, true]);
  // 기억은 휴지통 직전의 일반 자리(위에서 뒤로 가 프로젝트 맨 위) 그대로 — 휴지통의 '프로젝트 없음'으로 덮이지 않는다
  const memoryInTrash = JSON.parse(localStorage.getItem("ch.lib.teamLocationV1")!) as { project_id?: string; folder_path?: string };
  expect([memoryInTrash.project_id, memoryInTrash.folder_path]).toEqual(["resolve-project", undefined]);
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: top })));
  await settle();
  expect([librarySnapshot!.filters.deleted_only, librarySnapshot!.filters.project_id]).toEqual([undefined, "resolve-project"]);
  // 공유 탭 밖(작업 공간 탭)에서 뒤로 가도 공유 탭의 기록이면 그 폴더로 — 문맥은 지금 탭이 아니라 기록의 탭 기준(Codex 코드 리뷰)
  act(() => topBarOnTab!("my")); await settle();
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: enteredEntry }))); await settle();
  expect(librarySnapshot!.filters).toMatchObject({ tab: "team", project_id: "resolve-project", folder_path: "episode" });
  act(() => topBarOnTab!("my")); await settle();
  expect([librarySnapshot!.filters.tab, librarySnapshot!.filters.project_id]).toEqual(["my", undefined]);
  // 기억의 프로젝트가 사이드바 목록에 없어도 그대로 되살린다 — 목록은 보관·공간 제한이라 삭제의 증거가 아니다(Codex 코드 리뷰). 정말 사라졌으면 빈 목록.
  const myTop = window.history.state;
  act(() => sidebarSnapshot!.onChange({ project_id: "archived-project", folder_path: "ep" })); await settle(); // 눌러 고름 — 생성 위치도
  expect(JSON.parse(localStorage.getItem("ch.lib.generationScopeV1")!)).toEqual({ project_id: "archived-project", folder_path: "ep" });
  const archivedEntry = window.history.state; // 목록에 없는 프로젝트에 들어간 기록
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: myTop }))); await settle(); // 뒤로 — 맨 위(생성 위치도 맨 위로)
  expect(librarySnapshot!.filters.project_id).toBeUndefined();
  expect(JSON.parse(localStorage.getItem("ch.lib.generationScopeV1")!)).toEqual({});
  const saved = JSON.parse(localStorage.getItem("ch.lib.teamLocationV1")!) as { ctx: string };
  localStorage.setItem("ch.lib.teamLocationV1", JSON.stringify({ ...saved, project_id: "archived-project", folder_path: "ep" }));
  act(() => topBarOnTab!("team")); await settle();
  expect([librarySnapshot!.filters.tab, librarySnapshot!.filters.project_id, librarySnapshot!.filters.folder_path]).toEqual(["team", "archived-project", "ep"]);
  act(() => refreshProjects()); await settle(); // 프로젝트 목록 갱신 — 목록에 없지만 되살린 자리는 둔다
  expect([librarySnapshot!.filters.project_id, librarySnapshot!.filters.folder_path]).toEqual(["archived-project", "ep"]);
  expect(JSON.parse(localStorage.getItem("ch.lib.generationScopeV1")!)).toEqual({}); // 기억 되살림은 보는 자리만 — 생성 위치는 건드리지 않는다
  // 기록으로 돌아온 자리도 지우지 않는다 — 이때는 생성 위치가 같은 프로젝트가 되지만(뒤로·앞으로 가기는 생성 위치도 옮긴다) '낡은 프로젝트' 효과가
  //  되살린 자리를 지우지 않는다(되살린 자리 표식을 생성 위치를 옮긴 **뒤에** 켠다 — Codex 3차 P2 의 경우가 이제 이 길로 난다)
  act(() => topBarOnTab!("my")); await settle(); // 다른 자리(맨 위)로 — 같은 자리의 기록이면 생성 위치를 옮기지 않는다(자리가 바뀔 때만)
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: archivedEntry }))); await settle();
  expect([librarySnapshot!.filters.tab, librarySnapshot!.filters.project_id, librarySnapshot!.filters.folder_path]).toEqual(["my", "archived-project", "ep"]);
  expect(JSON.parse(localStorage.getItem("ch.lib.generationScopeV1")!)).toEqual({ project_id: "archived-project", folder_path: "ep" });
  act(() => refreshProjects()); await settle();
  expect([librarySnapshot!.filters.project_id, librarySnapshot!.filters.folder_path]).toEqual(["archived-project", "ep"]);
  act(() => sidebarSnapshot!.onChange({ project_id: "archived-project", folder_path: "ep" })); await settle(); // 눌러서 고른 자리는 전처럼 — 목록에 없으면 지운다
  act(() => refreshProjects()); await settle();
  expect(librarySnapshot!.filters.project_id).toBeUndefined();
  // 다른 문맥(다른 공간)의 기억은 되살리지 않는다 — 맨 위
  act(() => topBarOnTab!("my")); await settle();
  localStorage.setItem("ch.lib.teamLocationV1", JSON.stringify({ ctx: "다른 공간", project_id: "resolve-project", folder_path: "episode" }));
  act(() => topBarOnTab!("team")); await settle();
  expect([librarySnapshot!.filters.tab, librarySnapshot!.filters.project_id]).toEqual(["team", undefined]);
});

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
  // 조회를 보낼 수 없는 화면이다 — 자리를 옮겼고 목록이 '아직 옛것'이어도(받은 적이 없다) 잠그지 않는다: 잠그면 여기서 나가는 [전체 보기]가
  //  안 눌린다(Codex 31회차 코드 리뷰). 자리를 옮겨야 '옮긴 뒤' 조건이 선다 — 프로젝트를 골랐다가 푼다.
  act(() => { sidebarSnapshot!.onChange({ project_id: "resolve-project" }); setListBehind(true); });
  expect(document.querySelector("main.main")!.hasAttribute("inert")).toBe(false);
  act(() => { sidebarSnapshot!.onChange({ project_id: undefined }); setListBehind(false); });
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
  act(() => setLibraryGens([libraryGeneration("target")])); // 고를 카드는 목록에 있다(목록에 없는 id 는 선택에서 빠진다)
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

// 15회차(조작 규칙 42): 선택은 id 집합이라, 목록에서 빠진 카드(다른 폴더로 담음·다른 창의 삭제·자동 새로고침)가 선택에 남았다 —
//  남은 카드를 Ctrl+클릭해 삭제하면 보이지 않는 그 카드까지 지워졌다(삭제·복원·담기·색·d 는 선택 id 를 그대로 쓴다).
it("App: 목록에서 사라진 카드는 선택에서도 빠진다 — 남은 카드에 건 다음 조작에 섞이지 않는다", async () => {
  await mountApp("my");
  act(() => setLibraryGens([libraryGeneration("a"), libraryGeneration("b"), libraryGeneration("c")]));
  act(() => gridSnapshot!.onSelectedChange(new Set(["a", "c"])));
  expect(gridSnapshot!.selectedIds).toEqual(new Set(["a", "c"]));
  act(() => setLibraryGens([libraryGeneration("b"), libraryGeneration("c")])); // a 가 목록에서 빠졌다
  expect(gridSnapshot!.selectedIds).toEqual(new Set(["c"])); // 전엔 a 가 남아 '2개 선택'이었다
  act(() => gridSnapshot!.onSelectedChange(new Set([...gridSnapshot!.selectedIds, "b"]))); // 남은 카드를 Ctrl+클릭
  expect(gridSnapshot!.selectedIds).toEqual(new Set(["b", "c"]));
  // 같은 카드가 새 객체로 다시 와도(다시 받기) 선택은 그대로다 · 목록이 늘어도(더 보기) 그대로다
  act(() => setLibraryGens([libraryGeneration("b"), libraryGeneration("c"), libraryGeneration("d")]));
  expect(gridSnapshot!.selectedIds).toEqual(new Set(["b", "c"]));
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

    // 6) 닫는 순간 초점이 창의 툴바가 연 태그 패널에 있었어도 '창 안의 초점'이다 — 패널은 body 에 그려지고, 연 툴바를 표로 가리킨다(R14)
    await open();
    const bar = peekWindow()!.appendChild(document.createElement("div"));
    bar.dataset.floatOwner = "peek-bar";
    const floating = document.body.appendChild(document.createElement("div"));
    floating.dataset.floatOf = "peek-bar";
    floating.appendChild(document.createElement("button")).focus();
    pressEscapeInPeek();
    await settle();
    floating.remove(); // 창(툴바)과 함께 패널도 사라진다 — 초점은 BODY 로 떨어진다
    expect(document.activeElement).toBe(document.body);
    act(() => setLoadingList(false));
    expect(document.activeElement).toBe(grid());
  } finally {
    gridClass = "gen-grid";
    beginList.mockReset();
    elsewhere.remove();
    document.querySelectorAll("[data-float-of]").forEach((left) => left.remove());
  }
});

it("App 작업 공간: 바깥 막·✕ 로 닫히고, 보던 위치가 바뀌거나 부분 수정으로 넘어가도 닫힌다 — 휴지통 보기에는 이름표가 없다", async () => {
  const send = await mountApp("my");
  act(() => setLibraryGens([libraryGeneration("target")])); // 고를 카드는 목록에 있다
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

  // 프롬프트를 숨기면(Ctrl+K) 선택 막대는 화면 아래 묶음(.dock-float)에 뜬다(29회차 — 전엔 위쪽) — 그 막대도 창이 떠 있는 동안에는 그리지 않는다
  act(() => setLibraryGens([libraryGeneration("target")])); // 위의 따라가기가 목록을 other 들로 갈아 끼웠다 — 고를 카드를 다시 둔다
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })); });
  act(() => gridSnapshot!.onSelectedChange(new Set(["target"])));
  expect(document.querySelector(".dock-float .selbar-bottom-float")).not.toBeNull();
  await open();
  act(() => gridSnapshot!.onSelectedChange(new Set(["target"])));
  expect(document.querySelector(".selbar-bottom-float")).toBeNull();
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

it("App 편집 탭: 들어가면 폴더 창이 닫히고 다빈치 선택이 숨은 목록을 옮기지 않는다 — 나와도 창은 되살아나지 않는다", async () => {
  vi.doMock("../src/components/timeline/EditTab", () => ({ EditTab: () => <div data-testid="edit-tab" /> }));
  const send = await mountApp("my");
  const body = () => document.querySelector<HTMLElement>(".body")!;
  // 편집은 filters.tab 의 값이 아니라 내비 기록의 '보기'다 — 뒤로/앞으로 가기로도 들어오고 나간다.
  const editView = (edit: boolean) => act(() => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: { chv: { tab: "my", focusId: null, ov: null, key: 0, edit } } }));
  });
  act(() => gridSnapshot!.onOpenFolder!(libraryGeneration("target")));
  await settle();
  expect(peekWindow()).not.toBeNull();
  expect(body().hasAttribute("inert")).toBe(true);

  editView(true);
  await settle();
  await settle();
  expect(document.querySelector('[data-testid="edit-tab"]')).not.toBeNull();
  expect(peekWindow()).toBeNull();
  expect(body().hasAttribute("inert")).toBe(false); // 편집 화면이 조작 불가가 되지 않는다
  expect(document.querySelector('[data-testid="tab"]')!.textContent).toBe("my"); // 밑의 탭은 그대로

  const filtersInEdit = librarySnapshot!.filters;
  act(() => send(["other", "other-target"])); // 편집 중의 다빈치 선택은 숨은 목록의 위치를 옮기지 않는다
  await settle();
  expect(librarySnapshot!.filters).toBe(filtersInEdit);

  editView(false);
  await settle();
  expect(document.querySelector('[data-testid="edit-tab"]')).toBeNull();
  expect(peekWindow()).toBeNull();
  expect(gridSnapshot!.selectedIds.size).toBe(0);
  act(() => send(["other", "other-target"])); // 나온 뒤에는 다시 따라간다
  await settle();
  expect(librarySnapshot!.filters).toMatchObject({ project_id: "other-project", folder_path: "episode/shot" });
});

// 편집 탭의 컷 더블클릭(Jay 2026-10-08) — 공유 & 리뷰의 폴더 창을 그대로 쓴다. 창이 떠 있는 동안 목록·카드·액션만 공유 & 리뷰로
//  보고, 저장된 탭·다음 생성 위치·뒤로가기 기록은 건드리지 않는다(탭을 실제로 바꿨다 되돌리면 기록·저장에 임시 상태가 샌다).
it.each(["my", "compose"])("App 편집 탭(밑의 탭 %s): 컷을 더블클릭하면 공유 & 리뷰의 폴더 창이 그 컷 폴더로 뜬다 — 닫으면 밑의 탭은 그대로다", async (tab) => {
  type EditProps = ComponentProps<typeof import("../src/components/timeline/EditTab").EditTab>;
  let editProps: EditProps | null = null;
  vi.doMock("../src/components/timeline/EditTab", () => ({
    EditTab: (props: EditProps) => { editProps = props; return <div data-testid="edit-tab" />; },
  }));
  localStorage.setItem("ch.lib.generationScopeV1", JSON.stringify({ project_id: "generation-project", folder_path: "next/clip" }));
  await mountApp(tab);
  const body = () => document.querySelector<HTMLElement>(".body")!;
  const editView = (edit: boolean) => act(() => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: { chv: { tab, focusId: null, ov: null, key: 0, edit } } }));
  });
  const storedTab = () => JSON.parse(localStorage.getItem("ch.lib.filtersV2")!).tab;
  const marks = { g1: { label: "V1 - 선택 카드", lead: false }, g2: { label: "V2 - 선택 카드", lead: true } };
  const openCut = () => act(() => editProps!.onOpenCutFolder({
    projectId: "edit-project", projectName: "Edit project", path: "e035/C0050", focusId: "g2", marks,
  }));
  editView(true);
  await settle();
  await settle();
  beginList.mockClear();
  const filtersInEdit = librarySnapshot!.filters;
  const scopeBefore = localStorage.getItem("ch.lib.generationScopeV1");
  expect(editProps!.keysActive).toBe(true);
  expect(editProps!.reloadSignal).toBe(0);

  openCut();
  await settle();
  expect(peekWindow()!.querySelector(".folder-peek-title")!.textContent).toBe("Edit project / e035/C0050");
  expect(librarySnapshot!.filters.tab).toBe("team"); // 목록 훅·액션은 공유 & 리뷰로 본다
  expect(librarySnapshot!.genQuery).toMatchObject({ tab: "team", project_id: "edit-project", folder_path: "e035/C0050" });
  expect(gridSnapshot!.tab).toBe("team");
  expect(gridSnapshot!.cardMarks).toEqual(marks); // 타임라인에 넣은 카드의 표
  expect(gridSnapshot!.openedFromId).toBeUndefined(); // '방금 누른 카드'가 아니다
  expect(gridSnapshot!.resolveScrollRequest).toEqual({ generationId: "g2", nonce: 0 }); // 지금 보이는 카드로 내려간다
  expect(gridSnapshot!.onOpenFolder).toBeUndefined();
  expect(body().hasAttribute("inert")).toBe(true);
  expect(editProps!.keysActive).toBe(false); // 편집 키는 쉬고, 창 안에서는 라이브러리 키가 듣는다
  expect(beginList).toHaveBeenCalledTimes(1);
  expect(beginList).toHaveBeenLastCalledWith(); // 밑의 탭 목록은 숨어 있다 — 사본을 담지 않는다
  expect(storedTab()).toBe(tab); // 저장된 탭은 그대로
  expect(localStorage.getItem("ch.lib.generationScopeV1")).toBe(scopeBefore);
  expect(promptSnapshot?.activeProjectId).toBe("generation-project");

  // 창의 카드를 휠 클릭하면 편집 탭의 트랙 메뉴로 간다(편집 탭이 ref 에 걸어 둔다). 편집 탭이 표를 다시 알리면 창의 카드 표만
  //  바뀐다 — 창은 그대로다(열릴 때의 '그 카드로 내려가기'를 다시 하지 않는다).
  expect(editProps!.peekPath).toBe("e035/C0050");
  const cardMenu = vi.fn();
  editProps!.cardMenuRef.current = cardMenu;
  gridSnapshot!.onCardMenu!({ id: "g1" } as never, 5, 6);
  expect(cardMenu).toHaveBeenCalledExactlyOnceWith({ id: "g1" }, 5, 6);
  const scrollAtOpen = gridSnapshot!.resolveScrollRequest;
  const moved = { g1: { label: "V1 - 선택 카드", lead: true } };
  act(() => editProps!.onPeekMarks(moved));
  expect(gridSnapshot!.cardMarks).toEqual(moved);
  expect(gridSnapshot!.resolveScrollRequest).toBe(scrollAtOpen);
  expect(beginList).toHaveBeenCalledTimes(1);

  // 창에서 크게 보기를 열면 뒤로가기 기록이 하나 쌓인다 — 그 기록의 탭은 저장된 탭이다(임시 '공유 & 리뷰'가 남으면, 창을 닫은
  //  뒤 앞으로 가기로 그 기록에 돌아왔을 때 밑의 탭이 바뀐다).
  act(() => gridSnapshot!.onPreview({ url: "/media/x.png", type: "image", name: "x" }));
  expect(window.history.state.chv).toMatchObject({ tab, edit: true, ov: "preview" });
  // 크게 보기를 닫고 편집 기록으로 돌아와도(뒤로가기) 창은 그대로다 — 기록의 탭이 창을 깨지 않는다.
  editView(true);
  await settle();
  expect(peekWindow()).not.toBeNull();
  expect(librarySnapshot!.filters.tab).toBe("team");

  pressEscapeInPeek();
  await settle();
  expect(peekWindow()).toBeNull();
  expect(body().hasAttribute("inert")).toBe(false);
  expect(librarySnapshot!.filters).toBe(filtersInEdit); // 밑의 탭·필터가 그대로 돌아온다
  expect(document.querySelector('[data-testid="tab"]')!.textContent).toBe(tab);
  expect(beginList).toHaveBeenCalledTimes(2);
  expect(beginList).toHaveBeenLastCalledWith(); // 창의 카드가 밑의 탭 목록에 남지 않게 비운다
  expect(editProps!.keysActive).toBe(true);
  expect(editProps!.reloadSignal).toBe(1); // 편집 탭은 공유 목록을 다시 받는다(창에서 공유를 풀거나 지웠을 수 있다)
  expect(editProps!.peekPath).toBeNull();
  expect(storedTab()).toBe(tab);
  expect(localStorage.getItem("ch.lib.generationScopeV1")).toBe(scopeBefore);

  // 창이 뜬 채 편집을 떠나면(뒤로가기) 창은 닫히고, 떠난 탭이 공유 & 리뷰로 그려지지 않는다.
  openCut();
  await settle();
  expect(peekWindow()).not.toBeNull();
  editView(false);
  expect(document.querySelector('[data-testid="tab"]')!.textContent).toBe(tab); // 그 렌더부터
  await settle();
  expect(peekWindow()).toBeNull();
  expect(librarySnapshot!.filters.tab).toBe(tab);
  expect(beginList).toHaveBeenCalledTimes(3); // 문맥이 바뀌어 닫힌 창은 목록을 비우지 않는다 — 바뀐 문맥의 조회가 채운다
  editView(true); // 다시 들어와도 창이 되살아나지 않는다
  await settle();
  await settle();
  expect(peekWindow()).toBeNull();
  expect(librarySnapshot!.filters.tab).toBe(tab);
});

it("App 편집 탭(캔버스에서 들어옴): 편집 중의 다빈치 선택은 씬을 바꾸거나 창을 열지 않는다 — 나온 뒤의 선택은 다시 따른다", async () => {
  vi.doMock("../src/components/timeline/EditTab", () => ({ EditTab: () => <div data-testid="edit-tab" /> }));
  const send = await mountApp();
  const editView = (edit: boolean) => act(() => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: { chv: { tab: "compose", focusId: null, ov: null, key: 0, edit } } }));
  });
  editView(true);
  await settle();
  await settle();
  expect(document.querySelector('[data-testid="edit-tab"]')).not.toBeNull();
  act(() => send(["other-target"])); // 다른 씬의 결과 — 캔버스였다면 그 씬으로 옮기고 '생성 결과' 창을 연다
  await settle();
  editView(false);
  await settle();
  expect(view.container.querySelector(".scene-varwin")).toBeNull();
  expect(tile("other-target")).toBeNull();
  act(() => send(["other-target"]));
  await settle();
  expect(tile("other-target")).toBeTruthy();
  expect(resolveHighlightedIds()).toEqual(["other-target"]);
});

// ── 공유 & 리뷰 탭의 폴더 묶음 보기(2026-10-08) ──
type ToolbarProps = ComponentProps<typeof import("../src/components/LibraryToolbar").LibraryToolbar>;
let toolbarSnapshot: ToolbarProps | null = null;
const withAsset = (id: string): Generation => ({
  ...libraryGeneration(id), assets: [{ type: "image", file_path: `/media/${id}.png`, thumbnail_path: `/media/${id}.png` }],
} as Generation);
const cutCards = (rep = false) => ({ parent: "episode", own_count: 2, folders: [
  { path: "episode/other", name: "other", count: 4, rep: false, cover: withAsset("neighbour") },
  { path: "episode/shot", name: "shot", count: 3, rep, cover: withAsset("target") },
] });
// 부모 경로별 답 — 들어간 폴더의 [대표]는 부모 범위를 따로 받으므로(2026-10-13 ②) 어느 부모를 묻는지에 따라 답이 다르다. rep() = 'shot' 의 대표가 정해졌나.
const topCards = { parent: "", own_count: 0, folders: [{ path: "episode", name: "episode", count: 9, rep: false, subfolders: 2, cover: withAsset("ep") }] };
const byParent = (rep: () => boolean) => vi.fn((_pid: string, parent: string) =>
  Promise.resolve(parent === "episode" ? cutCards(rep()) : parent === "" ? topCards : { parent, own_count: 3, folders: [] }));
const cutGrid = () => document.querySelector<HTMLElement>("main.main .cut-grid");
// 컷 카드는 이름표(.cut-tab), 에피소드 화면의 카드는 표지 위 이름(.ep-cap > b · 리스트는 .ep-name) — 2026-10-13
const cutTile = (name: string) => [...document.querySelectorAll<HTMLElement>("main.main .cut-card:not(.cut-out)")]
  .find((tile) => tile.querySelector(".cut-tab > span, .ep-cap > b, .ep-name")!.textContent === name)!;
type Pill = { type: string; props: { className: string; disabled?: boolean; onMouseDown?: (event: { preventDefault: () => void; button: number }) => void } };
const pill = (id: string) => gridSnapshot!.cellHeader!(withAsset(id)) as unknown as Pill | null;

async function mountTeamFolder(api: Record<string, unknown>, more: Partial<Filters> = {}) {
  installAppBoundaries([fixture, otherScene]);
  toolbarSnapshot = null;
  // 마지막에 그린 것이 남는다 — 폴더 창이 뜨면 뒤의 사본을 먼저, 창의 툴바를 나중에 그리므로 창의 것이 남는다. 그린 자리는 표식으로 본다.
  vi.doMock("../src/components/LibraryToolbar", () => ({ LibraryToolbar: (props: ToolbarProps) => {
    toolbarSnapshot = props;
    return <i data-toolbar="" data-cut={props.folderCards ? "1" : "0"} data-tags={props.tagPanelOpen ? "1" : "0"} />;
  } }));
  Object.assign(boundary.api, api);
  localStorage.setItem("ch.lib.filtersV2", JSON.stringify({ tab: "team", __v: "2" }));
  const { default: App } = await import("../src/App");
  act(() => view.root.render(<StrictMode><App /></StrictMode>));
  await settle();
  act(() => sidebarSnapshot!.onChange({ project_id: "resolve-project", folder_path: "episode", ...more }));
  await settle();
}

it("App 공유·리뷰: 폴더를 고르면 바로 아래 폴더마다 카드 한 장 — 고른 것은 비우고, 폴더 창(카드의 폴더 이름표)에서 대표를 정한다", { timeout: 20_000 }, async () => {
  let repOn = false;
  const folderCards = byParent(() => repOn);
  let saved!: () => void;
  const setFolderCover = vi.fn(() => new Promise<void>((resolve) => { saved = resolve; }));
  localStorage.setItem("ch.lib.cutView", "0"); // 한 장씩 보기로 시작
  await mountTeamFolder({ folderCards, setFolderCover });
  act(() => setLibraryGens([libraryGeneration("target")])); // 고를 카드는 목록에 있다

  // 한 장씩 보는 동안 하위 묶음은 받지 않는다 — 들어가 있는 폴더(episode)의 대표를 알려고 부모("")만 받는다(2026-10-13 ②). 전환 단추는 보인다
  expect(folderCards.mock.calls.map((call) => call[1])).toEqual([""]);
  expect(toolbarSnapshot!.folderCards).toMatchObject({ on: false, summary: undefined });
  expect(cutGrid()).toBeNull();
  act(() => gridSnapshot!.onSelectedChange(new Set(["target"])));
  expect(promptSnapshot?.topSlot).toBeTruthy();

  // [컷별] — 격자 자리에 컷 카드. 고른 것은 비운다(남기면 보이지 않는 카드에 삭제·공유가 걸린다)
  act(() => toolbarSnapshot!.folderCards!.onChange(true));
  await settle();
  expect(localStorage.getItem("ch.lib.cutView")).toBe("1");
  expect(folderCards).toHaveBeenLastCalledWith("resolve-project", "episode", "view-workspace");
  expect([...cutGrid()!.querySelectorAll(".cut-tab > span")].map((name) => name.textContent)).toEqual(["other", "shot"]);
  expect(gridOutputs()).toHaveLength(0);
  expect(promptSnapshot?.topSlot).toBeUndefined();
  expect(toolbarSnapshot!.folderCards).toMatchObject({ on: true, summary: { folders: 2, items: 9 } });
  expect(cutGrid()!.querySelector(".cut-out-count")!.textContent).toBe("컷 밖 2건"); // 폴더에 직접 든 것은 맨 끝 칸으로

  // '컷 밖' 칸(또는 [전체]) — 다시 한 장씩
  act(() => cutGrid()!.querySelector<HTMLButtonElement>(".cut-out")!.click());
  await settle();
  expect(localStorage.getItem("ch.lib.cutView")).toBe("0");
  expect(cutGrid()).toBeNull();
  expect(gridOutputs()).toHaveLength(1);

  // 카드의 폴더 이름표 → 그 폴더의 창(컷 카드 두 번 클릭은 창이 아니라 이동 — 아래 시험). 창 안 카드 위의 [대표] — 대표가 아직 없으니 모두 지정 단추. 그림이 없는 것에는 없다.
  const backKey = JSON.stringify(librarySnapshot!.genQuery);
  beginList.mockClear();
  const behindToolbar = () => document.querySelector("main.main .lib-toolbar-behind [data-toolbar]");
  expect([behindToolbar(), document.querySelectorAll("main.main [data-toolbar]").length]).toEqual([null, 1]); // 창이 없을 때는 도구 줄 하나
  act(() => gridSnapshot!.onOpenFolder!(libraryGeneration("target")));
  await settle();
  expect(peekWindow()!.querySelector(".folder-peek-title")!.textContent).toBe("Resolve project / episode/shot");
  // 창 뒤의 도구 줄 자리에는 사본이 남는다(Jay 2026-10-13 — 창을 열어도 뒤 화면이 그대로, 흐리게만). 전환 단추는 사본에만 있고,
  //  창 밖에 뜨는 태그 패널은 사본이 그리지 않는다. 눌리는 것은 창의 툴바 하나다(뒤 화면은 inert)
  expect([behindToolbar()?.getAttribute("data-cut"), behindToolbar()?.getAttribute("data-tags"), behindToolbar()?.closest("[aria-hidden]") !== null])
    .toEqual(["1", "0", true]);
  expect(peekWindow()!.querySelector("[data-toolbar]")!.getAttribute("data-cut")).toBe("0");
  expect(document.querySelector<HTMLElement>(".body")!.hasAttribute("inert")).toBe(true);
  expect(librarySnapshot!.genQuery).toMatchObject({ tab: "team", project_id: "resolve-project", folder_path: "episode/shot" });
  expect(beginList).toHaveBeenLastCalledWith({ keep: backKey });
  expect(peekWindow()!.contains(gridOutputs()[0])).toBe(true);
  expect(toolbarSnapshot!.folderCards).toBeUndefined(); // 창 안의 툴바에는 전환 단추가 없다
  expect(pill("target")).toMatchObject({ type: "button", props: { className: "scene-varpop-rep", disabled: false } });
  expect(gridSnapshot!.cellHeader!(libraryGeneration("no-asset"))).toBeNull();
  const preventDefault = vi.fn();
  const requests = folderCards.mock.calls.length;
  repOn = true; // 저장 뒤 서버가 돌려줄 값
  act(() => pill("target")!.props.onMouseDown!({ preventDefault, button: 2 })); // 우클릭 — 팀의 대표가 바뀌면 안 된다
  expect(setFolderCover).not.toHaveBeenCalled();
  act(() => pill("target")!.props.onMouseDown!({ preventDefault, button: 0 }));
  expect(preventDefault).toHaveBeenCalled(); // 단추가 초점을 가져가지 않게
  expect(setFolderCover).toHaveBeenCalledWith("resolve-project", "episode/shot", "target");
  // 저장하는 동안은 잠근다 — 먼저 그리지 않고, 또 눌러도 한 번만 보낸다
  expect(pill("target")).toMatchObject({ type: "button", props: { disabled: true } });
  act(() => pill("sibling")!.props.onMouseDown!({ preventDefault, button: 0 }));
  expect(setFolderCover).toHaveBeenCalledTimes(1);
  expect(folderCards).toHaveBeenCalledTimes(requests);
  // 끝나면 서버 값을 다시 읽은 뒤에 푼다
  await act(async () => { saved(); });
  await settle();
  expect(folderCards.mock.calls.length).toBeGreaterThan(requests);
  expect(pill("target")).toMatchObject({ type: "span", props: { className: "scene-varpop-cur" } });
  expect(pill("sibling")).toMatchObject({ type: "button", props: { disabled: false } });

  // 닫으면 뒤 목록이 조작 가능해질 때까지 잠근다(목록 훅처럼: 닫을 때(restore) 옛 첫 쪽을 먼저 보인다). 다시 [컷별]로 보면 새 대표를 안다
  beginList.mockImplementationOnce((back?: { restore?: string }) => { if (back?.restore !== undefined) setStaleList(true); });
  pressEscapeInPeek();
  await settle();
  expect(peekWindow()).toBeNull();
  expect(document.querySelector("main.main")!.hasAttribute("inert")).toBe(true); // 잠긴 동안은 눌리지 않는다
  act(() => setStaleList(false));
  act(() => toolbarSnapshot!.folderCards!.onChange(true));
  await settle();
  expect(cutTile("shot").querySelector(".cut-pill")).toBeNull();
  expect(cutTile("other").querySelector(".cut-pill")!.textContent).toBe("대표 미정");
  expect(gridOutputs()).toHaveLength(0);
});

it("App 공유·리뷰: 대표 저장이 실패해도 서버 값을 다시 읽고 단추를 푼다 — 들어간 폴더의 카드 위에서", { timeout: 20_000 }, async () => {
  const folderCards = byParent(() => false);
  const setFolderCover = vi.fn().mockRejectedValue(new Error("404: 이 폴더에서 볼 수 있는 공유물이 아닙니다"));
  await mountTeamFolder({ folderCards, setFolderCover });
  act(() => sidebarSnapshot!.onChange({ project_id: "resolve-project", folder_path: "episode/shot" })); // 사이드바로 컷에 들어간다
  await settle();
  expect(peekWindow()).toBeNull();
  const requests = folderCards.mock.calls.length;
  act(() => pill("target")!.props.onMouseDown!({ preventDefault: () => {}, button: 0 }));
  await settle();
  expect(setFolderCover).toHaveBeenCalledWith("resolve-project", "episode/shot", "target");
  expect(folderCards.mock.calls.length).toBeGreaterThan(requests);
  expect(pill("target")).toMatchObject({ type: "button", props: { disabled: false } });
});

// 2026-10-13 낮(Jay): 컷 카드 두 번 클릭 = 모아보기, 우클릭 = 그 폴더의 창(아침의 ② '두 번 클릭 = 들어가기'를 뒤집음). 들어가기는 에피소드 카드(하위 폴더
//  있음)의 두 번 클릭(기록 한 칸 — 뒤로 가기가 돌아온다)과 사이드바. 사이드바로 들어간 컷의 낱장 목록 카드 위에 **그 폴더의** [대표](② A안은 남는다) —
//  지금 대표는 부모의 컷 카드 목록에서 읽고(부모 범위를 따로 받는다), 저장 뒤엔 부모·하위 둘 다 다시 읽는다. 프로젝트 맨 위(폴더 없음)에는 [대표]가 없다.
it("App 공유·리뷰: 컷 두 번 클릭 = 모아보기 · 우클릭 = 폴더 창 · 에피소드 두 번 클릭 = 들어가기(기록 한 칸) · 사이드바로 들어간 컷의 카드 위 [대표]", { timeout: 20_000 }, async () => {
  let repOn = false; // 처음엔 'shot' 의 표지가 최신 것일 뿐 대표가 아니다 → 저장 뒤 대표
  const folderCards = byParent(() => repOn);
  let saved!: () => void;
  const setFolderCover = vi.fn(() => new Promise<void>((resolve) => { saved = resolve; }));
  const generationMetrics = vi.fn().mockResolvedValue({ real_credits: 1, est_credits: null, credit_source: null, elapsed_seconds: null });
  localStorage.setItem("ch.lib.cutView", "1");
  await mountTeamFolder({ folderCards, setFolderCover, generationMetrics });
  expect(cutGrid()).not.toBeNull(); // episode 의 컷 카드 둘
  expect(gridSnapshot!.cellHeader).toBeUndefined(); // 묶음 보기 중에는 카드 위 [대표]가 없다(격자에 생성물이 없다)
  const before = window.history.length;
  // 컷(잎) 두 번 클릭 — 모아보기(그 컷 하나). 이동도 창도 기록도 아니다
  const reel = () => document.querySelector<HTMLElement>(".reel");
  act(() => { cutTile("shot").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await settle();
  expect([reel()?.getAttribute("aria-label"), peekWindow(), librarySnapshot!.filters.folder_path, window.history.length - before]).toEqual(["모아보기", null, "episode", 0]);
  expect([...reel()!.querySelectorAll(".reel-ttl b")].map((el) => el.textContent)).toEqual(["shot"]);
  act(() => { reel()!.querySelector<HTMLButtonElement>(".assets-x")!.click(); });
  expect(reel()).toBeNull();
  // 컷 우클릭(메뉴 키) — 그 폴더의 창. 뒤의 컷 카드는 그대로
  act(() => { cutTile("shot").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await settle();
  expect(peekWindow()!.querySelector(".folder-peek-title")!.textContent).toBe("Resolve project / episode/shot");
  expect([cutGrid() !== null, reel()]).toEqual([true, null]);
  pressEscapeInPeek();
  await settle();
  expect(peekWindow()).toBeNull();
  // 프로젝트 맨 위 — 에피소드 카드 두 번 클릭 = 그 폴더로 들어간다(창 없음·기록 한 칸), 뒤로 가기가 맨 위로 돌아온다
  act(() => sidebarSnapshot!.onChange({ folder_path: undefined }));
  await settle();
  expect(cutTile("episode")).toBeDefined();
  const topEntry = window.history.state;
  const mark = window.history.length;
  act(() => { cutTile("episode").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await settle();
  expect([peekWindow(), reel(), librarySnapshot!.filters.folder_path, window.history.length - mark, cutTile("shot") !== undefined]).toEqual([null, null, "episode", 1, true]);
  act(() => { window.dispatchEvent(new PopStateEvent("popstate", { state: topEntry })); }); // jsdom 의 history.back() 은 popstate 를 바로 내지 않아 그 기록으로 직접 낸다
  await settle();
  expect([librarySnapshot!.filters.folder_path, cutTile("episode") !== undefined]).toEqual([undefined, true]);
  // 사이드바로 컷에 들어가면 낱장 목록 — 그 폴더(episode/shot)의 대표는 부모(episode)의 컷 카드에서 읽는다: 표지('target')가 최신 것일 뿐이면 모두 지정 단추
  act(() => sidebarSnapshot!.onChange({ project_id: "resolve-project", folder_path: "episode/shot" }));
  await settle();
  expect([peekWindow(), cutGrid()]).toEqual([null, null]); // 잎 — 낱장 목록
  expect(folderCards.mock.calls.map((call) => call[1])).toContain("episode");
  expect(pill("target")).toMatchObject({ type: "button", props: { className: "scene-varpop-rep", disabled: false } });
  expect(pill("neighbour")).toMatchObject({ type: "button", props: { className: "scene-varpop-rep", disabled: false } });
  const requests = folderCards.mock.calls.length;
  repOn = true; // 저장 뒤 서버가 돌려줄 값
  act(() => pill("target")!.props.onMouseDown!({ preventDefault: () => {}, button: 0 }));
  expect(setFolderCover).toHaveBeenCalledWith("resolve-project", "episode/shot", "target");
  expect(pill("target")).toMatchObject({ type: "button", props: { disabled: true } }); // 저장 중 잠금 — 먼저 그리지 않는다
  act(() => saved());
  await settle();
  // 저장 뒤 부모(episode)와 하위(episode/shot) 둘 다 다시 읽는다 — 그제야 ★
  const after = folderCards.mock.calls.slice(requests).map((call) => call[1]);
  expect(after).toContain("episode");
  expect(after).toContain("episode/shot");
  expect(pill("target")).toMatchObject({ type: "span", props: { className: "scene-varpop-cur" } });
  expect(pill("neighbour")).toMatchObject({ type: "button", props: { disabled: false } });
});

// 2026-10-13 밤(배포 전 점검, Codex): 폴더를 옮길 때마다 같은 묶음 조회가 두 번 나갔다(자리 변경으로 한 번, 옮긴 뒤 목록의 첫 쪽이 와서 또 한 번).
it("App 공유·리뷰: 폴더를 옮기면 묶음 조회는 한 번 — 옮긴 뒤 온 목록의 첫 쪽은 변경 통보가 아니다. 같은 조회를 다시 받으면 그때 다시 받는다", { timeout: 20_000 }, async () => {
  const folderCards = byParent(() => false);
  await mountTeamFolder({ folderCards, setFolderCover: vi.fn() });
  act(() => bumpListRevision()); // 처음 연 화면(episode)의 첫 쪽
  await settle();
  const before = folderCards.mock.calls.length;
  const since = () => folderCards.mock.calls.slice(before).map((call) => call[1]);
  act(() => sidebarSnapshot!.onChange({ folder_path: undefined })); // 프로젝트 맨 위로
  await settle();
  expect(since()).toEqual([""]);
  act(() => bumpListRevision()); // 옮긴 조회의 첫 쪽이 왔다
  await settle();
  expect(since()).toEqual([""]);
  act(() => bumpListRevision()); // 같은 조회를 다시 받았다(주기 조회·통보)
  await settle();
  expect(since()).toEqual(["", ""]);
});

// 2026-10-13 오후(Jay): 모아보기 [개별] 카드의 [폴더로] = 그 컷 폴더로 이동 — 창이 닫히고, 사이드바에서 그 폴더를 누른 것처럼 기록 한 칸이 쌓인다.
it("App 공유·리뷰: 모아보기 카드의 [폴더로] = 창을 닫고 그 컷 폴더로 이동(기록 한 칸)", { timeout: 20_000 }, async () => {
  const generationMetrics = vi.fn().mockResolvedValue({ real_credits: 1, est_credits: null, credit_source: null, elapsed_seconds: null });
  localStorage.setItem("ch.lib.cutView", "1");
  await mountTeamFolder({ folderCards: byParent(() => false), setFolderCover: vi.fn(), generationMetrics });
  const reel = () => document.querySelector<HTMLElement>(".reel");
  act(() => { cutTile("shot").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await settle();
  expect([reel() !== null, librarySnapshot!.filters.folder_path]).toEqual([true, "episode"]);
  const before = window.history.length;
  const episodeEntry = window.history.state; // 들어가기 전(episode 의 컷 카드)의 기록
  act(() => { reel()!.querySelector<HTMLButtonElement>(".reel-go")!.click(); });
  await settle();
  expect([reel(), librarySnapshot!.filters.folder_path, window.history.length - before, cutGrid()]).toEqual([null, "episode/shot", 1, null]);
  expect(sidebarSnapshot!.armedFolder).toEqual({ projectId: "resolve-project", path: "episode/shot" });
  // 뒤로 가기 — 화면은 컷 카드(episode)로, 사이드바의 분홍 표시(무장 폴더 = 다음 생성 위치)도 같이 돌아온다(Jay 2026-10-13 오후: 표시만 shot 에 남았다)
  act(() => { window.dispatchEvent(new PopStateEvent("popstate", { state: episodeEntry })); });
  await settle();
  expect([librarySnapshot!.filters.folder_path, cutGrid() !== null, sidebarSnapshot!.armedFolder])
    .toEqual(["episode", true, { projectId: "resolve-project", path: "episode" }]);
});

// 2026-10-13 저녁(Jay): 컷 카드로 묶인 상태에서 종류·작성자·태그를 누르면 묶음이 풀려 낱장이 됐다 → 찾는 조건이 켜져도 묶음은 그대로,
//  걸러진 목록을 **따로 끝까지** 받아 화면이 묶는다. 받는 동안 낱장이 서지 않고(앞 카드 그대로 + '거르는 중…') 고른 것이 남으며, 답이 오면
//  화면에 없는 폴더만 고른 것에서 뺀다. 회색 숨김은 다시 받지 않고 다시 묶는다. 폴더 창을 여닫아도 뒤 카드는 그대로다.
it("App 공유·리뷰: 찾는 조건을 켜도 묶음이 풀리지 않는다 — 걸러진 목록을 끝까지 받아 묶고, 받는 동안 낱장이 서지 않으며 고른 것이 남는다", { timeout: 20_000 }, async () => {
  const at = (id: string, folder: string, extra: Partial<Generation> = {}): Generation => ({ ...withAsset(id), folder_path: folder, sort_ts: 1, ...extra } as Generation);
  const waiting: Array<(rows: Generation[]) => void> = [];
  // 안 거른 조회(옛 서버의 빈 칸을 채우려고 받는다)는 바로, 종류를 건 조회는 붙잡아 둔다
  const listGenerations = vi.fn((query: GenQuery) => (query.media_type
    ? new Promise<Generation[]>((resolve) => { waiting.push(resolve); })
    : Promise.resolve([at("o1", "episode/other"), at("s1", "episode/shot", { is_final: true }), at("s2", "episode/shot")])));
  localStorage.setItem("ch.lib.cutView", "1");
  await mountTeamFolder({ folderCards: byParent(() => false), setFolderCover: vi.fn(), listGenerations });
  const names = () => [...(cutGrid()?.querySelectorAll(".cut-tab > span") ?? [])].map((name) => name.textContent);
  const picked = () => [...document.querySelectorAll('main.main .cut-card[aria-pressed="true"]')].map((tile) => tile.querySelector(".cut-tab > span")!.textContent);
  const pick = (name: string, init: MouseEventInit = {}) => {
    act(() => { cutTile(name).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, ...init })); });
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  };
  expect([names(), toolbarSnapshot!.folderCards!.summary]).toEqual([["other", "shot"], { top: false, folders: 2, items: 9, note: undefined }]);
  // 옛 공유 서버(카드에 새 집계 칸이 없다) — 그 자리의 목록을 따로 끝까지 받아 없는 칸을 채운다. 건수·표지는 서버 것 그대로
  expect(listGenerations.mock.calls.map((call) => [call[0].folder_path, call[0].media_type ?? null, call[2]])).toEqual([["episode", null, 500]]);
  pick("other");
  pick("shot", { ctrlKey: true });
  expect(picked()).toEqual(["other", "shot"]);

  // 종류 = 영상 — 받는 동안: 묶음 그대로(안 거른 카드), 낱장 격자는 서지 않는다, 도구 줄이 '거르는 중…', 고른 것도 남는다
  act(() => toolbarSnapshot!.onTypeFilter("video"));
  await settle();
  expect([names(), gridOutputs().length, toolbarSnapshot!.folderCards!.summary!.note, picked(), waiting.length])
    .toEqual([["other", "shot"], 0, "거르는 중…", ["other", "shot"], 1]);
  // 답 — shot 에만 둘. 걸러진 것으로 묶이고, 화면에 없는 폴더(other)만 고른 것에서 빠진다
  await act(async () => { waiting[0]([at("v1", "episode/shot"), at("v2", "episode/shot"), at("mine", "episode")]); });
  await settle();
  expect([names(), gridOutputs().length, toolbarSnapshot!.folderCards!.summary, picked()])
    .toEqual([["shot"], 0, { top: false, folders: 1, items: 3, note: undefined }, ["shot"]]);
  expect(cutGrid()!.querySelector(".cut-tab > b")!.textContent).toBe("2"); // 건수는 걸러진 수
  expect(cutGrid()!.querySelector(".cut-out-count")!.textContent).toBe("컷 밖 1건");
  // 전환 단추는 걸러 보는 중에도 그대로다(전엔 사라졌다)
  expect(toolbarSnapshot!.folderCards!.on).toBe(true);

  // 회색 숨김 — 이 PC 에만 있는 조건: 다시 받지 않고 받은 것 위에서 다시 묶는다
  const calls = listGenerations.mock.calls.length;
  act(() => toolbarSnapshot!.onToggleGray!());
  await settle();
  expect([names(), listGenerations.mock.calls.length - calls]).toEqual([["shot"], 0]);
  act(() => toolbarSnapshot!.onToggleGray!());
  await settle();

  // 폴더 창을 열고 닫아도 뒤의 걸러진 카드는 그대로다(목록 훅의 목록은 창이 빌려 가지만, 묶음의 자료는 따로 받는다)
  act(() => { cutTile("shot").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  await settle();
  expect([peekWindow() !== null, names()]).toEqual([true, ["shot"]]);
  pressEscapeInPeek();
  await settle();
  expect([peekWindow(), names()]).toEqual([null, ["shot"]]);

  // 조건을 풀면 서버 카드로 돌아온다(걸러진 건수가 남지 않는다)
  act(() => toolbarSnapshot!.onTypeFilter("all"));
  await settle();
  expect([names(), toolbarSnapshot!.folderCards!.summary]).toEqual([["other", "shot"], { top: false, folders: 2, items: 9, note: undefined }]);
});

// 2026-10-13 저녁(Jay): "각 폴더별로 내가 봤던 게 리스트인지 그리드인지도 기억하게 한다." 모양은 **보는 폴더**의 것이다 — 폴더 창이 떠 있으면 그 창의
//  폴더. 처음엔 창 안에서 바꾼 모양이 뒤 화면의 폴더에 적혀, 창을 닫으면 뒤 화면까지 바뀌었다(Codex 코드 리뷰).
it("App 공유·리뷰: 모양은 보는 폴더마다 기억한다 — 폴더 창 안에서 바꾼 모양은 그 폴더 것이고, 닫으면 뒤 화면은 제 모양 그대로다", { timeout: 20_000 }, async () => {
  localStorage.setItem("ch.lib.cutView", "1");
  await mountTeamFolder({ folderCards: byParent(() => false), setFolderCover: vi.fn() });
  const openWindow = async (name: string) => {
    act(() => { cutTile(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    await settle();
  };
  const closeWindow = async () => { pressEscapeInPeek(); await settle(); };
  const stored = () => JSON.parse(localStorage.getItem("ch.lib.placeViews") ?? "{}") as Record<string, { layout: string; group: boolean }>;
  const key = (folder: string) => JSON.stringify(["team", "resolve-project", folder]);
  expect(toolbarSnapshot!.layout).toBe("grid");

  await openWindow("shot"); // 처음 보는 폴더 — 방금 보던 그리드를 물려받는다
  expect([peekWindow() !== null, toolbarSnapshot!.layout, gridSnapshot!.layout]).toEqual([true, "grid", "grid"]);
  act(() => toolbarSnapshot!.onLayout("list")); // 창 안에서 리스트로
  await settle();
  expect([toolbarSnapshot!.layout, gridSnapshot!.layout]).toEqual(["list", "list"]);
  await closeWindow();
  expect([peekWindow(), toolbarSnapshot!.layout]).toEqual([null, "grid"]); // 뒤 화면(episode)은 그대로다
  expect([stored()[key("episode")], stored()[key("episode/shot")]]).toEqual([{ layout: "grid", group: false }, { layout: "list", group: false }]);

  await openWindow("other"); // 다른 폴더의 창 — 방금 보던 것(뒤 화면의 그리드)을 물려받는다
  expect(gridSnapshot!.layout).toBe("grid");
  await closeWindow();
  await openWindow("shot"); // 다시 연 그 폴더는 본 모양 그대로
  expect([toolbarSnapshot!.layout, gridSnapshot!.layout]).toEqual(["list", "list"]);
  await closeWindow();
  // 그 폴더로 들어가도(창이 아니라 자리로) 같은 폴더다 — 리스트
  act(() => sidebarSnapshot!.onChange({ folder_path: "episode/shot" }));
  await settle();
  expect(toolbarSnapshot!.layout).toBe("list");
  act(() => sidebarSnapshot!.onChange({ folder_path: "episode" }));
  await settle();
  expect(toolbarSnapshot!.layout).toBe("grid");
});

// 걸러 보는 중의 경계(Codex 코드 리뷰) — 받지 못하면 그렇다고 알린다(앞 카드가 완료처럼 보이지 않게) · 상한에서 잘리면 '최근 2000건 기준'.
it("App 공유·리뷰: 걸러 받지 못하면 '걸러 보기 실패', 상한에서 잘리면 '최근 2000건 기준' — 어느 때도 낱장이 서지 않는다", { timeout: 20_000 }, async () => {
  let serial = 0;
  const many = () => Array.from({ length: 500 }, () => {
    serial += 1;
    return { ...withAsset("m" + serial), folder_path: "episode/shot", sort_ts: 100_000 - serial } as Generation;
  });
  const listGenerations = vi.fn(async (query: GenQuery) => {
    if (query.media_type === "video") throw new Error("502: 공유 서버 연결 실패");
    return query.media_type === "image" ? many() : [];
  });
  localStorage.setItem("ch.lib.cutView", "1");
  await mountTeamFolder({ folderCards: byParent(() => false), setFolderCover: vi.fn(), listGenerations });
  const names = () => [...(cutGrid()?.querySelectorAll(".cut-tab > span") ?? [])].map((name) => name.textContent);
  act(() => toolbarSnapshot!.onTypeFilter("video"));
  await settle();
  await settle();
  expect([names(), gridOutputs().length, toolbarSnapshot!.folderCards!.summary!.note]).toEqual([["other", "shot"], 0, "걸러 보기 실패"]);
  // 다른 조건 — 2000건(4쪽)에서 잘린다
  act(() => toolbarSnapshot!.onTypeFilter("image"));
  for (let round = 0; round < 6; round++) await settle();
  expect(listGenerations.mock.calls.filter((call) => call[0].media_type === "image")).toHaveLength(4);
  expect([names(), gridOutputs().length, toolbarSnapshot!.folderCards!.summary]).toEqual([["shot"], 0, { top: false, folders: 1, items: 2000, note: "최근 2000건 기준" }]);
});

// 옛 공유 서버(폴더 카드 경로 자체가 없다)는 걸러 보는 중에도 전처럼 한 장씩이다 — 목록에서 묶는 것은 서버 카드(구조·대표)를 알 때만 한다.
it("App 공유·리뷰: 폴더 카드 경로가 없는 옛 서버는 찾는 조건을 켜도 낱장 그대로 — 걸러 받기를 보내지 않는다", { timeout: 20_000 }, async () => {
  const { HttpError } = await import("../src/lib/http");
  const missing = vi.fn().mockRejectedValue(new HttpError(404, "404: Not Found", "Not Found"));
  const listGenerations = vi.fn(async () => []);
  localStorage.setItem("ch.lib.cutView", "1");
  await mountTeamFolder({ folderCards: missing, setFolderCover: vi.fn(), listGenerations });
  await settle();
  act(() => toolbarSnapshot!.onTypeFilter("video"));
  await settle();
  expect([cutGrid(), gridOutputs().length, toolbarSnapshot!.folderCards, listGenerations.mock.calls.length]).toEqual([null, 1, undefined, 0]);
});

// 2026-10-13 ③(Jay): 사이드바로 폴더를 옮기면 묶음 응답이 오기 전에 낱장 격자(옛 폴더의 카드)가 한 번 보였다가 컷 카드로 바뀌었다 → 응답 전엔 격자 자리를
//  비운다(전환 단추는 그동안 남는다). 조회가 실패하면 낱장으로 돌아간다(영영 빈 화면이 아니다).
it("App 공유·리뷰: 폴더를 옮기면 묶음 응답 전엔 낱장 격자를 그리지 않는다 — 오면 컷 카드(잎이면 낱장), 실패하면 낱장", { timeout: 20_000 }, async () => {
  const held = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  let episodeCalls = 0;
  const folderCards = vi.fn((_pid: string, parent: string) =>
    parent === "" ? Promise.resolve(topCards)
      : parent === "episode" && episodeCalls++ === 0 ? Promise.resolve(cutCards(false)) // 처음(마운트)만 바로 — 그 뒤는 붙잡는다
      : new Promise((resolve, reject) => { held.set(parent, { resolve, reject }); }));
  localStorage.setItem("ch.lib.cutView", "1");
  await mountTeamFolder({ folderCards, setFolderCover: vi.fn() });
  expect(cutGrid()).not.toBeNull();
  const busy = () => document.querySelector("main.main .grid-wrap[aria-busy='true']:empty");
  // 잎으로 — 응답 전: 컷 격자도 낱장 격자도 없고 자리만 비어 있다, 전환 단추는 남는다
  act(() => sidebarSnapshot!.onChange({ folder_path: "episode/shot" }));
  await settle();
  expect([cutGrid(), gridOutputs().length, busy() !== null, toolbarSnapshot!.folderCards?.on]).toEqual([null, 0, true, true]);
  await act(async () => { held.get("episode/shot")!.resolve({ parent: "episode/shot", own_count: 3, folders: [] }); });
  await settle();
  expect([gridOutputs().length, busy(), toolbarSnapshot!.folderCards]).toEqual([1, null, undefined]); // 잎 — 낱장. 바꿀 것이 없으니 단추 없음
  // 실패하면(옛 서버 아님) 낱장으로 돌아간다
  act(() => sidebarSnapshot!.onChange({ folder_path: "episode/other" }));
  await settle();
  expect([gridOutputs().length, busy() !== null]).toEqual([0, true]);
  await act(async () => { held.get("episode/other")!.reject(new Error("502: 공유 서버 연결 실패")); });
  await settle();
  expect([gridOutputs().length, busy()]).toEqual([1, null]);
  // 다시 에피소드로 — 한 번 본 폴더는 받아 둔 컷 카드가 응답 전부터 선다(기다리지 않는다, "아직 딜레이"). 조회는 다시 가고, 답이 오면 그것으로 바뀐다
  held.delete("episode");
  act(() => sidebarSnapshot!.onChange({ folder_path: "episode" }));
  await settle();
  expect([cutGrid() !== null, gridOutputs().length, busy(), toolbarSnapshot!.folderCards?.on]).toEqual([true, 0, null, true]);
  expect(cutTile("shot").querySelector(".cut-pill")!.textContent).toBe("대표 미정");
  await act(async () => { held.get("episode")!.resolve(cutCards(true)); });
  await settle();
  expect([cutGrid() !== null, cutTile("shot").querySelector(".cut-pill")]).toEqual([true, null]);
});

// 2026-10-13(Jay "아직 폴더 이동할 때 딜레이"): 에피소드(컷 카드)에서 컷으로 들어갈 때 서버 답 둘(묶음·목록)을 기다리지 않는다 — 컷의 묶음 답은 에피소드의
//  카드가 이미 알려 줬고(`subfolders` 0), 목록은 에피소드의 첫 쪽에서 그 컷에 드는 것만 골라 먼저 보인다. 그동안 격자는 잠그고(낡았을 수 있다) 더 받지 않는다.
it("App 공유·리뷰: 에피소드에서 컷으로 들어가면 받아 둔 목록에서 그 컷의 것만 먼저 보인다 — 형제 컷도, 고를 것이 없으면 자리를 비운다", { timeout: 20_000 }, async () => {
  const leafCards = { parent: "episode", own_count: 0, folders: cutCards(false).folders.map((folder) => ({ ...folder, subfolders: 0 })) };
  const folderCards = vi.fn((_pid: string, parent: string) =>
    Promise.resolve(parent === "episode" ? leafCards : parent === "" ? topCards : { parent, own_count: 0, folders: [] }));
  localStorage.setItem("ch.lib.cutView", "1");
  await mountTeamFolder({ folderCards, setFolderCover: vi.fn() });
  const at = (id: string, folder: string, more: Partial<Generation> = {}): Generation => ({ ...libraryGeneration(id), folder_path: folder, ...more });
  const episodeList = [at("a", "episode/shot"), at("b", "episode/other"), at("c", "episode/shot/takeB"), at("gone", "episode/shot", { deleted: true }), at("shotgun", "episode/shotgun")];
  act(() => setLibraryGens(episodeList)); // 에피소드의 첫 쪽(컷 카드 뒤에서 받아 둔 것)
  await settle();
  expect(cutGrid()).not.toBeNull();
  const main = () => document.querySelector<HTMLElement>("main.main")!;
  const shown = () => gridSnapshot!.generations.map((item) => item.id);
  const busy = () => document.querySelector("main.main .grid-wrap[aria-busy='true']:empty");
  // 컷으로 — 새 목록이 오기 전(listBehind): 그 컷(하위 포함)의 것만, 지운 것·이름만 비슷한 폴더는 빼고. 격자는 잠기고 더 받지 않는다
  act(() => { sidebarSnapshot!.onChange({ folder_path: "episode/shot" }); setListBehind(true); });
  await settle();
  expect([cutGrid(), busy(), gridOutputs().length, shown()]).toEqual([null, null, 1, ["a", "c"]]);
  expect([main().hasAttribute("inert"), gridSnapshot!.selectLocked, gridSnapshot!.hasMore]).toEqual([true, true, false]);
  // 새 목록이 왔다 — 그것으로 바뀌고 잠금이 풀린다
  act(() => { setLibraryGens([at("a", "episode/shot"), at("c", "episode/shot/takeB"), at("late", "episode/shot")]); setListBehind(false); });
  await settle();
  expect([shown(), main().hasAttribute("inert"), gridSnapshot!.selectLocked]).toEqual([["a", "c", "late"], false, false]);
  // 형제 컷으로 — 컷에 있는 동안에도 에피소드의 목록을 들고 있다
  act(() => { sidebarSnapshot!.onChange({ folder_path: "episode/other" }); setListBehind(true); });
  await settle();
  expect([busy(), shown(), main().hasAttribute("inert")]).toEqual([null, ["b"], true]);
  // 받아 둔 목록 밖의 폴더 — 고를 것이 없으니 자리를 비운다(옛 폴더의 낱장을 그리지 않는다). 목록이 오면 그린다
  act(() => { sidebarSnapshot!.onChange({ folder_path: "elsewhere" }); });
  await settle();
  expect([busy() !== null, gridOutputs().length]).toEqual([true, 0]);
  act(() => { setLibraryGens([at("far", "elsewhere")]); setListBehind(false); });
  await settle();
  expect([busy(), shown(), main().hasAttribute("inert")]).toEqual([null, ["far"], false]);
  // 자리는 그대로 두고 보기 필터만 바꾼 때는 전처럼 — 옛 목록을 새 목록이 올 때까지 그대로 보이고 잠그지도 않는다. 필터 변경은 선택을 남기므로
  //  화면을 비우거나 바꿔 그리면 보이지 않는 선택에 선택 막대·전역 단축키가 걸린다(Codex 코드 리뷰)
  act(() => { sidebarSnapshot!.onChange({ search: "cat" }); }); // 찾는 중 — 묶어 보이지 않는다
  await settle();
  act(() => gridSnapshot!.onSelectedChange(new Set(["far"])));
  act(() => { sidebarSnapshot!.onChange({ search: undefined }); setListBehind(true); }); // 필터를 풀었다 — 새 목록 전
  await settle();
  expect([busy(), shown(), main().hasAttribute("inert"), [...gridSnapshot!.selectedIds]]).toEqual([null, ["far"], false, ["far"]]);
  act(() => setListBehind(false));
  // 에피소드로 돌아오면 받아 둔 컷 카드가 바로 — 목록이 아직 옛것이어도 컷 카드는 눌린다(잠그지 않는다)
  act(() => { sidebarSnapshot!.onChange({ folder_path: "episode" }); setListBehind(true); });
  expect([cutGrid() !== null, main().hasAttribute("inert")]).toEqual([true, false]); // settle 전 — 응답을 기다리지 않았다
});

// 31회차(Codex 빈틈 점검 — 둘 다 '옛 자리의 카드가 잠금 없이 선다'):
//  ① 빠른 A→B→A — B 는 목록만 오고 묶음 답은 아직인 채 A 로 되돌아오면, A 가 '이미 선 자리'로 남아 B 의 목록이 A 에 그대로 섰다 → 자리를 떠나면 그 표식을 지운다.
//  ② 자리를 옮기고 기다리는 사이 검색어를 치면 묶음 조건이 풀리며 잠금까지 풀렸다 → 잠금은 묶어 보일 수 있는지와 무관하게 건다.
it("App 공유·리뷰: 자리를 옮긴 뒤 새 목록 전에는 옛 자리의 카드가 눌리지 않는다 — 빠르게 되돌아와도, 기다리는 사이 검색어를 쳐도", { timeout: 20_000 }, async () => {
  const leafCards = { parent: "episode", own_count: 0, folders: cutCards(false).folders.map((folder) => ({ ...folder, subfolders: 0 })) };
  const folderCards = vi.fn((_pid: string, parent: string) => (parent === "slow"
    ? new Promise<never>(() => {}) // 묶음 답이 끝내 안 오는 폴더
    : Promise.resolve(parent === "episode" ? leafCards : parent === "" ? topCards : { parent, own_count: 0, folders: [] })));
  localStorage.setItem("ch.lib.cutView", "1");
  await mountTeamFolder({ folderCards, setFolderCover: vi.fn() });
  const at = (id: string, folder: string): Generation => ({ ...libraryGeneration(id), folder_path: folder });
  const main = () => document.querySelector<HTMLElement>("main.main")!;
  const shown = () => gridSnapshot!.generations.map((item) => item.id);
  const busy = () => document.querySelector("main.main .grid-wrap[aria-busy='true']:empty");
  // A(episode/shot)에 선다 — 목록이 지금 조회의 것이고 묶음 답도 안다
  act(() => { sidebarSnapshot!.onChange({ folder_path: "episode/shot" }); setLibraryGens([at("a", "episode/shot")]); });
  await settle();
  expect([shown(), main().hasAttribute("inert")]).toEqual([["a"], false]);
  // B(slow, 처음 가는 폴더) — 목록은 왔는데 묶음 답은 아직: 자리를 비운 채다
  act(() => { sidebarSnapshot!.onChange({ folder_path: "slow" }); setLibraryGens([at("b1", "slow")]); });
  await settle();
  expect([busy() !== null, gridOutputs().length]).toEqual([true, 0]);
  // ① A 로 되돌아왔다 — 화면의 목록은 아직 B 의 것. A 에 그리지도, 누르게 두지도 않는다(받아 둔 것에서 고를 것도 없으니 자리를 비운다)
  act(() => { sidebarSnapshot!.onChange({ folder_path: "episode/shot" }); setListBehind(true); });
  await settle();
  expect([busy() !== null, gridOutputs().length, main().hasAttribute("inert")]).toEqual([true, 0, true]);
  act(() => { setLibraryGens([at("a", "episode/shot")]); setListBehind(false); }); // A 의 목록이 왔다
  await settle();
  expect([busy(), shown(), main().hasAttribute("inert")]).toEqual([null, ["a"], false]);
  // ② 다른 폴더로 옮기고 기다리는 사이 검색어를 쳤다 — 찾는 조건이 켜져도 묶음 보기의 자리다(2026-10-13 저녁: 걸러도 묶음이 풀리지 않는다).
  //  새 목록이 올 때까지 옛 자리의 카드를 그리지도 누르게 두지도 않는다(전엔 묶음 조건이 풀려 옛 목록이 잠긴 채 그려졌다)
  act(() => { sidebarSnapshot!.onChange({ folder_path: "episode/other" }); setListBehind(true); });
  await settle();
  act(() => { sidebarSnapshot!.onChange({ search: "cat" }); });
  await settle();
  expect([busy() !== null, gridOutputs().length, main().hasAttribute("inert")]).toEqual([true, 0, true]);
  act(() => { setLibraryGens([at("found", "episode/other")]); setListBehind(false); });
  await settle();
  expect([shown(), main().hasAttribute("inert"), gridSnapshot!.selectLocked]).toEqual([["found"], false, false]);
  // ③ 응답이 실패도 없이 매달린다 — 기다림은 4초까지. 그 뒤엔 전처럼 화면의 목록을 보이고 누르게 둔다(비우거나 잠근 채로 남지 않는다)
  act(() => { sidebarSnapshot!.onChange({ search: undefined }); });
  await settle();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    act(() => { sidebarSnapshot!.onChange({ folder_path: "slow" }); setListBehind(true); }); // 묶음 답도 목록도 안 온다
    expect([busy() !== null, gridOutputs().length]).toEqual([true, 0]);
    act(() => { vi.advanceTimersByTime(3999); });
    expect(busy() !== null).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect([busy(), shown(), main().hasAttribute("inert"), gridSnapshot!.selectLocked]).toEqual([null, ["found"], false, false]);
    // 다른 자리로 옮기면 다시 잰다 — 앞 자리에서 넘긴 시간이 새 자리의 기다림을 건너뛰게 하지 않는다
    act(() => { sidebarSnapshot!.onChange({ folder_path: "episode/shot" }); });
    expect(main().hasAttribute("inert")).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("App 공유·리뷰: 묶어 보이지 않는 경우 — 하위 폴더가 없는 폴더, 무엇을 찾는 중", { timeout: 20_000 }, async () => {
  // 하위 폴더가 없다 — 한 장씩 그대로이고, 바꿀 것이 없으니 전환 단추도 없다
  const leaf = vi.fn().mockResolvedValue({ parent: "episode", own_count: 5, folders: [] });
  await mountTeamFolder({ folderCards: leaf, setFolderCover: vi.fn() });
  expect(leaf).toHaveBeenCalled();
  expect(cutGrid()).toBeNull();
  expect(gridOutputs()).toHaveLength(1);
  expect(toolbarSnapshot!.folderCards).toBeUndefined();

  // 무엇을 찾는 조건이 켜지면 받지도 않는다
  const calls = leaf.mock.calls.length;
  act(() => sidebarSnapshot!.onChange({ search: "cat" }));
  await settle();
  expect(leaf).toHaveBeenCalledTimes(calls);
  expect(toolbarSnapshot!.folderCards).toBeUndefined();
});

it("App 공유·리뷰: 옛 공유 서버(경로 없음)면 한 장씩 보이고 전환 단추·대표 단추가 없다", { timeout: 20_000 }, async () => {
  const { HttpError } = await import("../src/lib/http");
  const missing = vi.fn().mockRejectedValue(new HttpError(404, "404: Not Found", "Not Found"));
  // 한 장씩 보기로 둔 PC — 들어가 있는 폴더의 대표를 묻는 조회(2026-10-13 ②)만 가고(404), 묶음 조회는 아직 안 물어봐 전환 단추는 보인다
  localStorage.setItem("ch.lib.cutView", "0");
  await mountTeamFolder({ folderCards: missing, setFolderCover: vi.fn() });
  expect(missing.mock.calls.map((call) => call[1])).toEqual([""]);
  expect(gridSnapshot!.cellHeader).toBeUndefined(); // 옛 서버 — 카드 위 [대표] 없음
  expect(toolbarSnapshot!.folderCards).toMatchObject({ on: false });
  // 폴더 창이 그 폴더의 대표를 물어보다가 옛 서버임을 안다 — 대표 단추가 없다
  act(() => gridSnapshot!.onOpenFolder!(libraryGeneration("target")));
  await settle();
  expect(missing).toHaveBeenCalled();
  expect(peekWindow()).not.toBeNull();
  expect(gridSnapshot!.cellHeader).toBeUndefined();
  // 닫은 뒤에는 전환 단추도 내놓지 않는다(눌러도 묶어 보일 수 없다)
  pressEscapeInPeek();
  await settle();
  expect(cutGrid()).toBeNull();
  expect(gridOutputs()).toHaveLength(1);
  expect(toolbarSnapshot!.folderCards).toBeUndefined();
});

it("App my 탭: 폴더 창이 뜬 채 하단 프롬프트의 글 칸에서 Esc 를 누르면 창을 닫지 않고 초점만 창으로 돌아온다 — 한 번 더 누르면 닫힌다", async () => {
  await mountApp("my");
  act(() => gridSnapshot!.onOpenFolder!(libraryGeneration("target")));
  await settle();
  expect(peekWindow()).not.toBeNull();
  const editor = document.querySelector<HTMLElement>('.sl-dockbar [contenteditable="true"]')!;
  Object.defineProperty(editor, "isContentEditable", { value: true }); // jsdom 에는 이 속성이 없다(브라우저에서는 참)
  act(() => editor.focus());
  expect(document.activeElement).toBe(editor);
  act(() => { editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await settle();
  expect(peekWindow()).not.toBeNull();
  expect(document.activeElement).toBe(peekWindow());
  pressEscapeInPeek();
  await settle();
  expect(peekWindow()).toBeNull();
});

// ── 조작 점검 7회차 ──
it.each(["my", "compose"])("App %s: 폴더 창이 뜬 동안 하단 상태 줄은 inert 다(Tab·Enter 로도 닿지 않는다) — 프롬프트는 그대로 쓰고, 닫으면 풀린다", async (tab) => {
  // 마우스는 CSS(body:has(.folder-peek) …)가 막는다. 키보드로는 상태 줄의 단추에 닿아 폴더 창 위로 Host 콘솔이 떴다.
  await mountApp(tab);
  const statusRow = () => document.querySelector(".sl-dockbar .sl-status-row")!;
  expect(statusRow().hasAttribute("inert")).toBe(false);
  act(() => {
    if (tab === "compose") canvasSidebarSnapshot!.onArmFolder("resolve-project", "episode/shot"); // 캔버스: 사이드바에서 폴더를 누른다
    else gridSnapshot!.onOpenFolder!(libraryGeneration("target")); // 목록 탭: 카드의 폴더 이름표
  });
  await settle();
  expect(peekWindow()).not.toBeNull();
  expect(statusRow().hasAttribute("inert")).toBe(true);
  expect(document.querySelector('.sl-dockbar [contenteditable="true"]')!.closest("[inert]")).toBeNull();
  act(() => { document.querySelector(".folder-peek-catcher")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  await settle();
  expect(peekWindow()).toBeNull();
  expect(statusRow().hasAttribute("inert")).toBe(false);
});

it.each(["my", "compose"])("App %s: 폴더 창이 뜬 동안 상단바와 뒤 화면(사이드바·본문)은 inert 다 — 창과 프롬프트는 그 밖이다. 닫으면 풀린다", async (tab) => {
  // 2026-10-11 실측: Tab 을 오래 누르면 목록 탭의 창은 48번째부터 상단바로, 캔버스의 창은 72번째부터 사이드바·상단바로 나갔다.
  //  사이드바의 폴더 줄에 초점이 놓이면 Esc 로 창이 닫히지도 않았다(그 줄의 키 처리가 전파를 막는다 — common/FolderTreeView).
  await mountApp(tab);
  const topbar = () => document.querySelector<HTMLElement>('[data-testid="tab"]')!;
  const body = () => document.querySelector<HTMLElement>(".body")!;
  expect(topbar().dataset.inert).toBeUndefined();
  expect(body().hasAttribute("inert")).toBe(false);
  act(() => {
    if (tab === "compose") canvasSidebarSnapshot!.onArmFolder("resolve-project", "episode/shot");
    else gridSnapshot!.onOpenFolder!(libraryGeneration("target"));
  });
  await settle();
  expect(peekWindow()).not.toBeNull();
  expect(topbar().dataset.inert).toBe("true");
  expect(body().hasAttribute("inert")).toBe(true); // 사이드바·툴바·보드(본문) 전부 — Tab 으로 닿지 않는다
  expect(peekWindow()!.closest("[inert]")).toBeNull(); // 창은 잠긴 곳 밖에 그린다(캔버스의 창은 전에 main 안이었다)
  expect(document.querySelector(".folder-peek-catcher")!.closest("[inert]")).toBeNull(); // 막도 — 눌러 닫을 수 있어야 한다
  expect(document.activeElement).toBe(peekWindow()); // 잠긴 자리에 있던 초점은 창이 가져간다
  expect(document.querySelector('.sl-dockbar [contenteditable="true"]')!.closest("[inert]")).toBeNull();
  act(() => { document.querySelector(".folder-peek-catcher")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  await settle();
  expect(peekWindow()).toBeNull();
  expect(topbar().dataset.inert).toBeUndefined();
  expect(body().hasAttribute("inert")).toBe(false);
});

it("App: 여러 장 리뷰의 허용 값이 같으면 선택이 바뀌어도 격자에 같은 객체를 넘긴다 — 달라지면 새 값을 넘긴다", async () => {
  // 격자는 이 객체를 모든 카드에 그대로 넘긴다 — 렌더마다 새 객체면 선택이 바뀔 때마다 보이는 카드의 memo 가 전부 깨진다
  const send = await mountApp("my");
  act(() => send(["other", "other-target"])); // 목록에 내 공유 카드 두 장
  await settle();
  act(() => gridSnapshot!.onSelectedChange(new Set(["other"])));
  const allowed = gridSnapshot!.bulkReviewAllowed;
  expect(allowed).toEqual({ unshared: true, shared: false, held: false, final: false });
  act(() => gridSnapshot!.onSelectedChange(new Set(["other", "other-target"]))); // 선택만 바뀐다 — 허용 값은 그대로
  expect(gridSnapshot!.selectedIds.size).toBe(2);
  expect(gridSnapshot!.bulkReviewAllowed).toBe(allowed);
  act(() => gridSnapshot!.onSelectedChange(new Set())); // 고른 것이 없으면 전부 꺼진다
  expect(gridSnapshot!.bulkReviewAllowed).toEqual({ unshared: false, shared: false, held: false, final: false });
  expect(gridSnapshot!.bulkReviewAllowed).not.toBe(allowed);
});

it("App: 인증 확인 중으로 한 번 그린 뒤 확인이 끝나도 예외 없이 화면이 뜬다 — 조기 반환 뒤에는 훅이 없다", async () => {
  // 로그인된 앱을 새로 고치면 인증 확인이 끝날 때까지 App 은 조기 반환(null)에서 끝난다. 그 뒤에 훅이 하나라도 있으면
  //  확인이 끝난 렌더에서 훅 수가 늘어 React 가 "Rendered more hooks than during the previous render" 로 앱을 멈춘다.
  startAuthPending = true;
  await mountApp("my");
  expect(gridSnapshot).toBeNull(); // 아직 아무것도 그리지 않았다
  expect(document.querySelector(".sl-dockbar")).toBeNull();
  act(() => setAuthPending(false)); // 같은 root 에서 확인이 끝난다
  await settle();
  expect(document.querySelector('[data-testid="library-highlight"]')).not.toBeNull(); // 격자
  expect(document.querySelector(".sl-dockbar")).not.toBeNull(); // 하단 프롬프트
  expect(gridSnapshot!.bulkReviewAllowed).toEqual({ unshared: false, shared: false, held: false, final: false });
});
