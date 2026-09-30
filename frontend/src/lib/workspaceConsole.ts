// 워크스페이스 콘솔(서브스페이스 — 대시보드의 워크스페이스 판) — 응답 모양과 새 저장 본문(설계: docs/WORKSPACE_CONSOLE_DESIGN.md).
// 할당·그룹·참가자 쓰기는 기존 PUT credit-plan 을 쓴다 — 본문 헬퍼도 lib/memberTable.ts 것을 그대로 쓴다.
import { newGroupId, type CreditPlanSaveBody, type CreditPlanSettings, type LimitPeriod } from "./creditPlan";
import { formatCredits } from "./formatCredits";
import type { Planning } from "../components/manage/types";

export interface ConsoleSub {
  id: string;
  name: string;
  balance: number | null; // 에이전트 마지막 보고 잔액
  balance_seen_at: string | null;
  first_seen_at: string | null; // 이 앱이 처음 본 날(힉스필드 생성일 대용)
  used_all: number; // 전체 기간 사용(우리 기록)
  monthly_topup: number | null; // 정기 크레딧(서브스페이스 전환 뒤엔 손 입력만 · 전환 전엔 비면 프로젝트 월 예산 합)
  monthly_topup_source: "manual" | "derived" | "none";
  recurring_auto: boolean; // true=자동(충전일 · Next) · false=수동(예정표에서 빠짐)
  recurring_period: LimitPeriod; // 자동 충전 주기 — monthly_topup 은 이 주기마다 한 번 들어가는 양
  recurring_anchor: string | null; // 주=그 요일 · 일=그날부터
  topup_day: number;
  next_topup_day: string | null;
  upcoming: string[]; // 30일 안 자동 충전 날짜
  cycle_start: string;
  cycle_end: string;
  topups_cycle: { count: number; credits: number }; // 이번 주기 추가 크레딧
  used_cycle: number;
  unknown_cycle: number;
  planned_left: number | null; // 정기 + 추가 − 사용(정기 크레딧을 모르면 null)
  group_count: number;
  participants: { reported: number; unconfirmed: number };
  status: ConsoleStatus; // 표시용 상태 — 활성·비활성·완료
  projects: { id: string; name: string; start_date: string | null; due_date: string | null; archived: boolean }[]; // 그 서브 프로젝트(보관 포함)
}

/** 서브 표 '기간' 칸 — 프로젝트가 하나면 그 기간, 여럿이면 가장 이른 시작 ~ 가장 늦은 종료. 날짜가 없으면 null. */
export function periodSummary(projects: Pick<ConsoleSub["projects"][number], "start_date" | "due_date">[]): string | null {
  const starts = projects.map((p) => p.start_date).filter((d): d is string => !!d).sort();
  const dues = projects.map((p) => p.due_date).filter((d): d is string => !!d).sort();
  if (!starts.length && !dues.length) return null;
  return `${starts[0]?.slice(5) ?? "?"} ~ ${dues[dues.length - 1]?.slice(5) ?? "?"}`;
}

export type ConsoleStatus = "active" | "inactive" | "done";
export const STATUS_LABEL: Record<ConsoleStatus, string> = { active: "활성", inactive: "비활성", done: "완료" };

export interface ConsoleOverview {
  today: string;
  main: { id: string; name: string; balance: number | null; balance_seen_at: string | null; reported: number } | null;
  subs: ConsoleSub[];
  totals: { recurring_30d: number; topups_cycle: number; topups_count: number; used_cycle: number; spent_all: number; unused: number };
  schedule: { day: string; subs: { id: string; name: string }[]; amount: number; balance_after: number | null }[];
  pending: { id: string; name: string; reported: number; last_seen_at: string | null; archived: boolean }[];
  // 메인은 정해져 있는데 등록부(힉스필드 보고)에서 사라짐 — 메인은 바꿀 수 없으니(Jay 2026-09-30) 지정 선택기 대신 복구 안내. 구서버는 없음.
  main_orphan?: { id: string } | null;
  // 풀 카드 — baseline=힉스필드 값 기준(할당 = 기준값 + 이후 기록·지나간 자동 충전, 사용 = 할당 − 미사용) · estimate=우리 기록 기준
  allocation: { source: "baseline" | "estimate"; base: number | null; base_day: string | null; allocated: number; spent: number; unused: number };
  // 크레딧 달력 — 지난 3개월 추가 크레딧 기록 + 앞으로 92일 자동 정기 크레딧(금액·서브 이름만)
  calendar: {
    from: string;
    to: string;
    events: { day: string; kind: "recurring" | "topup"; sub_id: string; name: string; credits: number; topup_id?: string }[];
  };
}

