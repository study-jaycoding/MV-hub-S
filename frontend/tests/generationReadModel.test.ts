import { describe, expect, it } from "vitest";
import { GenerationReadModel } from "../src/features/library/readModel";
import { storeGenerationRows } from "../src/features/library/readModels";
import type { Generation } from "../src/types";

const row = (id: string, patch: Partial<Generation> = {}) =>
  ({ id, job_id: "same-job", tags: ["old"], auto_tags: [], color: null, status: "running", ...patch }) as Generation;
const model = (authority: "local" | "team" | "lookup" = "local", capacity = 3000) =>
  new GenerationReadModel({ serverOrigin: "http://hub", accountNamespace: "account-a", authority }, capacity);

describe("generation record ownership", () => {
  it("does not merge local/team records by id or job id", () => {
    const local = model("local"); const team = model("team");
    local.store({ id: row("id", { tags: ["local"] }) }, local.beginRead());
    team.store({ id: row("id", { tags: ["team"] }) }, team.beginRead());
    local.store({ other: row("other") }, local.beginRead());
    expect(local.read("id")?.tags).toEqual(["local"]);
    expect(team.read("id")?.tags).toEqual(["team"]);
    expect(local.read("other")?.tags).toEqual(["old"]);
  });
  it("keeps newer tag fields when an older full response arrives", () => {
    const m = model(); m.store({ id: row("id") }, m.beginRead());
    const full = m.beginRead();
    m.store({ id: row("id", { tags: ["new"], status: "done" }) }, m.beginRead(["tags"]));
    m.store({ id: row("id", { status: "done", color: "red" }) }, full);
    expect(m.read("id")).toMatchObject({ tags: ["new"], status: "done", color: "red" });
  });
  it("invalidates in-flight pre-mutation fields without replacing other fields", () => {
    const m = model();m.store({ id: row("id") }, m.beginRead());
    const old = m.beginRead();m.invalidate(["id"], ["tags"]);
    m.store({ id: row("id", { tags: ["late"] }) }, old);
    expect(m.read("id")?.tags).toEqual(["old"]);
    expect(m.isFresh("id", ["tags"])).toBe(false);
    m.store({ id: row("id", { tags: ["settled"] }) }, m.beginRead(["tags"]));
    expect(m.isFresh("id", ["tags"])).toBe(true);
  });
  it("rejects tickets from another scope or an earlier cleared session", () => {
    const a = model();const b = model(); const old = a.beginRead();
    expect(b.store({ id: row("id") }, old)).toEqual([]);
    a.clear(); expect(a.store({ id: row("id") }, old)).toEqual([]);
  });
  it("does not seed unknown records from a read preceding invalidation", () => {
    const m = model();const old=m.beginRead();m.invalidate(["id"],["tags"]);
    expect(m.store({id:row("id")},old)).toEqual([]);
    expect(m.read("id")).toBeUndefined();
  });
  it("treats empty requested fields as no update", () => {
    const m=model();expect(m.store({id:row("id")},m.beginRead([]))).toEqual([]);
    expect(m.read("id")).toBeUndefined();
  });
  it("never seeds other fields or resurrects a missing record from a partial response", () => {
    const m=model();
    expect(m.store({ id:row("id", { status:"failed" }) },m.beginRead(["tags"]))).toEqual([]);
    expect(m.read("id")).toBeUndefined();
    m.markMissing(["id"],m.beginRead());
    expect(m.store({ id:row("id") },m.beginRead(["tags"]))).toEqual([]);
    expect(m.isMissing("id")).toBe(true);
    m.store({ id:row("canonical") },m.beginRead());
    expect(m.store({ id:row("other") },m.beginRead(["tags"]))).toEqual([]);
    expect(m.read("id")?.id).toBe("canonical");
  });
  it("replaces omitted full-response fields while preserving newer partial fields", () => {
    const m = model();m.store({ id: row("id", { color: "red" }) },m.beginRead());
    const full=m.beginRead();
    m.store({ id: row("id", { tags: ["new"] }) },m.beginRead(["tags"]));
    m.store({ id: { id: "id", status: "done" } as Generation },full);
    expect(m.read("id")?.color).toBeUndefined();
    expect(m.read("id")?.tags).toEqual(["new"]);
  });
  it("requires a newer explicit API resolution to retarget an alias", () => {
    const m = model("lookup");const old = m.beginRead();
    m.store({ alias: row("local-id", { tags: ["local"] }) }, m.beginRead());
    expect(m.store({ alias: row("other-id") }, old)).toEqual([]);
    m.store({ alias: row("other-id", { tags: ["resolved"] }) }, m.beginRead());
    expect(m.read("alias")?.id).toBe("other-id");
  });
  it("does not resurrect a newer missing record with an older response", () => {
    const m = model();m.store({ id: row("id") }, m.beginRead()); const old = m.beginRead();
    m.markMissing(["id"], m.beginRead());
    expect(m.store({ id: row("id") }, old)).toEqual([]);
    expect(m.isMissing("id")).toBe(true);
    m.store({ id: row("id") }, m.beginRead());expect(m.isMissing("id")).toBe(false);
  });
  it("preserves references and does not notify for unchanged server values", () => {
    const m = model();m.store({ id: row("id") }, m.beginRead());const before=m.read("id");let events=0;
    const off=m.subscribe(()=>events++);m.store({ id: row("id") },m.beginRead());off();
    expect(m.read("id")).toBe(before);expect(events).toBe(0);
  });
  it("keeps special property names as data without prototype lookup", () => {
    const m=model();m.store(Object.fromEntries([["__proto__",row("__proto__")]]),m.beginRead());
    expect(Object.hasOwn(m.snapshot(["__proto__"]),"__proto__")).toBe(true);
  });
  it("bounds records and refuses old in-flight tickets after watermark eviction", () => {
    const m=model("local",1);const old=m.beginRead();
    m.store({ a:row("a") },m.beginRead());m.store({ b:row("b") },m.beginRead());
    expect(m.read("a")).toBeUndefined();expect(m.store({ a:row("a") },old)).toEqual([]);
  });
  it("[R4-4] eviction preserves unrelated in-flight reads and per-ID invalidation watermarks", () => {
    const m = model("local", 1);
    m.store({ a: row("a") }, m.beginRead());
    const unrelated = m.beginRead();
    const old = m.beginRead();
    m.invalidate(["a"], ["tags"]);
    m.store({ b: row("b") }, m.beginRead());
    expect(m.isCurrent(unrelated)).toBe(true);
    expect(m.store({ a: row("a", { tags: ["obsolete"] }) }, old)).toEqual([]);
    m.markMissing(["a"], old);
    expect(m.isMissing("a")).toBe(false);
    expect(m.store({ c: row("c") }, unrelated)).toEqual(["c"]);
    expect(m.read("c")?.id).toBe("c");
    expect(m.store({ a: row("a", { tags: ["fresh"] }) }, m.beginRead())).toEqual(["a"]);
    expect(m.read("a")?.tags).toEqual(["fresh"]);
  });
  it("[R5-1] keeps an invalidated oldest row when an older page inserts a new row first", () => {
    const m = model("local", 2);
    m.store({ a: row("a"), b: row("b") }, m.beginRead());
    const old = m.beginRead();
    m.invalidate(["a"], ["tags"]);
    const page = storeGenerationRows(m, [row("new"), row("a", { tags: ["obsolete"], status: "done" })], old);
    expect(page.map(item => item.id)).toEqual(["new", "a"]);
    expect(m.read("a")).toMatchObject({ tags: ["old"], status: "done" });
    expect(m.isFresh("a", ["tags"])).toBe(false);
  });
});
