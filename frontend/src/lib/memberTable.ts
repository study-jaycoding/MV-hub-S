// PM 대시보드 '관리 표' — 응답 모양과 저장 본문(설계: docs/MEMBER_TABLE_DESIGN.md).
// 표에는 자기만의 쓰기 API 가 없다 — 칸마다 기존 API 를 부른다.
import { stripThousands, type CreditPlanSaveBody, type CreditPlanSettings, type DraftGroup, type LimitPeriod } from "./creditPlan";
import type { Planning } from "../components/manage/types";
import type { ConsoleLimit } from "./workspaceConsole";

export interface MemberTableRow {
  email: string;
  name: string;
  status: string | null; // pending | approved | rejected · 계정이 없으면 null
  global_roles: string[];
  uid: string | null; // 실제 creator_uid — 없거나 합성(acct:)이면 null
  project_editable: boolean;
  project_lock?: "unlinked" | "uid_conflict" | null; // 프로젝트 칸이 잠긴 이유
  linked_accounts: number; // 같은 uid 에 묶인 계정 수 — 프로젝트 역할은 묶인 계정 전체에 적용된다
  workspace_role: string | null;
  is_available: boolean | null; // null = 워크스페이스를 고르지 않음
  last_seen_at: string | null;
  hf_plan: string | null;
  group_id: string | null;
  projects: Record<string, string[]>; // pid → 프로젝트 역할
  usage: { credits: number; count: number; unknown: number } | null;
}

export interface MemberTableGroup {
  id: string;
  name: string;
  monthly_limit: number | null; // 인당 한도(2026-09-29)
  limit_period?: LimitPeriod;
  remaining: number | null; // 몫 합계 − 이번 기간 사용(이월 없음)
  member_count: number;
  color?: string | null;
  used_period?: number | null; // 이번 기간 사용(서브스페이스 그룹 탭과 같은 값, §16) · 구서버는 없음
  unknown_period?: number | null;
  quota_total?: number | null; // 몫 합계 · null = ∞ 그룹
}

export interface MemberTableData {
  workspace_id: string | null;
  cycle_start: string | null;
  cycle_end: string | null;
  rows: MemberTableRow[];
  // console_managed = 서브스페이스 서브(상태·예산은 서브스페이스에서 — 늘 옴) · console_limit = 그 금액(크레딧을 볼 수 있을 때만)
  // archived = 보관 프로젝트(워크스페이스를 고르면 함께 옴 — 프로젝트 시트에만, §16) · 구서버는 없음(= 활성)
  projects: { id: string; name: string; workspace_id?: string | null; workspace_name?: string | null; archived?: boolean; planning?: Planning | null; console_managed?: boolean; console_limit?: ConsoleLimit | null }[];
  console_limit?: ConsoleLimit | null; // 고른 워크스페이스가 서브스페이스 서브면 그 크레딧(§14 크레딧 시트)
  groups: MemberTableGroup[];
  credit: CreditPlanSettings | null; // 그룹 저장에 쓰는 원문 — create_project 가 없으면 null
  caps: { account: boolean; credit: boolean; project_roles: boolean; planning?: boolean };
  console_subs?: string[] | null; // 서브스페이스 메인을 골랐을 때만 — 연결된 서브(서브스페이스 왼쪽 목록 순서). 크레딧 시트는 서브 표 합본
  main_balance?: { credits: number | null; seen_at: string | null } | null; // 크레딧 풀(메인 보고 잔액) · 크레딧 권한일 때만
}

/** 메인 크레딧 시트 합본의 서브 한 곳 — 그 서브의 관리 표 그대로(실패하면 table=null) */
export interface SubCreditTable { id: string; table: MemberTableData | null; error: string }

