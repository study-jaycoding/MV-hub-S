// @vitest-environment jsdom
// 관리 표(docs/MEMBER_TABLE_DESIGN.md) — 표에는 자기만의 쓰기 API 가 없다. 칸마다 기존 API 를 부르고, 큐가 비면 표를 다시 읽는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemberTable } from "../src/components/manage/MemberTable";
import { draftFromSettings, GROUP_COLOR_PALETTE, newDraftGroup, todayLocal, type CreditPlanSettings } from "../src/lib/creditPlan";
import { HttpError } from "../src/lib/http";
import { fillReorder, groupAssignBody, groupColorBody, groupEditBody, groupTermsBody, mainPeople, memberQuotaBody, type MemberTableData, type MemberTableRow } from "../src/lib/memberTable";
import { recurringEditBody } from "../src/lib/workspaceConsole";

const mocks = vi.hoisted(() => ({ memberTable: vi.fn(), saveCreditPlan: vi.fn(), setPlanning: vi.fn(), members: vi.fn(), setProjectRoles: vi.fn(), removeProjectMember: vi.fn(), models: vi.fn(),
  consoleSetStatus: vi.fn(), getPlanning: vi.fn(), updateProject: vi.fn(), projects: vi.fn(), reorderProjects: vi.fn(), projectFolder: vi.fn(), setProjectFolder: vi.fn() }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: { memberTable: mocks.memberTable, saveCreditPlan: mocks.saveCreditPlan, setPlanning: mocks.setPlanning, consoleSetStatus: mocks.consoleSetStatus, getPlanning: mocks.getPlanning } }));
vi.mock("../src/api", () => ({ api: { members: mocks.members, setProjectRoles: mocks.setProjectRoles, removeProjectMember: mocks.removeProjectMember, models: mocks.models,
  updateProject: mocks.updateProject, projects: mocks.projects, reorderProjects: mocks.reorderProjects, projectFolder: mocks.projectFolder, setProjectFolder: mocks.setProjectFolder } }));

const group = (id: string, name: string) => ({ id, name, monthly_limit: 5000, limit_period: "month" as const, remaining: 3480, quota_total: 5000, member_count: 1, used_month: 0, unknown_month: 0, unknown_since_base: 0, estimated: false, allowed_models: ["seedance"], color: id === "g1" ? "#3b82f6" : "#f59e0b" });
const credit = (revision: number): CreditPlanSettings => ({ workspace_id: "ws1", month: "2026-09", plan: { monthly_topup: null, note: "메모", revision, updated_at: null }, groups: [group("g1", "2nd floor"), group("g2", "3rd floor")], members: [], topups: [] });
const row = (email: string, extra: Partial<MemberTableRow> = {}): MemberTableRow => ({ email, name: email.split("@")[0], status: "approved", global_roles: ["member"], uid: "u_" + email[0], project_editable: true, linked_accounts: 1, workspace_role: "member", is_available: true, last_seen_at: null, hf_plan: null, group_id: null, projects: {}, usage: { credits: 0, count: 0, unknown: 0 }, ...extra });
const table = (revision: number, rows: MemberTableRow[]): MemberTableData => ({ workspace_id: "ws1", cycle_start: "2026-09-01", cycle_end: "2026-09-30", rows, projects: [{ id: "p1", name: "본편", planning: { status: "active", start_date: null, due_date: null, budget_credits: null, budget_period: "month", archive_after_days: 30, note: null } }], groups: credit(revision).groups, credit: credit(revision), caps: { account: false, credit: true, project_roles: true, planning: true } });
let root: Root, host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.models.mockResolvedValue([]);
  mocks.members.mockResolvedValue([]);
  mocks.projectFolder.mockResolvedValue({ root_path: "", selected_path: "" });
  host =document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = async (workspaceId = "ws1") => { await act(async () => { root.render(<MemberTable workspaceId={workspaceId} />); }); await act(async () => {}); };
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
const conflictError = (latest: CreditPlanSettings) => new HttpError(409, "conflict", JSON.stringify({
  kind: "manage_edit_conflict", latest, latest_revision: latest.plan.revision,
  changes: [
    { revision: latest.plan.revision - 1, actor_uid: "a", actor_name: "Manager A", fields: ["topups.t1.credits"], created_at: "2026-09-28 01:00" },
    { revision: latest.plan.revision, actor_uid: "b", actor_name: "Manager B", fields: ["note"], created_at: "2026-09-28 01:01" },
  ], history_complete: false,
}));
const confirmMerge = async () => { await act(async () => { host.querySelector<HTMLButtonElement>(".manage-conflict .admin-confirm-yes")!.click(); }); await settle(); };
const chooseMerge = async (value: "mine" | "remote") => {
  await act(async () => {
    for (const select of host.querySelectorAll<HTMLSelectElement>(".manage-conflict select")) { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }
  });
};