/** 추가 크레딧 한 건 기록. 서버는 topups 를 **전체 교체**하므로 받은 기록 전부 + 새 한 건을 보낸다(Codex §9).
 *  note 도 늘 싣는다 — 빼면 서버가 메모를 지운다. 그룹·배정은 키를 빼서 그대로 둔다.
 *  새 건에도 id(uuid hex)를 미리 붙인다 — 없으면 409 병합기가 합칠 수 없어 경합 때 저장이 막힌다(Codex 코드 리뷰). */
export function topupAddBody(
  credit: CreditPlanSettings,
  topup: { day: string; credits: number; note: string | null },
): CreditPlanSaveBody {
  return {
    revision: credit.plan.revision,
    note: credit.plan.note,
    topups: [...credit.topups.map((t) => ({ id: t.id, day: t.day, credits: t.credits, note: t.note ?? null })), { id: newGroupId(), ...topup }],
  };
}

/** 정기 크레딧 창 저장 — 금액(null=파생)·충전 방식·주기·날짜. 그룹·충전 기록은 키를 빼서 그대로 둔다.
 *  날짜의 뜻은 주기마다 다르다: 월 = 매월 그 날(topup_day — 서브의 달 경계도 옮긴다) · 주 = 그 요일 · 일 = 그날부터.
 *  주·일에서는 topup_day 를 보내지 않는다(달 경계를 건드리지 않게). 수동은 주기 없이 달 경계만.
 *  바꾸지 않은 칸은 기준값과 같아 409 병합 때 다른 관리자의 변경을 덮지 않는다(mergeField). */
export function recurringPlanBody(
  credit: CreditPlanSettings,
  plan: { value: number | null; auto: boolean; period: LimitPeriod; date: string },
): CreditPlanSaveBody {
  const monthly = !plan.auto || plan.period === "month";
  return {
    revision: credit.plan.revision,
    note: credit.plan.note,
    recurring_topup: plan.value,
    recurring_auto: plan.auto,
    ...(plan.auto ? { recurring_period: plan.period, recurring_anchor: plan.date } : {}),
    ...(monthly ? { topup_day: Number(plan.date.slice(8, 10)) } : {}),
  };
}

/** 추가 크레딧 기록 하나를 고치거나(patch) 지운다(null). 달력의 끌기(날짜)·정보 창(크레딧·메모·삭제)이 쓴다.
 *  topups 는 전체 교체라 나머지 기록도 그대로 싣고, note(플랜 메모)도 늘 싣는다 — 빼면 서버가 지운다. */
export function topupPatchBody(
  credit: CreditPlanSettings,
  topupId: string,
  patch: { day?: string; credits?: number; note?: string | null } | null,
): CreditPlanSaveBody {
  if (!credit.topups.some((t) => t.id === topupId)) throw new Error("추가 크레딧 기록을 찾지 못했습니다. 새로고침 뒤 다시 해 주세요.");
  return {
    revision: credit.plan.revision,
    note: credit.plan.note,
    topups: credit.topups
      .filter((t) => patch !== null || t.id !== topupId)
      .map((t) => {
        const next = t.id === topupId && patch ? { ...t, ...patch } : t;
        return { id: next.id, day: next.day, credits: next.credits, note: next.note ?? null };
      }),
  };
}

/** 충전 방식 한 줄 — 메인 표·서브 화면이 같은 규칙으로 쓴다. 예: '자동 · 매월 1일' · '자동 · 매주 목요일' · '자동 · 매일' · '수동'. */
export function scheduleLabel(sub: Pick<ConsoleSub, "recurring_auto" | "recurring_period" | "recurring_anchor" | "topup_day">): string {
  if (!sub.recurring_auto) return "수동";
  if (sub.recurring_period === "day") return "자동 · 매일";
  if (sub.recurring_period === "week" && sub.recurring_anchor) {
    return `자동 · 매주 ${"일월화수목금토"[new Date(`${sub.recurring_anchor}T00:00:00`).getDay()]}요일`;
  }
  return `자동 · 매월 ${sub.topup_day}일`;
}

