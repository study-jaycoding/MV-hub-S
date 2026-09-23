import { formatCredits } from "./formatCredits";

// 크레딧 풀 · 그룹 한도 · 잔액 추이 — 타입과 순수 계산(대시보드 카드·프로젝트 설정 창 공용).
// 힉스필드가 한도를 강제하고 우리는 보여주기·경고만 한다(Jay 2026-09-10). 서버 계약은
// backend/app/repo/manage_credit_plan.py — 남은 양(이월 포함)·미상 건수는 서버가 계산해 준다.

export interface BalancePoint {
  day: string; // YYYY-MM-DD (서버 KST)
  credits: number;
}

export interface CreditPool {
  monthly_topup: number | null; // 파생값 — 이 워크스페이스 프로젝트들의 예산 한도(매월) 합
  topup_day?: number; // 매월 충전 기준일(1~31, 없는 날짜는 월말) — 달 경계
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

export type LimitPeriod = "day" | "week" | "month"; // 세 주기 모두 이월된다(안 쓴 몫이 다음 기간으로 넘어간다)

export const DEFAULT_GROUP_COLOR = "#64748b";
export const GROUP_COLOR_PALETTE = [
  "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6", "#6366f1",
  "#a855f7", "#ec4899", "#ef4444", "#f97316", "#f59e0b", "#94a3b8",
] as const;
export const TOPUP_DAY_OPTIONS = Array.from({ length: 31 }, (_, index) => index + 1);

export function groupColor(value: string | null | undefined): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : DEFAULT_GROUP_COLOR;
}

export function periodSuffix(period: LimitPeriod | undefined): string {
  return period === "day" ? "/일" : period === "week" ? "/주" : "/월";
}

export function periodUsageLabel(period: LimitPeriod | undefined): string {
  return period === "day" ? "오늘" : period === "week" ? "이번 주" : "이번 달";
}

