// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSection } from "../src/components/sidebar/ProjectSection";
import { CanvasFolderSidebar } from "../src/components/sidebar/CanvasFolderSidebar";
import { projectApi } from "../src/lib/projectApi";
import type { Project, ProjectFolderState } from "../src/types";

const mocks = vi.hoisted(() => ({ links: vi.fn(), folder: vi.fn(), counts: vi.fn(), reorder: vi.fn() }));
vi.mock("../src/api", () => ({ api: {
  projectFolderLinks: mocks.links, projectFolder: mocks.folder, projectFolderCountsBatch: mocks.counts, reorderProjects: mocks.reorder,
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

it("공유 폴더는 공유 저장·최종 저장과 원본 열기를 표시하고 열기에는 확인창이 없다", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const { action, menu: popup } = await menu("team");
  expect([...popup.querySelectorAll(".folder-ctx-btn")].map((b) => b.textContent)).toEqual(["공유 저장", "최종 저장"]);
  // 최종 저장만 골드 — 공유 저장은 폴더 색 그대로
  expect([...popup.querySelectorAll(".folder-ctx-btn")].map((b) => b.classList.contains("tone-final"))).toEqual([false, true]);
  const open = popup.querySelector<HTMLButtonElement>('.folder-ctx-head button[aria-label="원본 위치 열기"]')!;
  expect(open).toBeTruthy();
  act(() => open.click());
  expect(confirm).not.toHaveBeenCalled();
  expect(action).toHaveBeenCalledExactlyOnceWith("open-folder", "menu-team", "제이", "제이");
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it.each([
  [0, "공유 저장", "save-shared"],
  [1, "최종 저장", "save-finals"],
])("팀 탭 %i번째 단추 '%s' 는 확인창을 거쳐 %s 로 실행된다", async (index, label, kind) => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const { action, menu: popup } = await menu("team");
  act(() => popup.querySelectorAll<HTMLButtonElement>(".folder-ctx-btn")[index].click());
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining(label));
  expect(action).toHaveBeenCalledExactlyOnceWith(kind, "menu-team", "제이", "제이");
});

it("작업 공간에서도 상단 원본 열기가 동작하고 기존 팀 공유 버튼을 유지한다", async () => {
  const { action, menu: popup } = await menu("my");
  expect(popup.textContent).toContain("팀 공유");
  act(() => popup.querySelector<HTMLButtonElement>('.folder-ctx-head button[aria-label="원본 위치 열기"]')!.click());
  expect(action).toHaveBeenCalledExactlyOnceWith("open-folder", "menu-my", "제이", "제이");
});

it("캔버스의 동일한 폴더 메뉴에서도 상단 원본 열기가 동작한다", async () => {
  const { action, menu: popup } = await menu("my", true);
  act(() => popup.querySelector<HTMLButtonElement>('.folder-ctx-head button[aria-label="원본 위치 열기"]')!.click());
  expect(action).toHaveBeenCalledExactlyOnceWith("open-folder", "menu-my-canvas", "제이", "제이");
});

// 8회차(2026-10-11 격리 실측 dist_b46): 폴더 줄에서 d 를 길게 누르면 반복마다 뒤집혔고(키다운 11번 = 토글 11번, 6/6),
//  폴더 메뉴가 열린 채 Tab 으로 닿은 뒤의 폴더 줄에서도 d 가 먹었다(3/3).
it("폴더 줄의 d(비활성)는 길게 눌러도 한 번만 뒤집고, 폴더 메뉴가 떠 있는 동안은 쉰다", async () => {
  const { row } = await menu("my");
  const d = (init: KeyboardEventInit = {}) =>
    act(() => { row.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true, ...init })); });
  const off = () => row.classList.contains("disabled");
  d();
  expect(off()).toBe(false); // 메뉴가 떠 있다 — 뒤의 폴더 줄은 쉰다
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  d();
  expect(off()).toBe(true);
  for (let i = 0; i < 10; i += 1) {
    d({ repeat: true }); // 누르고 있는 동안의 자동 반복 — 걸음마다 그대로다
    expect(off()).toBe(true);
  }
  d();
  expect(off()).toBe(false);
});

