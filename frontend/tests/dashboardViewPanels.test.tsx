// @vitest-environment jsdom
// 대시보드 판(2026-10-03 점검) —
// L3-1: 요약(summary) 로딩·오류는 '상세' 판 안에서만 보인다. 바깥에서 조기 반환하면 워크스페이스를 고를 때마다 서브스페이스가
//       통째로 내려갔다 다시 올라와 '서브로 연결했지만…' 안내가 사라지고 화면이 깜빡였다.
// L3-4: 요약은 상세 판에서만 쓰인다 — 판이 닫혀 있으면 읽지 않고, 열 때 읽는다.
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DashboardView } from "../src/components/manage/DashboardView";
import type { ManageCaps } from "../src/lib/useManageCaps";

const mocks = vi.hoisted(() => ({ summary: vi.fn(), projectSummary: vi.fn(), allProjectMembers: vi.fn(), visibleProjectMembers: vi.fn(), mounts: { count: 0 } }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: { summary: mocks.summary, projectSummary: mocks.projectSummary } }));
vi.mock("../src/lib/projectApi", () => ({ projectApi: { allProjectMembers: mocks.allProjectMembers, visibleProjectMembers: mocks.visibleProjectMembers } }));
vi.mock("../src/components/manage/WorkspaceUsageDashboard", () => ({
  HoverMetric: () => null,
  WorkspaceUsageDashboard: ({ tableSlot, onToggleConsole, onToggleDetail }: { tableSlot?: React.ReactNode; onToggleConsole?: () => void; onToggleDetail?: () => void }) => (
    <div><button type="button" data-console onClick={onToggleConsole} /><button type="button" data-detail onClick={onToggleDetail} />{tableSlot}</div>
  ),
}));
vi.mock("../src/components/manage/console/WorkspaceConsole", () => ({
  WorkspaceConsole: () => { useEffect(() => { mocks.mounts.count += 1; }, []); return <div data-console-view />; },
}));
vi.mock("../src/components/manage/MemberTable", () => ({ MemberTable: () => null }));

const caps = { loaded: true, authOff: true, system: false, viewerUid: null, createProject: false, grantRole: false, readAll: true } as ManageCaps;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  [mocks.summary, mocks.projectSummary, mocks.allProjectMembers, mocks.visibleProjectMembers].forEach((mock) => mock.mockReset());
  mocks.mounts.count = 0;
  mocks.summary.mockReturnValue(new Promise(() => {})); // 요약이 늦게 온다(끝나지 않음)
  mocks.allProjectMembers.mockResolvedValue({});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
const render = async (workspaceId: string, reloadSignal = 0) => {
  await act(async () => { root.render(<DashboardView caps={caps} workspaceId={workspaceId} reloadSignal={reloadSignal} />); });
  await settle();
};
const click = async (selector: string) => { await act(async () => { host.querySelector<HTMLElement>(selector)!.click(); }); await settle(); };

it("L3-1 요약이 오기 전에도 워크스페이스 판을 그리고, 워크스페이스를 바꿔도 다시 마운트하지 않는다", async () => {
  await render("a");
  await click("[data-console]");
  expect(host.querySelector("[data-console-view]")).not.toBeNull();
  await render("b");
  expect(host.querySelector("[data-console-view]")).not.toBeNull();
  expect(mocks.mounts.count).toBe(1);
});

it("L3-4 상세를 읽는 중에 예약된 재조회는 그 사이 판을 닫으면 버린다(Codex 2라운드 A-4)", async () => {
  let answer: (value: { projects: [] }) => void = () => {};
  mocks.summary.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
  await render("a");
  await click("[data-detail]");
  expect(mocks.summary).toHaveBeenCalledTimes(1);
  await render("a", 1); // 읽는 중에 변경 신호 → 다음 재조회가 예약된다
  await click("[data-detail]"); // 닫기
  await act(async () => answer({ projects: [] }));
  await settle();
  expect(mocks.summary).toHaveBeenCalledTimes(1);
});

it("에피소드·시퀀스 검색 — Enter 로 알약을 쌓고, 알약이 모두 맞는 시퀀스만 보인다(Jay B안 2026-11-05)", async () => {
  const folder = (path: string, name: string) => ({
    folder_path: path, count: 1, final_count: 0, credits: 1, elapsed_seconds: 0, created_start: "2026-08-01", created_end: "2026-08-01",
    models: [], members: [{ uid: name, name, count: 1, final_count: 0, credits: 1 }],
  });
  mocks.summary.mockResolvedValue({ projects: [{ pid: "p1", name: "뻘뻘뻘", folders: [folder("e001/c0010", "제이"), folder("e020/c0010", "리버"), folder("e020/c0030", "리버")] }] });
  await render("a");
  await click("[data-detail]");
  const input = () => host.querySelector<HTMLInputElement>('input[aria-label="에피소드·시퀀스 검색"]')!;
  const rows = () => [...host.querySelectorAll("tbody tr")].map((row) => row.querySelector(".dash-episode-toggle span[title]")?.textContent ?? row.querySelector(".dash-sequence-path")?.textContent).filter(Boolean);
  const pills = () => [...host.querySelectorAll(".dash-seq-pills .usage-drill-chip")].map((pill) => pill.textContent);
  const type = async (text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const key = async (name: string, init: KeyboardEventInit = {}) => {
    await act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })); });
  };

  expect(rows()).toEqual(["e001", "c0010", "e020", "c0010", "c0030"]);
  await type("c0010");
  await key("Enter");
  expect(pills()).toEqual(["c0010×"]);
  expect(input().value).toBe("");
  expect(rows()).toEqual(["e001", "c0010", "e020", "c0010"]);
  await type("리버");
  await key("Enter");
  expect(pills()).toEqual(["c0010×", "리버×"]);
  expect(rows()).toEqual(["e020", "c0010"]); // c0010 이면서 리버
  await type("C0010");
  await key("Enter"); // 같은 글(대소문자 무시)은 다시 쌓지 않는다
  expect(pills()).toEqual(["c0010×", "리버×"]);
  await type("제");
  await key("Enter", { isComposing: true }); // 한글 조합 중 Enter 는 글자 확정만
  expect(pills()).toEqual(["c0010×", "리버×"]);
  expect(input().value).toBe("제");
  expect(rows()).toEqual([]); // 치고 있는 글도 함께 맞아야 한다
  await type("");
  await key("Backspace"); // 빈 칸 Backspace = 마지막 알약 빼기
  expect(pills()).toEqual(["c0010×"]);
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="검색어 c0010 빼기"]')!.click(); });
  expect(pills()).toEqual([]);
  expect(rows()).toEqual(["e001", "c0010", "e020", "c0010", "c0030"]);
});

it("L3-4 상세 판이 닫혀 있으면 요약을 읽지 않고, 열면 읽고 그 안에서 로딩을 보인다", async () => {
  await render("a");
  await render("a", 1);
  expect(mocks.summary).not.toHaveBeenCalled();
  await click("[data-detail]");
  expect(mocks.summary).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("불러오는 중");
  await click("[data-detail]"); // 닫기
  await render("a", 2);
  expect(mocks.summary).toHaveBeenCalledTimes(1);
});
