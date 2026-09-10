// 크레딧 풀 · 그룹 한도 · 잔액 추이 — 타입과 순수 계산(대시보드 카드·프로젝트 설정 창 공용).
// 힉스필드가 한도를 강제하고 우리는 보여주기·경고만 한다(Jay 2026-09-10). 서버 계약은
// backend/app/repo/manage_credit_plan.py — 남은 양(이월 포함)·미상 건수는 서버가 계산해 준다.

export interface BalancePoint {
  day: string; // YYYY-MM-DD (서버 KST)
  credits: number;
}

export interface CreditPool {
  monthly_topup: number | null; // 파생값 — 이 워크스페이스 프로젝트들의 예산 한도(매월) 합
  note: string | null;
  used_month: number; // 팀 기록 장부(팩트) 이번 달 합
  unknown_month: number; // 크레딧을 모르는 건 수(0원 아님)
  balance: number | null; // 힉스필드 보고 잔액(마지막 동기화)
  balance_seen_at: string | null;
  month_start_balance: number | null; // 이번 달 첫 관측값(계산값 아님)
  month_start_day: string | null;
  topups_month: { count: number; credits: number }; // 이번 달 긴급 충전 합·횟수
}

export interface CreditTopup {
  id: string;
  day: string; // YYYY-MM-DD
  credits: number;
  note: string | null;
}

export type LimitPeriod = "day" | "week" | "month"; // month 만 이월, day/week 는 그 기간 안에서만

export function periodSuffix(period: LimitPeriod | undefined): string {
  return period === "day" ? "/일" : period === "week" ? "/주" : "/월";
}

export function periodUsageLabel(period: LimitPeriod | undefined): string {
  return period === "day" ? "오늘" : period === "week" ? "이번 주" : "이번 달";
}

export interface CreditGroupSummary {
  id: string;
  name: string;
  monthly_limit: number | null; // null = ∞
  limit_period?: LimitPeriod; // 구서버는 없음(=month)
  used_period?: number; // 한도 주기 안 사용(month 면 used_month 와 같음)
  unknown_period?: number;
  my_used_period?: number; // 멤버 뷰만
  my_unknown_period?: number;
  base_start?: string; // 재기준일(YYYY-MM-DD) — 매니저 설정 창만
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
  today?: string;
  configured: boolean;
  revision?: number; // 매니저만 — 대시보드에서 '추정 → 힉스필드 값 맞추기' 저장에 쓴다
  pool?: CreditPool; // 매니저만
  groups?: CreditGroupSummary[]; // 매니저만
  unassigned?: CreditUnassigned; // 매니저만
  topups?: CreditTopup[]; // 매니저만 · 최근 3개월 긴급 충전(최근순)
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
  topups: CreditTopup[];
}

