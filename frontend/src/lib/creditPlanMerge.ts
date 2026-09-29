import type { Planning } from "../components/manage/types";
import type { CreditPlanSaveBody, CreditPlanSettings, LimitPeriod } from "./creditPlan";

export type MergeChoice = "remote" | "mine";
export type MergeChoices = Record<string, MergeChoice>;
export interface EditChange {
  path: string;
  before: unknown;
  mine: unknown;
  remote: unknown;
  conflict: boolean;
  label?: string;
}
export interface EditMerge<T> { value: T; changes: EditChange[] }

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function mergeField<T>(path: string, before: T, mine: T, remote: T, changes: EditChange[], choices: MergeChoices, force = false): T {
  const conflict = force || (!equal(before, mine) && !equal(before, remote) && !equal(mine, remote));
  if (!equal(before, remote) || conflict) changes.push({ path, before, mine, remote, conflict });
  if (conflict) return choices[path] === "mine" ? mine : remote;
  return equal(before, mine) ? remote : mine;
}

function mergeObject<T extends object>(prefix: string, before: T, mine: T, remote: T, changes: EditChange[], choices: MergeChoices): T {
  const result = { ...remote };
  for (const key of Object.keys(before) as (keyof T)[]) {
    result[key] = mergeField(`${prefix}${String(key)}`, before[key], mine[key], remote[key], changes, choices);
  }
  return result;
}

function mergeRows<T extends object>(name: string, before: T[], mine: T[], remote: T[], key: (row: T) => string, changes: EditChange[], choices: MergeChoices): T[] {
  const b = new Map(before.map((row) => [key(row), row]));
  const m = new Map(mine.map((row) => [key(row), row]));
  const r = new Map(remote.map((row) => [key(row), row]));
  const result: T[] = [];
  for (const id of new Set([...r.keys(), ...m.keys(), ...b.keys()])) {
    const old = b.get(id), local = m.get(id), latest = r.get(id);
    const path = `${name}.${id}`;
    // Presence conflicts are whole-row decisions; restoring a deleted row is never implicit.
    const row = old && local && latest
      ? mergeObject(`${path}.`, old, local, latest, changes, choices)
      : mergeField(path, old, local, latest, changes, choices, !old && !!local && !!latest);
    if (row) result.push(row);
  }
  return result;
}

export function planningValues(planning: Planning): Required<Pick<Planning, "status" | "start_date" | "due_date" | "budget_credits" | "budget_period" | "archive_after_days" | "note">> {
  return {
    status: planning.status || "active", start_date: planning.start_date || null,
    due_date: planning.due_date || null, budget_credits: planning.budget_credits ?? null,
    budget_period: planning.budget_period || "month", archive_after_days: planning.archive_after_days ?? 30,
    note: planning.note || null,
  };
}

export function mergePlanning(baseline: Planning, mine: Planning, latest: Planning, choices: MergeChoices = {}): EditMerge<Planning> {
  const changes: EditChange[] = [];
  const value = mergeObject("", planningValues(baseline), planningValues(mine), planningValues(latest), changes, choices);
  return { value: { ...value, revision: latest.revision ?? 0 }, changes };
}

type Group = { id: string; name: string; monthly_limit: number | null; limit_period: LimitPeriod; allowed_models: string[]; color: string | null };
type Member = { email: string; group_id: string | null; quota: number | null };
type Topup = { id: string; day: string; credits: number; note: string | null };
function creditValues(settings: CreditPlanSettings) {
  return {
    note: settings.plan.note || null,
    topup_day: settings.plan.topup_day ?? 1,
    recurring_topup: settings.plan.recurring_topup ?? null,
    groups: settings.groups.map((g): Group => ({ id: g.id, name: g.name, monthly_limit: g.monthly_limit, limit_period: g.limit_period ?? "month", allowed_models: [...(g.allowed_models ?? [])].sort(), color: g.color ?? null })),
    members: settings.members.map((m): Member => ({ email: m.email.toLowerCase(), group_id: m.group_id, quota: m.quota ?? null })),
    topups: settings.topups.map((t): Topup => ({ id: t.id, day: t.day, credits: t.credits, note: t.note || null })),
  };
}

