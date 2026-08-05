import { describe, expect, it } from "vitest";
import { shouldObserveProgressStatus } from "../src/lib/useGenerationProgress";

describe("shouldObserveProgressStatus", () => {
  it("처음 보는 active 상태는 완료 전환 기준선으로 관찰한다", () => {
    expect(shouldObserveProgressStatus("g1", "running", () => false)).toBe(true);
  });

  it("create 응답보다 먼저 온 미확정 done은 seedPending을 막지 않게 보류한다", () => {
    expect(shouldObserveProgressStatus("g1", "done", () => false)).toBe(false);
    expect(shouldObserveProgressStatus("g1", "failed", () => false)).toBe(false);
  });

  it("이미 pending을 관찰한 생성물의 종결 상태는 즉시 반영한다", () => {
    expect(shouldObserveProgressStatus("g1", "done", () => true)).toBe(true);
    expect(shouldObserveProgressStatus("g1", "failed", () => true)).toBe(true);
  });
});