// 11회차(조작 규칙 38): 프로젝트 줄의 고르기는 토글이다 — 길게 누르면 반복마다 지정·해제가 뒤집혔다.
it("프로젝트 줄의 Enter·Space 는 길게 눌러도 한 번만 고르고, 기본 동작(목록 스크롤)은 반복까지 막는다", async () => {
  const state = { project_id: "held", root_path: "fixture", selected_path: "", tree: { path: "", name: "Render", children: [] } } as unknown as ProjectFolderState;
  mocks.links.mockResolvedValue({ links: { held: state } }); mocks.folder.mockResolvedValue(state);
  const onFilter = vi.fn();
  await act(async () => root.render(<ProjectSection projects={[{ id: "held", name: "Held Project", count: 1 } as Project]}
    unassignedCount={0} archivedCount={0} deletedOnly={false} tab="my" activeId={undefined}
    onFilter={onFilter} onViewDeleted={vi.fn()} />));
  const row = host.querySelector<HTMLElement>('.proj-row[title="Held Project"]')!;
  const press = (key: string, repeat = false, target: HTMLElement = row) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, repeat });
    act(() => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  expect(press("Enter")).toBe(true); press("Enter", true); press("Enter", true);
  expect(onFilter).toHaveBeenCalledExactlyOnceWith("held");
  expect(press(" ")).toBe(true);
  expect(press(" ", true)).toBe(true); // 길게 눌린 Space — 고르지는 않아도 목록이 스크롤되면 안 된다
  expect(onFilter).toHaveBeenCalledTimes(2);
  // 줄 안의 접기 단추에서 올라온 키는 그 단추의 것이다 — 줄이 막으면 단추가 안 눌리고, 받으면 접으면서 프로젝트까지 골라진다
  const fold = row.querySelector<HTMLElement>("button.proj-fold")!;
  expect(press("Enter", false, fold)).toBe(false);
  expect(press(" ", false, fold)).toBe(false);
  expect(onFilter).toHaveBeenCalledTimes(2);
});

// 12회차(조작 규칙 39): ⠿ 를 누르는 동안만 줄이 draggable 이다. 누른 채 손잡이 밖에서 떼거나 창을 떠나면 그 표식이 남아,
//  그 뒤로는 줄의 이름을 끌어도 순서가 바뀌어 저장됐다(관리자 창의 프로젝트 표·서브스페이스 표도 같은 훅을 쓴다 — tests/reentryGuards).
it("프로젝트 순서 손잡이 — 손잡이 밖에서 떼거나 누른 채 창을 떠나면 줄이 끌리는 채로 남지 않는다", async () => {
  mocks.links.mockResolvedValue({ links: {} });
  await act(async () => root.render(<ProjectSection projects={[{ id: "held", name: "Held Project", count: 1 } as Project]}
    unassignedCount={0} archivedCount={0} deletedOnly={false} tab="my" activeId={undefined}
    onFilter={vi.fn()} onViewDeleted={vi.fn()} />));
  const row = host.querySelector<HTMLElement>('.proj-row[title="Held Project"]')!;
  const press = () => act(() => { row.querySelector(".proj-drag-handle")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  press();
  expect(row.draggable).toBe(true);
  act(() => { document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); }); // 손잡이 밖에서 뗌
  expect(row.draggable).toBe(false);
  press();
  act(() => { window.dispatchEvent(new Event("blur")); }); // 누른 채 다른 창으로(Alt+Tab)
  expect(row.draggable).toBe(false);
});

// 14회차(조작 규칙 41): 순서 저장의 실패를 삼켜, 새로 고칠 때까지 저장 안 된 순서가 보였다.
it("프로젝트 순서 — 저장에 실패하면 끌기 전 순서로 되돌리고 알린다. 그사이 목록이 다시 그려졌으면 그것을 둔다", async () => {
  mocks.links.mockResolvedValue({ links: {} });
  const flashes: string[] = [];
  const onFlash = (event: Event) => { flashes.push((event as CustomEvent<string>).detail); };
  window.addEventListener("ch:flash", onFlash);
  try {
    const project = (id: string) => ({ id, name: id, count: 1 }) as Project;
    const show = (projects: Project[]) => act(async () => root.render(<ProjectSection projects={projects}
      unassignedCount={0} archivedCount={0} deletedOnly={false} tab="my" activeId={undefined} onFilter={vi.fn()} onViewDeleted={vi.fn()} />));
    const names = () => [...host.querySelectorAll<HTMLElement>(".proj-row")].map((row) => row.title).filter((title) => /^[ABC]$/.test(title));
    const row = (name: string) => host.querySelector<HTMLElement>(`.proj-row[title="${name}"]`)!;
    const drag = async (from: string, to: string) => {
      await act(async () => { row(from).querySelector(".proj-drag-handle")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
      await act(async () => { row(from).dispatchEvent(Object.assign(new Event("dragstart", { bubbles: true }), { dataTransfer: {} })); });
      await act(async () => { row(to).dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: {} })); });
    };
    let fail!: (reason: Error) => void;
    const heldSave = () => new Promise((_, reject) => { fail = reject; });
    await show([project("A"), project("B")]);
    mocks.reorder.mockReturnValueOnce(heldSave());
    await drag("B", "A");
    expect(names()).toEqual(["B", "A"]); // 화면은 먼저 바뀐다
    expect(mocks.reorder).toHaveBeenCalledExactlyOnceWith(["B", "A"]);
    // 저장이 도는 동안의 다음 끌기는 받지 않는다 — 겹친 두 저장이 다 실패하면 둘째는 '저장 안 된 첫째의 순서'로 되돌린다(Codex 코드 리뷰)
    await drag("A", "B");
    expect(names()).toEqual(["B", "A"]);
    expect(mocks.reorder).toHaveBeenCalledTimes(1);
    await act(async () => { fail(new Error("offline")); });
    expect(names()).toEqual(["A", "B"]); // 전엔 저장 안 된 순서가 그대로 보였다
    expect(flashes).toEqual(["프로젝트 순서를 저장하지 못했습니다 — 원래 순서로 되돌렸습니다."]);
    // 저장되면 그대로다
    mocks.reorder.mockResolvedValueOnce({ ok: true });
    await drag("B", "A");
    expect(names()).toEqual(["B", "A"]);
    expect(flashes).toHaveLength(1);
    // 저장을 기다리는 사이에 목록이 다시 그려졌다(프로젝트가 생겼다) — 실패해도 옛 순서로 덮지 않는다
    mocks.reorder.mockReturnValueOnce(heldSave());
    await drag("A", "B");
    await show([project("A"), project("B"), project("C")]);
    expect(names()).toEqual(["A", "B", "C"]);
    await act(async () => { fail(new Error("offline")); });
    expect(names()).toEqual(["A", "B", "C"]); // 끌기 전 순서([B, A])로 되돌리면 C 가 사라진다
  } finally {
    window.removeEventListener("ch:flash", onFlash);
  }
});