export const PERIOD_UNIT: Record<LimitPeriod, string> = { month: "월", week: "주", day: "일" };

/** 대시보드·관리 표의 서브스페이스 크레딧(설계 §13) — 서버 `console_limit`. 서브스페이스 전환 뒤 연결된 서브의 프로젝트에만 온다. */
export interface ConsoleLimit {
  workspace_id: string;
  workspace_name: string | null;
  credits: number | null; // 정기 크레딧(한 번 충전액) — 없으면 null
  period: LimitPeriod;
  auto: boolean;
  anchor?: string | null; // 주 = 그 요일 · 일 = 그날부터(§14)
  topup_day?: number; // 월 충전 기준일(§14)
  cycle_start: string;
  cycle_end: string;
  topups_cycle: number; // 이번 주기 추가 크레딧 합
  shared_projects: number; // 같은 서브의 활성 프로젝트 수(워크스페이스 단위라 함께 쓴다)
  // 관리 표 한 워크스페이스용 상세(§16) — `/member-table` 최상위에만 온다(대시보드 줄엔 없음)
  balance?: number | null;
  balance_seen_at?: string | null;
  next_topup_day?: string | null;
  topups_count?: number;
  used_cycle?: number;
  unknown_cycle?: number;
}

// 서브 상태 → 그 서브 프로젝트의 기획 상태(active/hold/done). 완료는 보관도 한다(Jay 2026-09-29).
export const PLAN_STATUS: Record<ConsoleStatus, string> = { active: "active", inactive: "hold", done: "done" };
/** 기획 상태 → 콘솔 상태(관리 표 상태 칸의 현재 값). */
export function consoleStatusOf(planningStatus: string | null | undefined): ConsoleStatus {
  return planningStatus === "hold" ? "inactive" : planningStatus === "done" ? "done" : "active";
}

/** 서브 상태를 그 서브 프로젝트에 반영 — 서브스페이스·관리 표가 **같은 코드**로 부른다(§16). 프로젝트 관리 창과 같은 API 를 같은 순서로(§12):
 *  콘솔 상태 → 보관(`updateProject` — 이 PC 의 Assets 감시 해제·감사·서버 위임이 관리 창과 같다) → 기획 상태(`savePlanning`, 읽은 기획 전체 + 409 병합).
 *  원자적이지 않다 — 각 단계가 멱등이라 같은 상태를 다시 고르면 수렴한다. */
export async function syncConsoleStatus(
  subId: string,
  projects: { id: string; archived: boolean }[],
  status: ConsoleStatus,
  deps: {
    consoleSetStatus: (workspaceId: string, status: ConsoleStatus) => Promise<unknown>;
    updateProject: (id: string, patch: { archived: boolean }) => Promise<unknown>;
    getPlanning: (pid: string) => Promise<Planning>;
    savePlanning: (pid: string, baseline: Planning, body: Planning) => Promise<unknown>;
  },
): Promise<void> {
  await deps.consoleSetStatus(subId, status);
  for (const project of projects) {
    const archived = status === "done";
    if (project.archived !== archived) await deps.updateProject(project.id, { archived });
    const baseline = await deps.getPlanning(project.id);
    if ((baseline.status || "active") !== PLAN_STATUS[status]) {
      await deps.savePlanning(project.id, baseline, { ...baseline, status: PLAN_STATUS[status] });
    }
  }
}

/** today 이후(오늘 포함) 첫 '매월 day 일' — 없는 날짜는 그 달 마지막 날. */
export function nextMonthDay(today: string, day: number): string {
  const [y, m] = today.split("-").map(Number);
  const make = (yy: number, mm: number) =>
    `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(day, new Date(yy, mm, 0).getDate())).padStart(2, "0")}`;
  const here = make(y, m);
  return here >= today ? here : m === 12 ? make(y + 1, 1) : make(y, m + 1);
}

type RecurringPlan = CreditPlanSettings["plan"];

/** 날짜 문자열에 n 일 더하기(로컬 달력). */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 다음 자동 충전일(관리 표 정기 행 Next) — 서버 `_occurrences` 첫 값(= 서브스페이스 `next_topup_day`)과 같은 규칙:
 *  **이번 주기가 끝난 다음 주기의 시작**이라 오늘이 충전일이어도 오늘은 아니다(월 = 다음 충전일 · 주 = 다음 같은 요일 · 일 = 내일,
 *  기준 날짜가 더 뒤면 그날). 수동이거나 주 기준 날짜가 없으면 null. 구서버의 빈 방식·주기 = 자동·월. */
