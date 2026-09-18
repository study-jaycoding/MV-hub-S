// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThumbnailGrid } from "../src/components/ThumbnailGrid";
import { ProjectSection } from "../src/components/sidebar/ProjectSection";
import type { Generation, Project, ProjectFolderState } from "../src/types";

const mocks = vi.hoisted(() => ({
  scroll: vi.fn(),
  links: vi.fn(),
  folder: vi.fn(),
  counts: vi.fn(),
  saveFolder: vi.fn(),
  ack: vi.fn(),
}));
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: mocks.scroll }));
    return <>{props.data.map(props.children)}</>;
  }) };
});
vi.mock("../src/api", () => ({ api: {
  thumbOrRaw: (path: string) => path, mediaUrl: (path: string) => path,
  projectFolderLinks: mocks.links, projectFolder: mocks.folder,
  projectFolderCountsBatch: mocks.counts, setProjectFolderSelection: mocks.saveFolder,
} }));
vi.mock("../src/lib/useGenerationViewsSynced", () => ({ useGenerationViewsSynced: () => ({ card: {}, asset: {} }) }));
vi.mock("../src/lib/useOutsideDragSelect", () => ({ useOutsideDragSelect: () => {} }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (name: string) => name }));
vi.mock("../src/lib/i18n", () => ({ t: (value: string) => value, useT: () => (value: string) => value }));
vi.mock("../src/lib/teamSeen", () => ({
  subscribeTeamSeen: () => () => {}, getTeamSeenVersion: () => 0,
  isFreshGen: () => true, ackTeamFresh: mocks.ack, getTeamBase: () => null,
  ackAllLabel: () => "", isAckedFor: () => false, ackTeamFreshKeys: vi.fn(),
}));
vi.mock("../src/components/MediaThumbnail", () => ({ MediaThumbnail: () => <span>thumbnail</span> }));

let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
const noop = () => {};
function generation(id: string, day = 16): Generation {
  return {
    id, model: "test", prompt: "test", status: "done", created_at: `2026-09-${day}T12:00:00Z`,
    assets: [{ id: `asset-${id}`, type: "image", file_path: `/test/${id}.png` }],
    tags: [], auto_tags: [], references: [], shared: true, is_mine: true, params: {},
  } as unknown as Generation;
}
const generations = [generation("g1"), generation("g2", 15)];
function gridProps(patch: Partial<ComponentProps<typeof ThumbnailGrid>> = {}): ComponentProps<typeof ThumbnailGrid> {
  return {
    generations, tab: "my", scale: 1, fill: true, layout: "grid", groupByDate: false,
    selectedIds: new Set(), onSelectedChange: vi.fn(), onToggleSelect: vi.fn(),
    onSetSource: noop, onSetTags: noop, onOpenComments: noop, onRegenerate: noop,
    onPublish: noop, onUnpublish: noop, onFinalize: noop, onUnfinalize: noop,
    onImport: noop, onRestore: noop, dimDeleted: false,
    onInfo: noop, onPreview: noop, ...patch,
  };
}
function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}
function renderGrid(props: ComponentProps<typeof ThumbnailGrid>) {
  act(() => root.render(<ThumbnailGrid {...props} />));
  flushFrames();
  return host.querySelector<HTMLElement>(".gen-grid")!;
}

