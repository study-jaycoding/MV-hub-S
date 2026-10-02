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