it("그룹 저장 본문은 받은 그룹을 전부 되보내고 허용 모델 키는 싣지 않는다", () => {
  const body = groupAssignBody(credit(7), "b@x", "g2");
  expect(body).toEqual({ revision: 7, note: "메모", groups: [{ id: "g1", name: "2nd floor", monthly_limit: 5000, limit_period: "month" }, { id: "g2", name: "3rd floor", monthly_limit: 5000, limit_period: "month" }], members: [{ email: "b@x", group_id: "g2" }] });

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
  const select = host.querySelector<HTMLSelectElement>('table[aria-label="참가자 그룹 배정"] tbody select')!;
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
  expect([...projectTable.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["프로젝트", "상태", "시작일", "종료일", "주기", "예산", "작업 자동 보관(일)", "메모", "렌더 폴더 (이 PC)"]);
  expect(host.textContent).not.toContain("프로젝트 참여");

  await openSheet("그룹");
  expect(tab("그룹").getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector('table[aria-label="크레딧 그룹 현황"]')!.textContent).toContain("3,480");
  expect(host.querySelector('table[aria-label="참가자 그룹 배정"]')!.textContent).toContain("2nd floor");
  expect(host.textContent).not.toContain("프로젝트 참여");

  await openSheet("크레딧 관리");
  expect(tab("크레딧 관리").getAttribute("aria-selected")).toBe("true");
  const chargeSummary = host.querySelector('[aria-label="충전 요약"]')!;
  expect(chargeSummary.textContent).toContain("20,000");
  expect(chargeSummary.textContent).toContain("2026-09-01 ~ 2026-09-30");
  expect(chargeSummary.textContent).not.toContain("충전 기준일");
  expect(host.querySelector('table[aria-label="개인별 크레딧 사용량"]')!.textContent).toContain("321");
  expect(host.querySelector('table[aria-label="개인별 크레딧 사용량"]')!.textContent).toContain("2건");
  const chargeTable = host.querySelector('table[aria-label="크레딧 기록"]')!;
  expect([...chargeTable.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["날짜", "구분", "충전일", "크레딧", "메모", "관리"]);
  expect(chargeTable.textContent).toContain("정기 크레딧");
  expect(chargeTable.textContent).toContain("프로젝트 월 예산 합계와 자동 동기화");
  expect(chargeTable.textContent).toContain("2026-09-18");
  const daySelect = chargeTable.querySelector<HTMLSelectElement>('[aria-label="충전일"]')!;
  expect(daySelect.options).toHaveLength(32);
  expect(daySelect.options[0].textContent).toBe("오늘");
  expect(daySelect.options[31].textContent).toBe("매월 31일");
  expect(host.textContent).toContain("+1,250");
  expect(host.textContent).toContain("추가 제작");
  expect(host.textContent).not.toContain("프로젝트 참여");

  await openSheet("멤버");
  expect(host.textContent).toContain("b@x");
});

it("시스템 부트스트랩 계정은 표·멤버 수에서 빠진다", async () => {
  mocks.memberTable.mockResolvedValue(table(1, [row("a@x"), row("admin@millionvolt.com")]));
  await mount();

  expect(host.textContent).not.toContain("admin@millionvolt.com");
  expect(tab("멤버").textContent).toBe("멤버 1");
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
  expect(host.querySelector('table[aria-label="참가자 그룹 배정"]')!.textContent).toContain("a@x");
  expect(host.querySelector('table[aria-label="참가자 그룹 배정"]')!.textContent).not.toContain("b@x");

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
  expect(host.querySelector('[role="dialog"] .login-error')!.textContent).toContain("입력은 유지");
});

it("그룹 탭에서 고른 색은 대상 그룹만 기존 크레딧 설정 API 로 저장한다", async () => {
  mocks.memberTable.mockResolvedValue(table(3, [row("a@x", { group_id: "g1" })]));
  const saved = credit(4);
  saved.groups[0].color = "#06b6d4";
  mocks.saveCreditPlan.mockResolvedValue(saved);
  await mount();
  await openSheet("그룹");

  const headers = [...host.querySelectorAll('table[aria-label="크레딧 그룹 현황"] th')].map((cell) => cell.textContent);
  expect(headers).toEqual(["그룹", "인원", "기간", "그룹 크레딧", "이번 기간 사용", "남음"]);
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

  const rows = host.querySelectorAll<HTMLTableRowElement>('table[aria-label="참가자 그룹 배정"] tbody tr');
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

  const period = host.querySelector<HTMLSelectElement>('[aria-label="2nd floor 기간"]')!;
  await act(async () => { period.value = "week"; period.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan.mock.calls[0][1].groups[0]).toMatchObject({ monthly_limit: 5000, limit_period: "week" });
  expect(host.querySelector(".mtable-group-limit span")).toBeNull(); // 서브스페이스처럼 단위 글자 없음(§15)

  const limit = host.querySelector<HTMLInputElement>('[aria-label="2nd floor 크레딧 한도"]')!;
  expect(limit.maxLength).toBe(11);
  await act(async () => { limit.focus(); });
  await typeInput(limit, "4000");
  await act(async () => { limit.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  expect(host.querySelector<HTMLInputElement>('[aria-label="2nd floor 크레딧 한도"]')!.value).toBe("5,000");

  const limitAfterCancel = host.querySelector<HTMLInputElement>('[aria-label="2nd floor 크레딧 한도"]')!;
  await typeInput(limitAfterCancel, "4000");
  await act(async () => { limitAfterCancel.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan.mock.calls[1][1].groups[0]).toMatchObject({ monthly_limit: 4000, limit_period: "week" });
  expect(host.querySelector<HTMLInputElement>('[aria-label="2nd floor 크레딧 한도"]')!.value).toBe("4,000");
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
  const add = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "+ 추가 크레딧")!;
  expect(add.closest("table")?.getAttribute("aria-label")).toBe("크레딧 기록");
  await act(async () => { add.click(); });
  const form = host.querySelector<HTMLTableRowElement>('tr[aria-label="새 추가 크레딧"]')!;
  expect(form.querySelector<HTMLInputElement>('[aria-label="추가 크레딧 날짜"]')!.type).toBe("date");
  expect(form.querySelector(".mtable-charge-kind.emergency")?.textContent).toBe("추가 크레딧");
  const amount = form.querySelector<HTMLInputElement>('[aria-label="추가 크레딧"]')!;
  const note = form.querySelector<HTMLInputElement>('[aria-label="추가 크레딧 메모"]')!;
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

it("추가 크레딧은 날짜·크레딧·메모를 수정하면서 다른 기록을 보존한다", async () => {
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

  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="2026-09-18 추가 크레딧 수정"]')!.click(); });
  const form = host.querySelector<HTMLTableRowElement>('tr[aria-label="추가 크레딧 수정"]')!;
  const day = form.querySelector<HTMLInputElement>('[aria-label="추가 크레딧 날짜"]')!;
  expect(day.type).toBe("date");
  expect(day.value).toBe("2026-09-18");
  await typeInput(day, "2026-09-22");
  await typeInput(form.querySelector<HTMLInputElement>('[aria-label="추가 크레딧"]')!, "2500");
  await typeInput(form.querySelector<HTMLInputElement>('[aria-label="추가 크레딧 메모"]')!, "수정 후");
  await act(async () => { [...form.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "저장")!.click(); });
  await settle();

  expect(mocks.saveCreditPlan.mock.calls[0][1].topups).toEqual([
    { id: "edit", day: "2026-09-22", credits: 2500, note: "수정 후" },
    { id: "keep", day: "2025-01-10", credits: 500, note: "보존" },
  ]);
});

it("추가 크레딧 삭제는 확인 뒤 선택한 기록만 빼고 저장한다", async () => {
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

  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="2026-09-18 추가 크레딧 삭제"]')!.click(); });
  await settle();

  expect(confirm).toHaveBeenCalledWith("2026-09-18 추가 크레딧 1,250을 삭제할까요?");
  expect(mocks.saveCreditPlan.mock.calls[0][1].topups).toEqual([
    { id: "keep", day: "2025-01-10", credits: 500, note: "보존" },
  ]);
});

it("409 는 자동으로 다시 보내지 않고 최신 값으로 다시 읽은 뒤 알린다", async () => {
  mocks.memberTable.mockResolvedValue(table(3, [row("b@x")]));
  mocks.saveCreditPlan.mockRejectedValue(new HttpError(409, "conflict"));
  await mount();
  await openSheet("그룹");
  const select = host.querySelector<HTMLSelectElement>('table[aria-label="참가자 그룹 배정"] tbody select')!;
  await act(async () => { select.value = "g1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  expect(mocks.memberTable).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("다른 사람이 먼저");
  expect(host.querySelector<HTMLSelectElement>('table[aria-label="참가자 그룹 배정"] tbody select')!.value).toBe(""); // 서버 값으로 돌아왔다
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
  const notJoined = () => rows[0].querySelector(".mtable-project-role-cell")!.classList.contains("mtable-not-joined");
  expect(notJoined()).toBe(false);
  await act(async () => { chip("Creator").click(); });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(mocks.removeProjectMember).not.toHaveBeenCalled(); // 취소하면 아무것도 안 한다
  confirm.mockReturnValue(true);
  mocks.memberTable.mockResolvedValue(table(1, [row("a@x"), row("c@x", { uid: null, project_editable: false })])); // 저장 뒤 재조회 = 빠진 상태
  await act(async () => { chip("Creator").click(); });
  await settle();
  expect(mocks.removeProjectMember).toHaveBeenCalledWith("p1", "u_a");
  expect(notJoined()).toBe(true); // 역할을 다 빼면 '참여 안 함'(역할 안 고른 것과 구분)
  expect(rows[0].querySelector(".mtable-not-joined-label")!.textContent).toBe("참여 안 함");
  await act(async () => { chip("Supervisor").click(); }); // 참여 안 함 칸에서 역할을 누르면 그 역할로 참여
  await settle();
  expect(mocks.setProjectRoles).toHaveBeenCalledWith("p1", "u_a", ["supervisor"]);
});

it("워크스페이스를 바꾼 직후에는 이전 표로 새 워크스페이스에 저장하지 않는다", async () => {
  mocks.memberTable.mockResolvedValueOnce(table(3, [row("b@x")])).mockReturnValue(new Promise(() => {})); // 새 워크스페이스 조회는 아직 안 끝났다
  await mount();
  await openSheet("그룹");
  await act(async () => { root.render(<MemberTable workspaceId="ws2" />); });
  const select = host.querySelector<HTMLSelectElement>('table[aria-label="참가자 그룹 배정"] tbody select');
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
  const pick = async (value: string) => { const select = host.querySelector<HTMLSelectElement>('table[aria-label="참가자 그룹 배정"] tbody select')!; await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }); };
  await pick("g2");
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  await act(async () => { finishSave(credit(4)); });
  await settle();
  await act(async () => { finishStaleLoad(table(3, [row("b@x")])); }); // 저장이 끝난 뒤에 도착한 낡은 응답
  await settle();
  expect(host.querySelector<HTMLSelectElement>('table[aria-label="참가자 그룹 배정"] tbody select')!.value).toBe("g2"); // 낡은 값으로 되돌아가지 않는다
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

const blurInput = async (input: HTMLInputElement) => { await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); }); };

it("프로젝트 설정은 적용 단추 없이 칸마다 저장한다 — 날짜·선택은 바로, 글자·숫자 칸은 나갈 때, 틀린 조합은 고칠 때까지 보류", async () => {
  // 서버처럼: 저장할 때마다 revision 을 올려 돌려주고, 다시 읽으면 저장된 값을 준다 — 다음 저장이 새 기준을 쓰는지 본다
  let saved = table(1, [row("a@x")]).projects[0].planning;
  mocks.memberTable.mockImplementation(async () => { const t = table(1, [row("a@x")]); t.projects[0].planning = saved; return t; });
  mocks.setPlanning.mockImplementation(async (_pid: string, body: { revision?: number }) => {
    saved = { ...body, revision: (body.revision ?? 0) + 1 } as typeof saved;
    return saved;
  });
  await mount();
  await openSheet("프로젝트");
  const q = (label: string) => host.querySelector<HTMLInputElement>(`[aria-label="본편 ${label}"]`)!;
  expect(host.querySelector('table[aria-label="프로젝트 일정 예산 관리"] button.mtable-add')).toBeNull(); // 적용 단추 없음

  const status = host.querySelector<HTMLSelectElement>('[aria-label="본편 상태"]')!;
  expect(status.classList.contains("mtable-status-active")).toBe(true);
  await act(async () => { status.value = "hold"; status.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(mocks.setPlanning).toHaveBeenLastCalledWith("p1", expect.objectContaining({ revision: 0, status: "hold" })); // 고르는 순간 저장

  // 연달아 두 날짜 — 둘 다 저장되고, 둘째는 첫 저장이 돌려준 revision 으로(409 없음)
  await typeInput(q("시작일"), "2026-09-10");
  await typeInput(q("종료일"), "2026-10-20");
  await settle();
  expect(mocks.setPlanning).toHaveBeenLastCalledWith("p1", expect.objectContaining({ start_date: "2026-09-10", due_date: "2026-10-20" }));
  const afterDates = mocks.setPlanning.mock.calls.length;
  expect(mocks.setPlanning.mock.calls[afterDates - 1][1].revision).toBe(afterDates - 1);

  // 틀린 조합(종료 < 시작) — 저장하지 않고 줄을 빨갛게, 고치면 바로 저장
  await typeInput(q("종료일"), "2026-09-01");
  await settle();
  expect(mocks.setPlanning.mock.calls.length).toBe(afterDates);
  expect(q("종료일").closest("tr")!.classList.contains("mtable-invalid")).toBe(true);
  expect(host.querySelector(".mtable-notice.bad")!.textContent).toContain("고치면 바로 저장");
  await typeInput(q("종료일"), "2026-11-20");
  await settle();
  expect(mocks.setPlanning).toHaveBeenLastCalledWith("p1", expect.objectContaining({ due_date: "2026-11-20" }));
  expect(q("종료일").closest("tr")!.classList.contains("mtable-invalid")).toBe(false);

  // 글자·숫자 칸은 치는 동안 저장하지 않고, 칸을 나갈 때 저장
  const before = mocks.setPlanning.mock.calls.length;
  await typeInput(q("메모"), "후반 작업");
  await typeInput(q("예산 크레딧"), "25000");
  await typeInput(q("작업 자동 보관 일수"), "45");
  await settle();
  expect(mocks.setPlanning.mock.calls.length).toBe(before);
  expect(q("예산 크레딧").closest(".mtable-project-budget")?.textContent).toBe(""); // 단위 글자 없음(§15)
  await blurInput(q("작업 자동 보관 일수"));
  await settle();
  expect(mocks.setPlanning).toHaveBeenLastCalledWith("p1", expect.objectContaining({
    status: "hold", start_date: "2026-09-10", due_date: "2026-11-20", budget_credits: 25000, budget_period: "month", archive_after_days: 45, note: "후반 작업",
  }));
});

it("프로젝트 편집 중 재조회는 기준을 바꾸지 않고 409 선택 후 손대지 않은 서버 값을 보존한다", async () => {
  const initial = table(1, [row("a@x")]);
  const external = table(1, [row("a@x")]);
  external.projects[0].planning = { ...external.projects[0].planning, revision: 2, due_date: "2026-12-01", budget_credits: 9999 };
  mocks.memberTable.mockResolvedValueOnce(initial).mockResolvedValue(external);
  mocks.setPlanning.mockRejectedValueOnce(new HttpError(409, "conflict", JSON.stringify({ kind: "manage_edit_conflict", latest: external.projects[0].planning, latest_revision: 2, changes: [], history_complete: false })))
    .mockResolvedValue({ ...external.projects[0].planning, note: "내 메모" });
  await mount();
  await openSheet("프로젝트");

  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="본편 메모"]')!, "내 메모");
  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="본편 예산 크레딧"]')!, "25000");
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  await settle();
  expect(host.querySelector<HTMLInputElement>('[aria-label="본편 종료일"]')!.value).toBe("");
  expect(host.querySelector<HTMLInputElement>('[aria-label="본편 예산 크레딧"]')!.value).toBe("25,000");
  await blurInput(host.querySelector<HTMLInputElement>('[aria-label="본편 예산 크레딧"]')!); // 칸을 나가면 저장(적용 단추 없음)
  await settle();
  expect(mocks.setPlanning.mock.calls[0][1]).toMatchObject({ revision: 0, due_date: null });
  const choice = host.querySelector<HTMLSelectElement>('[aria-label="예산 충돌 선택"]')!;
  await act(async () => { choice.value = "mine"; choice.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { host.querySelector<HTMLButtonElement>('.manage-conflict .admin-confirm-yes')!.click(); });
  await settle();
  expect(mocks.setPlanning).toHaveBeenLastCalledWith("p1", expect.objectContaining({ revision: 2, due_date: "2026-12-01", budget_credits: 25000, note: "내 메모" }));
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

  const select = host.querySelector<HTMLSelectElement>('[aria-label="충전일"]')!;
  expect(select.options).toHaveLength(32);
  expect(select.options[0].textContent).toBe("오늘");
  expect(select.options[31].value).toBe("31");
  await act(async () => { select.value = "today"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(confirm).toHaveBeenCalledTimes(1);
  // 서브스페이스와 같은 정기 본문(§16) — 방식·주기는 지금 값, 모르는 금액(구서버)은 싣지 않는다
  expect(mocks.saveCreditPlan).toHaveBeenCalledWith("ws1", expect.objectContaining({ revision: 7, note: "메모", topup_day: todayDay, recurring_auto: true, recurring_period: "month" }));
  expect(mocks.saveCreditPlan.mock.calls[0][1]).not.toHaveProperty("recurring_topup");
  expect(mocks.saveCreditPlan.mock.calls[0][1]).not.toHaveProperty("groups");
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
  const groupSelect = host.querySelector<HTMLSelectElement>('table[aria-label="참가자 그룹 배정"] tbody select')!;
  await act(async () => { groupSelect.value = "g1"; groupSelect.dispatchEvent(new Event("change", { bubbles: true })); });
  await openSheet("크레딧 관리");
  const daySelect = host.querySelector<HTMLSelectElement>('[aria-label="충전일"]')!;
  await act(async () => { daySelect.value = "15"; daySelect.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);

  await act(async () => { finishGroupSave(credit(4)); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(2);
  expect(mocks.saveCreditPlan).toHaveBeenLastCalledWith("ws1", expect.objectContaining({ revision: 4, note: "메모", topup_day: 15 }));
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
  expect(sheet.textContent).toContain("4,680"); // 남은 몫
  const input = sheet.querySelector<HTMLInputElement>('[aria-label="a 할당 크레딧"]')!;
  expect(input.placeholder).toBe("그룹 5,000"); // 비어 있으면 그룹 인당 한도가 얼마인지 보여 준다
  await typeInput(input, "600");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenLastCalledWith("ws1", expect.objectContaining({
    revision: 3, members: [{ email: "a@x", quota: 600 }],
  }));
});

it("소수 칸에서 정수 값 뒤에 '.' 을 쳐도 점이 지워지지 않는다 — 100 → 100.5 가 1005 로 저장되던 것(2026-10-03 L3-2)", async () => {
  const data = table(3, [row("a@x", { group_id: "g1" })]);
  data.credit!.members = [
    { email: "a@x", name: "a", workspace_role: "member", is_available: true, group_id: "g1",
      quota: 100, quota_effective: 100, quota_source: "manual", used_period: 0, unknown_period: 0, remaining: 100 },
  ];
  mocks.memberTable.mockResolvedValue(data);
  mocks.saveCreditPlan.mockResolvedValue(credit(4));
  await mount();
  await openSheet("크레딧 관리");
  const input = host.querySelector<HTMLInputElement>('[aria-label="a 할당 크레딧"]')!;
  await typeInput(input, `${input.value}.`); // 사람이 한 글자씩 친다 — 지금 보이는 값 뒤에 붙는다
  await typeInput(input, `${input.value}5`);
  expect(input.value).toBe("100.5");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenLastCalledWith("ws1", expect.objectContaining({ members: [{ email: "a@x", quota: 100.5 }] }));
});

it("정기 충전은 손으로 적고, 비우면 프로젝트 예산 합계로 돌아간다", async () => {
  const data = table(6, [row("a@x", { group_id: "g1" })]);
  data.credit!.plan = { ...data.credit!.plan, monthly_topup: 20000, monthly_topup_source: "derived", derived_topup: 20000, recurring_topup: null };
  mocks.memberTable.mockResolvedValue(data);
  mocks.saveCreditPlan.mockResolvedValue(credit(7));
  await mount();
  await openSheet("크레딧 관리");
  const input = host.querySelector<HTMLInputElement>('[aria-label="정기 크레딧 금액"]')!;
  expect(input.placeholder).toBe("예산 합계 20,000"); // 비었을 때 어디서 온 값인지 알려 준다
  await typeInput(input, "24491.5");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan).toHaveBeenLastCalledWith("ws1", expect.objectContaining({ revision: 6, note: "메모", recurring_topup: 24491.5, topup_day: 1 }));
});

it("구서버(몫을 모르는 서버)면 몫 칸을 잠그고 이유를 적는다", async () => {
  // 구서버는 quota_source 키 자체가 없다. 그대로 열어 두면 저장해도 조용히 무시된다.
  const data = table(3, [row("a@x", { group_id: "g1" })]);
  data.credit!.members = [
    { email: "a@x", name: "a", workspace_role: "member", is_available: true, group_id: "g1" },
  ];
  mocks.memberTable.mockResolvedValue(data);
  await mount();
  await openSheet("크레딧 관리");
  const input = host.querySelector<HTMLInputElement>('[aria-label="a 할당 크레딧"]')!;
  expect(input.disabled).toBe(true);
  const header = [...host.querySelectorAll("th")].find((th) => th.textContent === "할당 크레딧")!;
  expect(header.getAttribute("title")).toContain("공유 서버를 업데이트");
});

it("09-23 '÷ 인원' 서버(quota_total 없음)면 몫 칸을 잠그고 옛 몫·남은 몫을 보이지 않는다", async () => {
  // 옛 서버도 quota_source 는 준다 — 그것만 보면 571.43 같은 나눈 값을 인당 몫처럼 보여 주게 된다.
  const data = table(3, [row("a@x", { group_id: "g1" })]);
  data.credit!.groups = data.credit!.groups.map(({ quota_total: _dropped, ...rest }) => rest);
  data.credit!.members = [
    { email: "a@x", name: "a", workspace_role: "member", is_available: true, group_id: "g1",
      quota: null, quota_effective: 571.43, quota_source: "auto", used_period: 0, unknown_period: 0, remaining: 571.43 },
  ];
  mocks.memberTable.mockResolvedValue(data);
  await mount();
  await openSheet("크레딧 관리");
  const sheet = host.querySelector('table[aria-label="개인별 크레딧 사용량"]')!;
  expect(sheet.querySelector<HTMLInputElement>('[aria-label="a 할당 크레딧"]')!.disabled).toBe(true);
  expect(sheet.textContent).not.toContain("571.43");
});

it("멤버 배정 시트는 그룹 인당 한도만 보인다(사람별 남은 몫은 크레딧 시트에만)", async () => {
  mocks.memberTable.mockResolvedValue(table(3, [row("a@x", { group_id: "g1" })]));
  await mount();
  await openSheet("그룹");
  const assign = host.querySelector('table[aria-label="참가자 그룹 배정"]')!;
  expect(assign.textContent).toContain("5,000 /월");
  expect(assign.textContent).not.toContain("3,480");
});

it("deleted topup stays a draft on refresh/cancel and is not recreated when remote deletion is chosen", async () => {
  const initial = table(1, [row("a@x")]);
  initial.credit!.topups = [{ id: "t1", day: "2026-09-18", credits: 100, note: "old" }];
  const latest = credit(3);
  const external = { ...initial, credit: latest };
  mocks.memberTable.mockResolvedValueOnce(initial).mockResolvedValue(external);
  mocks.saveCreditPlan.mockRejectedValueOnce(conflictError(latest)).mockRejectedValueOnce(conflictError(latest)).mockResolvedValue(credit(4));
  await mount(); await openSheet("크레딧 관리");
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="2026-09-18 추가 크레딧 수정"]')!.click(); });
  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="추가 크레딧"]')!, "200");
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  expect(host.querySelector<HTMLInputElement>('[aria-label="추가 크레딧"]')!.value).toBe("200");
  expect(host.textContent).toContain("편집 중인 입력과 시작값은 유지");
  const saveTopup = async () => { await act(async () => { host.querySelector<HTMLButtonElement>(".mtable-topup-actions .mtable-add")!.click(); }); await settle(); };
  await saveTopup();
  expect(mocks.saveCreditPlan.mock.calls[0][1].revision).toBe(1);
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  const dialog = host.querySelector(".manage-conflict")!;
  expect(dialog.textContent).toContain("내 입력으로 복원");
  expect(dialog.textContent).toContain("변경자를 모두 확인할 수 없습니다");
  const history = dialog.querySelectorAll("li");
  expect(history[0].textContent).toContain("Manager A");
  expect(history[0].textContent).not.toContain("메모");
  expect(history[1].textContent).toContain("Manager B");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settle();
  expect(host.querySelector(".manage-conflict")).toBeNull();
  expect(host.querySelector<HTMLInputElement>('[aria-label="추가 크레딧"]')!.value).toBe("200");
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  await saveTopup();
  expect(mocks.saveCreditPlan.mock.calls[1][1].revision).toBe(1);
  await chooseMerge("remote"); await confirmMerge();
  expect(mocks.saveCreditPlan.mock.calls[2][1]).toMatchObject({ revision: 3, topups: [] });
  expect(host.querySelector('[aria-label="추가 크레딧"]')).toBeNull();
});

it("a second 409 requires a fresh decision and never reuses an earlier keep-mine choice", async () => {
  const initial = table(1, []), remote = credit(2), newer = credit(3);
  initial.credit!.plan.recurring_topup = 100;
  remote.plan.recurring_topup = 300; newer.plan.recurring_topup = 400;
  mocks.memberTable.mockResolvedValue(initial);
  mocks.saveCreditPlan.mockRejectedValueOnce(conflictError(remote)).mockRejectedValueOnce(conflictError(newer)).mockResolvedValue(newer);
  await mount(); await openSheet("크레딧 관리");
  const input = host.querySelector<HTMLInputElement>('[aria-label="정기 크레딧 금액"]') ?? host.querySelector<HTMLInputElement>('.mtable-group-limit input')!;
  await typeInput(input, "200");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  await settle();
  await chooseMerge("mine"); await confirmMerge();
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(2);
  expect(host.querySelector<HTMLSelectElement>(".manage-conflict select")!.value).toBe("");
  expect(host.querySelector<HTMLButtonElement>(".manage-conflict .admin-confirm-yes")!.disabled).toBe(true);
  await chooseMerge("remote"); await confirmMerge();
  expect(mocks.saveCreditPlan.mock.calls[2][1]).toMatchObject({ revision: 3, recurring_topup: 400 });
  expect(input.value).toBe("400");
});

it("dirty group limit survives refresh and successful save releases the dirty baseline", async () => {
  const initial = table(1, []), external = table(2, []), saved = credit(3), refreshed = table(4, []);
  external.groups[0].monthly_limit = 6000; external.credit!.groups[0].monthly_limit = 6000;
  saved.groups[0].monthly_limit = 7000; refreshed.groups[0].monthly_limit = 8000; refreshed.credit!.groups[0].monthly_limit = 8000;
  mocks.memberTable.mockResolvedValueOnce(initial).mockResolvedValueOnce(external).mockResolvedValueOnce({ ...external, groups: saved.groups, credit: saved }).mockResolvedValue(refreshed);
  mocks.saveCreditPlan.mockRejectedValueOnce(conflictError(external.credit!)).mockResolvedValue(saved);
  await mount(); await openSheet("그룹");
  const input = host.querySelector<HTMLInputElement>('[aria-label="2nd floor 크레딧 한도"]')!;
  await typeInput(input, "7000");
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  expect(input.value).toBe("7,000");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  await settle();
  expect(mocks.saveCreditPlan.mock.calls[0][1].revision).toBe(1);
  await chooseMerge("mine"); await confirmMerge();
  expect(input.value).toBe("7,000");
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={2} />); });
  expect(input.value).toBe("8,000");
});

it.each(["cancel", "failure"])("inline %s preserves the captured baseline and explicit retry uses it again", async (mode) => {
  const initial = table(1, []), external = table(2, []), saved = credit(3);
  external.groups[0].monthly_limit = 6000; external.credit!.groups[0].monthly_limit = 6000;
  saved.groups[0].monthly_limit = 7000;
  mocks.memberTable.mockResolvedValueOnce(initial).mockResolvedValue(external);
  mocks.saveCreditPlan.mockRejectedValueOnce(mode === "cancel" ? conflictError(external.credit!) : new Error("offline"))
    .mockRejectedValueOnce(conflictError(external.credit!)).mockResolvedValue(saved);
  await mount(); await openSheet("그룹");
  const input = host.querySelector<HTMLInputElement>('[aria-label="2nd floor 크레딧 한도"]')!;
  await typeInput(input, "7000");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); }); await settle();
  if (mode === "cancel") { await act(async () => { host.querySelector<HTMLButtonElement>(".manage-conflict .credit-modal-delete")!.click(); }); await settle(); }
  expect(input.value).toBe("7,000");
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "입력 유지 · 다시 저장")!;
  await act(async () => { retry.click(); }); await settle();
  expect(mocks.saveCreditPlan.mock.calls[1][1].revision).toBe(1);
  await chooseMerge("mine"); await confirmMerge();
  expect(mocks.saveCreditPlan.mock.calls[2][1].revision).toBe(2);
  expect(host.textContent).not.toContain("미저장 입력:");
});

