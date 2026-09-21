// PM 대시보드 '관리 표' — 응답 모양과 저장 본문(설계: docs/MEMBER_TABLE_DESIGN.md).
// 표에는 자기만의 쓰기 API 가 없다 — 칸마다 기존 API 를 부른다.
import type { CreditPlanSaveBody, CreditPlanSettings, LimitPeriod } from "./creditPlan";

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
  monthly_limit: number | null;
  limit_period?: LimitPeriod;
  remaining: number | null;
  member_count: number;
}

export interface MemberTableData {
  workspace_id: string | null;
  cycle_start: string | null;
  rows: MemberTableRow[];
  projects: { id: string; name: string }[];
  groups: MemberTableGroup[];
  credit: CreditPlanSettings | null; // 그룹 저장에 쓰는 원문 — create_project 가 없으면 null
  caps: { account: boolean; credit: boolean; project_roles: boolean };
}

/** 한 사람의 그룹만 바꾸는 저장 본문. 서버는 목록에 없는 그룹을 **지우므로** 마지막에 받은 그룹을 전부 되보낸다.
 *  allowed_models·remaining_override 키는 보내지 않는다(= 유지). members 는 바꾼 한 줄만 — 안 적힌 이메일은 그대로다. */
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
