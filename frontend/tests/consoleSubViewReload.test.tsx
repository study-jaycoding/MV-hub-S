// @vitest-environment jsdom
// 서브 화면(그룹·참가자·크레딧)도 다른 관리자의 변경을 따라간다(2026-10-03 점검 L3-5) — 단 열린 편집 창의 기준값은 연 순간 그대로.
// 재조회가 기준을 바꾸면 창의 옛 값이 새 revision 으로 실려 충돌 없이 덮인다(Codex 검토).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConsoleSubView } from "../src/components/manage/console/ConsoleSubView";
import { useManageEditConflict } from "../src/components/manage/useManageEditConflict";

const mocks = vi.hoisted(() => ({ creditPlan: vi.fn(), creditPlanSettings: vi.fn(), memberTable: vi.fn(), saveCreditPlan: vi.fn() }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: mocks }));

const member = (email: string) => ({ email, name: email.split("@")[0], group_id: "g1", quota: null, quota_effective: null, used_period: 0, remaining: null, is_available: true });
const settings = (revision: number, emails: string[], auto = true) => ({ workspace_id: "a", month: "2026-11",
  plan: { monthly_topup: 100, monthly_topup_source: "manual", recurring_topup: 100, recurring_auto: auto, recurring_period: "month",
    recurring_anchor: null, topup_day: 1, note: null, revision, updated_at: null },
  groups: [{ id: "g1", name: "애니", monthly_limit: null, member_count: emails.length, used_month: 0, unknown_month: 0, remaining: null, unknown_since_base: 0, estimated: false }],
  members: emails.map(member), topups: [] });
const SUB = { id: "a", name: "A", monthly_topup: 100, monthly_topup_source: "manual", recurring_auto: true, recurring_period: "month",
  recurring_anchor: null, topup_day: 1, next_topup_day: "2026-12-01", cycle_start: "2026-11-01", cycle_end: "2026-11-30",
  topups_cycle: { count: 0, credits: 0 }, used_cycle: 0, unknown_cycle: 0 } as never;

function Host({ signal, sub = SUB }: { signal: number; sub?: never }) {
  const conflict = useManageEditConflict();
  return <>{conflict.dialog}<ConsoleSubView workspaceId="a" name="A" tier="sub" sub={sub} today="2026-11-03" canEdit conflict={conflict} onChanged={() => {}} reloadSignal={signal} /></>;
}

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.creditPlan.mockResolvedValue({ groups: [], topups: [] });
  mocks.creditPlanSettings.mockResolvedValue(settings(1, ["lee@a.b"]));
  mocks.memberTable.mockResolvedValue({ caps: { project_roles: false }, rows: [], projects: [] });
  mocks.saveCreditPlan.mockImplementation(async () => settings(3, ["lee@a.b"]));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const render = async (signal: number, sub?: never) => { await act(async () => { root.render(<Host signal={signal} sub={sub} />); }); await settle(); };
const peopleRows = () => [...host.querySelectorAll(".usage-table tbody tr")].filter((tr) => tr.textContent?.includes("@"));

it("다른 관리자가 참가자를 넣으면 변경 신호(reloadSignal)에 따라 명단을 다시 읽는다", async () => {
  await render(0);
  expect(peopleRows()).toHaveLength(1);
  mocks.creditPlanSettings.mockResolvedValue(settings(2, ["lee@a.b", "kim@a.b"]));
  await render(1);
  expect(peopleRows()).toHaveLength(2);
});

it("다시 읽어도 열린 크레딧 창의 기준은 연 순간의 설정 그대로다", async () => {
  await render(0);
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "크레딧")!.click(); });
  await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button.wc-btn")].find((b) => b.textContent?.includes("크레딧"))!.click(); });
  mocks.creditPlanSettings.mockResolvedValue(settings(2, ["lee@a.b"], false)); // 그사이 B 가 수동으로 바꿈
  // 개요의 이 서브 줄(sub)도 재조회로 수동이 된다 — 창은 연 순간의 값과 비교해야 날짜를 안 건드린 것으로 본다(Codex 2라운드 A-2)
  await render(1, { ...(SUB as object), recurring_auto: false, next_topup_day: null } as never);
  const input = host.querySelector<HTMLInputElement>("#wc-recurring")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => { setter?.call(input, "200"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { host.querySelector<HTMLButtonElement>(".wc-dialog button.pri")!.click(); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenCalled();
  const body = mocks.saveCreditPlan.mock.calls[0][1] as Record<string, unknown>;
  expect(body.revision).toBe(1);
  expect("topup_day" in body).toBe(false); // 금액만 고쳤다 — 충전일·기준 날짜는 보내지 않는다(CXF-3)
  expect("recurring_anchor" in body).toBe(false);
});