it("a color palette pins its edit baseline even when the table refreshes while open", async () => {
  const initial = table(1, []), external = table(2, []);
  external.groups[0].color = "#ff0000"; external.credit!.groups[0].color = "#ff0000";
  mocks.memberTable.mockResolvedValueOnce(initial).mockResolvedValue(external);
  mocks.saveCreditPlan.mockRejectedValue(conflictError(external.credit!));
  await mount(); await openSheet("그룹");
  const input = await openGroupColor();
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  expect(input.value).toBe("#3b82f6");
  await act(async () => { input.value = "#00ff00"; input.dispatchEvent(new Event("change", { bubbles: true })); }); await settle();
  expect(mocks.saveCreditPlan.mock.calls[0][1].revision).toBe(1);
  expect(host.querySelector('.manage-conflict')).not.toBeNull();
});

it("reload of an acknowledged own credit save does not warn a dirty planning draft about remote credit changes", async () => {
  const initial = table(1, []), own = table(2, []), external = table(3, []);
  own.credit!.plan.recurring_topup = 200;
  external.credit!.plan.recurring_topup = 300;
  mocks.memberTable.mockResolvedValueOnce(initial).mockResolvedValueOnce(own).mockResolvedValue(external);
  mocks.saveCreditPlan.mockResolvedValue(own.credit);
  await mount(); await openSheet("프로젝트");
  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="본편 메모"]')!, "draft");
  await openSheet("크레딧 관리");
  const input = host.querySelector<HTMLInputElement>('[aria-label="정기 크레딧 금액"]')!;
  await typeInput(input, "200");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); }); await settle();
  expect(host.textContent).not.toContain("서버 설정이 갱신됐습니다");
  expect(host.querySelector(".mtable-notice.ok")).not.toBeNull();
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  expect(host.textContent).toContain("서버 설정이 갱신됐습니다");
  await openSheet("프로젝트");
  expect(host.querySelector<HTMLInputElement>('[aria-label="본편 메모"]')!.value).toBe("draft");
});

