// @vitest-environment jsdom
// 메인 콘솔의 크레딧 편집(2026-10-03 점검) —
// CXF-3: 날짜를 안 건드리고 금액만 고치면 topup_day·recurring_anchor 를 보내지 않는다(매월 31일 → 다음 충전일 11-30 에서 30일로 바뀌던 것).
// CXF-7: 저장 기준은 편집 창을 연 순간 읽은 설정(값+revision) — 그사이 다른 관리자가 자동→수동으로 바꿨으면 409 병합 창을 거쳐 그 변경이 남는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceConsole } from "../src/components/manage/console/WorkspaceConsole";
import { HttpError } from "../src/lib/http";
import type { ManageCaps } from "../src/lib/useManageCaps";

const mocks = vi.hoisted(() => ({ consoleOverview: vi.fn(), creditPlanSettings: vi.fn(), saveCreditPlan: vi.fn() }));
vi.mock("../src/lib/manageApi", () => ({ manageApi: mocks }));
// 메인 표는 ＋ 크레딧 단추 하나만 남긴다 — 창(CreditDialog)과 달력(CreditCalendar)은 진짜를 쓴다
vi.mock("../src/components/manage/console/ConsoleMainParts", () => ({
  PoolCard: () => null,
  SubTable: ({ data, onCredit }: { data: { subs: unknown[] }; onCredit: (sub: unknown) => void }) => <button type="button" data-credit onClick={() => onCredit(data.subs[0])} />,
}));

const SUB = { id: "a", name: "A", status: "active", participants: { reported: 1, unconfirmed: 0 }, projects: [], balance: 0, balance_seen_at: null,
  monthly_topup: 100, monthly_topup_source: "manual", recurring_auto: true, recurring_period: "month", recurring_anchor: null,
  topup_day: 31, next_topup_day: "2026-11-30" };
const OVERVIEW = { today: "2026-11-03", main: { id: "mv", name: "MV", balance: 0, balance_seen_at: null, reported: 1 }, subs: [SUB], pending: [],
  totals: {}, schedule: [], allocation: {},
  calendar: { from: "2026-08-01", to: "2027-01-31", events: [{ day: "2026-11-30", kind: "recurring", sub_id: "a", name: "A", credits: 100 },
    { day: "2026-11-02", kind: "topup", sub_id: "a", name: "A", credits: 100, topup_id: "t1" }] } };
const settings = (revision: number, auto = true) => ({ workspace_id: "a", month: "2026-11",
  plan: { monthly_topup: 100, monthly_topup_source: "manual", recurring_topup: 100, recurring_auto: auto, recurring_period: "month",
    recurring_anchor: null, topup_day: 31, note: "메모", revision, updated_at: null },
  groups: [], members: [], topups: [] });
