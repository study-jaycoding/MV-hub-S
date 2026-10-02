import { passesChipFilters } from "../src/components/manage/console/ConsoleFilterBar";
import { describe, expect, it } from "vitest";
import type { CreditPlanSettings } from "../src/lib/creditPlan";
import { consoleLimitView, creditDialogSub, EMAIL_RE, periodSummary, recurringPlanBody, scheduleLabel, topupAddBody, topupPatchBody } from "../src/lib/workspaceConsole";

const settings = {
  workspace_id: "a",
  month: "2026-09",
  plan: { monthly_topup: 60000, note: "메모", revision: 7, updated_at: null },
  groups: [{ id: "g", name: "애니", monthly_limit: 8000, member_count: 1, used_month: 0, unknown_month: 0, remaining: 8000, unknown_since_base: 0, estimated: false }],
  members: [],
  topups: [{ id: "t1", day: "2026-08-10", credits: 999, note: null }],
} satisfies CreditPlanSettings;

describe("topupAddBody", () => {
  it("keeps note and every existing topup, and leaves groups untouched", () => {
    // 서버는 topups 를 전체 교체하고 note 를 빼면 지운다(Codex §9) — 둘 다 늘 실어야 한다.
    const body = topupAddBody(settings, { day: "2026-09-10", credits: 8000, note: null });
    expect(body).toEqual({
      revision: 7,
      note: "메모",
      topups: [
        { id: "t1", day: "2026-08-10", credits: 999, note: null },
        { id: expect.stringMatching(/^[0-9a-f]{32}$/), day: "2026-09-10", credits: 8000, note: null },
      ],
    });
    expect("groups" in body).toBe(false);
    expect("members" in body).toBe(false);
  });
});

describe("EMAIL_RE", () => {
  it("accepts a plain address and rejects obvious mistakes", () => {
    expect(EMAIL_RE.test("user7@example.com")).toBe(true);
    expect(EMAIL_RE.test("user7@example")).toBe(false);
    expect(EMAIL_RE.test("user 7@example.com")).toBe(false);
  });
});

describe("topupAddBody under a 409 merge", () => {
  it("merges with a concurrent topup instead of throwing", async () => {
    const { mergeCreditPlan } = await import("../src/lib/creditPlanMerge");
    const body = topupAddBody(settings, { day: "2026-09-10", credits: 8000, note: null });
    const latest = {
      ...settings,
      plan: { ...settings.plan, revision: 8 },
      topups: [...settings.topups, { id: "b".repeat(32), day: "2026-09-12", credits: 500, note: "다른 관리자" }],
    };
    const merged = mergeCreditPlan(settings, body, latest);
    const days = (merged.value.topups ?? []).map((t) => t.day).sort();
    expect(days).toEqual(["2026-08-10", "2026-09-10", "2026-09-12"]);
  });
});

describe("recurringPlanBody", () => {
  it("sends amount, mode and day but leaves groups and topups untouched", () => {
    const body = recurringPlanBody(settings, { value: null, auto: false, period: "week", date: "2026-10-15" });
    expect(body).toEqual({ revision: 7, note: "메모", recurring_topup: null, recurring_auto: false, topup_day: 15 });
    // 주 단위 자동은 요일 기준 날짜만 보내고 달 경계(topup_day)는 건드리지 않는다
    expect(recurringPlanBody(settings, { value: 500, auto: true, period: "week", date: "2026-10-07" })).toEqual({
      revision: 7, note: "메모", recurring_topup: 500, recurring_auto: true, recurring_period: "week", recurring_anchor: "2026-10-07",
    });
  });

  it("날짜를 빼면(안 건드림) 충전일·기준 날짜를 보내지 않는다 — 서버가 기존 값을 둔다(2026-10-03 점검 CXF-3)", () => {
    expect(recurringPlanBody(settings, { value: 200, auto: true, period: "month" })).toEqual({
      revision: 7, note: "메모", recurring_topup: 200, recurring_auto: true, recurring_period: "month",
    });
    expect(recurringPlanBody(settings, { value: 200, auto: false, period: "month" })).toEqual({ revision: 7, note: "메모", recurring_topup: 200, recurring_auto: false });
  });

  it("keeps another manager's mode change when only the amount was edited", async () => {
    const { mergeCreditPlan } = await import("../src/lib/creditPlanMerge");
    const base = { ...settings, plan: { ...settings.plan, recurring_topup: 100, recurring_auto: true, topup_day: 1 } };
    const latest = { ...base, plan: { ...base.plan, revision: 8, recurring_auto: false } };
    const body = recurringPlanBody(base, { value: 200, auto: true, period: "month", date: "2026-10-01" });
    const merged = mergeCreditPlan(base, body, latest);
    expect(merged.value.recurring_auto).toBe(false);
    expect(merged.value.recurring_topup).toBe(200);
  });
});

describe("topupPatchBody", () => {
  const two = { ...settings, topups: [...settings.topups, { id: "t2", day: "2026-09-01", credits: 5, note: "x" }] };
  it("moves or edits only the chosen record and keeps the rest and the plan note", () => {
    expect(topupPatchBody(two, "t2", { day: "2026-09-03" })).toEqual({
      revision: 7, note: "메모",
      topups: [{ id: "t1", day: "2026-08-10", credits: 999, note: null }, { id: "t2", day: "2026-09-03", credits: 5, note: "x" }],
    });
    expect(topupPatchBody(two, "t2", { credits: 50, note: "고침" }).topups?.[1]).toEqual({ id: "t2", day: "2026-09-01", credits: 50, note: "고침" });
    expect(() => topupPatchBody(two, "missing", { day: "2026-09-03" })).toThrow();
  });
  it("deletes only the chosen record", () => {
    expect(topupPatchBody(two, "t2", null).topups).toEqual([{ id: "t1", day: "2026-08-10", credits: 999, note: null }]);
  });
});