it("returning a numeric input to its original value releases dirty state before the next refresh", async () => {
  const initial = table(1, []), external = table(2, []);
  external.groups[0].monthly_limit = 6000; external.credit!.groups[0].monthly_limit = 6000;
  mocks.memberTable.mockResolvedValueOnce(initial).mockResolvedValue(external);
  await mount(); await openSheet("그룹");
  const input = host.querySelector<HTMLInputElement>('[aria-label="2nd floor 크레딧 한도"]')!;
  await typeInput(input, "7000"); await typeInput(input, "5000");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); }); await settle();
  expect(mocks.saveCreditPlan).not.toHaveBeenCalled();
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  expect(input.value).toBe("6,000");
  expect(host.textContent).not.toContain("서버 설정이 갱신됐습니다");
});

it("a synchronous numeric validation refusal clears the unsent edit, unlike an async failure", async () => {
  const initial = table(1, []), external = table(2, []);
  external.credit!.plan.recurring_topup = 300;
  mocks.memberTable.mockResolvedValueOnce(initial).mockResolvedValue(external);
  await mount(); await openSheet("크레딧 관리");
  const input = host.querySelector<HTMLInputElement>('[aria-label="정기 크레딧 금액"]')!;
  await typeInput(input, ".");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); }); await settle();
  expect(mocks.saveCreditPlan).not.toHaveBeenCalled();
  expect(input.value).toBe("");
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  expect(input.value).toBe("300");
  expect(host.textContent).not.toContain("서버 설정이 갱신됐습니다");
});