it("빈 필터 페이지에서 남은 항목은 없음으로 단정하지 않고 더 보기로 이어간다", () => {
  const onLoadMore = vi.fn();
  renderGrid(gridProps({ generations: [], hasMore: true, onLoadMore }));
  expect(host.textContent).toContain("뒤쪽 페이지");
  const next = [...host.querySelectorAll("button")].find((button) => button.textContent === "더 보기");
  expect(next).toBeTruthy();
  act(() => next!.click());
  expect(onLoadMore).toHaveBeenCalledOnce();
  renderGrid(gridProps({ generations: [], hasMore: true, loadingMore: true, onLoadMore }));
  expect(host.querySelector<HTMLButtonElement>(".settings-action")?.disabled).toBe(true);
});
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map(); frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  HTMLElement.prototype.scrollTo = vi.fn();
  mocks.links.mockResolvedValue({ links: {} });
  mocks.counts.mockResolvedValue({ counts: {} });
  host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it.each(["grid", "list"] as const)("%s: Resolve 강조는 직접 선택·Last viewed·공유 확인을 변경하지 않는다", (layout) => {
  const props = gridProps({ layout, tab: "team", resolveHighlightedIds: new Set(["g2"]), selectedIds: new Set(["g1"]) });
  renderGrid(props);
  const direct = host.querySelector('[data-id="g1"] .card')!;
  const follow = host.querySelector('[data-id="g2"] .card')!;
  expect(direct.classList.contains("selected")).toBe(true);
  expect(direct.classList.contains("resolve-highlighted")).toBe(false);
  expect(follow.classList.contains("selected")).toBe(false);
  expect(follow.classList.contains("resolve-highlighted")).toBe(true);
  expect(props.onSelectedChange).not.toHaveBeenCalled();
  expect(mocks.ack).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Last viewed");
  const style = document.createElement("style");
  style.textContent = readFileSync(new NodeURL("../src/styles/resolve-library.css", import.meta.url), "utf8");
  document.head.appendChild(style);
  // 링은 전환이 있는 카드가 아니라 셀의 독립 레이어에 그린다. 제거 시에도 red 잔상이 없다.
  const rules = [...style.sheet!.cssRules] as CSSStyleRule[];
  const ring = rules.find((rule) => rule.selectorText === '.gen-cell:has(> .card.resolve-highlighted)::after');
  expect(ring?.style.getPropertyValue("box-shadow")).toContain("#ff304f");
  expect(ring?.style.getPropertyValue("transition")).toBe("none");
  expect(ring?.style.getPropertyValue("pointer-events")).toBe("none");
  expect(host.querySelector('.gen-cell:has(> .card.resolve-highlighted)')).toBe(follow.parentElement);
  expect(getComputedStyle(follow).borderColor).not.toBe("rgb(255, 48, 79)");
  expect(getComputedStyle(follow).animation).toBe("none");
  expect(getComputedStyle(follow).filter).toBe("none");
  renderGrid({ ...props, resolveHighlightedIds: new Set() });
  expect(host.querySelector('.gen-cell:has(> .card.resolve-highlighted)')).toBeNull();
  expect(direct.classList.contains("selected")).toBe(true);
  style.remove();
});

it("날짜 헤더를 포함한 가상 행으로 필터 초기화 뒤 1회 이동한다", () => {
  const props = gridProps({ layout: "list", groupByDate: true, resetKey: "before" });
  renderGrid(props);
  const reset = vi.spyOn(HTMLElement.prototype, "scrollTo");
  renderGrid({ ...props, resetKey: "after", resolveScrollRequest: { generationId: "g2", nonce: 1 } });
  expect(mocks.scroll).toHaveBeenCalledExactlyOnceWith(3, { align: "nearest" });
  expect(reset.mock.invocationCallOrder[0]).toBeLessThan(mocks.scroll.mock.invocationCallOrder[0]);
  renderGrid({ ...props, resetKey: "after", generations: [...generations], resolveScrollRequest: { generationId: "g2", nonce: 1 } });
  expect(mocks.scroll).toHaveBeenCalledTimes(1);
});

it("대상이 나중에 도착하면 이동하고 빠르게 바뀐 이전 요청은 취소한다", () => {
  const props = gridProps({ generations: [], resolveScrollRequest: { generationId: "g2", nonce: 1 } });
  renderGrid(props);
  expect(mocks.scroll).not.toHaveBeenCalled();
  act(() => root.render(<ThumbnailGrid {...props} generations={generations} />));
  act(() => root.render(<ThumbnailGrid {...props} generations={generations} resolveScrollRequest={{ generationId: "g1", nonce: 2 }} />));
  flushFrames();
  expect(mocks.scroll).toHaveBeenCalledExactlyOnceWith(0, { align: "nearest" });
});

