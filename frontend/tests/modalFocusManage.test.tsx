// @vitest-environment jsdom
// 모달의 초점(lib/keyGate '모달의 초점') — 관리 화면·관리자 창 안쪽의 대화상자들. 실제 창을 붙여 본다(App 없이 — 분리 관리 창과 같은 처지).
//  프로젝트 설정 대화상자 · 그룹 창 · 그룹 삭제 확인 · 멤버 추가 창 · 콘솔 대화상자들(렌더 폴더·프로젝트 기간·할당 기준값·참가시키기·크레딧·
//  워크스페이스 만들기·달력의 크레딧 정보) · 완료 탭의 예/아니오 확인 · 백업 위치 비밀번호 확인.
//  창마다: 열면 초점이 창 안 · Tab 은 창 안에서만 돈다 · 닫으면 연 자리로(연 단추가 남아 있을 때).
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 가짜는 바깥 경계(서버 호출)에만. 이름을 준 것만 답하고 나머지는 '아직 안 옴'.
const { mocks, boundary } = vi.hoisted(() => {
  const names = ["creditPlanSettings", "getPlanning", "members", "projects", "workspaceOptions", "allProjectMembers", "projectMembers", "projectFolderLinks",
    "projectFolder", "workspaceMembers", "models", "consoleOverview", "saveFinalsStatus", "saveFinalsProgress", "saveFinals", "authConfig", "replicaStatus"] as const;
  const mocks = Object.fromEntries(names.map((name) => [name, vi.fn()])) as Record<(typeof names)[number], ReturnType<typeof vi.fn>>;
  const boundary = () => new Proxy(mocks as Record<string, unknown>, { get: (target, key: string) => target[key] ?? (() => new Promise(() => {})) });
  return { mocks, boundary };
});
vi.mock("../src/lib/manageApi", () => ({ manageApi: boundary() }));
vi.mock("../src/api", () => ({ api: boundary() }));
vi.mock("../src/lib/useManageCaps", () => ({
  useManageCaps: () => ({ loaded: true, authOff: false, system: true, viewerUid: null, createProject: true, grantRole: true, readAll: true }),
}));
vi.mock("../src/lib/useManageRealtime", () => ({ useManageRealtime: () => 0 }));
vi.mock("../src/lib/modelPolicy", () => ({ refreshModelPolicy: vi.fn() }));
vi.mock("../src/lib/backupReplicaApi", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  backupReplicaApi: { status: (...args: unknown[]) => mocks.replicaStatus(...args), save: () => new Promise(() => {}), run: () => new Promise(() => {}) },
}));
vi.mock("../src/components/admin/ProjectRenderTree", () => ({ ProjectRenderTree: () => null }));
vi.mock("../src/components/manage/DashboardView", () => ({ DashboardView: () => null }));
vi.mock("../src/components/manage/WorkBoard", () => ({ WorkBoard: () => null }));
// 콘솔의 서브 표는 이 시험과 무관하다 — 풀 카드(할당 기준값 창)는 진짜를 쓴다
vi.mock("../src/components/manage/console/ConsoleMainParts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), SubTable: () => null }));

import { BackupReplicaSection } from "../src/components/admin/BackupReplicaSection";
import { ConsoleFolderDialog } from "../src/components/manage/console/ConsoleFolderDialog";
import { PoolCard } from "../src/components/manage/console/ConsoleMainParts";
import { ConsolePeriodDialog } from "../src/components/manage/console/ConsolePeriodDialog";
import { AddMemberDialog, CreditDialog } from "../src/components/manage/console/ConsoleSubView";
import { CreditCalendar } from "../src/components/manage/console/CreditCalendar";
import { WorkspaceConsole } from "../src/components/manage/console/WorkspaceConsole";
import { ExportView } from "../src/components/manage/ExportView";
import { ProjectManagerPanel } from "../src/components/manage/ProjectManagerPanel";
import { ManageWindow } from "../src/components/ManageWindow";
import { backgroundKeysBlocked } from "../src/lib/keyGate";

let host: HTMLDivElement;
let root: Root;
const planSettings = {
  workspace_id: "ws", month: "2026-10", plan: { revision: 1, note: "", monthly_topup: 1000, topup_day: 1, updated_at: null },
  groups: [{ id: "g", name: "그룹", monthly_limit: 100, member_count: 0, used_month: 0, unknown_month: 0, remaining: 100, unknown_since_base: 0, estimated: false }],
  members: [], topups: [],
};
const overview = {
  today: "2026-10-11", main: { id: "mv", name: "MV", balance: 0, balance_seen_at: null, reported: 1 }, subs: [], pending: [{ id: "x", name: "X" }],
  totals: {}, schedule: [], allocation: { allocated: 0, spent: 0, unused: 0, source: "estimate", base: null, base_day: null },
  calendar: { from: "2026-07-01", to: "2026-12-31", events: [{ kind: "topup", sub_id: "s1", topup_id: "t1", name: "서브", day: "2026-10-02", credits: 100 }] },
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.models.mockResolvedValue([]);
  mocks.members.mockResolvedValue([]);
  mocks.allProjectMembers.mockResolvedValue({});
  mocks.projectMembers.mockResolvedValue([]);
  mocks.workspaceOptions.mockResolvedValue({ workspaces: [{ id: "ws", name: "WS", member_count: 0 }] });
  mocks.workspaceMembers.mockResolvedValue({ members: [] });
  mocks.projectFolderLinks.mockResolvedValue({ links: {} });
  mocks.projectFolder.mockResolvedValue({ root_path: "", selected_path: "" });
  mocks.projects.mockResolvedValue({ projects: [{ id: "p", name: "프로젝트", workspace_id: "ws", workspace_name: "WS", kind: "team" }] });
  mocks.getPlanning.mockResolvedValue({ project_id: "p", revision: 3, note: "", status: "active" });
  mocks.creditPlanSettings.mockResolvedValue(planSettings);
  mocks.consoleOverview.mockResolvedValue(overview);
  mocks.saveFinalsStatus.mockResolvedValue({ render_path: "\\\\NAS\\Render", error: null, shared_supported: true, history: [],
    targets: [{ gen_id: "c1", kind: "final", folder_path: "ep001/c1", filename: "", saved: false, reason: null, media_type: "video" }] });
  mocks.saveFinalsProgress.mockResolvedValue({ progress: null });
  mocks.authConfig.mockResolvedValue({ manage_enabled: true });
  mocks.replicaStatus.mockResolvedValue({
    applicable: true, target: "\\\\NAS\\backup", target_id: "a", source: "file", editable: true, lock_reason: null, target_garbled: false,
    target_is_unc: true, server_account_system: true, task: null, result: null,
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const noop = () => {};
const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const active = () => document.activeElement as HTMLElement;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async (ui: ReactElement) => { await act(async () => { root.render(ui); }); await settle(); };
/** 단추를 눌러 연다 — 초점이 그 단추에 있다(연 자리). */
const press = async (target: HTMLElement) => {
  act(() => target.focus());
  await act(async () => { target.click(); });
  await settle();
  return target;
};
const escape = async () => {
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await settle();
};
const byText = (selector: string, text: string) => [...document.querySelectorAll<HTMLElement>(selector)].find((item) => item.textContent?.includes(text))!;
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};

// 브라우저의 Tab — keydown 을 보내고, 아무도 막지 않았으면 문서 순서의 다음(이전) 자리로 초점을 옮긴다(jsdom 에는 이 기본 동작이 없다).
const stops = () => [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]")]
  .filter((item) => item.tabIndex >= 0 && !item.matches(":disabled") && !item.closest("[inert]"));
function tab(shift = false): KeyboardEvent {
  const from = (document.activeElement ?? document.body) as HTMLElement;
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
  act(() => { from.dispatchEvent(event); });
  if (event.defaultPrevented) return event;
  const all = stops();
  const at = all.indexOf(from);
  let next: HTMLElement | undefined;
  if (at >= 0) next = all[at + (shift ? -1 : 1)];
  else if (from === document.body) next = shift ? all[all.length - 1] : all[0];
  else if (shift) next = all.filter((item) => from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_PRECEDING && !item.contains(from)).pop();
  else next = all.find((item) => from.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING);
  act(() => { if (next) next.focus(); else from.blur(); });
  return event;
}
const walk = (count: number, shift = false) => Array.from({ length: count }, () => { tab(shift); return active(); });
const outside = (visited: HTMLElement[], region: HTMLElement) => visited.filter((at) => !region.contains(at)).map((at) => at.id || at.className || at.tagName);
/** 창이 떠 있다: 초점이 창 안이고, Tab 20번·Shift+Tab 8번이 창 안에서만 돈다. */
const expectTrapped = (selector: string) => {
  const win = q(selector);
  expect(win, selector).not.toBeNull();
  expect(win!.contains(active()), "열면 초점이 창 안").toBe(true);
  expect(outside([...walk(20), ...walk(8, true)], win!)).toEqual([]);
};

// 뒤 화면의 단추 사이에 창을 그린다
const page = (window: ReactElement | null) => (
  <>
    <button id="opener">연 단추</button>
    {window}
    <button id="behind">뒤 화면</button>
  </>
);
const sub = { id: "ws-sub", name: "서브 A", projects: [{ id: "p1", name: "프로젝트 1", archived: false, start_date: "2026-10-01", due_date: "2026-10-31" }] };
const creditSub = { monthly_topup: 100, monthly_topup_source: "manual" as const, recurring_auto: true, recurring_period: "month" as const,
  recurring_anchor: null, topup_day: 1, next_topup_day: "2026-11-01" };

describe("따로 뜨는 콘솔 대화상자", () => {
  const dialogs: [string, (onClose: () => void) => ReactElement, string][] = [
    ["렌더 폴더(ConsoleFolderDialog)", (onClose) => <ConsoleFolderDialog workspaceId="ws" name="WS" onClose={onClose} />, '.wc-dialog[aria-label="렌더 폴더"]'],
    ["프로젝트 기간(ConsolePeriodDialog)", (onClose) => <ConsolePeriodDialog sub={sub as never} savePlanning={async (_p, _b, body) => body} onClose={onClose} onSaved={noop} />, '.wc-dialog[aria-label="프로젝트 기간"]'],
    ["참가시키기(AddMemberDialog)", (onClose) => <AddMemberDialog groups={[]} onClose={onClose} onSave={async () => {}} />, '.wc-dialog[aria-label="참가시키기"]'],
    ["크레딧(CreditDialog)", (onClose) => <CreditDialog name="서브" sub={creditSub} today="2026-10-11" onClose={onClose} onSave={async () => {}} onAdd={async () => {}} />, '.wc-dialog[aria-label="크레딧"]'],
  ];
  it.each(dialogs)("%s: 열면 초점이 창 안 · Tab 이 창 안에서만 돈다 · 닫으면 연 단추로 돌아간다", async (_name, render, selector) => {
    await mount(page(null));
    act(() => q("#opener")!.focus());
    await mount(page(render(noop)));
    expectTrapped(selector);
    await mount(page(null));
    expect(active()).toBe(q("#opener"));
  });
});

describe("화면에서 여는 대화상자", () => {
  it("할당 기준값(풀 카드): 초점이 창 안에 있고 Tab 이 창 안에서 돈다 — 닫으면 연 단추로", async () => {
    await mount(page(<PoolCard data={overview as never} canEdit onChanged={noop} />));
    const opener = await press(q(".wc-pool-edit")!);
    expectTrapped('.wc-dialog[aria-label="할당된 크레딧 기준값"]');
    await escape();
    expect(q('.wc-dialog[aria-label="할당된 크레딧 기준값"]')).toBeNull();
    expect(active()).toBe(opener);
  });

  it("워크스페이스 만들기(메인 콘솔): 초점이 창 안에 있고 Tab 이 창 안에서 돈다 — 닫으면 연 단추로", async () => {
    await mount(page(<WorkspaceConsole caps={{ loaded: true, authOff: false, system: true, viewerUid: null, createProject: true, grantRole: true, readAll: true } as never} reloadSignal={0} />));
    const opener = await press(q(".wc-create")!);
    expectTrapped('.wc-dialog[aria-label="워크스페이스 만들기"]');
    await escape();
    expect(q('.wc-dialog[aria-label="워크스페이스 만들기"]')).toBeNull();
    expect(active()).toBe(opener);
  });

  it("달력의 크레딧 정보: 초점이 창 안에 있고 Tab 이 창 안에서 돈다 — 닫으면 연 칩으로", async () => {
    await mount(page(<CreditCalendar data={{ ...overview, subs: [{ id: "s1", name: "서브", projects: [], recurring_period: "month" }] } as never} canEdit busy={false}
      onMove={noop} onEdit={async () => {}} loadNote={() => new Promise(() => {})} />));
    const opener = await press(q(".wc-cal-chip")!);
    expectTrapped(".wc-event-info");
    await press(byText(".wc-event-info footer button", "취소"));
    expect(q(".wc-event-info")).toBeNull();
    expect(active()).toBe(opener);
  });

  it("달력의 크레딧 정보: Esc 겹이다 — 뒤 화면의 단축키가 쉬고, Esc 는 삭제 재확인부터 풀고 다음에 창을 닫는다. 저장 중에는 닫지 않고 삼킨다", async () => {
    let finish!: () => void;
    const onEdit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await mount(page(<CreditCalendar data={{ ...overview, subs: [{ id: "s1", name: "서브", projects: [], recurring_period: "month" }] } as never} canEdit busy={false}
      onMove={noop} onEdit={onEdit} loadNote={async () => "메모"} />));
    expect(backgroundKeysBlocked()).toBe(false);
    await press(q(".wc-cal-chip")!);
    expect(backgroundKeysBlocked()).toBe(true);
    await press(byText(".wc-event-info footer button", "삭제"));
    expect(byText(".wc-event-info footer button", "정말 삭제")).toBeTruthy();
    await escape();
    expect(q(".wc-event-info")).not.toBeNull(); // 재확인만 풀렸다
    expect(byText(".wc-event-info footer button", "정말 삭제")).toBeUndefined();
    // 저장 중: 닫히지 않는다 — 그래도 겹은 그대로라 Esc 가 뒤 화면으로 새지 않는다
    await type(q("#wc-event-credits") as HTMLInputElement, "200");
    await press(byText(".wc-event-info footer button", "저장"));
    expect(onEdit).toHaveBeenCalledTimes(1);
    await escape();
    expect(q(".wc-event-info")).not.toBeNull();
    expect(backgroundKeysBlocked()).toBe(true);
    await act(async () => { finish(); });
    await settle();
    expect(q(".wc-event-info")).toBeNull(); // 저장이 끝나 스스로 닫혔다
    expect(backgroundKeysBlocked()).toBe(false);
    // 다시 열어 Esc 한 번에 닫는다
    await press(q(".wc-cal-chip")!);
    await escape();
    expect(q(".wc-event-info")).toBeNull();
  });

  it("완료 탭의 예/아니오 확인: 초점이 창 안에 있고 Tab 이 창 안에서 돈다 — 닫으면 연 단추로", async () => {
    await mount(page(<ExportView />));
    const opener = await press(byText(".export-act button", "최종 저장"));
    expectTrapped(".export-modal");
    await press(byText(".export-modal button", "아니오"));
    expect(q(".export-modal")).toBeNull();
    expect(active()).toBe(opener);
  });

  it("백업 위치 비밀번호 확인(관리자 창의 공유 서버 탭): 비밀번호 칸의 초점이 남고 Tab 이 창 안에서 돈다 — 닫으면 연 단추로", async () => {
    await mount(page(<BackupReplicaSection />));
    await type(q('input[aria-label="백업 복사 위치"]') as HTMLInputElement, "\\\\NAS2\\b");
    const opener = await press(byText(".replica-actions button", "저장"));
    expect(active().getAttribute("type")).toBe("password"); // 창이 스스로 준 초점
    expectTrapped(".admin-confirm");
    await escape();
    expect(q(".admin-confirm")).toBeNull();
    expect(active()).toBe(opener);
  });
});

describe("프로젝트 관리(관리자 창의 프로젝트 탭)", () => {
  const openSettings = async () => {
    await mount(page(<ProjectManagerPanel />));
    return press(q('[title="프로젝트 설정"]')!);
  };

  it("프로젝트 설정 대화상자: 초점이 창 안에 있고 Tab 이 창 안에서 돈다 — 닫으면 연 단추로", async () => {
    const opener = await openSettings();
    expectTrapped(".project-dialog-stack");
    await escape();
    expect(q(".project-dialog-stack")).toBeNull();
    expect(active()).toBe(opener);
  });

  it("그 안의 그룹 창: Tab 이 그룹 창 안에서만 돈다(뒤의 프로젝트 설정으로 가지 않는다) — 닫으면 초점이 프로젝트 설정으로 돌아온다", async () => {
    await openSettings();
    await act(async () => { q('tr[title="클릭하면 그룹 창이 열립니다"]')!.click(); });
    await settle();
    expectTrapped(".credit-modal");
    await escape();
    expect(q(".credit-modal")).toBeNull();
    expect(q(".project-dialog-stack")!.contains(active())).toBe(true);
    expect(outside(walk(12), q(".project-dialog-stack")!)).toEqual([]);
  });

  it("그룹 삭제 확인: Tab 이 확인 창 안에서만 돈다 — 닫으면 연 단추(삭제)로", async () => {
    await openSettings();
    const opener = await press(q(".credit-plan-del")!);
    expectTrapped(".credit-plan-fields .admin-confirm");
    await escape();
    expect(q(".credit-plan-fields .admin-confirm")).toBeNull();
    expect(active()).toBe(opener);
  });

  it("멤버 추가 창: 초점이 창 안에 있고 Tab 이 창 안에서 돈다 — 닫으면 연 단추로", async () => {
    await mount(page(<ProjectManagerPanel />));
    await press(q('.admin-pactions button[title^="멤버 역할"]')!);
    const opener = await press(q(".project-member-add-button")!);
    expectTrapped(".project-member-add-dialog");
    await escape();
    expect(q(".project-member-add-dialog")).toBeNull();
    expect(active()).toBe(opener);
  });
});

describe("분리 관리 창(App 없이 뜬다)", () => {
  it("완료 탭의 확인 창에서도 초점 장치가 돈다 — 리스너는 모듈을 읽을 때 걸린다", async () => {
    await mount(<ManageWindow />);
    await press(byText(".manage-tabs button", "완료"));
    const opener = await press(byText(".export-act button", "최종 저장"));
    expectTrapped(".export-modal");
    await press(byText(".export-modal button", "아니오"));
    expect(active()).toBe(opener);
  });

  it("완료 탭의 확인 창은 Esc 겹이다 — 떠 있는 동안 뒤 화면의 단축키가 쉬고, Esc 는 '아니오'다. 연 직후의 Space 는 뒤의 관리 창을 밀지 않는다", async () => {
    await mount(<ManageWindow />);
    await press(byText(".manage-tabs button", "완료"));
    expect(backgroundKeysBlocked()).toBe(false);
    const opener = await press(byText(".export-act button", "최종 저장"));
    expect(q(".export-modal")).not.toBeNull();
    expect(backgroundKeysBlocked()).toBe(true);
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    act(() => { active().dispatchEvent(space); }); // 초점은 확인 창의 뿌리 — 관리 창의 본문(스크롤된다)이 밀리면 안 된다
    expect(space.defaultPrevented).toBe(true);
    await escape();
    expect(q(".export-modal")).toBeNull();
    expect(mocks.saveFinals).not.toHaveBeenCalled(); // '아니오' — 저장하지 않는다
    expect(backgroundKeysBlocked()).toBe(false);
    expect(active()).toBe(opener);
  });
});
