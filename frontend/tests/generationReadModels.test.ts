// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clearGenerationReadModels, getGenerationReadModel, storeGenerationRows } from "../src/features/library/readModels";
import { setAccountScope } from "../src/lib/accountScope";
import type { Generation } from "../src/types";

const row = (id: string, tags = ["old"]) => ({ id, tags, status: "running" }) as Generation;
beforeEach(() => { setAccountScope(""); clearGenerationReadModels(); });

describe("scoped generation reads", () => {
  it("shares an authority between views but keeps equal local/team IDs separate", () => {
    const local = getGenerationReadModel("a", "local");
    const team = getGenerationReadModel("a", "team");
    storeGenerationRows(local, [row("same", ["local"])], local.beginRead());
    storeGenerationRows(team, [row("same", ["team"])], team.beginRead());
    expect(getGenerationReadModel("a", "team")).toBe(team);
    expect(local.read("same")?.tags).toEqual(["local"]);
    expect(team.read("same")?.tags).toEqual(["team"]);
  });
  it("invalidates in-flight reads and data across account A to B to A", () => {
    const a = getGenerationReadModel("a", "lookup"); const old = a.beginRead();
    storeGenerationRows(a, [row("same")], a.beginRead());
    getGenerationReadModel("b", "lookup");
    const again = getGenerationReadModel("a", "lookup");
    expect(again).not.toBe(a);
    expect(again.read("same")).toBeUndefined();
    expect(storeGenerationRows(a, [row("same")], old)).toEqual([]);
  });
  it("uses the tab account namespace even when the supplied auth key is unchanged", () => {
    const a = getGenerationReadModel("same", "local");
    storeGenerationRows(a, [row("id")], a.beginRead());
    setAccountScope("different-account");
    expect(getGenerationReadModel("same", "local").read("id")).toBeUndefined();
    expect(a.read("id")).toBeUndefined();
  });
  it("clears records and old tickets while keeping mounted subscriptions usable", () => {
    const a = getGenerationReadModel("a", "local"); const old = a.beginRead(); const changes: string[][] = [];
    const off = a.subscribe(change => changes.push([...change.ids]));
    clearGenerationReadModels();
    expect(a.isCurrent(old)).toBe(false);
    expect(getGenerationReadModel("a", "local")).toBe(a);
    storeGenerationRows(a, [row("id")], a.beginRead()); off();
    expect(changes).toEqual([[], ["id"]]);
  });
});
