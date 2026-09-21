// @vitest-environment jsdom
// 관리 표(docs/MEMBER_TABLE_DESIGN.md) — 표에는 자기만의 쓰기 API 가 없다. 칸마다 기존 API 를 부르고, 큐가 비면 표를 다시 읽는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemberTable } from "../src/components/manage/MemberTable";
import type { CreditPlanSettings } from "../src/lib/creditPlan";
import { HttpError } from "../src/lib/http";
import { groupAssignBody, lastSeenLabel, type MemberTableData, type MemberTableRow } from "../src/lib/memberTable";

const mocks = vi.hoisted(() => ({ memberTable: vi.fn(), saveCreditPlan: vi.fn(), setProjectRoles: vi.fn(), removeProjectMember: vi.fn() }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: { memberTable: mocks.memberTable, saveCreditPlan: mocks.saveCreditPlan } }));
vi.mock("../src/api", () => ({ api: { setProjectRoles: mocks.setProjectRoles, removeProjectMember: mocks.removeProjectMember } }));

const group = (id: string, name: string) => ({ id, name, monthly_limit: 5000, limit_period: "month" as const, remaining: 3480, member_count: 1, used_month: 0, unknown_month: 0, unknown_since_base: 0, estimated: false, allowed_models: ["seedance"] });
const credit = (revision: number): CreditPlanSettings => ({ workspace_id: "ws1", month: "2026-09", plan: { monthly_topup: null, note: "메모", revision, updated_at: null }, groups: [group("g1", "2nd floor"), group("g2", "3rd floor")], members: [], topups: [] });
const row = (email: string, extra: Partial<MemberTableRow> = {}): MemberTableRow => ({ email, name: email.split("@")[0], status: "approved", global_roles: ["member"], uid: "u_" + email[0], project_editable: true, linked_accounts: 1, workspace_role: "member", is_available: true, last_seen_at: null, hf_plan: null, group_id: null, projects: {}, usage: { credits: 0, count: 0, unknown: 0 }, ...extra });
const table = (revision: number, rows: MemberTableRow[]): MemberTableData => ({ workspace_id: "ws1", cycle_start: "2026-09-01", rows, projects: [{ id: "p1", name: "본편" }], groups: credit(revision).groups, credit: credit(revision), caps: { account: false, credit: true, project_roles: true } });
let root: Root, host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => { root.render(<MemberTable workspaceId="ws1" />); }); await act(async () => {}); };
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };

it("그룹 저장 본문은 받은 그룹을 전부 되보내고 허용 모델 키는 싣지 않는다", () => {
  const body = groupAssignBody(credit(7), "b@x", "g2");
  expect(body).toEqual({ revision: 7, note: "메모", groups: [{ id: "g1", name: "2nd floor", monthly_limit: 5000, limit_period: "month" }, { id: "g2", name: "3rd floor", monthly_limit: 5000, limit_period: "month" }], members: [{ email: "b@x", group_id: "g2" }] });
  expect(lastSeenLabel(null)).toBe("보고 없음");
  expect(lastSeenLabel("2026-09-21 01:42:00", new Date(2026, 8, 21, 12))).toBe("오늘 10:42"); // 서버 시각은 UTC → KST
});

