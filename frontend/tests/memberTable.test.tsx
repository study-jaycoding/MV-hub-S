// @vitest-environment jsdom
// 관리 표(docs/MEMBER_TABLE_DESIGN.md) — 표에는 자기만의 쓰기 API 가 없다. 칸마다 기존 API 를 부르고, 큐가 비면 표를 다시 읽는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemberTable } from "../src/components/manage/MemberTable";
import { draftFromSettings, GROUP_COLOR_PALETTE, newDraftGroup, todayLocal, type CreditPlanSettings } from "../src/lib/creditPlan";
import { HttpError } from "../src/lib/http";
import { groupAssignBody, groupColorBody, groupEditBody, groupTermsBody, lastSeenLabel, memberQuotaBody, type MemberTableData, type MemberTableRow } from "../src/lib/memberTable";

const mocks = vi.hoisted(() => ({ memberTable: vi.fn(), saveCreditPlan: vi.fn(), setPlanning: vi.fn(), members: vi.fn(), setProjectRoles: vi.fn(), removeProjectMember: vi.fn(), models: vi.fn() }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: { memberTable: mocks.memberTable, saveCreditPlan: mocks.saveCreditPlan, setPlanning: mocks.setPlanning } }));
vi.mock("../src/api", () => ({ api: { members: mocks.members, setProjectRoles: mocks.setProjectRoles, removeProjectMember: mocks.removeProjectMember, models: mocks.models } }));

const group = (id: string, name: string) => ({ id, name, monthly_limit: 5000, limit_period: "month" as const, remaining: 3480, member_count: 1, used_month: 0, unknown_month: 0, unknown_since_base: 0, estimated: false, allowed_models: ["seedance"], color: id === "g1" ? "#3b82f6" : "#f59e0b" });
const credit = (revision: number): CreditPlanSettings => ({ workspace_id: "ws1", month: "2026-09", plan: { monthly_topup: null, note: "메모", revision, updated_at: null }, groups: [group("g1", "2nd floor"), group("g2", "3rd floor")], members: [], topups: [] });
const row = (email: string, extra: Partial<MemberTableRow> = {}): MemberTableRow => ({ email, name: email.split("@")[0], status: "approved", global_roles: ["member"], uid: "u_" + email[0], project_editable: true, linked_accounts: 1, workspace_role: "member", is_available: true, last_seen_at: null, hf_plan: null, group_id: null, projects: {}, usage: { credits: 0, count: 0, unknown: 0 }, ...extra });
const table = (revision: number, rows: MemberTableRow[]): MemberTableData => ({ workspace_id: "ws1", cycle_start: "2026-09-01", cycle_end: "2026-09-30", rows, projects: [{ id: "p1", name: "본편", planning: { status: "active", start_date: null, due_date: null, budget_credits: null, budget_period: "month", archive_after_days: 30, note: null } }], groups: credit(revision).groups, credit: credit(revision), caps: { account: false, credit: true, project_roles: true, planning: true } });
let root: Root, host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.models.mockResolvedValue([]);
  mocks.members.mockResolvedValue([]);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => { root.render(<MemberTable workspaceId="ws1" />); }); await act(async () => {}); };
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.startsWith(label))!;
const openSheet = async (label: string) => { await act(async () => { tab(label).click(); }); };
const typeInput = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const openGroupColor = async (name = "2nd floor") => {
  const trigger = host.querySelector<HTMLButtonElement>(`[aria-label^="${name} 색상 선택"]`)!;
  await act(async () => { trigger.click(); });
  return host.querySelector<HTMLInputElement>(`[aria-label="${name} 커스텀 색상"]`)!;
};