/** 크레딧 시트의 사람별 몫·사용 읽기 — 한 워크스페이스 표 기준(메인 합본은 서브 표마다 부른다, 같은 계산).
 *  ★서버가 몫 계약을 모르면(구서버) 저장해도 조용히 무시된다 — quotaSupported 로 칸을 잠근다(Codex 코드 리뷰).
 *  09-23 '÷ 인원' 서버도 quota_source 는 주므로, 인당 규칙 서버의 표식(그룹의 quota_total)까지 있어야 연다
 *  — 옛 서버의 몫·남은 몫을 인당 값처럼 보여 주지 않는다(Codex 설계 검토 2026-09-29). */
export function creditAccessors(table: Pick<MemberTableData, "credit">) {
  const quotaSupported = (table.credit?.members || []).some((member) => member.quota_source !== undefined)
    && (table.credit?.groups || []).every((group) => group.quota_total !== undefined);
  // 사람별 몫·남은 몫은 크레딧 설정 원문에 있다(이메일 기준). 구서버면 보이지 않는다(undefined).
  const creditMembers = new Map((table.credit?.members || []).map((member) => [member.email, member]));
  const quotaOf = (email: string) => (quotaSupported ? creditMembers.get(email) : undefined);
  // 그룹에 속했고 적용 할당이 없음(null) = 제한 없음. 구서버(몫 계약 모름)는 모르는 것이라 판정하지 않는다.
  const unlimitedOf = (row: MemberTableRow) => Boolean(row.group_id) && quotaOf(row.email)?.quota_effective === null;
  // 사용량 = 그룹에 배정된 사람은 몫과 같은 그룹 기간(서브스페이스 참가자 탭과 같은 값), 미배정은 충전 달(설계 §14)
  const usageOf = (row: MemberTableRow) => {
    const member = row.group_id ? creditMembers.get(row.email) : undefined;
    return member?.used_period != null && row.usage
      ? { ...row.usage, credits: member.used_period, unknown: member.unknown_period ?? 0 } : row.usage;
  };
  return { quotaSupported, quotaOf, unlimitedOf, usageOf };
}

/** 메인 합본의 한 사람이 속한 서브 한 곳 — 값은 그 서브 표 그대로(creditAccessors) */
export interface MainPersonEntry {
  sub: SubCreditTable;
  row: MemberTableRow;
  group?: MemberTableGroup;
  quota: number | null; // 적용 할당(그룹이 있을 때만)
  remaining: number | null;
  unlimited: boolean;
  used: MemberTableRow["usage"];
}
export interface MainPerson {
  email: string;
  name: string;
  entries: MainPersonEntry[]; // 그 사람이 속한 서브만(서브 목록 순서)
  grouped: boolean; // 한 곳이라도 그룹이 있다
  unlimited: boolean; // 한 곳이라도 제한 없는 그룹 — 할당·잔여 합계도 제한 없음
  quota: number | null; // 한도 있는 곳의 할당 합
  remaining: number | null; // 한도 있는 곳의 잔여 합
  used: MemberTableRow["usage"]; // 사용·금액 미상 합(서브마다 제 기간)
  available: boolean | null; // 모두 확인이면 true, 한 곳이라도 확인 전이면 false
}

/** 메인 합본 = 계정 한 줄(Jay 2026-09-30) — 서브 표의 줄을 이메일로 모아 숫자를 더한다. 서브마다 기간이 다를 수 있어
 *  화면은 칸 툴팁에 서브별 값을 함께 둔다. 못 불러온 서브는 건너뛴다(그 서브는 따로 '불러오지 못함' 줄). */