// 20회차(조작 규칙 45 의 남은 자리): 끄는 프로젝트를 목록의 '몇 번째'로 들고 있어, 끄는 사이 목록이 바뀌면(다른 창이 순서를 바꿈 → 새로 고침)
//  놓는 순간 그 번호 자리에 온 **다른 프로젝트**가 옮겨져 저장됐다.
it("프로젝트 순서 — 끄는 사이 목록의 순서가 바뀌어도 잡은 프로젝트가 옮겨진다. 그사이 사라졌으면 아무것도 옮기지 않는다", async () => {
  mocks.links.mockResolvedValue({ links: {} });
  mocks.reorder.mockReset().mockResolvedValue({ ok: true });
  const project = (id: string) => ({ id, name: id, count: 1 }) as Project;
  const show = (projects: Project[]) => act(async () => root.render(<ProjectSection projects={projects}
    unassignedCount={0} archivedCount={0} deletedOnly={false} tab="my" activeId={undefined} onFilter={vi.fn()} onViewDeleted={vi.fn()} />));
  const names = () => [...host.querySelectorAll<HTMLElement>(".proj-row")].map((row) => row.title).filter((title) => /^[ABC]$/.test(title));
  const row = (name: string) => host.querySelector<HTMLElement>(`.proj-row[title="${name}"]`)!;
  const grab = async (name: string) => {
    await act(async () => { row(name).querySelector(".proj-drag-handle")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    await act(async () => { row(name).dispatchEvent(Object.assign(new Event("dragstart", { bubbles: true }), { dataTransfer: {} })); });
  };
  const dropOn = (name: string) => act(async () => { row(name).dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: {} })); });
  const dragging = () => [...host.querySelectorAll<HTMLElement>(".proj-row.row-dragging")].map((item) => item.title);
  await show([project("A"), project("B"), project("C")]);
  await grab("B");
  await show([project("C"), project("A"), project("B")]); // 끄는 사이 다른 창이 바꾼 순서가 도착했다
  expect(dragging()).toEqual(["B"]); // 전엔 번호 1 자리에 온 A 가 끌리는 줄로 보였다
  await dropOn("C");
  expect(names()).toEqual(["B", "C", "A"]); // 전엔 A 가 옮겨져 [A, C, B]
  expect(mocks.reorder).toHaveBeenCalledExactlyOnceWith(["B", "C", "A"]);

  await grab("C");
  await show([project("B"), project("A")]); // 끄는 사이 그 프로젝트가 사라졌다(다른 창이 지움)
  await dropOn("B");
  expect(names()).toEqual(["B", "A"]);
  expect(mocks.reorder).toHaveBeenCalledTimes(1);
});

it("열기 API에는 프로젝트 ID와 상대 폴더만 전송한다", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await projectApi.openProjectFolder("p1", "제이/shot 01");
  expect(fetch.mock.calls[0][0]).toBe("/api/manage/project-folders/reveal");
  expect(fetch.mock.calls[0][1].method).toBe("POST");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ project_id: "p1", folder_path: "제이/shot 01" });
});