it("the initial assignment conflict dialog requires a deleted-group decision before keeping my move", async () => {
  const initial = table(1, [row("a@x", { group_id: "g2" })]);
  initial.groups.push(group("g3", "Other"));
  initial.credit!.groups.push(group("g3", "Other"));
  initial.credit!.members = [{ email: "a@x", name: "a", group_id: "g2", quota: null, workspace_role: "member", is_available: true }];
  const latest = { ...initial.credit!, plan: { ...initial.credit!.plan, revision: 2 }, groups: initial.credit!.groups.filter((item) => item.id !== "g1"), members: [{ ...initial.credit!.members[0], group_id: "g3", quota: 23 }] };
  mocks.memberTable.mockResolvedValue(initial);
  mocks.saveCreditPlan.mockRejectedValueOnce(conflictError(latest)).mockResolvedValue({ ...latest, plan: { ...latest.plan, revision: 3 } });
  await mount(); await openSheet("그룹");
  const groupSelect = host.querySelector<HTMLSelectElement>('table[aria-label="참가자 그룹 배정"] tbody select')!;
  await act(async () => { groupSelect.value = "g1"; groupSelect.dispatchEvent(new Event("change", { bubbles: true })); }); await settle();
  const selectors = host.querySelectorAll<HTMLSelectElement>(".manage-conflict select");
  expect(selectors).toHaveLength(2);
  const groupChoice = host.querySelector<HTMLSelectElement>('[aria-label="그룹 / g1 충돌 선택"]')!;
  const memberChoice = [...selectors].find((item) => item !== groupChoice)!;
  await act(async () => { memberChoice.value = "mine"; memberChoice.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelector<HTMLButtonElement>(".manage-conflict .admin-confirm-yes")!.disabled).toBe(true);
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  await act(async () => { groupChoice.value = "mine"; groupChoice.dispatchEvent(new Event("change", { bubbles: true })); });
  await confirmMerge();
  expect(mocks.saveCreditPlan.mock.calls[1][1]).toMatchObject({ revision: 2, members: [{ email: "a@x", group_id: "g1" }] });
  expect(mocks.saveCreditPlan.mock.calls[1][1].groups).toContainEqual(expect.objectContaining({ id: "g1" }));
  expect(host.querySelector(".manage-conflict")).toBeNull();
});

it("서브스페이스 서브(§14·§16)면 정기 행은 서브스페이스와 같은 편집 칸, 기간·요약은 서브스페이스 값, 사용량은 그룹 몫 기간, 예산 칸은 금액 없이도 잠근다", async () => {
  const data = table(3, [row("b@x", { group_id: "g1", usage: { credits: 900, count: 3, unknown: 0 } })]);
  data.credit = { ...data.credit!, plan: { ...data.credit!.plan, recurring_topup: 20000, recurring_auto: false, recurring_period: "month", topup_day: 1 },
    members: [{ email: "b@x", name: "b", workspace_role: "member", is_available: true, group_id: "g1", used_period: 120, unknown_period: 1 }] };
  data.console_limit = { workspace_id: "ws1", workspace_name: "뻘뻘뻘", credits: 20000, period: "month", auto: false, anchor: null, topup_day: 1,
    cycle_start: "2026-09-01", cycle_end: "2026-09-30", topups_cycle: 100, shared_projects: 1 };
  data.projects = [{ ...data.projects[0], console_managed: true, console_limit: null }]; // 금액은 못 받아도 잠근다
  mocks.memberTable.mockResolvedValue(data);
  await mount();
  await openSheet("크레딧 관리");
  const regular = [...host.querySelectorAll<HTMLTableRowElement>(".mtable-topup-table tbody tr")][0];
  expect(regular.querySelector<HTMLSelectElement>('[aria-label="정기 크레딧 방식"]')!.value).toBe("manual");
  expect(regular.querySelector('[aria-label="정기 크레딧 주기"]')).toBeNull(); // 수동은 주기 없음
  expect(regular.querySelector<HTMLInputElement>('[aria-label="정기 크레딧 금액"]')!.placeholder).toBe("없음"); // 서브스페이스 서브 빈 금액 = 없음
  expect(regular.textContent).toContain("서브스페이스와 같은 설정 · 수동");
  expect(host.querySelector('[aria-label="충전 요약"]')!.textContent).toContain("추가 크레딧(이번 주기)+100");
  const usageTable = host.querySelector('table[aria-label="개인별 크레딧 사용량"] tbody')!;
  expect(usageTable.textContent).toContain("120"); // 달 기준 900 이 아니라 그룹 기간 사용
  expect(usageTable.textContent).not.toContain("900");
  await openSheet("프로젝트");
  const status = host.querySelector<HTMLSelectElement>('[aria-label="본편 상태"]')!;
  expect(status.disabled).toBe(false); // 서브스페이스와 같은 경로로 바로 실행(§16)
  expect([...status.options].map((option) => option.textContent)).toEqual(["활성", "비활성", "완료"]);
  expect(host.querySelector('[aria-label="본편 예산 크레딧"]')).toBeNull();
  expect(host.querySelector('[aria-label="프로젝트 요약"]')!.textContent).toContain("20,000 /월");
});

it("정기 크레딧 칸(§16): 날짜를 안 만지면 서브스페이스처럼 지금 설정의 다음 충전일을 보낸다(월 31일·주 요일 유지)", async () => {
  // 순수 본문 — 월 31일은 달 끝 보정(30일)에 끌려가지 않는다 · 날짜를 만졌을 때만 바뀐다
  const monthly = { ...credit(2), plan: { ...credit(2).plan, recurring_topup: 500, recurring_auto: true, recurring_period: "month" as const, recurring_anchor: null, topup_day: 31 } };
  expect(recurringEditBody(monthly, "2026-09-10", { value: 700 })).toMatchObject({ recurring_topup: 700, topup_day: 31, recurring_period: "month" });
  expect(recurringEditBody(monthly, "2026-09-10", { day: 5 })).toMatchObject({ recurring_topup: 500, topup_day: 5, recurring_anchor: "2026-10-05" });
  expect(recurringEditBody({ ...monthly, plan: { ...monthly.plan, recurring_auto: false } }, "2026-09-10", { value: 1 })).not.toHaveProperty("recurring_anchor");
  // 주(기준 9/24 수) → 일 로 주기만 바꾸면 과거 9/24 가 아니라 다음 충전일(10/1)부터 — 서브스페이스와 같다(Codex 코드 리뷰)
  const weekly = { ...monthly, plan: { ...monthly.plan, recurring_period: "week" as const, recurring_anchor: "2026-09-24" } };
  expect(recurringEditBody(weekly, "2026-09-29", { period: "day" })).toMatchObject({ recurring_period: "day", recurring_anchor: "2026-10-01" });
  // 당일 경계 — 충전일 당일(9/24 수)이어도 다음 주기(10/1)부터, 서버 next_topup_day 와 같다(Codex 코드 리뷰)
  expect(recurringEditBody(weekly, "2026-09-24", { period: "day" })).toMatchObject({ recurring_anchor: "2026-10-01" });
  expect(recurringEditBody({ ...monthly, plan: { ...monthly.plan, topup_day: 1 } }, "2026-10-01", { value: 9 })).toMatchObject({ recurring_anchor: "2026-11-01", topup_day: 1 });
  expect(recurringEditBody({ ...monthly, plan: { ...monthly.plan, topup_day: 1, recurring_anchor: "2027-01-01" } }, "2026-10-01", { value: 9 })).toMatchObject({ recurring_anchor: "2027-01-01" });

  const data = table(5, [row("a@x")]);
  data.credit!.plan = { ...data.credit!.plan, monthly_topup: 1000, monthly_topup_source: "manual", recurring_topup: 1000,
    recurring_auto: true, recurring_period: "week", recurring_anchor: "2026-09-03", topup_day: 17 };
  mocks.memberTable.mockResolvedValue(data);
  mocks.saveCreditPlan.mockResolvedValue(credit(6));
  await mount();
  await openSheet("크레딧 관리");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="충전일"]')!.value).toBe("2026-09-03"); // 주 = 날짜 칸
  const input = host.querySelector<HTMLInputElement>('[aria-label="정기 크레딧 금액"]')!;
  await typeInput(input, "2000");
  await act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  await settle();
  const body = mocks.saveCreditPlan.mock.calls[0][1];
  expect(body).toMatchObject({ revision: 5, recurring_topup: 2000, recurring_auto: true, recurring_period: "week" });
  expect(body.recurring_anchor >= todayLocal() && new Date(`${body.recurring_anchor}T00:00:00`).getDay()).toBe(new Date("2026-09-03T00:00:00").getDay()); // 같은 요일의 다음 충전일
  expect(body).not.toHaveProperty("topup_day"); // 주 주기는 달 경계를 건드리지 않는다
});

