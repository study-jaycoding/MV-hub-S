import { describe, expect, it } from "vitest";
import { hasPersonalQuota, quotaUncertainty, showsWorkspacePool, type MyCreditQuota } from "../src/lib/myCreditQuota";

const quota = {
  workspace_id: "ws", source: "override", quota: 4000, remaining: 2765.5,
  used: 1234.5, used_real: 1234.5, used_estimated: 0, estimated_count: 0, unknown_count: 0,
} as MyCreditQuota;

describe("personal quota presentation", () => {
  it("uses the personal allocation, including an exhausted zero allocation", () => {
    expect(hasPersonalQuota(quota)).toBe(true);
    expect(hasPersonalQuota({ ...quota, quota: 0, remaining: -0.12 })).toBe(true);
    expect(quotaUncertainty(quota)).toBe("");
  });
  it("does not turn missing authority or an unassigned member into a personal balance", () => {
    for (const source of ["unavailable", "unassigned", "unlimited"] as const) {
      expect(hasPersonalQuota({ ...quota, source })).toBe(false);
    }
    expect(hasPersonalQuota(null)).toBe(false);
    expect(hasPersonalQuota({ ...quota, remaining: Number.NaN })).toBe(false);
    expect(hasPersonalQuota({ ...quota, quota: Infinity })).toBe(false);
  });
  it("shows the workspace pool to members without a personal allocation — no group limit or no group (Jay 2026-09-29)", () => {
    expect(showsWorkspacePool({ ...quota, source: "unassigned" })).toBe(true);
    expect(showsWorkspacePool({ ...quota, source: "unlimited" })).toBe(true);
    for (const source of ["auto", "override", "unavailable"] as const) {
      expect(showsWorkspacePool({ ...quota, source })).toBe(false);
    }
    expect(showsWorkspacePool(null)).toBe(false);
  });
  it("marks estimates including free estimates and unknown usage", () => {
    expect(quotaUncertainty({ ...quota, estimated_count: 1, unknown_count: 2 })).toBe("견적 사용량 1건 포함 · 사용량 미확인 2건");
  });
});
