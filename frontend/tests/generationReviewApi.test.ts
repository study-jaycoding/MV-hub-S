import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { reviewTargets, matchesReviewFilter } from "../src/lib/generationReview";
import { computeGradeStep, describeGradeStep } from "../src/lib/gradeStep";
import type { Generation } from "../src/types";

const generation = (patch: Partial<Generation> = {}) => ({
  id: "shared", prompt: "test", shared: true, is_held: false, is_final: false,
  status: "done", deleted: false, ...patch,
} as Generation);
const response = (body: unknown, filter?: string, status = 200) => new Response(JSON.stringify(body), {
  status, headers: filter ? { "X-MVHub-Review-Filter": filter } : {},
});
afterEach(() => vi.unstubAllGlobals());

describe("review API compatibility", () => {
  it.each(["shared", "held"] as const)("sends %s and accepts the verified empty page", async (filter) => {
    const fetch = vi.fn().mockResolvedValue(response([], filter));
    vi.stubGlobal("fetch", fetch);
    expect(await api.listGenerations({ tab: "team", workspace_ids: ["ws-a"], review_filter: filter })).toEqual([]);
    const url = new URL(fetch.mock.calls[0][0], "http://localhost");
    expect(url.searchParams.get("review_filter")).toBe(filter);
    expect(url.searchParams.get("workspace_ids")).toBe("ws-a");
    expect(url.searchParams.has("shared_only")).toBe(false);
  });
  it.each([undefined, "shared"])("rejects an empty held page with invalid acknowledgement %s", async (header) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([], header)));
    await expect(api.listGenerations({ tab: "team", review_filter: "held" })).rejects.toThrow("업데이트");
  });
  it("rejects missing state fields but retains legacy unfiltered calls", async () => {
    const old = generation({ is_held: undefined });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response([old], "shared")).mockResolvedValueOnce(response([old])));
    await expect(api.listGenerations({ tab: "my", review_filter: "shared" })).rejects.toThrow("업데이트");
    expect(await api.listGenerations({ tab: "my", shared_only: true })).toHaveLength(1);
  });
  it.each(["hold", "unhold"] as const)("%s posts state and preserves mirror_pending", async (action) => {
    const fetch = vi.fn().mockResolvedValue(response(generation({ is_held: action === "hold", mirror_pending: true })));
    vi.stubGlobal("fetch", fetch);
    expect((await api[action]("g/1")).mirror_pending).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(`/api/generations/g%2F1/${action}`);
    expect(fetch.mock.calls[0][1].method).toBe("POST");
  });
  it("missing hold route/field requires update; domain 404 stays a domain error", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ detail: "Not Found" }, undefined, 404))
      .mockResolvedValueOnce(response({ id: "old", prompt: "" }))
      .mockResolvedValueOnce(response({ detail: "generation missing" }, undefined, 404)));
    await expect(api.hold("g")).rejects.toThrow("업데이트");
    await expect(api.unhold("g")).rejects.toThrow("업데이트");
    await expect(api.hold("g")).rejects.toThrow("generation missing");
  });
  it.each(["unshared", "shared", "held"] as const)("final to %s uses one atomic route", async (state) => {
    const fetch = vi.fn().mockResolvedValue(response(generation({ is_held: state === "held" })));
    vi.stubGlobal("fetch", fetch);
    await api.setReviewState(generation({ is_final: true }), state);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/generations/shared/final-review");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ state });
  });
  it.each([["unshared", "unpublish"], ["shared", "unhold"], ["held", "hold"], ["final", "finalize"]] as const)("ordinary %s uses %s", async (state, route) => {
    const fetch = vi.fn().mockResolvedValue(response(generation())); vi.stubGlobal("fetch", fetch);
    await api.setReviewState(generation(), state);
    expect(fetch.mock.calls[0][0]).toBe(`/api/generations/shared/${route}`);
  });
  it("final-review never falls back to sequential mutations on old servers", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ detail: "Not Found" }, undefined, 404)); vi.stubGlobal("fetch", fetch);
    await expect(api.setReviewState(generation({ is_final: true }), "held")).rejects.toThrow("업데이트");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("review targets", () => {
  const shared = generation();
  const held = generation({ id: "held", is_held: true });
  const final = generation({ id: "final", is_final: true });
  const denied = generation({ id: "denied" });
  const all = [shared, held, final, denied, generation({ deleted: true }), generation({ status: "running" }), generation({ shared: false })];
  const allowed = (g: Generation) => g.id !== "denied";
  it("bulk hold/unhold/finalize excludes wrong state and permission", () => {
    expect(reviewTargets(all, "held", allowed)).toEqual([shared, final]);
    expect(reviewTargets(all, "shared", allowed)).toEqual([held, final]);
    expect(reviewTargets(all, "final", allowed)).toEqual([shared, held]);
    expect(reviewTargets(all, "unshared", allowed)).toEqual([shared, held, final]);
  });
  it("shared and held filters both exclude final", () => {
    expect([shared, held, final].filter((g) => matchesReviewFilter(g, "shared"))).toEqual([shared]);
    expect([shared, held, final].filter((g) => matchesReviewFilter(g, "held"))).toEqual([held]);
  });
  it("owners may unshare held results but final transitions still require review permission", () => {
    expect(reviewTargets([generation({ is_mine: true, is_held: true })], "unshared", () => false)).toHaveLength(1);
    expect(reviewTargets([generation({ is_mine: true, is_final: true })], "unshared", () => false)).toEqual([]);
  });
  it("explicit arrows return held to shared or unshared without going straight to final", () => {
    expect(computeGradeStep([held, shared, final], "up", allowed).ops.map((op) => op.action)).toEqual(["unhold", "finalize"]);
    expect(computeGradeStep([held, shared, final], "down", allowed).ops.map((op) => op.action)).toEqual(["unpublish", "unpublish", "unfinalize"]);
  });
  it.each([
    ["up", "단계 올리기", "일반·보류→공유, 공유→최종"],
    ["down", "단계 내리기", "최종→공유, 공유·보류→일반"],
  ] as const)("%s copy has the shorter title and explains held transitions", (mode, title, transitions) => {
    const result = computeGradeStep([held], mode, allowed);
    const description = describeGradeStep(result);
    expect(description.title).toBe(title);
    expect(description.body).toBe(`선택한 1개를 한 단계 ${mode === "up" ? "올릴까요" : "내릴까요"}? (${transitions})`);
  });
});
