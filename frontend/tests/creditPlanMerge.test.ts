import { describe, expect, it } from "vitest";
import { draftFromSettings, draftToBody, type CreditPlanSettings } from "../src/lib/creditPlan";
import { mergeCreditPlan, mergePlanning } from "../src/lib/creditPlanMerge";

const settings = (): CreditPlanSettings => ({
  workspace_id: "ws", month: "2026-09", plan: { revision: 1, monthly_topup: 1000, note: null, updated_at: null },
  groups: [{ id: "g", name: "Artists", monthly_limit: 100, limit_period: "month", allowed_models: ["one"], color: "#ffffff", used_month: 99, remaining: 1, member_count: 1, unknown_month: 0, unknown_since_base: 0, estimated: false }],
  members: [{ email: "a@example.com", name: "A", group_id: "g", quota: null, workspace_role: null, is_available: true, used_period: 99 }],
  topups: [{ id: "t", day: "2026-09-01", credits: 100, note: "old" }],
});
const body = (s: CreditPlanSettings) => draftToBody(draftFromSettings(s));

it("only local editable deltas are merged; remote fields, new rows and member quotas survive", () => {
  const base = settings(), latest = settings();
  latest.plan.revision = 2;
  latest.plan.note = "remote note";
  latest.groups[0].allowed_models = ["two"];
  latest.groups[0].used_month = 1000;
  latest.members[0].quota = 12.5;
  latest.topups.push({ id: "remote", day: "2026-09-02", credits: 200, note: null });
  const mine = body(base); mine.groups![0].name = "Mine";
  const merged = mergeCreditPlan(base, mine, latest);
  expect(merged.value).toMatchObject({ revision: 2, note: "remote note", groups: [{ name: "Mine", allowed_models: ["two"] }] });
  expect(merged.value.groups![0]).not.toHaveProperty("used_month");
  expect(merged.value.members).toEqual([]);
  expect(merged.value.topups).toEqual(latest.topups);
  expect(merged.changes.some((change) => change.conflict)).toBe(false);
  expect(base.groups[0].name).toBe("Artists");
});

describe.each(["groups", "topups"] as const)("%s presence conflicts", (collection) => {
  const path = collection === "groups" ? "groups.g" : "topups.t";
  it("modify-v-delete needs explicit resurrection", () => {
    const base = settings(), latest = settings(), mine = body(base);
    if (collection === "groups") { mine.groups![0].name = "Mine"; latest.groups = []; latest.members[0].group_id = null; }
    else { mine.topups![0].credits = 200; latest.topups = []; }
    const merged = mergeCreditPlan(base, mine, latest);
    expect(merged.changes).toContainEqual(expect.objectContaining({ path, conflict: true, remote: undefined }));
    expect(merged.value[collection]).toEqual([]);
    expect(mergeCreditPlan(base, mine, latest, { [path]: "mine" }).value[collection]).toHaveLength(1);
  });
  it("delete-v-modify is not an automatic delete", () => {
    const base = settings(), latest = settings(), mine = body(base);
    mine[collection] = [];
    if (collection === "groups") latest.groups[0].name = "Remote"; else latest.topups[0].credits = 500;
    expect(mergeCreditPlan(base, mine, latest).changes).toContainEqual(expect.objectContaining({ path, conflict: true, mine: undefined }));
    expect(mergeCreditPlan(base, mine, latest).value[collection]).toHaveLength(1);
    expect(mergeCreditPlan(base, mine, latest, { [path]: "mine" }).value[collection]).toEqual([]);
  });
  it("same-key double-add is explicit even when the values match", () => {
    const base = settings(), latest = settings(), mine = body(latest);
    base[collection] = [];
    expect(mergeCreditPlan(base, mine, latest).changes).toContainEqual(expect.objectContaining({ path, conflict: true, before: undefined }));
  });
  it("untouched remote deletion is preserved", () => {
    const base = settings(), latest = settings(); latest[collection] = [];
    if (collection === "groups") latest.members[0].group_id = null;
    const merged = mergeCreditPlan(base, body(base), latest);
    expect(merged.value[collection]).toEqual([]);
    expect(merged.changes.some((change) => change.conflict)).toBe(false);
  });
});

it("keeping mine only overrides the chosen overlap and preserves unrelated remote values", () => {
  const base = settings(), latest = settings(), mine = body(base);
  mine.groups![0].name = "Mine";
  latest.groups[0].name = "Remote";
  latest.groups[0].monthly_limit = 400;
  expect(mergeCreditPlan(base, mine, latest, { "groups.g.name": "mine" }).value.groups![0]).toMatchObject({ name: "Mine", monthly_limit: 400 });
  expect(mergeCreditPlan(base, mine, latest, { "groups.g.name": "remote" }).value.groups![0].name).toBe("Remote");
});