export interface CreditPlanSaveBody {
  revision: number;
  note: string | null;
  groups?: { id?: string; name: string; monthly_limit: number | null; limit_period: LimitPeriod; remaining_override?: number | null }[]; // 없으면 그룹·배정 그대로
  members?: { email: string; group_id: string | null }[];
  topups?: { id?: string; day: string; credits: number; note: string | null }[]; // 전체 교체 · 없으면 그대로
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

/** 유한한 **매월** 한도의 합(∞·매일·매주 그룹 제외). 충전액(월)과 비교해 "한도 합이 충전을 넘음" 경고에 쓴다. */
export function limitTotal(groups: { monthly_limit: number | null; limit_period?: LimitPeriod }[]): number {
  return groups.reduce(
    (sum, group) => sum + ((group.limit_period ?? "month") === "month" ? group.monthly_limit ?? 0 : 0),
    0,
  );
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

// ── 숫자 입력(천 단위 구분) ────────────────────────────────────────────────
/** 입력 문자열에서 숫자만 남긴다("20,000" → "20000"). 초안은 항상 이 형태로 들고 있다. */
export function stripThousands(text: string): string {
  return text.replace(/[^\d]/g, "");
}

/** 숫자 문자열을 천 단위 구분으로("20000" → "20,000"). 빈 값은 빈 문자열. */
export function formatThousands(digits: string): string {
  const clean = stripThousands(digits);
  return clean ? Number(clean).toLocaleString("en-US") : "";
}

/** 새 그룹에 클라이언트가 미리 붙이는 id(uuid hex 32자) — 같은 저장에 멤버 배정을 실을 수 있게. 서버가 형식·소유를 검사한다. */
export function newGroupId(): string {
  const g = globalThis.crypto as Crypto | undefined;
  if (g?.randomUUID) return g.randomUUID().replace(/-/g, "");
  let out = "";
  for (let i = 0; i < 32; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

// ── 설정 창 초안 ────────────────────────────────────────────────────────────
export interface DraftGroup {
  id: string; // 기존 그룹은 서버 id, 새 그룹은 newGroupId()
  isNew: boolean;
  name: string;
  limitInput: string; // 숫자만 · 빈 값 + unlimited=false 는 오류
  limitPeriod: LimitPeriod;
  unlimited: boolean;
  remaining: number | null; // 서버가 준 현재 남은 양(표시용)
  usedMonth: number;
  memberCount: number; // 서버 기준(표시용) — 초안의 실제 인원은 members 로 센다
}

export interface DraftTopup {
  id: string; // 기존은 서버 id, 새 기록은 newGroupId()
  day: string; // YYYY-MM-DD
  creditsInput: string; // 숫자만
  note: string;
}

export interface CreditPlanDraft {
  loadedFor: string; // workspaceId
  revision: number;
  monthlyTopup: number | null; // 파생값(예산 한도 매월 합) — 표시만
  note: string;
  groups: DraftGroup[];
  members: CreditPlanMember[];
  topups: DraftTopup[];
  dirty: boolean;
}

export function draftFromSettings(settings: CreditPlanSettings): CreditPlanDraft {
  return {
    loadedFor: settings.workspace_id,
    revision: settings.plan.revision,
    monthlyTopup: settings.plan.monthly_topup,
    note: settings.plan.note || "",
    topups: (settings.topups || []).map((topup) => ({
      id: topup.id, day: topup.day, creditsInput: String(topup.credits), note: topup.note || "",
    })),
    groups: settings.groups.map((group) => ({
      id: group.id,
      isNew: false,
      name: group.name,
      limitInput: group.monthly_limit == null ? "" : String(group.monthly_limit),
      limitPeriod: group.limit_period ?? "month",
      unlimited: group.monthly_limit == null,
      remaining: group.remaining,
      usedMonth: group.used_month,
      memberCount: group.member_count,
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

/** 긴급 충전 한 줄 검사 — 오류 문구 또는 null. */
export function validateTopup(topup: DraftTopup): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(topup.day)) return "긴급 충전 날짜를 골라 주세요.";
  if (!parseNonNegative(topup.creditsInput)) return `긴급 충전(${topup.day}): 크레딧을 1 이상으로 입력하세요.`;
  return null;
}

/** 초안 검사 — 오류 문구 또는 null. */
export function validateDraft(draft: CreditPlanDraft): string | null {
  for (const topup of draft.topups) {
    const error = validateTopup(topup);
    if (error) return error;
  }
  const names = new Set<string>();
  for (const group of draft.groups) {
    const name = group.name.trim();
    if (!name) return "그룹 이름을 입력하세요.";
    if (names.has(name)) return `그룹 이름이 겹칩니다: ${name}`;
    names.add(name);
    if (!group.unlimited) {
      const limit = parseNonNegative(group.limitInput);
      if (limit === undefined || limit === null) return `${name}: 한도를 0 이상의 정수로 입력하거나 '한도 없음'을 켜세요.`;
    }
  }
  return null;
}

/** 대시보드 '추정 → 힉스필드 값 맞추기' 저장 본문 — 그룹 목록은 그대로(배정은 안 보내 서버가 유지), 한 그룹만 남은 양을 R 로.
 *  view 는 매니저 응답(revision·groups 포함)이어야 한다. */
export function overrideBody(view: CreditPlanView, groupId: string, remaining: number): CreditPlanSaveBody {
  return {
    revision: view.revision ?? 0,
    note: null,
    groups: (view.groups || []).map((group) => ({
      id: group.id,
      name: group.name,
      monthly_limit: group.monthly_limit,
      limit_period: group.limit_period ?? "month",
      remaining_override: group.id === groupId ? remaining : null,
    })),
  };
}

/** 초안 → 저장 본문. 새 그룹도 클라이언트 id 를 그대로 보내므로 멤버 배정을 같은 저장에 싣는다.
 *  초안에서 사라진 그룹을 가리키는 배정은 해제(null)로 보낸다. */
export function draftToBody(draft: CreditPlanDraft): CreditPlanSaveBody {
  const validIds = new Set(draft.groups.map((group) => group.id));
  return {
    revision: draft.revision,
    note: draft.note.trim() || null,
    topups: draft.topups.map((topup) => ({
      id: topup.id,
      day: topup.day,
      credits: parseNonNegative(topup.creditsInput) ?? 0,
      note: topup.note.trim() || null,
    })),
    groups: draft.groups.map((group) => ({
      id: group.id,
      name: group.name.trim(),
      monthly_limit: group.unlimited ? null : parseNonNegative(group.limitInput) ?? null,
      limit_period: group.limitPeriod,
    })),
    members: draft.members.map((member) => ({
      email: member.email,
      group_id: member.group_id !== null && validIds.has(member.group_id) ? member.group_id : null,
    })),
  };
}

/** 긴급 충전 줄 단위 저장 본문 — 그룹·배정은 보내지 않아(서버가 그대로 둠) 편집 중인 그룹 초안을 건드리지 않는다. */
export function topupsOnlyBody(draft: CreditPlanDraft, topups: DraftTopup[]): CreditPlanSaveBody {
  return {
    revision: draft.revision,
    note: draft.note.trim() || null,
    topups: topups.map((topup) => ({
      id: topup.id,
      day: topup.day,
      credits: parseNonNegative(topup.creditsInput) ?? 0,
      note: topup.note.trim() || null,
    })),
  };
}

/** 줄 단위 저장 응답을 초안에 반영 — 그룹·배정 초안은 그대로, revision·충전 기록·월 충전만 서버값으로. */
export function mergeTopupsFromServer(draft: CreditPlanDraft, settings: CreditPlanSettings): CreditPlanDraft {
  return {
    ...draft,
    revision: settings.plan.revision,
    monthlyTopup: settings.plan.monthly_topup,
    topups: (settings.topups || []).map((topup) => ({
      id: topup.id, day: topup.day, creditsInput: String(topup.credits), note: topup.note || "",
    })),
  };
}

/** 초안의 그룹별 실제 인원(초안 members 기준). */
export function draftMemberCount(draft: CreditPlanDraft, groupId: string): number {
  return draft.members.filter((member) => member.group_id === groupId).length;
}
