// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreditPlanFields } from "../src/components/manage/CreditPlanFields";
import { ProjectManagerPanel } from "../src/components/manage/ProjectManagerPanel";
import { draftFromSettings, draftToBody, type CreditPlanDraft, type CreditPlanSettings } from "../src/lib/creditPlan";
import { mergeCreditPlan } from "../src/lib/creditPlanMerge";
import { HttpError } from "../src/lib/http";
import { parseManageConflict } from "../src/components/manage/useManageEditConflict";

const mocks = vi.hoisted(() => ({
  creditPlanSettings: vi.fn(), saveCreditPlan: vi.fn(), getPlanning: vi.fn(), setPlanning: vi.fn(),
  members: vi.fn(), projects: vi.fn(), workspaceOptions: vi.fn(), allProjectMembers: vi.fn(), projectFolderLinks: vi.fn(), projectFolder: vi.fn(), workspaceMembers: vi.fn(), updateProject: vi.fn(), createProject: vi.fn(), models: vi.fn(),
}));
vi.mock("../src/lib/manageApi", () => ({ manageApi: mocks }));
vi.mock("../src/api", () => ({ api: mocks }));
vi.mock("../src/lib/useManageCaps", () => ({ useManageCaps: () => ({ createProject: true, grantRole: true, loaded: true }) }));
vi.mock("../src/lib/modelPolicy", () => ({ refreshModelPolicy: vi.fn() }));
vi.mock("../src/components/admin/ProjectRenderTree", () => ({ ProjectRenderTree: () => null }));
vi.mock("../src/components/manage/ProjectMembersPanel", () => ({ ProjectMembersPanel: () => null }));

const settings = (revision = 1): CreditPlanSettings => ({
  workspace_id: "ws", month: "2026-09", plan: { revision, note: "old", monthly_topup: 1000, topup_day: 1, updated_at: null },
  groups: [{ id: "g", name: "Group", monthly_limit: 100, member_count: 0, used_month: 0, unknown_month: 0, remaining: 100, unknown_since_base: 0, estimated: false }],
  members: [], topups: [{ id: "t", day: "2026-09-01", credits: 100, note: "before" }],
});
const conflict = (latest: object, revision: number) => new HttpError(409, "conflict", JSON.stringify({ kind: "manage_edit_conflict", latest, latest_revision: revision, changes: [], history_complete: false }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.models.mockResolvedValue([]); mocks.members.mockResolvedValue([]); mocks.allProjectMembers.mockResolvedValue({});
  mocks.workspaceOptions.mockResolvedValue({ workspaces: [{ id: "ws", name: "Workspace", member_count: 0 }] });
  mocks.workspaceMembers.mockResolvedValue({ members: [] }); mocks.projectFolderLinks.mockResolvedValue({ links: {} });
  mocks.projectFolder.mockResolvedValue({ root_path: "", selected_path: "" });
  mocks.projects.mockResolvedValue({ projects: [{ id: "p", name: "Project", workspace_id: "ws", workspace_name: "Workspace", kind: "team" }] });
  mocks.getPlanning.mockResolvedValue({ project_id: "p", revision: 3, note: "old planning", status: "active" });
  mocks.updateProject.mockResolvedValue({}); mocks.creditPlanSettings.mockResolvedValue(settings());
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const click = async (selector: string) => { await act(async () => { host.querySelector<HTMLButtonElement>(selector)!.click(); }); await settle(); };
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};
const select = async (selector: string, value: string) => {
  await act(async () => { const input = host.querySelector<HTMLSelectElement>(selector)!; input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); });
};
const openPanel = async () => {
  await act(async () => { root.render(<ProjectManagerPanel onClose={vi.fn()} />); }); await settle();
  await click('[title="프로젝트 설정"]');
};

it("only well-formed structured 409 details enter the merge workflow", () => {
  expect(parseManageConflict(new HttpError(409, "legacy conflict"))).toBeNull();
  expect(parseManageConflict(new HttpError(500, "bad", JSON.stringify({ kind: "manage_edit_conflict" })))).toBeNull();
  expect(parseManageConflict(conflict(settings(), 2))).toMatchObject({ latest_revision: 2, history_complete: false });
  expect(parseManageConflict(conflict(settings(), -1))).toBeNull();
});