it("member email keys merge quota separately from group and omit derived usage", () => {
  const base = settings(), latest = settings(); latest.members[0].group_id = null;
  const merged = mergeCreditPlan(base, { revision: 1, note: null, members: [{ email: "A@example.com", quota: 40 }] }, latest);
  expect(merged.value.members).toEqual([{ email: "a@example.com", quota: 40 }]);
});

it("assigning into a remotely deleted group requires a separate restore choice", () => {
  const base = settings(), latest = settings(); base.members[0].group_id = null;
  latest.members[0].group_id = null; latest.groups = [];
  const mine = { revision: 1, note: null, members: [{ email: "a@example.com", group_id: "g" }] };
  expect(mergeCreditPlan(base, mine, latest).changes).toContainEqual(expect.objectContaining({ path: "groups.g", conflict: true }));
  expect(mergeCreditPlan(base, mine, latest).value.members).toEqual([]);
  expect(mergeCreditPlan(base, mine, latest, { "groups.g": "mine" }).value.groups).toHaveLength(1);
});

it("deleting a group cannot silently drop newly assigned remote members", () => {
  const base = settings(), latest = settings(); base.members[0].group_id = null;
  const mine = body(base); mine.groups = [];
  expect(mergeCreditPlan(base, mine, latest).changes).toContainEqual(expect.objectContaining({ path: "groups.g", conflict: true }));
  expect(mergeCreditPlan(base, mine, latest).value.groups).toHaveLength(1);
});

it("a conflicting member move into a deleted group exposes restoration before any choices", () => {
  const base = settings(), latest = settings();
  base.groups.push({ ...base.groups[0], id: "old", name: "Old" }, { ...base.groups[0], id: "other", name: "Other" });
  base.members[0].group_id = "old";
  latest.groups = base.groups.filter((group) => group.id !== "g");
  latest.members[0].group_id = "other";
  latest.members[0].quota = 23;
  const mine = { revision: 1, note: null, members: [{ email: "a@example.com", group_id: "g" }] };
  const first = mergeCreditPlan(base, mine, latest);
  expect(first.changes).toContainEqual(expect.objectContaining({ path: "groups.g", conflict: true }));
  expect(first.changes).toContainEqual(expect.objectContaining({ path: "members.a@example.com.group_id", conflict: true }));
  const resolved = mergeCreditPlan(base, mine, latest, { "members.a@example.com.group_id": "mine", "groups.g": "mine" });
  expect(resolved.value.groups).toContainEqual(expect.objectContaining({ id: "g" }));
  expect(resolved.value.members).toEqual([{ email: "a@example.com", group_id: "g" }]);
  expect(resolved.changes.filter((change) => change.conflict).map((change) => change.path))
    .toEqual(first.changes.filter((change) => change.conflict).map((change) => change.path));
  const keepDeletion = mergeCreditPlan(base, mine, latest, { "members.a@example.com.group_id": "mine", "groups.g": "remote" });
  expect(keepDeletion.value.groups).toBeUndefined();
  expect(keepDeletion.value.members).toEqual([]);
});

it("참가자 항목 이름은 이메일의 점에서 잘리지 않는다 — 칸 충돌·행 전체 충돌 모두(2026-10-03 점검 L3-6)", () => {
  const email = "lee.jae@mail.example.com";
  const base = settings(), latest = settings();
  base.members[0].email = email; latest.members[0].email = email;
  latest.plan.revision = 2;
  latest.members[0].group_id = null; // B 는 그룹에서 뺐다
  latest.members.push({ ...latest.members[0], email: "new.person@x.com", group_id: "g" }); // B 도 새 사람을 넣었다
  const mine = { revision: 1, note: null, members: [{ email, quota: 5 as number | null, group_id: "h" as string | null }, { email: "new.person@x.com", group_id: "g" as string | null }] };
  const labels = Object.fromEntries(mergeCreditPlan(base, mine, latest).changes.map((change) => [change.path, change.label]));
  expect(labels[`members.${email}.group_id`]).toBe(`참가자 / ${email} / 소속 그룹`);
  expect(labels["members.new.person@x.com"]).toBe("참가자 / new.person@x.com");
});

it("planning uses only known fields, preserves dates and includes the latest revision", () => {
  const base = { note: "before", start_date: "2026-09-01", revision: 1 };
  const mine = { ...base, note: "mine" };
  const latest = { ...base, due_date: "2026-12-01", note: "remote", revision: 2, updated_by: "u2" };
  const result = mergePlanning(base, mine, latest, { note: "mine" });
  expect(result.value).toMatchObject({ revision: 2, note: "mine", due_date: "2026-12-01" });
  expect(result.value).not.toHaveProperty("updated_by");
  expect(mergePlanning({}, { note: "new" }, {}).value.revision).toBe(0);
});
