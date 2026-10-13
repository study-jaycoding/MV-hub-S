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