export function nextRecurringDay(plan: RecurringPlan, today: string): string | null {
  if (plan.recurring_auto === false) return null;
  const period = plan.recurring_period ?? "month";
  const anchor = plan.recurring_anchor;
  if (period === "month") {
    let day = nextMonthDay(addDays(today, 1), plan.topup_day ?? 1);
    for (let i = 0; anchor && day < anchor && i < 240; i++) day = nextMonthDay(addDays(day, 1), plan.topup_day ?? 1); // 기준 날짜 전 충전은 없다(서버와 같게)
    return day;
  }
  if (period === "day") return anchor && anchor > today ? anchor : addDays(today, 1);
  if (!anchor) return null;
  if (anchor > today) return anchor;
  const gap = (new Date(`${anchor}T00:00:00`).getDay() - new Date(`${today}T00:00:00`).getDay() + 7) % 7;
  return addDays(today, gap || 7);
}

/** 관리 표 정기 행 한 칸 저장 본문(§16 합의 1) — 서브스페이스 CreditDialog 와 같은 `recurringPlanBody`, 같은 날짜 규칙:
 *  날짜(`day`=월 충전일 · `date`=주/일 기준 날짜)를 만지면 그 값, 안 만지면 **지금 설정의 다음 충전일**(오늘 이후, 없으면 오늘)
 *  — 서브스페이스의 `startDate` 와 같다(주기만 바꿔도 과거 기준 날짜로 즉시 충전되지 않게, Codex 코드 리뷰). 구서버의 빈 방식·주기 = 자동·월. */
export function recurringEditBody(
  credit: CreditPlanSettings,
  today: string,
  patch: { value?: number | null; auto?: boolean; period?: LimitPeriod; day?: number; date?: string },
): CreditPlanSaveBody {
  const plan = credit.plan;
  const auto = patch.auto ?? plan.recurring_auto ?? true;
  const period = patch.period ?? plan.recurring_period ?? "month";
  const monthly = !auto || period === "month";
  const day = patch.day ?? plan.topup_day ?? 1;
  const date = patch.date ?? (patch.day !== undefined ? nextMonthDay(today, day) : nextRecurringDay(plan, today) ?? today);
  const body = recurringPlanBody(credit, { value: patch.value !== undefined ? patch.value : plan.recurring_topup ?? null, auto, period, date });
  if (patch.value === undefined && plan.recurring_topup === undefined) delete body.recurring_topup; // 구서버 — 모르는 금액을 비우지 않게
  if (monthly) body.topup_day = day; // 달 끝 보정(31→30)이 충전일을 바꾸지 않게
  return body;
}

/** 관리 표 정기 행의 방식 글자 — 서브스페이스와 같은 `scheduleLabel`(§14). */
export function consoleSchedule(limit: ConsoleLimit): string {
  return scheduleLabel({ recurring_auto: limit.auto, recurring_period: limit.period, recurring_anchor: limit.anchor ?? null, topup_day: limit.topup_day ?? 1 });
}

/** 이번 주기 계획 = 정기 + 이번 주기 추가. 0 이면 '없음'(Jay 결정 — null). 툴팁은 출처·주기·공유를 밝힌다. */
export function consoleLimitView(limit: ConsoleLimit): { total: number | null; title: string } {
  const total = (limit.credits ?? 0) + limit.topups_cycle;
  const shared = limit.shared_projects > 1 ? ` · 프로젝트 ${limit.shared_projects}개가 함께 씀` : "";
  const head = `서브스페이스 · 서브 ${limit.workspace_name ?? limit.workspace_id}`;
  if (!total) return { total: null, title: `${head} · 정기 크레딧 없음${shared}` };
  return {
    total,
    title: `${head} · 이번 주기 계획 ${limit.cycle_start} ~ ${limit.cycle_end} · 정기(${PERIOD_UNIT[limit.period]}) `
      + `${formatCredits(limit.credits ?? 0)} + 추가 ${formatCredits(limit.topups_cycle)} · 누적 사용과 기준이 다름${shared}`,
  };
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