export function mainPeople(subs: SubCreditTable[]): MainPerson[] {
  const people = new Map<string, MainPerson>();
  for (const sub of subs) {
    if (!sub.table) continue;
    const access = creditAccessors(sub.table);
    const groups = new Map(sub.table.groups.map((group) => [group.id, group]));
    for (const row of sub.table.rows) {
      const quota = access.quotaOf(row.email);
      const person = people.get(row.email) ?? {
        email: row.email, name: row.name, entries: [], grouped: false, unlimited: false, quota: null, remaining: null, used: null, available: null,
      };
      if (person.name === row.email.split("@")[0] && row.name !== person.name) person.name = row.name; // 이메일 앞부분보다 실제 이름
      person.entries.push({
        sub, row, group: row.group_id ? groups.get(row.group_id) : undefined,
        quota: row.group_id ? quota?.quota_effective ?? null : null, remaining: quota?.remaining ?? null,
        unlimited: access.unlimitedOf(row), used: access.usageOf(row),
      });
      people.set(row.email, person);
    }
  }
  const add = (sum: number | null, value: number | null) => (value == null ? sum : (sum ?? 0) + value);
  return [...people.values()].map((person) => {
    const { entries } = person;
    return {
      ...person,
      grouped: entries.some((entry) => entry.row.group_id),
      unlimited: entries.some((entry) => entry.unlimited),
      quota: entries.reduce<number | null>((sum, entry) => add(sum, entry.quota), null),
      remaining: entries.reduce<number | null>((sum, entry) => add(sum, entry.remaining), null),
      used: entries.reduce<MemberTableRow["usage"]>((sum, { used }) => used
        ? { credits: (sum?.credits ?? 0) + used.credits, count: (sum?.count ?? 0) + used.count, unknown: (sum?.unknown ?? 0) + used.unknown }
        : sum, null),
      available: entries.some((entry) => entry.row.is_available == null) ? null : entries.every((entry) => entry.row.is_available),
    };
  });
}

/** 한 사람의 그룹만 바꾸는 저장 본문. 서버는 목록에 없는 그룹을 **지우므로** 마지막에 받은 그룹을 전부 되보낸다.
 *  allowed_models·color 키는 보내지 않는다(= 유지). members 는 바꾼 한 줄만 — 안 적힌 이메일은 그대로다. */
export function groupAssignBody(credit: CreditPlanSettings, email: string, groupId: string | null): CreditPlanSaveBody {
  return {
    revision: credit.plan.revision ?? 0,
    note: credit.plan.note,
    groups: credit.groups.map((group) => ({
      id: group.id,
      name: group.name,
      monthly_limit: group.monthly_limit,
      limit_period: group.limit_period ?? "month",
    })),
    members: [{ email, group_id: groupId }],
  };
}

/** 그룹 추가·편집 본문. 그룹 목록은 최신 전체를 보내되 허용 모델은 편집한 그룹에만 명시하고,
 * 멤버는 실제로 바뀐 이메일만 보내 필터 밖 배정을 보존한다. */
export function groupEditBody(credit: CreditPlanSettings, edited: DraftGroup, memberEmails: string[]): CreditPlanSaveBody {
  const selected = new Set(memberEmails);
  const currentByEmail = new Map(credit.members.map((member) => [member.email, member]));
  const members: { email: string; group_id: string | null }[] = [];
  for (const member of credit.members) {
    if (selected.has(member.email) && member.group_id !== edited.id) {
      members.push({ email: member.email, group_id: edited.id });
    } else if (!selected.has(member.email) && member.group_id === edited.id) {
      members.push({ email: member.email, group_id: null });
    }
  }
  for (const email of selected) {
    if (!currentByEmail.has(email)) members.push({ email, group_id: edited.id });
  }

  const editedBody = {
    id: edited.id,
    name: edited.name.trim(),
    monthly_limit: edited.unlimited ? null : Number(stripThousands(edited.limitInput)),
    limit_period: edited.limitPeriod,
    allowed_models: [...edited.allowedModels],
    ...(edited.color ? { color: edited.color } : {}),
  };
  const exists = credit.groups.some((group) => group.id === edited.id);
  return {
    revision: credit.plan.revision,
    note: credit.plan.note,
    groups: [
      ...credit.groups.map((group) => (group.id === edited.id ? editedBody : {
        id: group.id,
        name: group.name,
        monthly_limit: group.monthly_limit,
        limit_period: group.limit_period ?? "month",
      })),
      ...(exists ? [] : [editedBody]),
    ],
    members,
  };
}