export function mergeCreditPlan(baseline: CreditPlanSettings, body: CreditPlanSaveBody, latest: CreditPlanSettings, choices: MergeChoices = {}): EditMerge<CreditPlanSaveBody> {
  const b = creditValues(baseline), r = creditValues(latest);
  const m = {
    note: body.note,
    topup_day: body.topup_day ?? b.topup_day,
    recurring_topup: body.recurring_topup === undefined ? b.recurring_topup : body.recurring_topup,
    groups: body.groups?.map((g): Group => {
      if (!g.id) throw new Error("그룹 ID가 없어 안전하게 병합할 수 없습니다.");
      const old = b.groups.find((row) => row.id === g.id);
      return { id: g.id, name: g.name, monthly_limit: g.monthly_limit, limit_period: g.limit_period, allowed_models: [...(g.allowed_models ?? old?.allowed_models ?? [])].sort(), color: g.color ?? old?.color ?? null };
    }) ?? b.groups,
    members: b.members.map((row) => ({ ...row })),
    topups: body.topups?.map((t): Topup => {
      if (!t.id) throw new Error("충전 ID가 없어 안전하게 병합할 수 없습니다.");
      return { id: t.id, day: t.day, credits: t.credits, note: t.note || null };
    }) ?? b.topups,
  };
  for (const patch of body.members ?? []) {
    const email = patch.email.toLowerCase();
    const index = m.members.findIndex((row) => row.email === email);
    const old = m.members[index] ?? { email, group_id: null, quota: null };
    const next = { email, group_id: patch.group_id === undefined ? old.group_id : patch.group_id, quota: patch.quota === undefined ? old.quota : patch.quota };
    if (index < 0) m.members.push(next); else m.members[index] = next;
  }
  const changes: EditChange[] = [];
  const value: CreditPlanSaveBody = { revision: latest.plan.revision, note: mergeField("note", b.note, m.note, r.note, changes, choices) };
  const day = mergeField("topup_day", b.topup_day, m.topup_day, r.topup_day, changes, choices);
  const recurring = mergeField("recurring_topup", b.recurring_topup, m.recurring_topup, r.recurring_topup, changes, choices);
  if (body.topup_day !== undefined) value.topup_day = day;
  if (body.recurring_topup !== undefined) value.recurring_topup = recurring;
  const groups = mergeRows("groups", b.groups, m.groups, r.groups, (row) => row.id, changes, choices);
  const members = mergeRows("members", b.members, m.members, r.members, (row) => row.email, changes, choices);
  const topups = mergeRows("topups", b.topups, m.topups, r.topups, (row) => row.id, changes, choices);
  // Deleting a group affects assignments too; neither a new remote assignment nor
  // a local assignment to a remotely deleted group may be silently discarded/restored.
  for (const old of b.groups) {
    const local = m.groups.find((row) => row.id === old.id);
    const remote = r.groups.find((row) => row.id === old.id);
    const remoteAssignment = !local && remote && r.members.some((row) => row.group_id === old.id && !equal(row, b.members.find((item) => item.email === row.email)));
    // Detect intent before applying choices, or the default remote member value can
    // hide the required group-restoration choice from the first prompt.
    const localAssignment = local && !remote && m.members.some((row) => row.group_id === old.id && row.group_id !== b.members.find((item) => item.email === row.email)?.group_id);
    if (!remoteAssignment && !localAssignment) continue;
    const path = `groups.${old.id}`;
    const previous = changes.findIndex((change) => change.path === path);
    if (previous >= 0) changes.splice(previous, 1);
    const chosen = mergeField(path, old, local, remote, changes, choices, true);
    const index = groups.findIndex((row) => row.id === old.id);
    if (index >= 0) groups.splice(index, 1);
    if (chosen) groups.push(chosen);
    else for (const member of members) {
      if (member.group_id === old.id) member.group_id = localAssignment ? r.members.find((row) => row.email === member.email)?.group_id ?? null : null;
    }
    if (localAssignment && chosen) value.groups = groups;
  }
  if (body.groups) value.groups = groups;
  if (body.topups) value.topups = topups;
  if (body.members) {
    value.members = [];
    for (const row of members) {
      const old = r.members.find((item) => item.email === row.email);
      const patch: NonNullable<CreditPlanSaveBody["members"]>[number] = { email: row.email };
      if (row.group_id !== old?.group_id) patch.group_id = row.group_id;
      if (row.quota !== (old?.quota ?? null)) patch.quota = row.quota;
      if (Object.keys(patch).length > 1) value.members.push(patch);
    }
  }
  for (const change of changes) {
    const [collection, id, ...field] = change.path.split(".");
    if (collection === "groups") {
      const group = r.groups.find((row) => row.id === id) ?? b.groups.find((row) => row.id === id) ?? m.groups.find((row) => row.id === id);
      change.label = `그룹 / ${group?.name || id}${field.length ? ` / ${editFieldLabel(field.join("."))}` : ""}`;
    } else if (collection === "topups") {
      const topup = r.topups.find((row) => row.id === id) ?? b.topups.find((row) => row.id === id) ?? m.topups.find((row) => row.id === id);
      change.label = `긴급 충전 / ${topup?.day || id}${field.length ? ` / ${editFieldLabel(field.join("."))}` : ""}`;
    }
  }
  return { value, changes };
}

const LABELS: Record<string, string> = {
  groups: "그룹", members: "멤버", topups: "긴급 충전", name: "이름", monthly_limit: "한도", limit_period: "한도 주기",
  allowed_models: "허용 모델", color: "색상", group_id: "소속 그룹", quota: "개인 몫", note: "메모", topup_day: "충전 기준일",
  recurring_topup: "정기 충전", day: "날짜", credits: "크레딧", status: "상태", start_date: "시작일", due_date: "마감일",
  budget_credits: "예산", budget_period: "예산 주기", archive_after_days: "보관 전환 일수", id: "ID", email: "이메일",
};
export const editFieldLabel = (path: string) => path.split(".").map((part) => LABELS[part] ?? part).join(" / ");
export function editValueLabel(value: unknown): string {
  if (value === undefined) return "없음 (삭제/미등록)";
  if (value === null || value === "") return "미설정";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "제한 없음";
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${LABELS[key] ?? key}: ${editValueLabel(item)}`).join(" · ");
  const values: Record<string, string> = { active: "진행", hold: "보류", done: "완료", day: "매일", week: "매주", month: "매월" };
  return typeof value === "string" ? values[value] ?? value : String(value);
}