it("그룹 저장 본문은 받은 그룹을 전부 되보내고 허용 모델 키는 싣지 않는다", () => {
  const body = groupAssignBody(credit(7), "b@x", "g2");
  expect(body).toEqual({ revision: 7, note: "메모", groups: [{ id: "g1", name: "2nd floor", monthly_limit: 5000, limit_period: "month" }, { id: "g2", name: "3rd floor", monthly_limit: 5000, limit_period: "month" }], members: [{ email: "b@x", group_id: "g2" }] });
  expect(lastSeenLabel(null)).toBe("보고 없음");
  expect(lastSeenLabel("2026-09-21 01:42:00", new Date(2026, 8, 21, 12))).toBe("오늘 10:42"); // 서버 시각은 UTC → KST

  const settings = credit(7);
  settings.members = [
    { email: "a@x", name: "a", workspace_role: "member", is_available: true, group_id: "g1" },
    { email: "b@x", name: "b", workspace_role: "member", is_available: true, group_id: "g2" },
  ];
  const added = { ...newDraftGroup(), name: "Producer", limitInput: "3000", allowedModels: ["seedance"] };
  const editBody = groupEditBody(settings, added, ["b@x"]);
  expect(editBody.groups).toHaveLength(3);
  expect(editBody.groups?.[0]).not.toHaveProperty("allowed_models");
  expect(editBody.groups?.[2]).toMatchObject({ id: added.id, name: "Producer", monthly_limit: 3000, allowed_models: ["seedance"] });
  expect(editBody.members).toEqual([{ email: "b@x", group_id: added.id }]);

  const existing = { ...draftFromSettings(settings).groups[0], allowedModels: ["veo3"] };
  const existingBody = groupEditBody(settings, existing, []);
  expect(existingBody.groups).toHaveLength(2);
  expect(existingBody.groups?.[0]).toMatchObject({ id: "g1", allowed_models: ["veo3"] });
  expect(existingBody.groups?.[1]).not.toHaveProperty("allowed_models");
  expect(existingBody.members).toEqual([{ email: "a@x", group_id: null }]);

  const colorBody = groupColorBody(settings, "g1", "#06b6d4");
  expect(colorBody.groups?.[0]).toMatchObject({ id: "g1", color: "#06b6d4" });
  expect(colorBody.groups?.[1]).not.toHaveProperty("color");
  expect(colorBody).not.toHaveProperty("members");
  expect(colorBody.groups?.[0]).not.toHaveProperty("allowed_models");

  const termsBody = groupTermsBody(settings, "g1", 4000, "week");
  expect(termsBody.groups?.[0]).toMatchObject({ id: "g1", monthly_limit: 4000, limit_period: "week" });
  expect(termsBody.groups?.[1]).toMatchObject({ id: "g2", monthly_limit: 5000, limit_period: "month" });
  expect(termsBody).not.toHaveProperty("members");
  expect(termsBody.groups?.[0]).not.toHaveProperty("color");
  expect(termsBody.groups?.[0]).not.toHaveProperty("allowed_models");
});