/** 'YYYY-MM-DD' → 'M/D'. 충전 달 범위 표시용. */
export function shortDay(day: string | undefined): string {
  if (!day) return "";
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/** 이번 충전 달 범위 문구 — 기준일 1이면 "9월", 아니면 "9/15 ~ 10/14". */
export function cycleLabel(view: { month: string; cycle_start?: string; cycle_end?: string }, topupDay?: number): string {
  if (!view.cycle_start || !view.cycle_end || (topupDay ?? 1) === 1) return `${Number(view.month.split("-")[1])}월`;
  return `${shortDay(view.cycle_start)} ~ ${shortDay(view.cycle_end)}`;
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
  allowed_models?: string[]; // 그룹이 쓸 수 있는 모델(job_type, **빈 목록=제한 없음**) — 구서버는 없음
  color?: string | null; // 그룹 표시색(#rrggbb) · 구서버/NULL은 기본색
  // 사람별 몫 나누기(2026-09-23) — 구서버는 없음
  quota_fixed?: number; // 손으로 덮어쓴 몫의 합
  quota_auto?: number | null; // 나머지 사람 한 명 몫(null = 나눌 수 없음: 무제한이거나 자동 인원 0명)
  quota_over?: boolean; // 덮어쓴 합이 그룹 한도를 넘음(경고만)
  // 멤버 뷰만 — 내 몫은 **이번 기간** 기준이고, 그룹 이월은 group_carryover 로 따로 온다
  my_quota?: number | null;
  my_quota_source?: "manual" | "auto" | "none";
  my_remaining?: number | null; // 내 몫 − 이번 기간 내 사용(음수 = 초과)
  group_carryover?: number; // 지난 기간에서 그룹으로 넘어온 여유분
}

/** GET /api/manage/credit-plan/my-models — 본인 그룹이 쓸 수 있는 모델(생성 창·캔버스 모델 노드가 거르는 근거). */
export interface MyModelPolicy {
  workspace_id: string;
  group_id: string | null; // null = 배정 없음(제한 없음)
  group_name: string | null;
  allowed_models: string[]; // 빈 목록 = 제한 없음(전부 사용)
  revision: number;
}

export interface CreditUnassigned {
  member_count: number;
  used_month: number;
  unknown_month: number;
}

export interface CreditPlanView {
  month: string;
  today?: string;
  cycle_start?: string; // 이번 충전 달 범위(기준일 기준) — 예: 09-15 ~ 10-14
  cycle_end?: string;
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
  // 사람별 몫(2026-09-23) — 구서버는 없음
  quota?: number | null; // 손으로 덮어쓴 값(null = 자동)
  quota_effective?: number | null; // 실제 적용되는 몫(자동이면 계산값)
  quota_source?: "manual" | "auto" | "none";
  used_period?: number; // 이번 기간(그룹 주기) 내 사용
  unknown_period?: number;
  remaining?: number | null; // 몫 − 사용
}

export interface CreditPlanSettings {
  workspace_id: string;
  month: string;
  today?: string;
  cycle_start?: string;
  cycle_end?: string;
  plan: {
    monthly_topup: number | null; // 손 입력이 있으면 그 값, 없으면 프로젝트 '매월 예산' 합에서 파생
    monthly_topup_source?: "manual" | "derived";
    recurring_topup?: number | null; // 손 입력 원본(null = 파생)
    derived_topup?: number | null; // 손 입력을 지우면 돌아갈 값
    topup_day?: number;
    note: string | null;
    revision: number;
    updated_at: string | null;
  };
  groups: CreditGroupSummary[];
  members: CreditPlanMember[];
  topups: CreditTopup[];
}

export interface CreditPlanSaveBody {
  revision: number;
  note: string | null;
  topup_day?: number; // 매월 충전 기준일 · 없으면 그대로
  // allowed_models/color: 키를 빼면 서버가 기존값을 유지한다(구버전 앱·'추정' 맞추기가 설정을 지우지 않게).
  groups?: { id?: string; name: string; monthly_limit: number | null; limit_period: LimitPeriod; remaining_override?: number | null; allowed_models?: string[]; color?: string | null }[]; // 없으면그룹·배정 그대로
  // quota: 키를 빼면 서버가 기존 몫을 유지하고, null 을 보내야 자동으로 돌아간다(구버전 저장이 몫을 지우지 않게).
  //  group_id 도 같은 규칙이라 '몫만 바꾸기'는 group_id 키 없이 보낸다.
  members?: { email: string; group_id?: string | null; quota?: number | null }[];
  recurring_topup?: number | null; // 정기 충전 손 입력 · 키 없음=그대로 · null=파생으로
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

/** 자동으로 나눈 몫 표기 — 나누어떨어지지 않으면 `≈` 를 붙인다(33.333… 을 33.33 으로 보여 주므로).
 *  사람이 직접 정한 몫은 정확한 값이라 이 표기를 쓰지 않는다. */
export function autoShareLabel(value: number | null | undefined): string {
  if (value == null) return "—";
  const shown = formatCredits(value);
  return Number(shown.replace(/,/g, "")) === value ? shown : `≈${shown}`;
}

/** 소수를 허용하는 숫자 입력 정리 — **크레딧은 소수다**(−1.5·0.12·33.33). 사람별 몫·정기 충전 칸이 쓴다.
 *  점은 하나만 남기고(둘째 점부터는 버린다) 숫자 아닌 글자는 지운다. 그룹 한도·긴급 충전은 서버가 정수만
 *  받으므로 그쪽은 종전 `stripThousands` 를 그대로 쓴다. */
export function stripDecimal(text: string): string {
  const cleaned = text.replace(/[^\d.]/g, "");
  const [head, ...rest] = cleaned.split(".");
  return rest.length ? `${head}.${rest.join("")}` : head;
}

/** 소수 입력을 천 단위 구분으로 보여 준다("24491.5" → "24,491.5"). 입력 중인 끝점("12.")은 그대로 둔다. */
export function formatDecimal(value: string): string {
  const clean = stripDecimal(value);
  if (!clean) return "";
  const [head, tail] = clean.split(".");
  const intPart = head ? Number(head).toLocaleString("en-US") : "0";
  return tail === undefined ? intPart : `${intPart}.${tail}`;
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
  allowedModels: string[]; // 그룹이 쓸 수 있는 모델(job_type). 빈 배열=제한 없음. 앱이 모르는 id 도 그대로 보존한다
  color: string | null; // #rrggbb · null은 서버 기본색을 그대로 유지
}

export function newDraftGroup(): DraftGroup {
  const id = newGroupId();
  const paletteIndex = Number.parseInt(id.slice(-2), 16) % GROUP_COLOR_PALETTE.length;
  return {
    id, isNew: true, name: "", limitInput: "", limitPeriod: "month", unlimited: false,
    remaining: null, usedMonth: 0, memberCount: 0, allowedModels: [], color: GROUP_COLOR_PALETTE[paletteIndex],
  };
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
  topupDay: number; // 매월 충전 기준일(1~31, 없는 날짜는 월말)
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
    topupDay: settings.plan.topup_day ?? 1,
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
      allowedModels: [...(group.allowed_models ?? [])],
      color: group.color ?? null,
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

/** 대시보드 '추정 → 힉스필드 값 맞추기' 저장 본문 — 그룹 목록은 그대로(배정은 안 보내 서버가 유지), 한 그룹만 남은 양을
 *  사용 모델은 일부러 싣지 않는다 — 키가 없으면 서버가 기존값을 유지하므로, 오래된 대시보드 응답이 다른 매니저의 변경을 덮지 않는다.R 로.
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
    topup_day: draft.topupDay,
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
      // 설정 창은 항상 명시한다(빈 배열 = 제한 없음). 초안에 값이 없는 비정상 상태에서는 키를 빼
      // 서버가 기존값을 유지하게 한다 — 크래시도, 조용한 설정 해제도 없게.
      ...(Array.isArray(group.allowedModels) ? { allowed_models: [...group.allowedModels] } : {}),
      ...(group.color ? { color: group.color } : {}),
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

/** 줄 단위 저장 응답을 초안에 반영 — 그룹·배정 초안은 그대로, revision·충전 기록·월 충전·기준일만 서버값으로. */
export function mergeTopupsFromServer(draft: CreditPlanDraft, settings: CreditPlanSettings): CreditPlanDraft {
  return {
    ...draft,
    revision: settings.plan.revision,
    monthlyTopup: settings.plan.monthly_topup,
    topupDay: settings.plan.topup_day ?? draft.topupDay,
    topups: (settings.topups || []).map((topup) => ({
      id: topup.id, day: topup.day, creditsInput: String(topup.credits), note: topup.note || "",
    })),
  };
}

/** 초안의 그룹별 실제 인원(초안 members 기준). */
export function draftMemberCount(draft: CreditPlanDraft, groupId: string): number {
  return draft.members.filter((member) => member.group_id === groupId).length;
}