/** 그룹 색상 한 칸 저장. 다른 그룹의 color 키는 빼서 동시에 바뀐 색을 덮지 않는다. */
export function groupColorBody(credit: CreditPlanSettings, groupId: string, color: string): CreditPlanSaveBody {
  return {
    revision: credit.plan.revision,
    note: credit.plan.note,
    groups: credit.groups.map((group) => ({
      id: group.id,
      name: group.name,
      monthly_limit: group.monthly_limit,
      limit_period: group.limit_period ?? "month",
      ...(group.id === groupId ? { color } : {}),
    })),
  };
}

/** 그룹 한도 한 줄 저장. 다른 그룹의 모델·색상과 전체 멤버 배정은 키를 빼서 기존값을 유지한다. */
export function groupTermsBody(
  credit: CreditPlanSettings,
  groupId: string,
  monthlyLimit: number | null,
  limitPeriod: LimitPeriod,
): CreditPlanSaveBody {
  return {
    revision: credit.plan.revision,
    note: credit.plan.note,
    groups: credit.groups.map((group) => ({
      id: group.id,
      name: group.name,
      monthly_limit: group.id === groupId ? monthlyLimit : group.monthly_limit,
      limit_period: group.id === groupId ? limitPeriod : group.limit_period ?? "month",
    })),
  };
}

/** 사람별 몫 한 칸 저장. `quota` 만 싣고 `group_id` 키는 빼서 소속을 건드리지 않는다
 *  (null = 자동 몫으로 되돌리기). 그룹 목록은 서버가 목록에 없는 그룹을 지우므로 최신 전체를 되보낸다. */
export function memberQuotaBody(
  credit: CreditPlanSettings,
  email: string,
  quota: number | null,
): CreditPlanSaveBody {
  return {
    revision: credit.plan.revision,
    note: credit.plan.note,
    groups: credit.groups.map((group) => ({
      id: group.id,
      name: group.name,
      monthly_limit: group.monthly_limit,
      limit_period: group.limit_period ?? "month",
    })),
    members: [{ email, quota }],
  };
}

/** 정기 충전 손 입력 저장(null = 프로젝트 월 예산 합에서 파생으로 되돌리기). 그룹·배정은 건드리지 않는다. */
export function recurringTopupBody(credit: CreditPlanSettings, value: number | null): CreditPlanSaveBody {
  return { revision: credit.plan.revision, note: credit.plan.note, recurring_topup: value };
}

/** 낙관 반영 — 프로젝트 역할은 uid 기준이라 같은 uid 의 줄이 함께 바뀐다. roles 가 비면 그 프로젝트에서 빠진다. */
export function applyProjectRoles(rows: MemberTableRow[], uid: string, pid: string, roles: string[]): MemberTableRow[] {
  return rows.map((row) => {
    if (row.uid !== uid) return row;
    const projects = { ...row.projects };
    if (roles.length) projects[pid] = roles;
    else delete projects[pid];
    return { ...row, projects };
  });
}

export function matchesMemberQuery(row: MemberTableRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || row.name.toLowerCase().includes(q) || row.email.toLowerCase().includes(q);
}

/** 마지막 보고 — 서버 시각은 UTC('YYYY-MM-DD HH:MM:SS'). 오늘이면 시각, 아니면 날짜만. */
export function lastSeenLabel(value: string | null, now = new Date()): string {
  if (!value) return "보고 없음";
  const at = new Date(value.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? "" : "Z"));
  if (Number.isNaN(at.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return day === today ? `오늘 ${pad(at.getHours())}:${pad(at.getMinutes())}` : day;
}

/** 프로젝트 순서(§16 합의 4) — 전체 활성 목록에서 **이 워크스페이스 프로젝트가 있던 자리에만** 새 순서를 채운다.
 *  다른 프로젝트 자리는 그대로. 두 목록의 워크스페이스 프로젝트가 서로 다르면(그 사이 바뀜) null. */
export function fillReorder(fullIds: string[], newOrder: string[]): string[] | null {
  const mine = new Set(newOrder);
  const slots = fullIds.filter((id) => mine.has(id));
  if (slots.length !== newOrder.length) return null;
  let next = 0;
  return fullIds.map((id) => (mine.has(id) ? newOrder[next++] : id));
}