it("그룹 칸을 바꾸면 기존 크레딧 설정 API 로 저장하고 표를 다시 읽는다", async () => {
  mocks.memberTable.mockResolvedValueOnce(table(3, [row("b@x")])).mockResolvedValue(table(4, [row("b@x", { group_id: "g2" })]));
  mocks.saveCreditPlan.mockResolvedValue(credit(4));
  await mount();
  await openSheet("그룹");
  const select = host.querySelector<HTMLSelectElement>('table[aria-label="멤버 그룹 배정"] tbody select')!;
  await act(async () => { select.value = "g2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenCalledWith("ws1", expect.objectContaining({ revision: 3, members: [{ email: "b@x", group_id: "g2" }] }));
  expect(mocks.memberTable).toHaveBeenCalledTimes(2);
  expect(host.querySelector(".mtable-notice.ok")!.textContent).toContain("3rd floor");
});

it("엑셀 시트처럼 멤버·프로젝트·그룹·크레딧 정보가 서로 섞이지 않고 전환된다", async () => {
  const data = table(3, [row("b@x", { group_id: "g1", usage: { credits: 321, count: 8, unknown: 2 } })]);
  data.credit = {
    ...data.credit!,
    plan: { ...data.credit!.plan, monthly_topup: 20000, topup_day: 15 },
    topups: [{ id: "t1", day: "2026-09-18", credits: 1250, note: "추가 제작" }],
  };
  mocks.memberTable.mockResolvedValue(data);
  await mount();

  const memberTable = host.querySelector(".mtable-scroll table")!;
  expect(memberTable.textContent).toContain("프로젝트 참여");
  expect(memberTable.textContent).not.toContain("크레딧 그룹");
  expect(memberTable.textContent).not.toContain("사용 크레딧");

  await openSheet("프로젝트");
  expect(tab("프로젝트").getAttribute("aria-selected")).toBe("true");
  const projectTable = host.querySelector('table[aria-label="프로젝트 일정 예산 관리"]')!;
  expect(projectTable.textContent).toContain("본편");
  expect([...projectTable.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["프로젝트", "상태", "시작일", "마감일", "주기", "예산", "보관 전환", "메모", "적용"]);
  expect(host.textContent).not.toContain("프로젝트 참여");

  await openSheet("그룹");
  expect(tab("그룹").getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector('table[aria-label="크레딧 그룹 현황"]')!.textContent).toContain("3,480 cr");
  expect(host.querySelector('table[aria-label="멤버 그룹 배정"]')!.textContent).toContain("2nd floor");
  expect(host.textContent).not.toContain("프로젝트 참여");

  await openSheet("크레딧 관리");
  expect(tab("크레딧 관리").getAttribute("aria-selected")).toBe("true");
  const chargeSummary = host.querySelector('[aria-label="충전 요약"]')!;
  expect(chargeSummary.textContent).toContain("20,000 cr");
  expect(chargeSummary.textContent).toContain("2026-09-01 ~ 2026-09-30");
  expect(chargeSummary.textContent).not.toContain("충전 기준일");
  expect(host.querySelector('table[aria-label="개인별 크레딧 사용량"]')!.textContent).toContain("321 cr");
  expect(host.querySelector('table[aria-label="개인별 크레딧 사용량"]')!.textContent).toContain("2건");
  const chargeTable = host.querySelector('table[aria-label="충전 기록"]')!;
  expect([...chargeTable.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["충전일", "구분", "충전 기준일", "크레딧", "메모", "관리"]);
  expect(chargeTable.textContent).toContain("정기 충전");
  expect(chargeTable.textContent).toContain("프로젝트 월 예산 합계와 자동 동기화");
  expect(chargeTable.textContent).toContain("2026-09-18");
  const daySelect = chargeTable.querySelector<HTMLSelectElement>('[aria-label="충전 기준일"]')!;
  expect(daySelect.options).toHaveLength(32);
  expect(daySelect.options[0].textContent).toBe("오늘");
  expect(daySelect.options[31].textContent).toBe("매월 31일");
  expect(host.textContent).toContain("+1,250 cr");
  expect(host.textContent).toContain("추가 제작");
  expect(host.textContent).not.toContain("프로젝트 참여");

  await openSheet("멤버");
  expect(host.textContent).toContain("b@x");
});

it("전역 역할과 프로젝트 역할은 행마다 같은 고정 슬롯 순서로 보인다", async () => {
  mocks.memberTable.mockResolvedValue(table(1, [row("a@x", {
    global_roles: ["member", "product_manager", "admin", "production_director"],
    projects: { p1: ["creator", "project_manager"] },
  })]));
  await mount();

  const global = host.querySelector(".mtable-role-grid-global")!;
  expect([...global.querySelectorAll(".mtable-chip")].map((chip) => chip.textContent)).toEqual(["Admin", "Director", "Manager", "Member"]);
  expect(global.querySelectorAll(".mtable-role-slot")).toHaveLength(4);
  const project = host.querySelector(".mtable-role-grid-project")!;
  expect([...project.querySelectorAll(".mtable-chip")].map((chip) => chip.textContent)).toEqual(["PM", "Supervisor", "Creator"]);
  expect(project.querySelectorAll(".mtable-role-slot")).toHaveLength(3);
});

it("탭별 필터는 표시만 거르고 다른 시트 필터와 독립적이다", async () => {
  mocks.memberTable.mockResolvedValue(table(1, [
    row("a@x", { status: "approved", global_roles: ["member"], group_id: "g1", projects: { p1: ["creator"] }, usage: { credits: 20, count: 1, unknown: 0 } }),
    row("b@x", { status: "pending", global_roles: ["admin"], group_id: null, usage: { credits: 0, count: 0, unknown: 1 } }),
  ]));
  await mount();

  const status = host.querySelector<HTMLSelectElement>('[aria-label="가입 상태 필터"]')!;
  await act(async () => { status.value = "pending"; status.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelector(".mtable-scroll table")!.textContent).toContain("b@x");
  expect(host.querySelector(".mtable-scroll table")!.textContent).not.toContain("a@x");

  await openSheet("그룹");
  const groupFilter = host.querySelector<HTMLSelectElement>('[aria-label="그룹 필터"]')!;
  await act(async () => { groupFilter.value = "g1"; groupFilter.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelector('table[aria-label="멤버 그룹 배정"]')!.textContent).toContain("a@x");
  expect(host.querySelector('table[aria-label="멤버 그룹 배정"]')!.textContent).not.toContain("b@x");

  await openSheet("멤버");
  expect(host.querySelector<HTMLSelectElement>('[aria-label="가입 상태 필터"]')!.value).toBe("pending");
});

it("그룹 추가는 기존 그룹을 보존하고 같은 크레딧 설정 API 로 바로 저장한다", async () => {
  const data = table(3, [row("a@x")]);
  mocks.memberTable.mockResolvedValue(data);
  mocks.saveCreditPlan.mockResolvedValue(credit(4));
  await mount();
  await openSheet("그룹");
  const add = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "+ 새 그룹")!;
  expect(add.closest("table")?.getAttribute("aria-label")).toBe("크레딧 그룹 현황");
  await act(async () => { add.click(); });
  const dialog = host.querySelector<HTMLElement>('[role="dialog"][aria-label="그룹 추가"]')!;
  const name = dialog.querySelector<HTMLInputElement>('input[placeholder="예: Producer"]')!;
  const limit = dialog.querySelector<HTMLInputElement>('input[placeholder="예: 5,000"]')!;
  await typeInput(name, "Producer");
  await typeInput(limit, "3000");
  await act(async () => { dialog.querySelector<HTMLButtonElement>("button.admin-confirm-yes")!.click(); });
  await settle();
  const body = mocks.saveCreditPlan.mock.calls[0][1];
  expect(body.revision).toBe(3);
  expect(body.groups).toHaveLength(3);
  expect(body.groups).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Producer", monthly_limit: 3000 })]));
  expect(body).not.toHaveProperty("topups");
});

it("그룹 편집은 창을 연 revision으로 저장해 다른 관리자의 변경을 조용히 덮지 않는다", async () => {
  const initial = table(3, [row("a@x", { group_id: "g1" }), row("b@x")]);
  initial.credit!.members = [
    { email: "a@x", name: "a", workspace_role: "member", is_available: true, group_id: "g1" },
    { email: "b@x", name: "b", workspace_role: "member", is_available: true, group_id: null },
  ];
  const external = table(4, [row("a@x", { group_id: "g1" }), row("b@x", { group_id: "g1" })]);
  external.credit!.members = [
    { email: "a@x", name: "a", workspace_role: "member", is_available: true, group_id: "g1" },
    { email: "b@x", name: "b", workspace_role: "member", is_available: true, group_id: "g1" },
  ];
  external.credit!.groups[0].allowed_models = ["veo3"];
  mocks.memberTable.mockResolvedValueOnce(initial).mockResolvedValue(external);
  mocks.saveCreditPlan.mockRejectedValue(new HttpError(409, "conflict"));
  await mount();
  await openSheet("그룹");
  const edit = [...host.querySelectorAll<HTMLButtonElement>('button[title="그룹 편집"]')]
    .find((button) => button.textContent === "2nd floor")!;
  await act(async () => { edit.click(); });

  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  await settle();
  const dialog = host.querySelector<HTMLElement>('[role="dialog"][aria-label="그룹 편집"]')!;
  await typeInput(dialog.querySelector<HTMLInputElement>('input[placeholder="예: Producer"]')!, "2nd floor edit");
  await act(async () => { dialog.querySelector<HTMLButtonElement>("button.admin-confirm-yes")!.click(); });
  await settle();

  const body = mocks.saveCreditPlan.mock.calls[0][1];
  expect(body.revision).toBe(3);
  expect(body.members).toEqual([]);
  expect(body.groups[0].allowed_models).toEqual(["seedance"]);
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="dialog"] .login-error')!.textContent).toContain("창을 닫았다 다시 열어");
});

it("그룹 탭에서 고른 색은 대상 그룹만 기존 크레딧 설정 API 로 저장한다", async () => {
  mocks.memberTable.mockResolvedValue(table(3, [row("a@x", { group_id: "g1" })]));
  const saved = credit(4);
  saved.groups[0].color = "#06b6d4";
  mocks.saveCreditPlan.mockResolvedValue(saved);
  await mount();
  await openSheet("그룹");

  const headers = [...host.querySelectorAll('table[aria-label="크레딧 그룹 현황"] th')].map((cell) => cell.textContent);
  expect(headers).toEqual(["그룹", "멤버", "한도 주기", "한도", "남은 양"]);
  expect(host.querySelector(".mtable-group-dot")).toBeNull();
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="2nd floor 색상 선택"]')!;
  expect(trigger.getAttribute("aria-label")).toContain("현재 파랑");
  const groupCell = host.querySelector('table[aria-label="크레딧 그룹 현황"] tbody td')!;
  expect(trigger.closest("td")).toBe(groupCell);
  expect(groupCell.querySelector(".mtable-group-main")?.firstElementChild).toBe(trigger.closest(".mtable-color-picker"));
  const groupChip = groupCell.querySelector<HTMLElement>(".mtable-chip.mtable-group-chip")!;
  expect(groupChip.textContent).toBe("2nd floor");
  expect(groupChip.style.getPropertyValue("--mtable-group-color")).toBe("#3b82f6");
  const input = await openGroupColor();
  expect(host.querySelectorAll(".mtable-color-presets button")).toHaveLength(12);
  expect(GROUP_COLOR_PALETTE).toHaveLength(12);
  expect(input.value).toBe("#3b82f6");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, "#06b6d4");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(mocks.saveCreditPlan).not.toHaveBeenCalled();
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();

  const body = mocks.saveCreditPlan.mock.calls[0][1];
  expect(body.groups[0]).toMatchObject({ id: "g1", color: "#06b6d4" });
  expect(body.groups[1]).not.toHaveProperty("color");
  expect(body).not.toHaveProperty("members");
  expect(body).not.toHaveProperty("topups");
});

it("멤버 배정은 행 배경 없이 선택된 그룹만 멤버 탭 형식의 색상 태그로 보여준다", async () => {
  mocks.memberTable.mockResolvedValue(table(3, [row("a@x", { group_id: "g1" }), row("b@x")]));
  await mount();
  await openSheet("그룹");

  const rows = host.querySelectorAll<HTMLTableRowElement>('table[aria-label="멤버 그룹 배정"] tbody tr');
  expect(rows[0].classList.contains("mtable-group-member-row")).toBe(false);
  expect(rows[0].getAttribute("style")).toBeNull();
  const assignedGroup = rows[0].querySelector<HTMLSelectElement>("select.mtable-chip.mtable-group-chip")!;
  expect(assignedGroup.value).toBe("g1");
  expect(assignedGroup.style.getPropertyValue("--mtable-group-color")).toBe("#3b82f6");
  expect(rows[1].classList.contains("mtable-group-member-row")).toBe(false);
  expect(rows[1].querySelector(".mtable-group-chip")).toBeNull();
});

it("그룹 색상 저장 중 들어온 추가 확정은 저장값으로 즉시 되돌린다", async () => {
  mocks.memberTable.mockResolvedValue(table(3, [row("a@x", { group_id: "g1" })]));
  mocks.saveCreditPlan.mockReturnValue(new Promise(() => {}));
  await mount();
  await openSheet("그룹");

  const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="2nd floor 색상 선택"]')!;
  const input = await openGroupColor();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, "#06b6d4");
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(trigger.disabled).toBe(true);
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  expect([...host.querySelectorAll<HTMLButtonElement>('[title="그룹 편집"]')].every((button) => button.disabled)).toBe(true);
  expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "+ 새 그룹")!.disabled).toBe(true);
});

