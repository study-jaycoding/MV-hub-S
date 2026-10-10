// @vitest-environment jsdom
// 놓기 대상의 강조는 끌기가 어디서 끝나든 꺼진다(7회차 R28).
// 2026-10-11 격리 실측(5/5): 라이브러리 카드를 사이드바 폴더 줄 위로 끌다 그 위에서 취소하면 줄의 강조(drop-over)가 남았다.
//  온 이벤트: dragstart(카드) → dragenter·dragover(줄) → dragend(카드). 줄에는 dragleave 가 오지 않는다 — 줄은 dragleave·drop 에서만
//  강조를 껐다. 같은 꼴(dragover 에 켜고 dragleave·drop 에만 끄는 곳)을 전부 본다: 폴더 줄 · 사이드바 '미분류' 줄 · 캔버스 Set 노드의
//  폴더 칸 · 작업 보드의 열.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FolderTreeView } from "../src/components/common/FolderTreeView";
import { BoardView } from "../src/components/manage/KanbanBoard";
import { TASK_MIME, type Task, type WorkViewProps } from "../src/components/manage/types";
import { SetCard } from "../src/components/scene/cards/SetCard";
import { ProjectSection } from "../src/components/sidebar/ProjectSection";
import { DRAG_TYPES } from "../src/lib/dragTypes";
import type { SceneCard } from "../src/lib/scenes";
import type { Project } from "../src/types";

const mocks = vi.hoisted(() => ({ links: vi.fn(), folder: vi.fn(), counts: vi.fn(), fresh: vi.fn(), creators: vi.fn(), projects: vi.fn() }));
vi.mock("../src/api", () => ({ api: {
  projectFolderLinks: mocks.links, projectFolder: mocks.folder, projectFolderCountsBatch: mocks.counts,
  teamFreshAll: mocks.fresh, creators: mocks.creators, projects: mocks.projects,
} }));
vi.mock("../src/components/MediaThumbnail", () => ({ MediaThumbnail: () => null }));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;
let source: HTMLDivElement; // 끌기를 시작한 요소(라이브러리 카드 등) — dragend 는 여기서 난다
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.links.mockResolvedValue({ links: {} });
  mocks.counts.mockResolvedValue({ counts: {}, review_counts: {} });
  mocks.fresh.mockResolvedValue([]);
  mocks.projects.mockResolvedValue({ projects: [] });
  host = document.createElement("div");
  source = document.createElement("div");
  document.body.append(host, source);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  source.remove();
  vi.unstubAllGlobals();
});

// 브라우저의 끌기 이벤트 — jsdom 에는 DragEvent·DataTransfer 가 없어 필요한 만큼만 싣는다
const drag = (target: Element, type: string, types: string[] = []) => act(async () => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer: { types, dropEffect: "none", effectAllowed: "all", getData: () => "", setData: noop } });
  target.dispatchEvent(event);
});

// 대상 위로 끌어 올려 강조가 켜진 것을 확인한 뒤, 그 위에서 끌기를 취소한다(dragleave 없이 끈 쪽에 dragend 만).
async function cancelOver(target: () => Element, lit: string, types: string[]) {
  await drag(target(), "dragenter", types);
  await drag(target(), "dragover", types);
  expect(target().classList.contains(lit), "끌어 올리면 강조가 켜진다").toBe(true);
  await drag(source, "dragend");
  expect(target().classList.contains(lit), "취소한 뒤 강조가 남지 않는다").toBe(false);
  // 다시 끌어 올리면 다시 켜지고, 밖으로 나가면(dragleave) 전처럼 꺼진다
  await drag(target(), "dragover", types);
  expect(target().classList.contains(lit)).toBe(true);
  await drag(target(), "dragleave", types);
  expect(target().classList.contains(lit)).toBe(false);
}

it("폴더 줄: 그 위에서 끌기를 취소하면 강조가 꺼진다", async () => {
  await act(async () => {
    root.render(<FolderTreeView nodes={[{ name: "C0040", path: "e035/C0040" }]} onSelect={noop} onDropFolder={noop} />);
  });
  await cancelOver(() => host.querySelector(".folder-tree-row")!, "drop-over", [DRAG_TYPES.generation]);
});

it("사이드바 '미분류' 줄: 그 위에서 끌기를 취소하면 강조가 꺼진다", async () => {
  const props: ComponentProps<typeof ProjectSection> = {
    projects: [{ id: "p1", name: "Project", count: 1 } as Project], unassignedCount: 2, archivedCount: 0, activeId: undefined,
    tab: "my", deletedOnly: false, onFilter: noop, onViewDeleted: noop, onDropToUnassigned: noop,
  };
  await act(async () => { root.render(<ProjectSection {...props} />); });
  await cancelOver(() => host.querySelector(".proj-unassigned")!, "drop-over", [DRAG_TYPES.generation]);
});

it("캔버스 Set 노드의 폴더 칸: 그 위에서 끌기를 취소하면 강조가 꺼진다", async () => {
  const card = { id: "s1", kind: "set", x: 0, y: 0 } as SceneCard;
  await act(async () => {
    root.render(<SetCard card={card} setFolder={noop} setTagsText={noop} flushPending={noop} onOutPortDown={noop} onResizeDown={noop} />);
  });
  await cancelOver(() => host.querySelector(".scene-setnode-folder")!, "drag-over", [DRAG_TYPES.folder]);
});

it("작업 보드의 열: 그 위에서 끌기를 취소하면 강조가 꺼진다", async () => {
  const task: Task = {
    id: "task", project_id: "project", name: "episode", sequence: "cut", status: "in_progress",
    created_at: "2026-09-17", derived_start: "2026-09-17", derived_due: "2026-09-17", cuts: [],
  };
  const props: WorkViewProps = {
    tasks: [task], seqOptions: [], thumb: (path) => path || undefined, disabled: new Set(),
    onPatch: vi.fn(), onDelete: vi.fn(), onLinkGen: vi.fn(), onUnlinkGen: vi.fn(),
  };
  await act(async () => { root.render(<BoardView {...props} />); });
  await cancelOver(() => host.querySelectorAll(".kanban-col")[1], "drop", [TASK_MIME]);
});

it("강조가 꺼져 있는 동안에는 창의 끌기 이벤트를 듣지 않는다 — 켜져 있는 동안만 듣고, 꺼지면 뗀다", async () => {
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const dragEnds = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === "dragend").length;
  await act(async () => {
    root.render(<FolderTreeView nodes={[{ name: "a", path: "a" }, { name: "b", path: "b" }]} onSelect={noop} onDropFolder={noop} />);
  });
  expect(dragEnds(add)).toBe(0); // 줄이 몇백 개여도 가만히 있을 때는 리스너가 없다
  const row = host.querySelector(".folder-tree-row")!;
  await drag(row, "dragover", [DRAG_TYPES.generation]);
  expect(dragEnds(add)).toBe(1);
  await drag(row, "dragleave", [DRAG_TYPES.generation]);
  expect(dragEnds(remove)).toBe(1);
});