it("그룹 칸을 바꾸면 기존 크레딧 설정 API 로 저장하고 표를 다시 읽는다", async () => {
  mocks.memberTable.mockResolvedValueOnce(table(3, [row("b@x")])).mockResolvedValue(table(4, [row("b@x", { group_id: "g2" })]));
  mocks.saveCreditPlan.mockResolvedValue(credit(4));
  await mount();
  const select = host.querySelector<HTMLSelectElement>("tbody select")!;
  await act(async () => { select.value = "g2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenCalledWith("ws1", expect.objectContaining({ revision: 3, members: [{ email: "b@x", group_id: "g2" }] }));
  expect(mocks.memberTable).toHaveBeenCalledTimes(2);
  expect(host.querySelector(".mtable-notice.ok")!.textContent).toContain("3rd floor");
});

it("409 는 자동으로 다시 보내지 않고 최신 값으로 다시 읽은 뒤 알린다", async () => {
  mocks.memberTable.mockResolvedValue(table(3, [row("b@x")]));
  mocks.saveCreditPlan.mockRejectedValue(new HttpError(409, "conflict"));
  await mount();
  const select = host.querySelector<HTMLSelectElement>("tbody select")!;
  await act(async () => { select.value = "g1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  expect(mocks.memberTable).toHaveBeenCalledTimes(2);
  expect(host.querySelector(".mtable-notice.bad")!.textContent).toContain("다른 사람이 먼저");
  expect(host.querySelector<HTMLSelectElement>("tbody select")!.value).toBe(""); // 서버 값으로 돌아왔다
});

it("에이전트가 연결되지 않은 계정은 프로젝트 칸이 닫히고, 마지막 역할을 빼면 확인 뒤 제거 API 를 부른다", async () => {
  mocks.memberTable.mockResolvedValue(table(1, [row("a@x", { projects: { p1: ["creator"] } }), row("c@x", { uid: null, project_editable: false })]));
  mocks.removeProjectMember.mockResolvedValue([]);
  mocks.setProjectRoles.mockResolvedValue([]);
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  await mount();
  const rows = [...host.querySelectorAll("tbody tr")];
  expect(rows[1].querySelector(".mtable-off")!.textContent).toContain("에이전트가 아직 연결되지 않아");
  expect(rows[1].querySelectorAll("button.mtable-chip").length).toBe(0);
  const chip = (label: string) => [...rows[0].querySelectorAll<HTMLButtonElement>("button.mtable-chip")].find((button) => button.textContent === label)!;
  await act(async () => { chip("Creator").click(); });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(mocks.removeProjectMember).not.toHaveBeenCalled(); // 취소하면 아무것도 안 한다
  confirm.mockReturnValue(true);
  await act(async () => { chip("Creator").click(); });
  await settle();
  expect(mocks.removeProjectMember).toHaveBeenCalledWith("p1", "u_a");
  await act(async () => { chip("Supervisor").click(); });
  await settle();
  expect(mocks.setProjectRoles).toHaveBeenCalledWith("p1", "u_a", expect.arrayContaining(["supervisor"]));
});

it("워크스페이스를 바꾼 직후에는 이전 표로 새 워크스페이스에 저장하지 않는다", async () => {
  mocks.memberTable.mockResolvedValueOnce(table(3, [row("b@x")])).mockReturnValue(new Promise(() => {})); // 새 워크스페이스 조회는 아직 안 끝났다
  await mount();
  await act(async () => { root.render(<MemberTable workspaceId="ws2" />); });
  const select = host.querySelector<HTMLSelectElement>("tbody select");
  if (select) await act(async () => { select.value = "g2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan).not.toHaveBeenCalled();
});

it("저장 도중에 떠난 조회가 늦게 와도 낡은 revision 으로 다음 저장을 보내지 않는다", async () => {
  let finishSave!: (value: CreditPlanSettings) => void, finishStaleLoad!: (value: MemberTableData) => void;
  mocks.memberTable
    .mockResolvedValueOnce(table(3, [row("b@x")]))
    .mockReturnValueOnce(new Promise<MemberTableData>((resolve) => { finishStaleLoad = resolve; })) // reloadSignal 로 떠난 조회(저장 전 값)
    .mockResolvedValue(table(4, [row("b@x", { group_id: "g2" })]));
  mocks.saveCreditPlan.mockReturnValueOnce(new Promise<CreditPlanSettings>((resolve) => { finishSave = resolve; })).mockResolvedValue(credit(5));
  await mount();
  const pick = async (value: string) => { const select = host.querySelector<HTMLSelectElement>("tbody select")!; await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }); };
  await pick("g2");
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  await act(async () => { finishSave(credit(4)); });
  await settle();
  await act(async () => { finishStaleLoad(table(3, [row("b@x")])); }); // 저장이 끝난 뒤에 도착한 낡은 응답
  await settle();
  expect(host.querySelector<HTMLSelectElement>("tbody select")!.value).toBe("g2"); // 낡은 값으로 되돌아가지 않는다
  await pick("g1");
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenLastCalledWith("ws1", expect.objectContaining({ revision: 4 }));
});