it("서브스페이스 서브 프로젝트 상태(§16)는 확인 뒤 바로 콘솔 상태 → 보관 → 기획 상태 순으로 반영하고 그 초안을 버린다", async () => {
  const data = table(3, [row("a@x")]);
  data.projects = [{ ...data.projects[0], archived: false, console_managed: true, console_limit: null }];
  mocks.memberTable.mockResolvedValue(data);
  mocks.consoleSetStatus.mockResolvedValue({ workspace_id: "ws1", changed: true });
  mocks.updateProject.mockResolvedValue({});
  mocks.getPlanning.mockResolvedValue({ project_id: "p1", status: "active", revision: 2, note: null });
  mocks.setPlanning.mockResolvedValue({ project_id: "p1", status: "done", revision: 3, note: null });
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  await mount();
  await openSheet("프로젝트");
  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="본편 메모"]')!, "draft");
  const status = host.querySelector<HTMLSelectElement>('[aria-label="본편 상태"]')!;
  expect(status.value).toBe("active");
  await act(async () => { status.value = "done"; status.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(mocks.consoleSetStatus).toHaveBeenCalledWith("ws1", "done");
  expect(mocks.updateProject).toHaveBeenCalledWith("p1", { archived: true });
  expect(mocks.setPlanning).toHaveBeenCalledWith("p1", expect.objectContaining({ status: "done" }));
  const order = [mocks.consoleSetStatus, mocks.updateProject, mocks.setPlanning].map((mock) => mock.mock.invocationCallOrder[0]);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(host.querySelector<HTMLInputElement>('[aria-label="본편 메모"]')!.value).toBe(""); // 초안 폐기 → 재조회 값
  expect(mocks.memberTable.mock.calls.length).toBeGreaterThan(1);
});

it("메인을 고르면 여러 서브가 섞인다 — 서브 상태는 그 줄의 서브와 그 서브 프로젝트에만 적용한다", async () => {
  const data = table(3, [row("a@x")]);
  const planning = data.projects[0].planning;
  data.workspace_id = "main";
  data.projects = [
    { id: "p1", name: "본편", workspace_id: "subA", workspace_name: "A", archived: false, console_managed: true, console_limit: null, planning },
    { id: "p2", name: "외전", workspace_id: "subB", workspace_name: "B", archived: false, console_managed: true, console_limit: null, planning },
  ];
  mocks.memberTable.mockResolvedValue(data);
  mocks.consoleSetStatus.mockResolvedValue({ workspace_id: "subB", changed: true });
  mocks.updateProject.mockResolvedValue({});
  mocks.getPlanning.mockResolvedValue({ project_id: "p2", status: "active", revision: 2, note: null });
  mocks.setPlanning.mockResolvedValue({ project_id: "p2", status: "hold", revision: 3, note: null });
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  await mount("main");
  await openSheet("프로젝트");
  const status = host.querySelector<HTMLSelectElement>('[aria-label="외전 상태"]')!;
  await act(async () => { status.value = "inactive"; status.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(confirm.mock.calls[0][0]).toContain("'B' 서브 전체(프로젝트 1개)");
  expect(mocks.consoleSetStatus).toHaveBeenCalledWith("subB", "inactive");
  expect(mocks.setPlanning.mock.calls.map((call) => call[0])).toEqual(["p2"]); // 서브 A 의 본편은 건드리지 않는다
});

it("서브스페이스 서브 상태 변경이 실패하면 적어 둔 초안을 지킨다(§16 Codex 코드 리뷰)", async () => {
  const data = table(3, [row("a@x")]);
  data.projects = [{ ...data.projects[0], archived: false, console_managed: true, console_limit: null }];
  mocks.memberTable.mockResolvedValue(data);
  mocks.consoleSetStatus.mockRejectedValue(new Error("network down"));
  vi.stubGlobal("confirm", vi.fn(() => true));
  await mount();
  await openSheet("프로젝트");
  await typeInput(host.querySelector<HTMLInputElement>('[aria-label="본편 메모"]')!, "draft");
  const status = host.querySelector<HTMLSelectElement>('[aria-label="본편 상태"]')!;
  await act(async () => { status.value = "done"; status.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(mocks.updateProject).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLInputElement>('[aria-label="본편 메모"]')!.value).toBe("draft");
  expect(host.querySelector(".mtable-notice.bad")!.textContent).toContain("같은 상태를 다시");
});

it("프로젝트 순서(§16)는 이 워크스페이스 활성 프로젝트 자리에만 채우고 보관 ID 는 싣지 않는다", async () => {
  expect(fillReorder(["a", "x", "b", "y", "c"], ["c", "a", "b"])).toEqual(["c", "x", "a", "y", "b"]);
  expect(fillReorder(["a", "x"], ["a", "gone"])).toBeNull(); // 그 사이 목록이 바뀜

  const data = table(3, [row("a@x")]);
  const planning = data.projects[0].planning;
  data.projects = [
    { id: "p1", name: "본편", archived: false, planning },
    { id: "p2", name: "외전", archived: false, planning },
    { id: "p3", name: "옛편", archived: true, planning },
  ];
  mocks.memberTable.mockResolvedValue(data);
  mocks.projects.mockResolvedValue({ projects: [
    { id: "o1", archived: false }, { id: "p1", archived: false }, { id: "o2", archived: false }, { id: "p2", archived: false }, { id: "p3", archived: true },
  ], unassigned: 0 });
  mocks.reorderProjects.mockResolvedValue({ ok: true });
  await mount();
  await openSheet("프로젝트");
  const rowOf = (name: string) => [...host.querySelectorAll<HTMLTableRowElement>(".mtable-project-table tbody tr")].find((tr) => tr.textContent?.startsWith(name))!;
  await act(async () => { rowOf("외전").cells[0].dispatchEvent(new Event("dragstart", { bubbles: true })); }); // 이름 칸이 손잡이
  await act(async () => { rowOf("본편").dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true })); });
  await act(async () => { rowOf("본편").dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })); });
  await settle();
  expect(mocks.projects).toHaveBeenCalledWith("team", true);
  expect(mocks.reorderProjects).toHaveBeenCalledWith(["o1", "p2", "o2", "p1"]);
});

