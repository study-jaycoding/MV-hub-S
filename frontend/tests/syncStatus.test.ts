import { describe, expect, it } from "vitest";

import { formatTelemetryLastSuccess } from "../src/lib/useSyncStatus";

describe("telemetry sync status", () => {
  it("성공 기록이 없으면 그 상태를 명확히 표시한다", () => {
    expect(formatTelemetryLastSuccess(null)).toBe("마지막 성공 기록 없음");
  });

  it("깨진 시각은 잘못된 날짜로 표시하지 않는다", () => {
    expect(formatTelemetryLastSuccess("not-a-date")).toBe("마지막 성공 시각 확인 불가");
  });

  it("UTC 성공 시각을 한국 시간 안내로 변환한다", () => {
    const text = formatTelemetryLastSuccess("2026-08-16T01:23:45.000Z");
    expect(text).toContain("마지막 성공");
    expect(text).toContain("2026");
    expect(text).toContain("10:23");
  });
});