it("그룹 색상 저장 실패는 그룹 탭에 알리고 서버 색으로 되돌린다", async () => {
  mocks.memberTable.mockResolvedValue(table(3, [row("a@x", { group_id: "g1" })]));
  mocks.saveCreditPlan.mockRejectedValue(new Error("network down"));
  await mount();
  await openSheet("그룹");

  const input = await openGroupColor();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, "#06b6d4");
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();

  const restored = await openGroupColor();
  expect(restored.value).toBe("#3b82f6");
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("그룹 색상을 저장하지 못했습니다");
  await openSheet("크레딧 관리");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("그룹 한도 주기와 한도를 행에서 저장하고 한도에는 cr만 표시한다", async () => {
  const initial = table(3, [row("a@x")]);
  const weekly = table(4, [row("a@x")]);
  weekly.groups[0].limit_period = "week";
  weekly.credit!.groups[0].limit_period = "week";
  const limited = table(5, [row("a@x")]);
  limited.groups[0] = { ...limited.groups[0], limit_period: "week", monthly_limit: 4000 };
  limited.credit!.groups[0] = { ...limited.credit!.groups[0], limit_period: "week", monthly_limit: 4000 };
  const savedWeekly = credit(4);
  savedWeekly.groups[0].limit_period = "week";
  const savedLimited = credit(5);
  savedLimited.groups[0] = { ...savedLimited.groups[0], limit_period: "week", monthly_limit: 4000 };
  mocks.memberTable.mockResolvedValueOnce(initial).mockResolvedValueOnce(weekly).mockResolvedValue(limited);
  mocks.saveCreditPlan.mockResolvedValueOnce(savedWeekly).mockResolvedValueOnce(savedLimited);
  await mount();
  await openSheet("그룹");

  const period = host.querySelector<HTMLSelectElement>('[aria-label="2nd floor 한도 주기"]')!;
  await act(async () => { period.value = "week"; period.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan.mock.calls[0][1].groups[0]).toMatchObject({ monthly_limit: 5000, limit_period: "week" });
  expect(host.querySelector(".mtable-group-limit span")!.textContent).toBe("cr");

  const limit = host.querySelector<HTMLInputElement>('[aria-label="2nd floor 한도"]')!;
  expect(limit.maxLength).toBe(11);
  await act(async () => { limit.focus(); });
  await typeInput(limit, "4000");
  await act(async () => { limit.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  expect(host.querySelector<HTMLInputElement>('[aria-label="2nd floor 한도"]')!.value).toBe("5,000");

  const limitAfterCancel = host.querySelector<HTMLInputElement>('[aria-label="2nd floor 한도"]')!;
  await typeInput(limitAfterCancel, "4000");
  await act(async () => { limitAfterCancel.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan.mock.calls[1][1].groups[0]).toMatchObject({ monthly_limit: 4000, limit_period: "week" });
  expect(host.querySelector<HTMLInputElement>('[aria-label="2nd floor 한도"]')!.value).toBe("4,000");
});

it("크레딧 추가는 필터와 표시 범위에 상관없이 전 기간 충전 기록을 보존한다", async () => {
  const data = table(3, [row("a@x")]);
  data.credit = {
    ...data.credit!,
    topups: [{ id: "old", day: "2025-01-10", credits: 500, note: "과거 기록" }],
  };
  mocks.memberTable.mockResolvedValue(data);
  mocks.saveCreditPlan.mockResolvedValue(credit(4));
  await mount();
  await openSheet("크레딧 관리");
  const add = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "+ 새 충전 기록")!;
  expect(add.closest("table")?.getAttribute("aria-label")).toBe("충전 기록");
  await act(async () => { add.click(); });
  const form = host.querySelector<HTMLTableRowElement>('tr[aria-label="크레딧 추가"]')!;
  expect(form.querySelector<HTMLInputElement>('[aria-label="충전 날짜"]')!.type).toBe("date");
  expect(form.querySelector(".mtable-charge-kind.emergency")?.textContent).toBe("긴급 충전");
  const amount = form.querySelector<HTMLInputElement>('[aria-label="충전 크레딧"]')!;
  const note = form.querySelector<HTMLInputElement>('[aria-label="충전 메모"]')!;
  await typeInput(amount, "1250");
  await typeInput(note, "추가 제작");
  await act(async () => { [...form.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "저장")!.click(); });
  await settle();
  const body = mocks.saveCreditPlan.mock.calls[0][1];
  expect(body.topups).toEqual(expect.arrayContaining([
    expect.objectContaining({ credits: 1250, note: "추가 제작" }),
    { id: "old", day: "2025-01-10", credits: 500, note: "과거 기록" },
  ]));
  expect(body).not.toHaveProperty("groups");
  expect(body).not.toHaveProperty("members");
  expect(body).not.toHaveProperty("topup_day");
});

it("긴급 충전은 날짜·크레딧·메모를 수정하면서 다른 기록을 보존한다", async () => {
  const data = table(3, [row("a@x")]);
  data.credit = {
    ...data.credit!,
    topups: [
      { id: "edit", day: "2026-09-18", credits: 1250, note: "수정 전" },
      { id: "keep", day: "2025-01-10", credits: 500, note: "보존" },
    ],
  };
  mocks.memberTable.mockResolvedValue(data);
  mocks.saveCreditPlan.mockResolvedValue(credit(4));
  await mount();
  await openSheet("크레딧 관리");

  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="2026-09-18 긴급 충전 수정"]')!.click(); });
  const form = host.querySelector<HTMLTableRowElement>('tr[aria-label="긴급 충전 수정"]')!;
  const day = form.querySelector<HTMLInputElement>('[aria-label="충전 날짜"]')!;
  expect(day.type).toBe("date");
  expect(day.value).toBe("2026-09-18");
  await typeInput(day, "2026-09-22");
  await typeInput(form.querySelector<HTMLInputElement>('[aria-label="충전 크레딧"]')!, "2500");
  await typeInput(form.querySelector<HTMLInputElement>('[aria-label="충전 메모"]')!, "수정 후");
  await act(async () => { [...form.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "저장")!.click(); });
  await settle();

  expect(mocks.saveCreditPlan.mock.calls[0][1].topups).toEqual([
    { id: "edit", day: "2026-09-22", credits: 2500, note: "수정 후" },
    { id: "keep", day: "2025-01-10", credits: 500, note: "보존" },
  ]);
});

it("긴급 충전 삭제는 확인 뒤 선택한 기록만 빼고 저장한다", async () => {
  const data = table(3, [row("a@x")]);
  data.credit = {
    ...data.credit!,
    topups: [
      { id: "delete", day: "2026-09-18", credits: 1250, note: "삭제" },
      { id: "keep", day: "2025-01-10", credits: 500, note: "보존" },
    ],
  };
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  mocks.memberTable.mockResolvedValue(data);
  mocks.saveCreditPlan.mockResolvedValue(credit(4));
  await mount();
  await openSheet("크레딧 관리");

  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="2026-09-18 긴급 충전 삭제"]')!.click(); });
  await settle();

  expect(confirm).toHaveBeenCalledWith("2026-09-18 긴급 충전 1,250 cr을 삭제할까요?");
  expect(mocks.saveCreditPlan.mock.calls[0][1].topups).toEqual([
    { id: "keep", day: "2025-01-10", credits: 500, note: "보존" },
  ]);
});

it("409 는 자동으로 다시 보내지 않고 최신 값으로 다시 읽은 뒤 알린다", async () => {
  mocks.memberTable.mockResolvedValue(table(3, [row("b@x")]));
  mocks.saveCreditPlan.mockRejectedValue(new HttpError(409, "conflict"));
  await mount();
  await openSheet("그룹");
  const select = host.querySelector<HTMLSelectElement>('table[aria-label="멤버 그룹 배정"] tbody select')!;
  await act(async () => { select.value = "g1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  expect(mocks.memberTable).toHaveBeenCalledTimes(2);
  expect(host.querySelector(".mtable-notice.bad")!.textContent).toContain("다른 사람이 먼저");
  expect(host.querySelector<HTMLSelectElement>('table[aria-label="멤버 그룹 배정"] tbody select')!.value).toBe(""); // 서버 값으로 돌아왔다
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
  await openSheet("그룹");
  await act(async () => { root.render(<MemberTable workspaceId="ws2" />); });
  const select = host.querySelector<HTMLSelectElement>('table[aria-label="멤버 그룹 배정"] tbody select');
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
  await openSheet("그룹");
  const pick = async (value: string) => { const select = host.querySelector<HTMLSelectElement>('table[aria-label="멤버 그룹 배정"] tbody select')!; await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }); };
  await pick("g2");
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  await act(async () => { finishSave(credit(4)); });
  await settle();
  await act(async () => { finishStaleLoad(table(3, [row("b@x")])); }); // 저장이 끝난 뒤에 도착한 낡은 응답
  await settle();
  expect(host.querySelector<HTMLSelectElement>('table[aria-label="멤버 그룹 배정"] tbody select')!.value).toBe("g2"); // 낡은 값으로 되돌아가지 않는다
  await pick("g1");
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenLastCalledWith("ws1", expect.objectContaining({ revision: 4 }));
});

it("멤버 추가는 승인된 실제 가입 계정만 프로젝트 후보로 보여주고 기존 역할 API 를 쓴다", async () => {
  mocks.memberTable.mockResolvedValue(table(1, [row("a@x", { uid: "u_a", projects: { p1: ["creator"] } })]));
  mocks.members.mockResolvedValue([
    { uid: "u_a", name: "기존", email: "a@x", status: "approved", global_roles: ["member"], is_mine: false, count: 0 },
    { uid: "u_new", name: "새 멤버", email: "new@x", status: "approved", global_roles: ["member"], is_mine: false, count: 0 },
    { uid: "acct:ghost@x", name: "합성", email: "ghost@x", status: "approved", global_roles: ["member"], is_mine: false, count: 0 },
    { uid: "u_wait", name: "대기", email: "wait@x", status: "pending", global_roles: ["member"], is_mine: false, count: 0 },
  ]);
  mocks.setProjectRoles.mockResolvedValue([]);
  await mount();

  const add = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "+ 멤버 추가")!;
  expect(add.closest("table")).toBeTruthy();
  await act(async () => { add.click(); });
  await settle();

  const form = host.querySelector<HTMLTableRowElement>('tr[aria-label="프로젝트 멤버 추가"]')!;
  expect([...form.cells].map((cell) => cell.colSpan)).toEqual([2, 2, 1]);
  const account = form.querySelector<HTMLSelectElement>('[aria-label="추가할 가입 계정"]')!;
  expect(account.textContent).toContain("새 멤버");
  expect(account.textContent).not.toContain("기존");
  expect(account.textContent).not.toContain("합성");
  expect(account.textContent).not.toContain("대기");
  const actions = form.querySelectorAll<HTMLButtonElement>(".mtable-member-add-action");
  expect(actions).toHaveLength(2);
  expect(actions[0].className).toContain("mtable-member-add-action");
  expect(actions[1].className).toContain("mtable-member-add-action");
  await act(async () => { form.querySelector<HTMLButtonElement>("button.mtable-add")!.click(); });
  await settle();
  expect(mocks.setProjectRoles).toHaveBeenCalledWith("p1", "u_new", ["creator"]);
});

it("프로젝트 일정과 예산은 검증한 전체 설정을 한 번에 저장한다", async () => {
  const data = table(1, [row("a@x")]);
  mocks.memberTable.mockResolvedValue(data);
  mocks.setPlanning.mockResolvedValue({ status: "hold", start_date: "2026-09-10", due_date: "2026-10-20", budget_credits: 25000, budget_period: "month", archive_after_days: 45, note: "후반 작업" });
  await mount();
  await openSheet("프로젝트");

  const status = host.querySelector<HTMLSelectElement>('[aria-label="본편 상태"]')!;
  expect(status.classList.contains("mtable-chip")).toBe(true);
  expect(status.classList.contains("mtable-status-active")).toBe(true);
  await act(async () => { status.value = "hold"; status.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(status.classList.contains("mtable-status-hold")).toBe(true);
  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="본편 시작일"]')!, "2026-09-10");
  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="본편 마감일"]')!, "2026-10-20");
  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="본편 예산 크레딧"]')!, "25000");
  expect(host.querySelector<HTMLInputElement>('[aria-label="본편 예산 크레딧"]')!.closest(".mtable-project-budget")?.textContent).toContain("cr");
  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="본편 보관 전환 일수"]')!, "45");
  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="본편 메모"]')!, "후반 작업");
  await act(async () => { host.querySelector<HTMLButtonElement>('table[aria-label="프로젝트 일정 예산 관리"] button.mtable-add')!.click(); });
  await settle();

  expect(mocks.setPlanning).toHaveBeenCalledWith("p1", {
    status: "hold",
    start_date: "2026-09-10",
    due_date: "2026-10-20",
    budget_credits: 25000,
    budget_period: "month",
    archive_after_days: 45,
    note: "후반 작업",
  });
});