it("보관 프로젝트(§16)는 프로젝트 시트에만 흐리게 보이고 멤버 시트 역할 칸·필터에는 없다", async () => {
  const data = table(3, [row("a@x")]);
  data.projects = [...data.projects, { id: "p9", name: "옛편", archived: true, planning: { status: "done", start_date: null, due_date: null, budget_credits: null, budget_period: "month", archive_after_days: 30, note: null } }];
  mocks.memberTable.mockResolvedValue(data);
  await mount();
  const heads = [...host.querySelectorAll(".mtable-project-role-head")].map((cell) => cell.textContent);
  expect(heads).toEqual(["본편"]);
  expect([...host.querySelectorAll<HTMLOptionElement>('[aria-label="프로젝트 참여 필터"] option')].map((option) => option.textContent)).not.toContain("옛편");
  await openSheet("프로젝트");
  const archived = [...host.querySelectorAll<HTMLTableRowElement>(".mtable-project-table tbody tr")].find((tr) => tr.textContent?.includes("옛편"))!;
  expect(archived.className).toContain("mtable-archived");
  expect(archived.textContent).toContain("보관");
  expect(host.querySelector('[aria-label="프로젝트 요약"]')!.textContent).toContain("1개 · 보관 1");
});

it("서브스페이스 서브 프로젝트 줄은 서브스페이스 서브 표와 같은 칸 — 워크스페이스 배지 · 다음 할당일 · 남은/할당 크레딧", async () => {
  const data = table(3, [row("a@x")]);
  const limit = { workspace_id: "ws1", workspace_name: "뻘뻘뻘", credits: 20000, period: "month" as const, auto: false, anchor: null, topup_day: 1,
    cycle_start: "2026-09-01", cycle_end: "2026-09-30", topups_cycle: 100, shared_projects: 1, balance: 9424.49, next_topup_day: "2026-10-01" };
  data.projects = [{ ...data.projects[0], workspace_name: "뻘뻘뻘", archived: false, console_managed: true, console_limit: limit }];
  mocks.memberTable.mockResolvedValue(data);
  await mount();
  await openSheet("프로젝트");
  const headers = [...host.querySelectorAll(".mtable-project-table thead th")].map((th) => th.textContent);
  expect(headers).toContain("남은 크레딧 / 할당 크레딧");
  expect(headers).toContain("다음 할당일");
  const cells = [...host.querySelectorAll(".mtable-project-table tbody tr")][0].textContent ?? "";
  expect(cells).toContain("뻘뻘뻘"); // 배지
  expect(cells).toContain("수동");
  expect(cells).toContain("9,424.49 / 20,000"); // 20,100(정기+추가)이 아니라 서브스페이스와 같은 남은/할당
});

it("제한 없는 그룹의 사람은 할당·잔여 크레딧에 '제한 없음'(그룹·— 로 헷갈리지 않게)", async () => {
  const data = table(3, [row("a@x", { group_id: "g1" }), row("b@x", { group_id: "g2" })]);
  data.credit = { ...data.credit!, members: [
    { email: "a@x", name: "a", workspace_role: "member", is_available: true, group_id: "g1", quota: null, quota_effective: null, quota_source: "none", used_period: 3, remaining: null },
    { email: "b@x", name: "b", workspace_role: "member", is_available: true, group_id: "g2", quota: null, quota_effective: 5000, quota_source: "auto", used_period: 10, remaining: 4990 },
  ] };
  mocks.memberTable.mockResolvedValue(data);
  await mount();
  await openSheet("크레딧 관리");
  const rowOf = (email: string) => [...host.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(email))!;
  expect(rowOf("a@x").querySelector<HTMLInputElement>('[aria-label="a 할당 크레딧"]')!.placeholder).toBe("제한 없음");
  expect(rowOf("a@x").textContent).toContain("제한 없음");
  expect(rowOf("b@x").querySelector<HTMLInputElement>('[aria-label="b 할당 크레딧"]')!.placeholder).toBe("그룹 5,000");
  expect(rowOf("b@x").textContent).toContain("4,990");
});

// 메인 크레딧 시트 합본(Jay 2026-09-30) — 서브 관리 표를 그대로 불러 (사람 × 서브) 줄로 펼친다
const subLimit = (id: string, name: string, credits: number) => ({ workspace_id: id, workspace_name: name, credits, period: "month" as const, auto: false, anchor: null, topup_day: 1,
  cycle_start: "2026-09-01", cycle_end: "2026-09-30", topups_cycle: 0, shared_projects: 1, balance: 0, balance_seen_at: null, next_topup_day: "2026-10-01" });
const subTable = (id: string, name: string, credits: number, rows: MemberTableRow[], extra: Partial<CreditPlanSettings> = {}): MemberTableData => {
  const data = table(1, rows);
  const groups = [group(`${id}-g`, "Artist_test")];
  return { ...data, workspace_id: id, groups, credit: { ...data.credit!, workspace_id: id, groups, ...extra }, console_limit: subLimit(id, name, credits) };
};
const mainTable = (credit = true): MemberTableData => ({ ...table(1, [row("a@x")]), workspace_id: "main", console_subs: ["subA", "subB"],
  credit: credit ? table(1, []).credit : null, main_balance: credit ? { credits: 158155.75, seen_at: "2026-09-29 05:45:48" } : null });