it.each(["wheel", "touchstart", "pointerdown", "PageDown"])("자동 이동은 추가 조회를 막고 사용자 %s는 다시 허용한다", (gesture) => {
  const props = gridProps({ hasMore: true, onLoadMore: vi.fn(), resolveScrollRequest: { generationId: "g2", nonce: 1 } });
  const grid = renderGrid(props);
  act(() => grid.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(props.onLoadMore).not.toHaveBeenCalled();
  act(() => grid.dispatchEvent(gesture === "PageDown"
    ? new KeyboardEvent("keydown", { key: gesture, bubbles: true }) : new Event(gesture, { bubbles: true })));
  act(() => grid.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(props.onLoadMore).toHaveBeenCalledTimes(1);
});

it("직접 클릭은 Resolve 표시만 해제하도록 알리고 기존 단일 선택으로 처리한다", () => {
  const props = gridProps({ onClearResolveHighlight: vi.fn(), resolveHighlightedIds: new Set(["g2"]) });
  renderGrid(props);
  const card = host.querySelector('[data-id="g1"] .card')!;
  act(() => card.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true })));
  act(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true })));
  expect(props.onClearResolveHighlight).toHaveBeenCalledTimes(1);
  expect(props.onSelectedChange).toHaveBeenCalledExactlyOnceWith(new Set(["g1"]));
});

it("스크롤바 없는 짧은 목록도 휠 의도 이후 추가 조회가 다시 가능하다", () => {
  const props = gridProps({ hasMore: true, onLoadMore: vi.fn(), resolveScrollRequest: { generationId: "g2", nonce: 1 } });
  const grid = renderGrid(props);
  expect(props.onLoadMore).not.toHaveBeenCalled();
  act(() => grid.dispatchEvent(new Event("wheel", { bubbles: true })));
  flushFrames();
  expect(props.onLoadMore).toHaveBeenCalledTimes(1);
});

it("대상 주입·정렬 뒤에도 방향키 포커스와 Shift 범위 앵커가 같은 ID를 따른다", () => {
  const props = gridProps({ layout: "list" });
  let grid = renderGrid(props);
  const click = (id: string, shiftKey = false) => {
    const card = host.querySelector(`[data-id="${id}"] .card`)!;
    act(() => card.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, shiftKey })));
    act(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true, shiftKey })));
  };
  click("g2");
  const next = [generation("new"), ...generations, generation("g3")];
  grid = renderGrid({ ...props, generations: next });
  expect(host.querySelector(".gen-cell.focused")?.getAttribute("data-id")).toBe("g2");
  // Shift를 누른 채 마우스를 잡은 사이 앞에 다른 항목이 추가돼도 g2~g3만 선택한다.
  const target = host.querySelector('[data-id="g3"] .card')!;
  act(() => target.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, shiftKey: true })));
  grid = renderGrid({ ...props, generations: [generation("newer"), ...next] });
  act(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true, shiftKey: true })));
  expect(props.onSelectedChange).toHaveBeenLastCalledWith(new Set(["g2", "g3"]));
  act(() => grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
  expect(props.onSelectedChange).toHaveBeenLastCalledWith(new Set(["g1"]));
});

