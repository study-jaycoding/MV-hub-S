// @vitest-environment jsdom
// 사이드바의 '보는 중'·'생성' 표(Jay 2026-10-15 8A) — 앱을 새로 켜면 목록이 보는 폴더와 다음 생성 위치가 다를 수 있다.
//  갈렸을 때만 보는 줄에 라임 테두리+'보는 중', 실제 생성 목적지 줄에 '생성'. 같으면 아무 표시 없다. 생성 위치는 고치지 않는다.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSection } from "../src/components/sidebar/ProjectSection";
import { FilterSidebar } from "../src/components/FilterSidebar";
import { CanvasFolderSidebar } from "../src/components/sidebar/CanvasFolderSidebar";
import type { Store } from "../src/lib/storage";
import { useLibraryFilters } from "../src/lib/useLibraryFilters";
import { FILTERS_KEY, GENERATION_SCOPE_KEY } from "../src/lib/useLibraryPersistence";
import type { Filters, Project } from "../src/types";

const mocks = vi.hoisted(() => ({ links: vi.fn(), folder: vi.fn(), counts: vi.fn(), fresh: vi.fn(), creators: vi.fn(), projects: vi.fn() }));
vi.mock("../src/api", () => ({ api: {
  projectFolderLinks: mocks.links, projectFolder: mocks.folder, projectFolderCountsBatch: mocks.counts,
  teamFreshAll: mocks.fresh, creators: mocks.creators, projects: mocks.projects,
} }));

const noop = () => {};
const leaf = (name: string) => ({ path: name, name, children: [] });
const folderState = (id: string) => ({ project_id: id, root_path: "fixture", selected_path: "",
  tree: { path: "", name: "Render", children: [leaf("e035"), leaf("e036"), leaf("e037")] } });