it("CreditPlanFields preserves group baseline and topup inputs on cancel and advances only the topup baseline after save", async () => {
  const base = settings(), latest = settings(2), saved = settings(3);
  latest.groups[0].name = "Remote group"; latest.topups[0].credits = 300;
  saved.groups[0].name = "Remote group"; saved.topups[0].credits = 300;
  mocks.saveCreditPlan.mockRejectedValueOnce(conflict(latest, 2)).mockRejectedValueOnce(conflict(latest, 2)).mockResolvedValue(saved);
  let current: CreditPlanDraft | null = null;
  function Harness() {
    const [draft, setDraft] = useState<CreditPlanDraft | null>(() => { const d = draftFromSettings(base); d.groups[0].name = "My group"; d.dirty = true; return d; });
    current = draft;
    return <CreditPlanFields workspaceId="ws" draft={draft} onChange={setDraft} />;
  }
  await act(async () => { root.render(<Harness />); });
  await type(host.querySelector<HTMLInputElement>('[aria-label="추가 크레딧"]')!, "200");
  await click('.credit-topup-save');
  await click('.manage-conflict .credit-modal-delete');
  expect(current!.baseline!.plan.revision).toBe(1);
  expect(current!.groups[0].name).toBe("My group");
  expect(current!.topups[0].creditsInput).toBe("200");
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  await click('.credit-topup-save');
  await select('.manage-conflict select', 'remote');
  await click('.manage-conflict .admin-confirm-yes');
  expect(current!.topupBaseline!.plan.revision).toBe(3);
  expect(current!.baseline!.plan.revision).toBe(1);
  expect(current!.topups[0].creditsInput).toBe("300");
  expect(current!.groups[0].name).toBe("My group");
  expect(mergeCreditPlan(current!.baseline!, draftToBody(current!), saved).changes).toContainEqual(expect.objectContaining({ path: "groups.g.name", conflict: true }));
  expect(mocks.saveCreditPlan.mock.calls[2][1]).toMatchObject({ revision: 2, topups: [{ credits: 300 }] });
});

it("ProjectManagerPanel planning sends revision and keeps its original baseline after conflict cancellation", async () => {
  const latest = { project_id: "p", revision: 4, note: "remote planning", due_date: "2026-12-01" };
  mocks.setPlanning.mockRejectedValue(conflict(latest, 4));
  await openPanel();
  const note = host.querySelector<HTMLInputElement>('.project-planning-fields input[type="text"]:not([aria-label])')!;
  await type(note, "my planning");
  await click('.project-dialog-actions .admin-confirm-yes');
  expect(mocks.setPlanning.mock.calls[0][1]).toMatchObject({ revision: 3, note: "my planning" });
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }); await settle();
  expect(host.querySelector('.admin-project-dialog')).not.toBeNull();
  expect(note.value).toBe("my planning");
  expect(host.textContent).toContain("일부 저장됨: 프로젝트 이름·워크스페이스");
  expect(mocks.setPlanning).toHaveBeenCalledTimes(1);
  await click('.project-dialog-actions .admin-confirm-yes');
  expect(mocks.setPlanning.mock.calls[1][1].revision).toBe(3);
});

it("ProjectManagerPanel keeps credit drafts on 409 while reporting earlier planning success explicitly", async () => {
  const latest = settings(2); latest.plan.topup_day = 20;
  mocks.setPlanning.mockResolvedValue({ project_id: "p", revision: 4, note: "old planning", status: "active" });
  mocks.saveCreditPlan.mockRejectedValue(conflict(latest, 2));
  await openPanel();
  await select('[aria-label="매월 충전일"]', '15');
  await click('.project-dialog-actions .admin-confirm-yes');
  expect(mocks.saveCreditPlan.mock.calls[0][1]).toMatchObject({ revision: 1, topup_day: 15 });
  await click('.manage-conflict .credit-modal-delete');
  expect(host.querySelector<HTMLSelectElement>('[aria-label="매월 충전일"]')!.value).toBe("15");
  expect(host.textContent).toContain("일부 저장됨: 프로젝트 이름·워크스페이스, 일정·예산");
  expect(host.textContent).toContain("미저장 입력은 유지");
  await click('.project-dialog-actions .admin-confirm-yes');
  expect(mocks.setPlanning.mock.calls[1][1].revision).toBe(4);
  expect(mocks.saveCreditPlan.mock.calls[1][1].revision).toBe(1);
});

it("new project partial failure stays editable and retry does not create the project twice", async () => {
  mocks.createProject.mockResolvedValue({ id: "new", name: "New", workspace_id: "ws" });
  mocks.setPlanning.mockRejectedValue(new Error("offline"));
  await act(async () => { root.render(<ProjectManagerPanel onClose={vi.fn()} />); }); await settle();
  const create = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("프로젝트 추가"))
    ?? [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("새 프로젝트"))!;
  await act(async () => { create.click(); }); await settle();
  await type(host.querySelector<HTMLInputElement>('[placeholder="프로젝트 이름"]')!, "New");
  await click('.project-dialog-actions .admin-confirm-yes');
  expect(mocks.setPlanning.mock.calls[0][1].revision).toBe(0);
  expect(host.textContent).toContain("일부 저장됨: 프로젝트 생성");
  await click('.project-dialog-actions .admin-confirm-yes');
  expect(mocks.createProject).toHaveBeenCalledTimes(1);
  expect(mocks.setPlanning.mock.calls[1][0]).toBe("new");
});