describe("scheduleLabel", () => {
  const base = { recurring_auto: true, recurring_period: "month" as const, recurring_anchor: null, topup_day: 1 };
  it("describes the mode and period the same way everywhere", () => {
    expect(scheduleLabel(base)).toBe("자동 · 매월 1일");
    expect(scheduleLabel({ ...base, recurring_period: "week", recurring_anchor: "2026-10-01" })).toBe("자동 · 매주 목요일");
    expect(scheduleLabel({ ...base, recurring_period: "day" })).toBe("자동 · 매일");
    expect(scheduleLabel({ ...base, recurring_auto: false, recurring_period: "week" })).toBe("수동");
  });
});

describe("passesChipFilters", () => {
  const rows = [{ g: "A", hf: "확인" }, { g: "B", hf: "확인 전" }, { g: "A", hf: "확인 전" }];
  const pick = (active: string[], values: Record<string, string[]>) =>
    rows.filter((r) => passesChipFilters(r, { active, values }, (row, key) => (key === "group" ? row.g : row.hf)));
  it("ORs values inside a chip and ANDs chips, empty chips pass everything", () => {
    expect(pick([], {})).toHaveLength(3);
    expect(pick(["group"], { group: [] })).toHaveLength(3);
    expect(pick(["group"], { group: ["A", "B"] })).toHaveLength(3);
    expect(pick(["group", "hf"], { group: ["A"], hf: ["확인 전"] })).toEqual([{ g: "A", hf: "확인 전" }]);
  });
});

describe("periodSummary", () => {
  const p = (start: string | null, due: string | null) => ({ id: "x", name: "x", start_date: start, due_date: due });
  it("shows the whole span of a sub's projects", () => {
    expect(periodSummary([])).toBeNull();
    expect(periodSummary([p(null, null)])).toBeNull();
    expect(periodSummary([p("2026-09-01", "2026-10-31")])).toBe("09-01 ~ 10-31");
    expect(periodSummary([p("2026-09-10", "2026-09-30"), p("2026-09-01", "2026-11-15")])).toBe("09-01 ~ 11-15");
    expect(periodSummary([p("2026-09-01", null)])).toBe("09-01 ~ ?");
  });
});

describe("consoleLimitView (설계 §13 — 대시보드·관리 표의 서브스페이스 크레딧)", () => {
  const base = { workspace_id: "a", workspace_name: "A", credits: 1000, period: "month" as const, auto: true,
    cycle_start: "2026-09-01", cycle_end: "2026-09-30", topups_cycle: 250, shared_projects: 1 };
  it("이번 주기 계획 = 정기 + 추가, 툴팁에 출처·주기", () => {
    const view = consoleLimitView(base);
    expect(view.total).toBe(1250);
    expect(view.title).toContain("서브스페이스 · 서브 A");
    expect(view.title).toContain("정기(월) 1,000 + 추가 250");
    expect(view.title).not.toContain("함께 씀");
  });
  it("0 이면 없음(null), 여럿이 쓰면 공유를 밝힌다", () => {
    expect(consoleLimitView({ ...base, credits: null, topups_cycle: 0 }).total).toBeNull();
    expect(consoleLimitView({ ...base, shared_projects: 2 }).title).toContain("프로젝트 2개가 함께 씀");
  });
});

describe("creditDialogSub 의 다음 충전일 — 서버 개요(_occurrences)와 같은 규칙(2026-10-03 Codex 3라운드)", () => {
  const plan = (p: Record<string, unknown>) => ({ ...settings, plan: { ...settings.plan, ...p } }) as unknown as CreditPlanSettings;
  it("수동은 월 주기·기준 날짜 없이 — 자동만 골라도 오늘이 충전일로 가지 않게", () => {
    expect(creditDialogSub(plan({ recurring_auto: false, recurring_period: "week", recurring_anchor: "2026-10-01", topup_day: 20 }), "2026-11-03").next_topup_day)
      .toBe("2026-11-20");
  });
  it("기준 날짜 없는 주 충전도 월 주기로 센다", () => {
    expect(creditDialogSub(plan({ recurring_auto: true, recurring_period: "week", recurring_anchor: null, topup_day: 20 }), "2026-11-03").next_topup_day)
      .toBe("2026-11-20");
  });
  it("먼 미래 기준 날짜도 반복 상한 없이 그날부터(Codex 4라운드 — 240개월 상한에 걸려 2046 을 냈다)", () => {
    expect(creditDialogSub(plan({ recurring_auto: true, recurring_period: "month", recurring_anchor: "2050-11-20", topup_day: 20 }), "2026-11-03").next_topup_day)
      .toBe("2050-11-20");
  });
  it("자동 월은 그대로", () => {
    expect(creditDialogSub(plan({ recurring_auto: true, recurring_period: "month", recurring_anchor: null, topup_day: 20 }), "2026-11-03").next_topup_day)
      .toBe("2026-11-20");
  });
});
