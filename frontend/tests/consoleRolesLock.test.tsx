// @vitest-environment jsdom
// 콘솔의 역할 저장(조작 규칙 52 — 25회차, Codex 전수 검토): 저장 뒤 명단을 다시 읽기 **전에** 잠금을 풀어, 그 사이에 다시 연 메뉴가 옛 역할 배열(방금 넣은
//  역할이 빠진)로 저장을 보냈다 — 서버는 역할 전체를 교체하므로 방금 넣은 Sup 가 사라졌다. 최신 역할이 화면에 올 때까지 잠근다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CreditPlanSettings } from "../src/lib/creditPlan";

const mocks = vi.hoisted(() => ({ creditPlan: vi.fn(), creditPlanSettings: vi.fn(), memberTable: vi.fn(), setProjectRoles: vi.fn(), removeProjectMember: vi.fn() }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: { creditPlan: mocks.creditPlan, creditPlanSettings: mocks.creditPlanSettings, memberTable: mocks.memberTable } }));
vi.mock("../src/api", () => ({ api: { setProjectRoles: mocks.setProjectRoles, removeProjectMember: mocks.removeProjectMember } }));

import { ConsoleSubView } from "../src/components/manage/console/ConsoleSubView";

const settings: CreditPlanSettings = {
  workspace_id: "ws", month: "2026-10", plan: { monthly_topup: null, note: "", revision: 1, updated_at: null }, groups: [], topups: [],
  members: [{ email: "a@x", name: "a", workspace_role: "member", is_available: true, group_id: null }],
};
const table = (roles: string[]) => ({
  workspace_id: "ws", cycle_start: "2026-10-01", cycle_end: "2026-10-31", groups: [], credit: settings,
  rows: [{ email: "a@x", name: "a", status: "approved", global_roles: ["member"], uid: "u_a", project_editable: true, linked_accounts: 1, workspace_role: "member",
    is_available: true, last_seen_at: null, hf_plan: null, group_id: null, projects: { p1: roles }, usage: { credits: 0, count: 0, unknown: 0 } }],
  projects: [{ id: "p1", name: "본편", planning: { status: "active", start_date: null, due_date: null, budget_credits: null, budget_period: "month", archive_after_days: 30, note: null } }],
  caps: { account: false, credit: true, project_roles: true, planning: true },
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.creditPlan.mockResolvedValue({ month: "2026-10", configured: true });
  mocks.creditPlanSettings.mockResolvedValue(settings);
  mocks.setProjectRoles.mockResolvedValue([]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const pill = () => host.querySelector<HTMLButtonElement>(".wc-pill-btn")!;
const roleItem = (role: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')].find((item) => item.querySelector(`.role-${role}`))!;

it("역할 저장 뒤 명단을 다시 읽을 때까지 잠근다 — 다시 읽기 전에 연 메뉴가 옛 역할로 저장하지 않는다", async () => {
  let finishReload!: (value: ReturnType<typeof table>) => void;
  mocks.memberTable.mockResolvedValueOnce(table(["creator"])).mockReturnValueOnce(new Promise((resolve) => { finishReload = resolve; }));
  await act(async () => root.render(<ConsoleSubView workspaceId="ws" name="서브" tier="sub" today="2026-10-12" canEdit onChanged={() => {}}
    conflict={{ saveCredit: vi.fn(), savePlanning: vi.fn(), dialog: null, active: false } as never} />));
  await settle();
  expect(pill().disabled).toBe(false);
  expect(pill().textContent).toBe("Creator");
  await act(async () => { pill().click(); }); // 메뉴를 열고 Sup 를 더한다
  await act(async () => { roleItem("supervisor").click(); });
  await settle();
  expect(mocks.setProjectRoles).toHaveBeenCalledWith("p1", "u_a", ["creator", "supervisor"]);
  expect(mocks.memberTable).toHaveBeenCalledTimes(2); // 저장은 끝났고 다시 읽기는 아직
  expect(pill().disabled).toBe(true); // 전엔 여기서 풀려 — 화면은 아직 [Creator] 라 다음 저장이 [Creator, PM] 으로 나가 Supervisor 가 사라졌다
  await act(async () => { finishReload(table(["creator", "supervisor"])); });
  await settle();
  expect(pill().disabled).toBe(false);
  expect(pill().textContent).toContain("Sup"); // 다시 읽은 역할(Supervisor 의 짧은 이름)이 화면에 있다
});

// Codex 코드 리뷰: 다시 읽기에 순번이 없어, 먼저 떠난 자동 재조회(reloadSignal)가 뒤에 떠난 조회보다 늦게 오면 최신 명단을 옛 명단으로 덮었다 — 다음 저장이
//  옛 배열로 나간다. 그리고 마지막에 떠난 조회가 오기 전에는 화면의 역할이 낡았을 수 있어 알약을 잠근다(2차 리뷰).
it("먼저 떠난 자동 재조회가 뒤에 떠난 조회보다 늦게 와도 최신 명단을 덮지 않는다 — 마지막에 떠난 조회가 올 때까지 알약은 잠긴다", async () => {
  let finishR0!: (value: ReturnType<typeof table>) => void;
  let finishR2!: (value: ReturnType<typeof table>) => void;
  mocks.memberTable.mockResolvedValueOnce(table(["creator"]))
    .mockReturnValueOnce(new Promise((resolve) => { finishR0 = resolve; }))
    .mockReturnValueOnce(new Promise((resolve) => { finishR2 = resolve; }));
  const view = (reloadSignal: number) => (
    <ConsoleSubView workspaceId="ws" name="서브" tier="sub" today="2026-10-12" canEdit onChanged={() => {}} reloadSignal={reloadSignal}
      conflict={{ saveCredit: vi.fn(), savePlanning: vi.fn(), dialog: null, active: false } as never} />
  );
  await act(async () => root.render(view(0)));
  await settle();
  expect(pill().disabled).toBe(false);
  await act(async () => root.render(view(1))); // 다른 관리자의 변경 알림 — 자동 재조회 R0 가 떠났다(아직 안 옴)
  await settle();
  expect(pill().disabled).toBe(true); // 화면의 역할이 낡았을 수 있다 — 전엔 열 수 있었다
  await act(async () => root.render(view(2))); // 또 한 번 — R2
  await settle();
  await act(async () => { finishR2(table(["creator", "supervisor"])); }); // 뒤에 떠난 R2 가 먼저 온다(다른 관리자가 Sup 를 넣었다)
  await settle();
  expect(pill().disabled).toBe(false);
  expect(pill().textContent).toContain("Sup");
  await act(async () => { finishR0(table(["creator"])); }); // 늦은 R0 = 옛 명단
  await settle();
  expect(pill().textContent).toContain("Sup"); // 전엔 [Creator] 로 되돌아가 다음 저장이 Sup 없이 나갔다
  expect(pill().disabled).toBe(false);
});

// Codex 코드 리뷰(2차): 저장 뒤의 조회 R1 이 뒤에 떠난 자동 조회 R2 에 밀려 버려지면, R1 을 기다리던 저장이 잠금을 풀어 화면은 아직 옛 역할인데 다음 저장을 받았다.
it("저장 뒤의 조회가 뒤에 떠난 자동 조회에 밀려 버려져도, 그 자동 조회가 올 때까지 역할 알약은 잠겨 있다", async () => {
  let finishR1!: (value: ReturnType<typeof table>) => void;
  let finishR2!: (value: ReturnType<typeof table>) => void;
  mocks.memberTable.mockResolvedValueOnce(table(["creator"]))
    .mockReturnValueOnce(new Promise((resolve) => { finishR1 = resolve; }))
    .mockReturnValueOnce(new Promise((resolve) => { finishR2 = resolve; }));
  const view = (reloadSignal: number) => (
    <ConsoleSubView workspaceId="ws" name="서브" tier="sub" today="2026-10-12" canEdit onChanged={() => {}} reloadSignal={reloadSignal}
      conflict={{ saveCredit: vi.fn(), savePlanning: vi.fn(), dialog: null, active: false } as never} />
  );
  await act(async () => root.render(view(0)));
  await settle();
  await act(async () => { pill().click(); });
  await act(async () => { roleItem("supervisor").click(); }); // 저장 → R1
  await settle();
  await act(async () => root.render(view(1))); // 그 사이 자동 재조회 R2
  await settle();
  await act(async () => { finishR1(table(["creator", "supervisor"])); }); // R1 이 먼저 — R2 에 밀려 버려진다
  await settle();
  expect(pill().textContent).toBe("Creator"); // 화면은 아직 옛 역할
  expect(pill().disabled).toBe(true); // 전엔 여기서 풀려 다음 저장이 [Creator, PM] 으로 나갔다
  await act(async () => { finishR2(table(["creator", "supervisor"])); });
  await settle();
  expect(pill().disabled).toBe(false);
  expect(pill().textContent).toContain("Sup");
});
