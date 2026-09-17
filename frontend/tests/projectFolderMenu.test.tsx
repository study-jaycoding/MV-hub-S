// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSection } from "../src/components/sidebar/ProjectSection";
import { CanvasFolderSidebar } from "../src/components/sidebar/CanvasFolderSidebar";
import { projectApi } from "../src/lib/projectApi";
import type { Project, ProjectFolderState } from "../src/types";

const mocks = vi.hoisted(() => ({ links: vi.fn(), folder: vi.fn(), counts: vi.fn() }));
vi.mock("../src/api", () => ({ api: {
  projectFolderLinks: mocks.links, projectFolder: mocks.folder, projectFolderCountsBatch: mocks.counts,
} }));
vi.mock("../src/lib/i18n", () => ({ useT: () => (text: string) => text }));
vi.mock("../src/lib/teamSeen", () => ({ subscribeTeamSeen: () => () => {}, getTeamSeenVersion: () => 0,
  getTeamBase: () => null, isAckedFor: () => false, ackTeamFreshKeys: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  mocks.counts.mockResolvedValue({ counts: {} });
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function menu(tab: "my" | "team", canvas = false) {
  const pid = `menu-${tab}${canvas ? "-canvas" : ""}`;
  const state = { project_id: pid, root_path: "fixture", selected_path: "", tree: {
    path: "", name: "Render", children: [{ path: "제이", name: "제이", children: [] }],
  } } as unknown as ProjectFolderState;
  mocks.links.mockResolvedValue({ links: { [pid]: state } }); mocks.folder.mockResolvedValue(state);
  const action = vi.fn();
  await act(async () => root.render(canvas ? <CanvasFolderSidebar
    projects={[{ id: pid, name: "Project", count: 1 } as Project]} filters={{ tab, project_id: pid }}
    unassignedCount={0} archivedCount={0} onChange={vi.fn()} onFolderAction={action}
  /> : <ProjectSection projects={[{ id: pid, name: "Project", count: 1 } as Project]}
    unassignedCount={0} archivedCount={0} deletedOnly={false} tab={tab} activeId={pid}
    onFilter={vi.fn()} onViewDeleted={vi.fn()} onFolderAction={action} />));
  const row = host.querySelector(".folder-tree-row")!;
  expect(row).toBeTruthy();
  act(() => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 })));
  return { action, row, menu: document.querySelector<HTMLElement>('[role="menu"]')! };
}

it("공유 폴더는 골드 저장과 원본 열기를 표시하고 열기에는 확인창이 없다", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const { action, menu: popup } = await menu("team");
  expect(popup.textContent).toContain("골드만 저장");
  const open = popup.querySelector<HTMLButtonElement>('.folder-ctx-head button[aria-label="원본 위치 열기"]')!;
  expect(open).toBeTruthy();
  act(() => open.click());
  expect(confirm).not.toHaveBeenCalled();
  expect(action).toHaveBeenCalledExactlyOnceWith("open-folder", "menu-team", "제이", "제이");
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("골드 저장은 기존 확인창과 save-finals 동작을 유지한다", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const { action, menu: popup } = await menu("team");
  act(() => (popup.querySelector(".folder-ctx-btn") as HTMLButtonElement).click());
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("골드만 저장"));
  expect(action).toHaveBeenCalledExactlyOnceWith("save-finals", "menu-team", "제이", "제이");
});

it("작업 공간에서도 상단 원본 열기가 동작하고 기존 팀 공유 버튼을 유지한다", async () => {
  const { action, menu: popup } = await menu("my");
  expect(popup.textContent).toContain("팀에 공유");
  act(() => popup.querySelector<HTMLButtonElement>('.folder-ctx-head button[aria-label="원본 위치 열기"]')!.click());
  expect(action).toHaveBeenCalledExactlyOnceWith("open-folder", "menu-my", "제이", "제이");
});

it("캔버스의 동일한 폴더 메뉴에서도 상단 원본 열기가 동작한다", async () => {
  const { action, menu: popup } = await menu("my", true);
  act(() => popup.querySelector<HTMLButtonElement>('.folder-ctx-head button[aria-label="원본 위치 열기"]')!.click());
  expect(action).toHaveBeenCalledExactlyOnceWith("open-folder", "menu-my-canvas", "제이", "제이");
});

it("열기 API에는 프로젝트 ID와 상대 폴더만 전송한다", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await projectApi.openProjectFolder("p1", "제이/shot 01");
  expect(fetch.mock.calls[0][0]).toBe("/api/manage/project-folders/reveal");
  expect(fetch.mock.calls[0][1].method).toBe("POST");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ project_id: "p1", folder_path: "제이/shot 01" });
});