it("필터를 수동 변경하거나 확인 요청이 해제되면 자동 조회 차단도 해제한다", () => {
  const props = gridProps({ hasMore: true, onLoadMore: vi.fn(), resetKey: "before", resolveScrollRequest: { generationId: "g2", nonce: 1 } });
  renderGrid(props);
  let grid = renderGrid({ ...props, resetKey: "manual" });
  act(() => grid.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(props.onLoadMore).toHaveBeenCalledTimes(1);
  grid = renderGrid({ ...props, resetKey: "manual", resolveScrollRequest: { generationId: "g2", nonce: 2 } });
  grid = renderGrid({ ...props, resetKey: "manual", resolveScrollRequest: null });
  act(() => grid.dispatchEvent(new Event("scroll", { bubbles: true })));
  expect(props.onLoadMore).toHaveBeenCalledTimes(2);
});

it("닫힌 프로젝트·조상 폴더를 조회용으로 펼치고 생성 목적지는 보존한다", async () => {
  const state = {
    project_id: "view-project", root_path: "test", selected_path: "parent/destination",
    tree: { path: "", name: "render", children: [{ path: "parent", name: "parent", children: [
      { path: "parent/target", name: "target" }, { path: "parent/destination", name: "destination" },
    ] }] },
  } as ProjectFolderState;
  mocks.links.mockResolvedValue({ links: { "view-project": state } });
  mocks.folder.mockResolvedValue(state);
  mocks.saveFolder.mockResolvedValue(state);
  localStorage.setItem("ch.collapsedProjects", JSON.stringify(["view-project"]));
  const onArm = vi.fn(), onFilter = vi.fn();
  await act(async () => root.render(<ProjectSection
    projects={[{ id: "view-project", name: "Project", count: 2 } as Project]}
    unassignedCount={0} archivedCount={0} activeId="view-project" deletedOnly={false}
    armedFolder={{ projectId: "view-project", path: "parent/destination" }}
    viewedFolder={{ projectId: "view-project", path: "parent/target", nonce: 1 }}
    onFilter={onFilter} onViewDeleted={noop} onArmFolder={onArm}
  />));
  flushFrames();
  expect(host.querySelector(".folder-tree-row.viewed-resolve")?.textContent).toContain("target");
  expect(host.querySelector(".folder-tree-row.selected")?.textContent).toContain("destination");
  expect(onFilter).not.toHaveBeenCalled(); expect(onArm).not.toHaveBeenCalled();
  expect(mocks.saveFolder).not.toHaveBeenCalled();
  // 일반 클릭은 기존 생성 목적지/API 저장 계약을 유지한다.
  await act(async () => (host.querySelector(".folder-tree-row.viewed-resolve") as HTMLElement).click());
  expect(onArm).toHaveBeenCalledWith("view-project", "parent/target");
  expect(mocks.saveFolder).toHaveBeenCalledWith("view-project", "parent/target");
});

it("폴더 트리가 없어도 읽기 전용 경로를 안전하게 표시한다", async () => {
  await act(async () => root.render(<ProjectSection
    projects={[{ id: "missing-tree", name: "Project", count: 1 } as Project]}
    unassignedCount={0} archivedCount={0} deletedOnly={false}
    viewedFolder={{ projectId: "missing-tree", path: "<img onerror=alert(1)>/target", nonce: 2 }}
    onFilter={noop} onViewDeleted={noop}
  />));
  expect(host.querySelector(".resolve-viewed-path")?.textContent).toContain("<img onerror=alert(1)>/target");
  expect(host.querySelector(".resolve-viewed-path img")).toBeNull();
  expect(mocks.saveFolder).not.toHaveBeenCalled();
});

it("다른 생성 워크스페이스의 프로젝트도 등록·전환 없이 조회용 이름과 경로를 보여준다", async () => {
  const onFilter = vi.fn(), onArm = vi.fn();
  await act(async () => root.render(<ProjectSection
    projects={[]} unassignedCount={0} archivedCount={0} deletedOnly={false}
    viewedFolder={{ projectId: "other-workspace-project", projectName: "다른 팀 <Project>", path: "episode/clip", nonce: 3 }}
    onFilter={onFilter} onArmFolder={onArm} onViewDeleted={noop}
  />));
  const fallback = host.querySelector('[data-project-id="other-workspace-project"]')!;
  expect(fallback.textContent).toContain("다른 팀 <Project>");
  expect(fallback.textContent).toContain("episode/clip");
  expect(fallback.querySelector("button")).toBeNull();
  expect(onFilter).not.toHaveBeenCalled(); expect(onArm).not.toHaveBeenCalled();
  expect(mocks.folder).not.toHaveBeenCalled(); expect(mocks.saveFolder).not.toHaveBeenCalled();
});