it("a pending credit row locks project/workspace inputs without disabling conflict choices", async () => {
  const latest = settings(2); latest.topups[0].credits = 300;
  mocks.saveCreditPlan.mockRejectedValue(conflict(latest, 2));
  await openPanel();
  await type(host.querySelector<HTMLInputElement>('[aria-label="추가 크레딧"]')!, "200");
  await click('.credit-topup-save');
  const workspace = host.querySelector<HTMLSelectElement>('.admin-project-dialog .admin-field select')!;
  expect(workspace.matches(":disabled")).toBe(true);
  const choice = host.querySelector<HTMLSelectElement>('.manage-conflict select')!;
  expect(choice.matches(":disabled")).toBe(false);
  await click('.manage-conflict .credit-modal-delete');
  expect(workspace.matches(":disabled")).toBe(false);
});

it("project save after its own topup save rebases a revision-only 409 once without an empty dialog", async () => {
  const afterTopup = settings(2); afterTopup.topups[0].credits = 200;
  const saved = settings(3); saved.topups[0].credits = 200; saved.plan.topup_day = 15;
  mocks.setPlanning.mockResolvedValue({ project_id: "p", revision: 4, note: "old planning", status: "active" });
  mocks.saveCreditPlan.mockResolvedValueOnce(afterTopup).mockRejectedValueOnce(conflict(afterTopup, 2)).mockResolvedValue(saved);
  await openPanel();
  await select('[aria-label="매월 충전일"]', '15');
  await type(host.querySelector<HTMLInputElement>('[aria-label="추가 크레딧"]')!, "200");
  await click('.credit-topup-save');
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(1);
  await click('.project-dialog-actions .admin-confirm-yes');
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(3);
  expect(mocks.saveCreditPlan.mock.calls[1][1].revision).toBe(1);
  expect(mocks.saveCreditPlan.mock.calls[2][1]).toMatchObject({ revision: 2, topup_day: 15, topups: [{ credits: 200 }] });
  expect(host.querySelector('.manage-conflict')).toBeNull();
  expect(host.querySelector('.admin-project-dialog')).toBeNull();
});

it.each([1, 2, 3])("revision-only 409 retry is bounded (reported revision %s) and keeps the draft", async (revision) => {
  mocks.setPlanning.mockResolvedValue({ project_id: "p", revision: 4, note: "old planning", status: "active" });
  if (revision > 1) mocks.saveCreditPlan.mockRejectedValueOnce(conflict(settings(2), 2));
  mocks.saveCreditPlan.mockRejectedValue(conflict(settings(revision), revision));
  await openPanel();
  await select('[aria-label="매월 충전일"]', '15');
  await click('.project-dialog-actions .admin-confirm-yes');
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(revision > 1 ? 2 : 1);
  expect(host.querySelector('.manage-conflict')).toBeNull();
  expect(host.querySelector<HTMLSelectElement>('[aria-label="매월 충전일"]')!.value).toBe("15");
  expect(host.textContent).toContain("자동 재시도를 중단");
  expect(host.querySelector<HTMLButtonElement>('.project-dialog-actions .admin-confirm-yes')!.disabled).toBe(false);
});

it("real changes after a revision-only retry still require explicit conflict choices", async () => {
  const remote = settings(3); remote.plan.topup_day = 20;
  mocks.setPlanning.mockResolvedValue({ project_id: "p", revision: 4, note: "old planning", status: "active" });
  mocks.saveCreditPlan.mockRejectedValueOnce(conflict(settings(2), 2)).mockRejectedValueOnce(conflict(remote, 3)).mockResolvedValue(remote);
  await openPanel();
  await select('[aria-label="매월 충전일"]', '15');
  await click('.project-dialog-actions .admin-confirm-yes');
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(2);
  expect(host.querySelector('.manage-conflict')).not.toBeNull();
  expect(host.querySelector<HTMLSelectElement>('.manage-conflict select')!.value).toBe("");
  expect(host.querySelector<HTMLButtonElement>('.manage-conflict .admin-confirm-yes')!.disabled).toBe(true);
  await select('.manage-conflict select', 'remote');
  await click('.manage-conflict .admin-confirm-yes');
  expect(mocks.saveCreditPlan).toHaveBeenCalledTimes(3);
  expect(mocks.saveCreditPlan.mock.calls[2][1]).toMatchObject({ revision: 3, topup_day: 20 });
});