const caps = { loaded: true, authOff: false, system: false, viewerUid: null, createProject: true, grantRole: false, readAll: true } as ManageCaps;

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.consoleOverview.mockResolvedValue(OVERVIEW);
  mocks.creditPlanSettings.mockResolvedValue(settings(1));
  mocks.saveCreditPlan.mockImplementation(async () => settings(3));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const type = async (selector: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => { setter?.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};
const click = async (selector: string) => { await act(async () => { host.querySelector<HTMLElement>(selector)!.click(); }); await settle(); };
const start = async () => { await act(async () => { root.render(<WorkspaceConsole caps={caps} reloadSignal={0} />); }); await settle(); };
const sentBodies = () => mocks.saveCreditPlan.mock.calls.map((call) => call[1] as Record<string, unknown>);

// 다른 관리자 B 가 창이 열린 뒤 자동→수동으로 바꿔 저장했다 — 서버는 revision 2. 옛 revision 으로 오면 409.
const otherManagerSwitchedToManual = () => {
  mocks.creditPlanSettings.mockResolvedValue(settings(2, false));
  mocks.saveCreditPlan.mockImplementation(async (_id: string, body: { revision: number }) => {
    if (body.revision !== 2) {
      throw new HttpError(409, "conflict", JSON.stringify({ kind: "manage_edit_conflict", latest: settings(2, false), latest_revision: 2,
        changes: [{ revision: 2, actor_uid: "b", actor_name: "B", fields: ["recurring_auto"], created_at: "2026-11-03 10:00" }], history_complete: true }));
    }
    return settings(3, false);
  });
};

it("CXF-3 크레딧 창에서 금액만 고치면 충전일·기준 날짜를 보내지 않는다(서버가 매월 31일을 그대로 둔다)", async () => {
  await start();
  await click("[data-credit]");
  await type("#wc-recurring", "200");
  await click(".wc-dialog button.pri");
  expect(sentBodies()).toHaveLength(1);
  const body = sentBodies()[0];
  expect(body.recurring_topup).toBe(200);
  expect("topup_day" in body).toBe(false);
  expect("recurring_anchor" in body).toBe(false);
});

it("CXF-3 달력에서 자동 크레딧 금액만 고쳐도 충전일·기준 날짜를 보내지 않는다", async () => {
  await start();
  await click(".wc-cal-chip.rec");
  await type("#wc-event-credits", "200");
  await click(".wc-event-info button.pri");
  expect(sentBodies()).toHaveLength(1);
  const body = sentBodies()[0];
  expect(body.recurring_topup).toBe(200);
  expect("topup_day" in body).toBe(false);
  expect("recurring_anchor" in body).toBe(false);
});

it("CXF-7 크레딧 창은 연 순간의 설정을 기준으로 보낸다 — 그사이 다른 관리자의 수동 전환은 병합 창을 거쳐 남는다", async () => {
  await start();
  await click("[data-credit]");
  otherManagerSwitchedToManual();
  await type("#wc-recurring", "200");
  await click(".wc-dialog button.pri");
  expect(sentBodies()[0].revision).toBe(1); // 연 순간의 revision
  await click(".manage-conflict .admin-confirm-yes");
  const bodies = sentBodies();
  expect(bodies[bodies.length - 1]).toMatchObject({ revision: 2, recurring_topup: 200, recurring_auto: false });
});

it("CXF-7 달력 정보 창도 연 순간의 설정을 기준으로 보낸다", async () => {
  await start();
  await click(".wc-cal-chip.rec");
  otherManagerSwitchedToManual();
  await type("#wc-event-credits", "200");
  await click(".wc-event-info button.pri");
  expect(sentBodies()[0].revision).toBe(1);
  await click(".manage-conflict .admin-confirm-yes");
  const bodies = sentBodies();
  expect(bodies[bodies.length - 1]).toMatchObject({ revision: 2, recurring_topup: 200, recurring_auto: false });
});

// Codex 코드 리뷰 2라운드(2026-10-03 A-1) — 창의 처음 값과 기준 revision 은 **같은 응답**이어야 한다.
it("CXF-7 표는 자동인데 창을 열 때 이미 수동이면 창도 수동으로 열리고 수동을 그대로 보낸다", async () => {
  mocks.creditPlanSettings.mockResolvedValue(settings(2, false)); // 개요(표)는 아직 자동 — B 가 먼저 수동으로 바꿨다
  await start();
  await click("[data-credit]");
  await type("#wc-recurring", "200");
  await click(".wc-dialog button.pri");
  expect(sentBodies()).toHaveLength(1);
  expect(sentBodies()[0]).toMatchObject({ revision: 2, recurring_topup: 200, recurring_auto: false });
  expect("topup_day" in sentBodies()[0]).toBe(false);
});

it("CXF-7 창을 열 때 설정을 못 읽으면 창을 열지 않고 알린다(저장 때 다시 읽어 대신하지 않는다)", async () => {
  mocks.creditPlanSettings.mockRejectedValueOnce(new Error("네트워크"));
  await start();
  await click("[data-credit]");
  expect(host.querySelector("#wc-recurring")).toBeNull();
  expect(host.querySelector(".wc-notice")?.textContent).toContain("읽지 못했습니다");
});

it("CXF-7 달력 정보 창을 열 때 설정을 못 읽으면 저장을 막는다(저장 때 다시 읽어 대신하지 않는다)", async () => {
  await start();
  mocks.creditPlanSettings.mockRejectedValueOnce(new Error("네트워크"));
  await click(".wc-cal-chip.rec");
  await type("#wc-event-credits", "200");
  await click(".wc-event-info button.pri");
  expect(mocks.saveCreditPlan).not.toHaveBeenCalled();
  expect(host.querySelector(".wc-event-info .wc-error")?.textContent).toContain("설정을 읽지 못해 저장하지 않았습니다");
});

it("CXF-7 달력 자동 크레딧 금액만 고칠 때 방식은 연 순간 설정의 값 — 이미 수동이면 수동 그대로", async () => {
  mocks.creditPlanSettings.mockResolvedValue(settings(2, false));
  await start();
  await click(".wc-cal-chip.rec");
  await type("#wc-event-credits", "200");
  await click(".wc-event-info button.pri");
  expect(sentBodies()).toHaveLength(1);
  expect(sentBodies()[0]).toMatchObject({ revision: 2, recurring_topup: 200, recurring_auto: false });
});

it("CXF-7 추가 기록의 메모만 고치면 금액은 보내지 않는다 — 연 순간 설정의 금액(다른 관리자가 고친 값)이 남는다", async () => {
  mocks.creditPlanSettings.mockResolvedValue({ ...settings(2), topups: [{ id: "t1", day: "2026-11-02", credits: 150, note: "메모B" }] });
  await start();
  await click(".wc-cal-chip.top");
  expect(host.querySelector<HTMLInputElement>("#wc-event-note")!.value).toBe("메모B");
  await type("#wc-event-note", "새 메모");
  await click(".wc-event-info button.pri");
  expect(sentBodies()).toHaveLength(1);
  expect(sentBodies()[0]).toMatchObject({ revision: 2, topups: [{ id: "t1", day: "2026-11-02", credits: 150, note: "새 메모" }] });
});