const state = folderState("p1");
const projects = [{ id: "p1", name: "데모", count: 28 } as Project];
const facets = { auto_tags: [], tags: [], colors: [], workers: [] };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.links.mockResolvedValue({ links: { p1: state } });
  mocks.folder.mockResolvedValue(state);
  mocks.counts.mockResolvedValue({ counts: {}, review_counts: {} });
  mocks.fresh.mockResolvedValue([]);
  mocks.creators.mockResolvedValue([]);
  mocks.projects.mockResolvedValue({ projects: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

type Section = ComponentProps<typeof ProjectSection>;
async function draw(props: Partial<Section>) {
  const base: Section = { projects, unassignedCount: 2, archivedCount: 0, tab: "team", deletedOnly: false,
    generationScope: { project_id: "p1" }, onFilter: noop, onViewDeleted: noop };
  await act(async () => { root.render(<ProjectSection {...base} {...props} />); });
}
/** 표가 붙은 줄의 이름 — [보는 중 줄, 생성 줄]. 라임 테두리(see-here)는 '보는 중' 줄에만 있어야 한다. */
function marks() {
  const nameOf = (mark: Element) => mark.parentElement!.querySelector(".proj-name, .folder-tree-name")!.textContent;
  const see = [...host.querySelectorAll(".side-mark.see")];
  const gen = [...host.querySelectorAll(".side-mark.gen")];
  const lime = [...host.querySelectorAll(".see-here")];
  expect(lime.length === see.length && lime.every((row, i) => row === see[i].parentElement)).toBe(true);
  expect(see.map((mark) => mark.textContent)).toEqual(see.map(() => "보는 중"));
  expect(gen.map((mark) => mark.textContent)).toEqual(gen.map(() => "생성"));
  return [see.map(nameOf), gen.map(nameOf)];
}

it("① 다르면 두 표시 — 보는 폴더엔 라임 테두리+'보는 중', 분홍(무장) 폴더엔 '생성'", async () => {
  await draw({ activeId: "p1", viewPath: "e035", armedFolder: { projectId: "p1", path: "e036" } });
  expect(marks()).toEqual([["e035"], ["e036"]]);
  expect(host.querySelector(".folder-tree-row.selected .folder-tree-name")?.textContent).toBe("e036"); // 분홍은 그대로
  // 프로젝트 맨 위를 보는데 생성은 폴더 — 프로젝트 줄이 '보는 중'
  await draw({ activeId: "p1", armedFolder: { projectId: "p1", path: "e036" } });
  expect(marks()).toEqual([["데모"], ["e036"]]);
  // 폴더를 보는데 생성은 프로젝트 맨 위(분홍 프로젝트 줄) — 프로젝트 줄이 '생성'
  await draw({ activeId: "p1", viewPath: "e035", armedFolder: null });
  expect(marks()).toEqual([["e035"], ["데모"]]);
  expect(host.querySelector(".proj-tree-wrap > .proj-row")!.classList.contains("sel-target")).toBe(true);
  // 라이브러리를 보는데 생성은 폴더 — 라이브러리 줄이 '보는 중'
  await draw({ activeId: undefined, armedFolder: { projectId: "p1", path: "e036" } });
  expect(marks()).toEqual([["라이브러리"], ["e036"]]);
});

it("② 같으면 표시 없음 — 같은 폴더·같은 프로젝트 맨 위·라이브러리·휴지통 보기", async () => {
  await draw({ activeId: "p1", viewPath: "e036", armedFolder: { projectId: "p1", path: "e036" } });
  expect(marks()).toEqual([[], []]);
  expect(host.querySelector(".folder-tree-row.selected .folder-tree-name")?.textContent).toBe("e036");
  await draw({ activeId: "p1", armedFolder: null });
  expect(marks()).toEqual([[], []]);
  await draw({ activeId: undefined, armedFolder: null, generationScope: {} });
  expect(marks()).toEqual([[], []]);
  await draw({ activeId: undefined, deletedOnly: true, viewPath: "e035", armedFolder: { projectId: "p1", path: "e036" } }); // 휴지통은 생성 목적지가 아니다
  expect(marks()).toEqual([[], []]);
  await draw({ activeId: "p1", viewPath: "e035", armedFolder: { projectId: "p1", path: "e036" }, generationScope: undefined }); // 목적지를 모르는 호출자
  expect(marks()).toEqual([[], []]);
});

it("③ 보는 폴더가 바뀌면 표시가 따라간다 — 같아지면 사라진다(공유 & 리뷰·워크스페이스·캔버스 사이드바 모두)", async () => {
  const armedFolder = { projectId: "p1", path: "e036" };
  const generationScope = { project_id: "p1", folder_path: "e036" };
  const sidebars = [
    (filters: Filters) => <FilterSidebar projects={projects} unassignedCount={2} archivedCount={0}
      filters={filters} onChange={noop} facets={facets}
      colorDots={[]} colorFilter={new Set()} onToggleColor={noop} armedAutoTags={new Set()}
      onToggleAutoTag={noop} onAddAutoTag={noop} onDeleteAutoTag={noop} workspaceChips={[]}
      onToggleWorkspaceChip={noop} onRemoveWorkspaceChip={noop} onCreatorChanged={noop}
      armedFolder={armedFolder} generationScope={generationScope} />,
    (filters: Filters) => <CanvasFolderSidebar projects={projects} unassignedCount={2} archivedCount={0}
      filters={filters} onChange={noop} armedFolder={armedFolder} generationScope={generationScope} />,
  ];
  for (const [sidebar, tab] of [[sidebars[0], "team"], [sidebars[0], "my"], [sidebars[1], "compose"]] as const) {
    const show = (folder_path?: string) => act(async () => { root.render(sidebar({ tab, project_id: "p1", folder_path })); });
    await show("e035");
    expect(marks()).toEqual([["e035"], ["e036"]]);
    await show("e037");
    expect(marks()).toEqual([["e037"], ["e036"]]);
    await show("e036");
    expect(marks()).toEqual([[], []]);
    await show(undefined);
    expect(marks()).toEqual([["데모"], ["e036"]]);
  }
});

// Codex 독립 리뷰 P2(2026-10-15): A 맨 위(고른 폴더 없음)로 생성하던 중 다빈치 따라가기로 화면이 B/e035 로 가면, 분홍(옛 규칙 — 보는 프로젝트)은
//  B 이지만 생성 요청은 여전히 A 로 간다. '생성'은 B 가 아니라 실제 목적지 A 에 붙어야 한다. 실제 필터 훅(useLibraryFilters)으로 순서를 그대로 밟는다.
it("④ 다빈치 따라가기로 다른 프로젝트 폴더를 보게 돼도 '생성'은 실제 생성 목적지(generationScope)에 — 분홍인 보는 프로젝트가 아니다", async () => {
  const states: Record<string, ReturnType<typeof folderState>> = { pA: folderState("pA"), pB: folderState("pB") };
  mocks.links.mockResolvedValue({ links: states });
  mocks.folder.mockImplementation(async (id: string) => states[id]);
  const two = [{ id: "pA", name: "A", count: 3 } as Project, { id: "pB", name: "B", count: 4 } as Project];
  const data: Record<string, string> = {
    [FILTERS_KEY]: JSON.stringify({ tab: "team", project_id: "pA" }),
    [GENERATION_SCOPE_KEY]: JSON.stringify({ project_id: "pA" }),
  };
  const store: Store = {
    get: (key, fallback) => data[key] ?? fallback,
    set: (key, value) => void (data[key] = value),
    loadJSON: <T,>(key: string) => (key in data ? (JSON.parse(data[key]) as T) : null),
    setJSON: (key, value) => void (data[key] = JSON.stringify(value)),
    loadSet: (key) => new Set(key in data ? JSON.parse(data[key]) : []),
    setSet: (key, value) => void (data[key] = JSON.stringify([...value])),
  };
  let lib!: ReturnType<typeof useLibraryFilters>;
  function Library() {
    lib = useLibraryFilters(store);
    // App 과 같은 배선 — 사이드바는 보는 자리(filters)·무장 폴더·생성 요청의 프로젝트(generationScope)를 받는다
    return <FilterSidebar projects={two} unassignedCount={0} archivedCount={0} filters={lib.filters} onChange={lib.patch}
      facets={facets} colorDots={[]} colorFilter={new Set()} onToggleColor={noop} armedAutoTags={new Set()}
      onToggleAutoTag={noop} onAddAutoTag={noop} onDeleteAutoTag={noop} workspaceChips={[]}
      onToggleWorkspaceChip={noop} onRemoveWorkspaceChip={noop} onCreatorChanged={noop}
      armedFolder={lib.armedFolder} generationScope={lib.generationScope} />;
  }
  await act(async () => { root.render(<Library />); });
  expect(marks()).toEqual([[], []]); // A 맨 위를 보며 A 맨 위로 생성
  await act(async () => { lib.followLocation({ project_id: "pB", folder_path: "e035" }); }); // 다빈치 따라가기
  expect(lib.generationScope).toEqual({ project_id: "pA" }); // 따라가기는 생성 위치를 바꾸지 않는다
  expect(marks()).toEqual([["e035"], ["A"]]);
  expect(host.querySelector('[data-project-id="pB"] .side-mark.see')).not.toBeNull(); // 보는 e035 는 B 의 것
  const rowB = [...host.querySelectorAll(".proj-tree-wrap > .proj-row")].find((row) => row.textContent?.includes("B"))!;
  expect(rowB.classList.contains("sel-target")).toBe(true); // 분홍 규칙은 그대로(보는 프로젝트) — 고치지 않는다
});