it("메인 크레딧 시트 = 서브 합본 — 계정 한 줄에 속한 서브의 '서브 / 그룹'과 합친 값(툴팁 = 서브별), 서브 필터, 메인→서브 크레딧 기록", async () => {
  const subA = subTable("subA", "A", 20000, [row("a@x", { group_id: "subA-g" })], {
    members: [{ email: "a@x", name: "a", workspace_role: "member", is_available: true, group_id: "subA-g", quota: null, quota_effective: 5000, quota_source: "auto", used_period: 800, unknown_period: 0, remaining: 4200 }],
    topups: [{ id: "t1", day: "2026-09-22", credits: 100, note: "급한 컷" }],
  });
  const subB = subTable("subB", "B", 400, [row("a@x", { usage: { credits: 30, count: 1, unknown: 2 } }), row("b@x")], { topups: [{ id: "t2", day: "2026-09-25", credits: 50, note: null }] });
  mocks.memberTable.mockImplementation(async (id?: string) => (id === "subA" ? subA : id === "subB" ? subB : mainTable()));
  await mount("main");
  await openSheet("크레딧 관리");
  await settle();
  expect(mocks.memberTable).toHaveBeenCalledWith("subA");
  const people = () => [...host.querySelectorAll('table[aria-label="서브별 개인 크레딧 사용량"] tbody tr')].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
  expect(people()).toEqual([
    // 같은 사람은 한 줄 — 속한 서브마다 '서브 / 그룹', 할당·잔여는 한도 있는 곳만, 사용·미상은 서브 합
    ["a", "a@x", "A/Artist_testB/그룹 없음", "확인", "5,000", "830", "4,200", "2건"],
    ["b", "b@x", "B/그룹 없음", "확인", "그룹 없음", "0", "—", "없음"], // 속하지 않은 서브 A 는 안 보인다
  ]);
  const usedCell = host.querySelectorAll('table[aria-label="서브별 개인 크레딧 사용량"] tbody tr')[0].querySelectorAll("td")[5];
  expect(usedCell.getAttribute("title")).toBe("A 800 · B 30"); // 서브마다 기간이 달라 서브별 값을 함께
  expect(host.querySelector('table[aria-label="개인별 크레딧 사용량"]')).toBeNull(); // 메인 자기 표·참가시키기는 안 보인다
  const records = () => [...host.querySelectorAll('table[aria-label="크레딧 기록"] tbody tr')].map((tr) => [...tr.querySelectorAll("td")].slice(0, 5).map((td) => td.textContent).join("|"));
  expect(records()).toEqual(["—|정기 크레딧|A|수동|20,000", "—|정기 크레딧|B|수동|400", "2026-09-25|추가 크레딧|B|—|+50", "2026-09-22|추가 크레딧|A|—|+100"]);
  const summary = host.querySelector('[aria-label="메인 크레딧 요약"]')!.textContent!;
  expect(summary).toContain("158,155.75");
  expect(summary).toContain("20,400 /월");
  expect(summary).toContain("+150");

  const subFilter = host.querySelector<HTMLSelectElement>('[aria-label="서브 필터"]')!;
  await act(async () => { subFilter.value = "subA"; subFilter.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(people().map((cells) => `${cells[2]}|${cells[5]}`)).toEqual(["A/Artist_test|800"]); // 고른 서브의 값만
  expect(records()).toEqual(["—|정기 크레딧|A|수동|20,000", "2026-09-22|추가 크레딧|A|—|+100"]);
  expect([...host.querySelectorAll<HTMLOptionElement>('[aria-label="그룹 필터"] option')].map((option) => option.textContent)).toEqual(["그룹 전체", "그룹 없음", "A / Artist_test"]);

  // 그룹 시트도 같은 모양 — 그룹 현황 = 서브마다의 그룹, 참가자 배정 = 계정 한 줄에 '서브 / 그룹'
  await openSheet("그룹");
  await settle();
  expect([...host.querySelectorAll('table[aria-label="크레딧 그룹 현황"] tbody tr')].map((tr) => tr.querySelector("td")!.textContent)).toEqual(["A/Artist_test", "B/Artist_test"]); // 그룹 시트는 서브 필터가 따로(전체)
  const assign = [...host.querySelectorAll('table[aria-label="참가자 그룹 배정"] tbody tr')].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
  expect(assign).toEqual([["a", "a@x", "A/Artist_testB/그룹 없음", "5,000"], ["b", "b@x", "B/그룹 없음", "—"]]);
});

it("메인 합본도 시스템 부트스트랩 계정을 싣지 않는다(메인 표와 같게 — Codex main 검토 P2-1)", async () => {
  const subA = subTable("subA", "A", 100, [row("a@x"), row("admin@millionvolt.com")]);
  mocks.memberTable.mockImplementation(async (id?: string) => (id === "subA" ? subA : { ...mainTable(), console_subs: ["subA"] }));
  await mount("main");
  await openSheet("크레딧 관리");
  await settle();
  const emails = [...host.querySelectorAll('table[aria-label="서브별 개인 크레딧 사용량"] tbody tr')].map((tr) => tr.querySelectorAll("td")[1].textContent);
  expect(emails).toEqual(["a@x"]);
});

it("mainPeople 합산 규칙 — 유한+제한 없음은 제한 없음, 음수 잔여는 그대로 더하고, 구서버(할당 계약 없음) 서브는 할당·잔여를 모름", () => {
  const member = (email: string, group: string, quota: number | null, remaining: number | null, used: number) =>
    ({ email, name: email[0], workspace_role: "member", is_available: true, group_id: group, quota: null, quota_effective: quota, quota_source: "auto" as const, used_period: used, unknown_period: 0, remaining });
  const a = subTable("subA", "A", 0, [row("x@x", { group_id: "subA-g" }), row("y@x", { group_id: "subA-g" })],
    { members: [member("x@x", "subA-g", 1000, -200, 1200), member("y@x", "subA-g", 1000, 400, 600)] });
  const b = subTable("subB", "B", 0, [row("x@x", { group_id: "subB-g" }), row("y@x", { group_id: "subB-g", is_available: false })],
    { members: [member("x@x", "subB-g", 500, -50, 550), member("y@x", "subB-g", null, null, 30)] }); // y 는 B 에서 제한 없음
  const old = subTable("subC", "C", 0, [row("x@x", { group_id: "subC-g" })]); // members 에 quota_source 없음 = 구서버
  const [x, y] = mainPeople([{ id: "subA", table: a, error: "" }, { id: "subB", table: b, error: "" }, { id: "subC", table: old, error: "" }]);
  expect([x.quota, x.remaining, x.unlimited, x.used?.credits, x.entries.length]).toEqual([1500, -250, false, 1750, 3]); // 음수 잔여도 합에 그대로(초과는 초과)
  expect([y.unlimited, y.used?.credits, y.available]).toEqual([true, 630, false]); // 한 곳이라도 제한 없음 → 합계도 제한 없음 · 한 곳이라도 확인 전
});

it("메인 크레딧 합본 — 크레딧 권한이 없으면 시트 전체를 막고 서브를 부르지 않으며, 늦게 온 옛 서브 응답은 버린다", async () => {
  mocks.memberTable.mockResolvedValue(mainTable(false));
  await mount("main");
  await openSheet("크레딧 관리");
  await settle();
  expect(host.textContent).toContain("크레딧 상세를 볼 권한이 없습니다");
  expect(mocks.memberTable).not.toHaveBeenCalledWith("subA");

  let resolveOld: (value: MemberTableData) => void = () => {};
  const fresh = subTable("subA", "A", 20000, [row("new@x")]);
  let subCalls = 0;
  mocks.memberTable.mockImplementation((id?: string) => {
    if (id === "subA") return ++subCalls === 1 ? new Promise<MemberTableData>((resolve) => { resolveOld = resolve; }) : Promise.resolve(fresh);
    if (id === "subB") return Promise.resolve(subTable("subB", "B", 400, []));
    return Promise.resolve(mainTable());
  });
  await act(async () => { root.render(<MemberTable workspaceId="main" reloadSignal={1} />); });
  await settle();
  expect(host.textContent).toContain("서브 크레딧을 불러오는 중"); // 첫 합본은 서브 A 를 기다린다
  await act(async () => { root.render(<MemberTable workspaceId="main" reloadSignal={2} />); }); // 다시 읽기 — 새 합본
  await settle();
  await act(async () => { resolveOld(subTable("subA", "A", 20000, [row("old@x")])); });
  await settle();
  expect(host.textContent).toContain("new@x");
  expect(host.textContent).not.toContain("old@x");
});

it("메인 크레딧 합본 — 서브 0개는 빈 합본(로딩 아님), 메인에서 고른 그룹 필터는 서브로 넘어가지 않는다(Codex 코드 리뷰)", async () => {
  mocks.memberTable.mockResolvedValue({ ...mainTable(), console_subs: [] });
  await mount("main");
  await openSheet("크레딧 관리");
  await settle();
  expect(host.textContent).toContain("표시할 크레딧 사용량이 없습니다");
  expect(host.textContent).not.toContain("불러오는 중");

  const subA = subTable("subA", "A", 20000, [row("a@x", { group_id: "subA-g" })]);
  mocks.memberTable.mockImplementation(async (id?: string) => (id === "subA" ? subA : id === "subB" ? subTable("subB", "B", 400, []) : id === "ws1" ? table(1, [row("w@x")]) : mainTable()));
  await act(async () => { root.render(<MemberTable workspaceId="main" reloadSignal={1} />); });
  await settle();
  const groupFilter = () => host.querySelector<HTMLSelectElement>('[aria-label="그룹 필터"]')!;
  await act(async () => { groupFilter().value = "subA-g"; groupFilter().dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelectorAll('table[aria-label="서브별 개인 크레딧 사용량"] tbody tr').length).toBe(1);
  await act(async () => { root.render(<MemberTable workspaceId="ws1" reloadSignal={1} />); });
  await settle();
  expect(groupFilter().value).toBe("");
  expect(host.querySelector('table[aria-label="개인별 크레딧 사용량"]')!.textContent).toContain("w@x");
});

it("그룹 시트 남음 — 그룹 크레딧이 없는 그룹은 '제한 없음', 있는 그룹은 숫자", async () => {
  const data = table(3, [row("a@x")]);
  data.groups = [{ ...data.groups[0], monthly_limit: null, remaining: null }, data.groups[1]];
  mocks.memberTable.mockResolvedValue(data);
  await mount();
  await openSheet("그룹");
  const rowOf = (name: string) => [...host.querySelectorAll('table[aria-label="크레딧 그룹 현황"] tbody tr')].find((tr) => tr.textContent?.includes(name))!;
  expect(rowOf("2nd floor").lastElementChild!.textContent).toBe("제한 없음");
  expect(rowOf("3rd floor").lastElementChild!.textContent).toBe("3,480");
});
