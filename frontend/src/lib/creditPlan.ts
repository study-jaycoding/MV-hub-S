// 크레딧 풀 · 그룹 한도 · 잔액 추이 — 타입과 순수 계산(대시보드 카드·프로젝트 설정 창 공용).
// 힉스필드가 한도를 강제하고 우리는 보여주기·경고만 한다(Jay 2026-09-10). 서버 계약은
// backend/app/repo/manage_credit_plan.py — 남은 양(이월 포함)·미상 건수는 서버가 계산해 준다.

export interface BalancePoint {
  day: string; // YYYY-MM-DD (서버 KST)
  credits: number;
}

export interface CreditPool {
  monthly_topup: number | null; // 설정값(손 입력)
  note: string | null;
  used_month: number; // 팀 기록 장부(팩트) 이번 달 합
  unknown_month: number; // 크레딧을 모르는 건 수(0원 아님)
  balance: number | null; // 힉스필드 보고 잔액(마지막 동기화)
  balance_seen_at: string | null;
  month_start_balance: number | null; // 이번 달 첫 관측값(계산값 아님)
  month_start_day: string | null;
}

export interface CreditGroupSummary {
  id: string;
  name: string;
  monthly_limit: number | null; // null = ∞
  base_month?: string;
  base_balance?: number;
  member_count: number;
  used_month: number;
  unknown_month: number;
  remaining: number | null; // 이월 포함 · ∞ 면 null
  unknown_since_base: number;
  estimated: boolean; // 미상 건이 섞여 추정치
  my_used_month?: number; // 멤버 뷰만
  my_unknown_month?: number;
}

export interface CreditUnassigned {
  member_count: number;
  used_month: number;
  unknown_month: number;
}

export interface CreditPlanView {
  month: string;
  configured: boolean;
  pool?: CreditPool; // 매니저만
  groups?: CreditGroupSummary[]; // 매니저만
  unassigned?: CreditUnassigned; // 매니저만
  history?: BalancePoint[]; // 매니저만 · 최근 60일
  my_group?: CreditGroupSummary | null; // 멤버만(null=배정 전)
}

export interface CreditPlanMember {
  email: string;
  name: string;
  workspace_role: string | null;
  is_available: boolean;
  group_id: string | null;
}

export interface CreditPlanSettings {
  workspace_id: string;
  month: string;
  plan: { monthly_topup: number | null; note: string | null; revision: number; updated_at: string | null };
  groups: CreditGroupSummary[];
  members: CreditPlanMember[];
}

export interface CreditPlanSaveBody {
  revision: number;
  monthly_topup: number | null;
  note: string | null;
  groups: { id?: string; name: string; monthly_limit: number | null; remaining_override?: number | null }[];
  members: { email: string; group_id: string | null }[];
}

// ── 표시 판정 ──────────────────────────────────────────────────────────────
export type LimitTone = "none" | "ok" | "warn" | "bad";

/** 남은 양 기준 경고색 — 이월이 있으면 '이번 달 사용/한도' 100% 가 소진이 아니라서(코덱스 P2) 남은 양으로 판정한다.
 *  bad = 다 씀(0 이하), warn = 한도의 20% 이하, ok = 그 외, none = ∞. */
export function remainingTone(remaining: number | null, limit: number | null): LimitTone {
  if (limit == null || remaining == null) return "none";
  if (remaining <= 0) return "bad";
  if (remaining <= limit * 0.2) return "warn";
  return "ok";
}

/** 이번 달 사용 / 월 한도(%). 한도 없음·0 이면 null. */
export function usagePercent(used: number, limit: number | null): number | null {
  if (!limit || limit <= 0) return null;
  return Math.round((used / limit) * 100);
}

/** 유한한 월 한도의 합(∞ 그룹 제외). 충전액과 비교해 "한도 합이 충전을 넘음" 경고에 쓴다. */
export function limitTotal(groups: { monthly_limit: number | null }[]): number {
  return groups.reduce((sum, group) => sum + (group.monthly_limit ?? 0), 0);
}

// ── 잔액 추이 ──────────────────────────────────────────────────────────────
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return date.toISOString().slice(0, 10);
}

