// @vitest-environment jsdom
// 사이드바의 '보는 중'·'생성' 표(Jay 2026-10-15 8A) — 앱을 새로 켜면 목록이 보는 폴더와 분홍(다음 생성 위치)이 다를 수 있다.
//  갈렸을 때만 보는 줄에 라임 테두리+'보는 중', 분홍 줄에 '생성'. 같으면 아무 표시 없다. 생성 위치는 고치지 않는다.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSection } from "../src/components/sidebar/ProjectSection";
import { FilterSidebar } from "../src/components/FilterSidebar";
import { CanvasFolderSidebar } from "../src/components/sidebar/CanvasFolderSidebar";
import type { Filters, Project } from "../src/types";

const mocks = vi.hoisted(() => ({ links: vi.fn(), folder: vi.fn(), counts: vi.fn(), fresh: vi.fn(), creators: vi.fn(), projects: vi.fn() }));
vi.mock("../src/api", () => ({ api: {
  projectFolderLinks: mocks.links, projectFolder: mocks.folder, projectFolderCountsBatch: mocks.counts,
  teamFreshAll: mocks.fresh, creators: mocks.creators, projects: mocks.projects,
} }));

const noop = () => {};
const leaf = (name: string) => ({ path: name, name, children: [] });
const state = { project_id: "p1", root_path: "fixture", selected_path: "",
  tree: { path: "", name: "Render", children: [leaf("e035"), leaf("e036"), leaf("e037")] } };
const projects = [{ id: "p1", name: "데모", count: 28 } as Project];
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
    onFilter: noop, onViewDeleted: noop };
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
  await draw({ activeId: undefined, armedFolder: null });
  expect(marks()).toEqual([[], []]);
  await draw({ activeId: undefined, deletedOnly: true, viewPath: "e035", armedFolder: { projectId: "p1", path: "e036" } }); // 휴지통은 생성 목적지가 아니다
  expect(marks()).toEqual([[], []]);
});

it("③ 보는 폴더가 바뀌면 표시가 따라간다 — 같아지면 사라진다(공유 & 리뷰·워크스페이스·캔버스 사이드바 모두)", async () => {
  const armedFolder = { projectId: "p1", path: "e036" };
  const sidebars = [
    (filters: Filters) => <FilterSidebar projects={projects} unassignedCount={2} archivedCount={0}
      filters={filters} onChange={noop} facets={{ auto_tags: [], tags: [], colors: [], workers: [] }}
      colorDots={[]} colorFilter={new Set()} onToggleColor={noop} armedAutoTags={new Set()}
      onToggleAutoTag={noop} onAddAutoTag={noop} onDeleteAutoTag={noop} workspaceChips={[]}
      onToggleWorkspaceChip={noop} onRemoveWorkspaceChip={noop} onCreatorChanged={noop} armedFolder={armedFolder} />,
    (filters: Filters) => <CanvasFolderSidebar projects={projects} unassignedCount={2} archivedCount={0}
      filters={filters} onChange={noop} armedFolder={armedFolder} />,
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
