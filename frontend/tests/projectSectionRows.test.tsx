// @vitest-environment jsdom
// 사이드바 프로젝트 줄 — 이미 고른 프로젝트를 다시 눌러도 그 프로젝트(맨 위)다. 전엔 '같은 줄 다시 누름 = 해제' 토글이라 라이브러리로 튀었다
//  (Jay 2026-10-13: "이미 뻘뻘뻘을 선택하고 있다가 다시 한번 뻘뻘뻘을 누르면 라이브러리로 이동이 되는 버그"). 해제는 '라이브러리' 줄. 미분류 줄도 같다.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSection } from "../src/components/sidebar/ProjectSection";
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
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.links.mockResolvedValue({ links: {} });
  mocks.counts.mockResolvedValue({ counts: {}, review_counts: {} });
  mocks.fresh.mockResolvedValue([]);
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

const row = (name: string) => [...host.querySelectorAll<HTMLElement>(".proj-row")].find((el) => el.querySelector(".proj-name")?.textContent === name)!;
const key = (el: Element, name: string, init: KeyboardEventInit = {}) => act(() => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
});

async function draw(activeId: string | undefined, onFilter: (id?: string) => void) {
  const props: ComponentProps<typeof ProjectSection> = {
    projects: [{ id: "p1", name: "뻘뻘뻘", count: 411 } as Project], unassignedCount: 2, archivedCount: 0, activeId,
    tab: "team", deletedOnly: false, onFilter, onViewDeleted: noop, onDropToUnassigned: noop,
  };
  await act(async () => { root.render(<ProjectSection {...props} />); });
}

it("이미 고른 프로젝트 줄을 다시 눌러도 그 프로젝트다 — 클릭·Enter·Space 모두(길게 눌린 키는 무시). 미분류도 같다. 해제는 '라이브러리' 줄", async () => {
  const onFilter = vi.fn();
  await draw("p1", onFilter);
  expect(row("뻘뻘뻘").classList.contains("on")).toBe(true);
  act(() => row("뻘뻘뻘").click());
  expect(onFilter).toHaveBeenLastCalledWith("p1");
  key(row("뻘뻘뻘"), "Enter");
  expect(onFilter).toHaveBeenLastCalledWith("p1");
  key(row("뻘뻘뻘"), " ");
  expect(onFilter).toHaveBeenCalledTimes(3);
  key(row("뻘뻘뻘"), "Enter", { repeat: true }); // 길게 눌린 키는 받지 않는다(조작 규칙 38)
  expect(onFilter).toHaveBeenCalledTimes(3);
  expect(onFilter.mock.calls.every((call) => call[0] === "p1")).toBe(true); // 한 번도 해제(undefined)가 아니다
  // 미분류 — 이미 미분류여도 다시 누르면 미분류
  await draw("none", onFilter);
  act(() => row("미분류").click());
  expect(onFilter).toHaveBeenLastCalledWith("none");
  // 해제는 '라이브러리' 줄
  act(() => row("라이브러리").click());
  expect(onFilter).toHaveBeenLastCalledWith(undefined);
});

// Jay 2026-10-30: 프로젝트 앞은 글자 마크 하나 — 접기 화살표·⠿ 손잡이가 없고, 마크가 접기와 순서 끌기를 같이 맡는다.
const withTree = () => {
  const state = { project_id: "p1", root_path: "fixture", selected_path: "", tree: {
    path: "", name: "Render", children: [{ path: "e001", name: "e001", children: [] }],
  } };
  mocks.links.mockResolvedValue({ links: { p1: state } });
  mocks.folder.mockResolvedValue(state);
};

it("폴더가 있는 프로젝트 — 마크를 누르면 접히고(회색) 프로젝트는 안 골라진다. 다시 누르면 펼쳐진다. 접힘은 저장된다", async () => {
  withTree();
  const onFilter = vi.fn();
  await draw(undefined, onFilter);
  await act(async () => {});
  const mark = () => row("뻘뻘뻘").querySelector<HTMLButtonElement>("button.proj-mark")!;
  expect(row("뻘뻘뻘").querySelector(".proj-fold, .proj-drag-handle")).toBeNull();
  expect(mark().querySelector(".ws-mark-box")?.textContent).toBe("뻘");
  expect(row("뻘뻘뻘").classList.contains("open")).toBe(true);
  expect(mark().getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector(".folder-tree-name")?.textContent).toBe("e001");

  await act(async () => mark().click());
  expect(row("뻘뻘뻘").classList.contains("closed")).toBe(true);
  expect(mark().getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector(".folder-tree-name")).toBeNull();
  expect(JSON.parse(localStorage.getItem("ch.collapsedProjects")!)).toEqual(["p1"]);
  expect(onFilter).not.toHaveBeenCalled();

  await act(async () => mark().click());
  expect(row("뻘뻘뻘").classList.contains("open")).toBe(true);
  expect(onFilter).not.toHaveBeenCalled();
});

it("폴더가 없는 프로젝트 — 접을 것이 없어 마크를 누르면 줄을 누른 것과 같다. 끌기는 그대로 된다", async () => {
  const onFilter = vi.fn();
  await draw(undefined, onFilter);
  const mark = row("뻘뻘뻘").querySelector<HTMLButtonElement>("button.proj-mark")!;
  expect(row("뻘뻘뻘").classList.contains("flat")).toBe(true);
  expect(mark.hasAttribute("aria-expanded")).toBe(false);
  act(() => mark.click());
  expect(onFilter).toHaveBeenCalledExactlyOnceWith("p1");
  act(() => { mark.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(row("뻘뻘뻘").draggable).toBe(true);
});

it("위쪽 세 줄 앞에는 아이콘이 있다", async () => {
  await draw(undefined, noop);
  expect(["라이브러리", "미분류", "휴지통"].map((name) => !!row(name).querySelector(".proj-ico svg"))).toEqual([true, true, true]);
});