export function dayDiff(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** 관측 사이에 잔액이 늘어난 지점 = 충전(관측된 계단). 설정값이 아니라 실제 관측으로만 그린다(코덱스 P2). */
export function topupSteps(history: BalancePoint[]): { day: string; amount: number }[] {
  const steps: { day: string; amount: number }[] = [];
  for (let i = 1; i < history.length; i += 1) {
    const delta = history[i].credits - history[i - 1].credits;
    if (delta > 0) steps.push({ day: history[i].day, amount: delta });
  }
  return steps;
}

export interface Depletion {
  perDay: number; // 최근 소진 속도(크레딧/일)
  daysLeft: number;
  depleteDay: string;
}

export function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** 최근 lookback 일의 관측으로 하루 소진 속도를 재고, 그 속도면 언제 바닥나는지. 충전(증가) 구간은 소진에서 뺀다.
 *  관측 3점 미만·소진 없음·관측 공백이 lookback 을 넘으면 null(코덱스 P2 — 공백·충전 처리). 마지막 관측이 오늘 기준
 *  lookback 일보다 오래됐으면(보고가 끊김) 예측하지 않는다. 1년 넘게 남으면 null. */
export function projectDepletion(history: BalancePoint[], lookbackDays = 7, today = todayLocal()): Depletion | null {
  if (history.length < 3) return null;
  const last = history[history.length - 1];
  if (dayDiff(last.day, today) > lookbackDays) return null;
  const window = history.filter((point) => dayDiff(point.day, last.day) <= lookbackDays);
  if (window.length < 3) return null;
  let spent = 0;
  for (let i = 1; i < window.length; i += 1) {
    const delta = window[i - 1].credits - window[i].credits;
    if (delta > 0) spent += delta;
  }
  const span = dayDiff(window[0].day, last.day);
  if (span <= 0 || spent <= 0) return null;
  const perDay = spent / span;
  const daysLeft = last.credits / perDay;
  if (!Number.isFinite(daysLeft) || daysLeft > 365) return null;
  return { perDay, daysLeft, depleteDay: addDays(last.day, Math.ceil(daysLeft)) };
}

/** 차트 세로축 최대값 — 값보다 살짝 큰 '깔끔한' 수. */
export function niceCeil(value: number): number {
  if (value <= 0) return 1000;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const unit = magnitude / 2;
  return Math.ceil((value * 1.05) / unit) * unit;
}

// ── 설정 창 초안 ────────────────────────────────────────────────────────────
export interface DraftGroup {
  id?: string;
  name: string;
  limitInput: string; // 빈 값 + unlimited=false 는 오류
  unlimited: boolean;
  overrideInput: string; // 지금 남은 양 보정(비우면 서버 계산 유지)
  remaining: number | null; // 서버가 준 현재 남은 양(표시용)
  usedMonth: number;
}

export interface CreditPlanDraft {
  loadedFor: string; // workspaceId
  revision: number;
  topupInput: string;
  note: string;
  groups: DraftGroup[];
  members: CreditPlanMember[];
  dirty: boolean;
}

export function draftFromSettings(settings: CreditPlanSettings): CreditPlanDraft {
  return {
    loadedFor: settings.workspace_id,
    revision: settings.plan.revision,
    topupInput: settings.plan.monthly_topup == null ? "" : String(settings.plan.monthly_topup),
    note: settings.plan.note || "",
    groups: settings.groups.map((group) => ({
      id: group.id,
      name: group.name,
      limitInput: group.monthly_limit == null ? "" : String(group.monthly_limit),
      unlimited: group.monthly_limit == null,
      overrideInput: "",
      remaining: group.remaining,
      usedMonth: group.used_month,
    })),
    members: settings.members.map((member) => ({ ...member })),
    dirty: false,
  };
}

function parseNonNegative(input: string): number | null | undefined {
  const text = input.trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

/** 초안 검사 — 오류 문구 또는 null. */
export function validateDraft(draft: CreditPlanDraft): string | null {
  if (parseNonNegative(draft.topupInput) === undefined) return "월 충전은 0 이상의 정수로 입력하세요.";
  const names = new Set<string>();
  for (const group of draft.groups) {
    const name = group.name.trim();
    if (!name) return "그룹 이름을 입력하세요.";
    if (names.has(name)) return `그룹 이름이 겹칩니다: ${name}`;
    names.add(name);
    if (!group.unlimited) {
      const limit = parseNonNegative(group.limitInput);
      if (limit === undefined || limit === null) return `${name}: 월 한도를 0 이상의 정수로 입력하거나 ∞ 를 켜세요.`;
    }
    if (group.overrideInput.trim() && !Number.isInteger(Number(group.overrideInput))) {
      return `${name}: 남은 양 보정은 정수로 입력하세요.`;
    }
  }
  return null;
}

/** 초안 → 저장 본문. 그룹이 아직 id 가 없으면(새 그룹) 멤버 배정은 이름 기준 임시 키 `new:<index>` 로 보낸다 —
 *  서버가 같은 순서로 id 를 발급하지 않으므로 새 그룹 배정은 저장 뒤 한 번 더 저장해야 한다(설정 창이 안내). */
export function draftToBody(draft: CreditPlanDraft): CreditPlanSaveBody {
  const validIds = new Set(draft.groups.map((group) => group.id).filter((id): id is string => Boolean(id)));
  return {
    revision: draft.revision,
    monthly_topup: parseNonNegative(draft.topupInput) ?? null,
    note: draft.note.trim() || null,
    groups: draft.groups.map((group) => ({
      id: group.id,
      name: group.name.trim(),
      monthly_limit: group.unlimited ? null : parseNonNegative(group.limitInput) ?? null,
      remaining_override: group.overrideInput.trim() ? Number(group.overrideInput) : null,
    })),
    members: draft.members
      .filter((member) => member.group_id === null || validIds.has(member.group_id))
      .map((member) => ({ email: member.email, group_id: member.group_id })),
  };
}