it("프로젝트 편집 중 다시 읽으면 손대지 않은 칸은 최신 서버 값으로 저장한다", async () => {
  const initial = table(1, [row("a@x")]);
  const external = table(1, [row("a@x")]);
  external.projects[0].planning = { ...external.projects[0].planning, due_date: "2026-12-01", budget_credits: 9999 };
  mocks.memberTable.mockResolvedValueOnce(initial).mockResolvedValue(external);
  mocks.setPlanning.mockResolvedValue({ ...external.projects[0].planning, note: "내 메모" });
  await mount();
  await openSheet("프로젝트");

  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="본편 메모"]')!, "내 메모");
  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="본편 예산 크레딧"]')!, "25000");
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  await settle();
  expect(host.querySelector<HTMLInputElement>('[aria-label="본편 마감일"]')!.value).toBe("2026-12-01");
  expect(host.querySelector<HTMLInputElement>('[aria-label="본편 예산 크레딧"]')!.value).toBe("25,000");
  await act(async () => { host.querySelector<HTMLButtonElement>('table[aria-label="프로젝트 일정 예산 관리"] button.mtable-add')!.click(); });
  await settle();

  expect(mocks.setPlanning).toHaveBeenCalledWith("p1", expect.objectContaining({ due_date: "2026-12-01", budget_credits: 25000, note: "내 메모" }));
});

it("구버전 서버가 planning 권한 필드를 생략해도 기존 관리 권한으로 프로젝트 설정을 연다", async () => {
  const data = table(1, [row("a@x")]);
  delete data.caps.planning;
  mocks.memberTable.mockResolvedValue(data);
  await mount();
  await openSheet("프로젝트");
  expect(host.querySelector<HTMLSelectElement>('[aria-label="본편 상태"]')!.disabled).toBe(false);
  expect(host.querySelector<HTMLInputElement>('[aria-label="본편 예산 크레딧"]')!.disabled).toBe(false);
});

it("구버전 서버가 planning 원문도 생략하면 기본값으로 덮지 않게 프로젝트 설정을 잠근다", async () => {
  const data = table(1, [row("a@x")]);
  delete data.caps.planning;
  delete data.projects[0].planning;
  mocks.memberTable.mockResolvedValue(data);
  await mount();
  await openSheet("프로젝트");
  expect(host.querySelector<HTMLSelectElement>('[aria-label="본편 상태"]')!.disabled).toBe(true);
  expect(host.textContent).toContain("일정·예산 원문을 보내지 않아 안전하게 잠갔습니다");
});

it("충전 기준일 변경은 확인 뒤 다른 크레딧 설정을 건드리지 않고 저장한다", async () => {
  const data = table(7, [row("a@x")]);
  const todayDay = Number(todayLocal().slice(8, 10));
  const previousDay = todayDay === 1 ? 2 : 1;
  data.credit = { ...data.credit!, plan: { ...data.credit!.plan, topup_day: previousDay } };
  mocks.memberTable.mockResolvedValue(data);
  mocks.saveCreditPlan.mockResolvedValue({ ...credit(8), plan: { ...credit(8).plan, topup_day: todayDay } });
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  await mount();
  await openSheet("크레딧 관리");

  const select = host.querySelector<HTMLSelectElement>('[aria-label="충전 기준일"]')!;
  expect(select.options).toHaveLength(32);
  expect(select.options[0].textContent).toBe("오늘");
  expect(select.options[31].value).toBe("31");
  await act(async () => { select.value = "today"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(mocks.saveCreditPlan).toHaveBeenCalledWith("ws1", { revision: 7, note: "메모", topup_day: todayDay });
});

it("그룹 저장 직후 충전 기준일을 바꿔도 큐 안의 최신 revision 을 쓴다", async () => {
  let finishGroupSave!: (value: CreditPlanSettings) => void;
  const data = table(3, [row("a@x")]);
  data.credit = { ...data.credit!, plan: { ...data.credit!.plan, topup_day: 1 } };
  mocks.memberTable.mockResolvedValue(data);
  mocks.saveCreditPlan
    .mockReturnValueOnce(new Promise<CreditPlanSettings>((resolve) => { finishGroupSave = resolve; }))
    .mockResolvedValue({ ...credit(5), plan: { ...credit(5).plan, topup_day: 15 } });
  vi.stubGlobal("confirm", vi.fn(() => true));
  await mount();

  await openSheet("그룹");
  const groupSelect = host.querySelector<HTMLSelectElement>('table[aria-label="멤버 그룹 배정"] tbody select')!;
  await act(async () => { groupSelect.value = "g1"; groupSelect.dispatchEvent(new Event("change", { bubbles: true })); });
  await openSheet("크레딧 관리");
  const daySelect = host.querySelector<HTMLSelectElement>('[aria-label="충전 기준일"]')!;
  await act(async () => { daySelect.value = "15"; daySelect.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);

  await act(async () => { finishGroupSave(credit(4)); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(2);
  expect(mocks.saveCreditPlan).toHaveBeenLastCalledWith("ws1", { revision: 4, note: "메모", topup_day: 15 });
});

it("몫 칸은 소속을 건드리지 않고 사람별 몫만 저장한다", async () => {
  // 서버가 몫을 지우지 않는 계약: group_id 키는 싣지 않고 quota 만 보낸다(비우면 null = 자동).
  const body = memberQuotaBody(credit(9), "b@x", 600);
  expect(body.members).toEqual([{ email: "b@x", quota: 600 }]);
  expect(body.members![0]).not.toHaveProperty("group_id");
  expect(memberQuotaBody(credit(9), "b@x", null).members).toEqual([{ email: "b@x", quota: null }]);

  const data = table(3, [row("a@x", { group_id: "g1", usage: { credits: 320, count: 2, unknown: 0 } })]);
  data.credit!.members = [
    { email: "a@x", name: "a", workspace_role: "member", is_available: true, group_id: "g1",
      quota: null, quota_effective: 5000, quota_source: "auto", used_period: 320, unknown_period: 0, remaining: 4680 },
  ];
  mocks.memberTable.mockResolvedValue(data);
  mocks.saveCreditPlan.mockResolvedValue(credit(4));
  await mount();
  await openSheet("크레딧 관리");

  const sheet = host.querySelector('table[aria-label="개인별 크레딧 사용량"]')!;
  expect(sheet.textContent).toContain("4,680 cr"); // 남은 몫
  const input = sheet.querySelector<HTMLInputElement>('[aria-label="a 몫"]')!;
  expect(input.placeholder).toBe("자동 5,000"); // 비어 있으면 자동 몫이 얼마인지 보여 준다
  await typeInput(input, "600");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenLastCalledWith("ws1", expect.objectContaining({
    revision: 3, members: [{ email: "a@x", quota: 600 }],
  }));
});
