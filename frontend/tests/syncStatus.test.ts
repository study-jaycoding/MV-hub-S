import { describe, expect, it } from "vitest";

import {
  formatTelemetryLastSuccess,
  latestSyncSuccess,
  syncFailedCount,
  syncPendingCount,
  type SyncStatus,
} from "../src/lib/useSyncStatus";

const status = (overrides: Partial<SyncStatus> = {}): SyncStatus => ({
  pending: 0,
  failed: 0,
  last_error: null,
  oldest_dirty: null,
  last_success_at: null,
  account_report_pending: 0,
  account_report_failed: 0,
  account_report_last_error: null,
  account_report_oldest_dirty: null,
  account_report_last_success_at: null,
  ...overrides,
});

describe("telemetry sync status", () => {
  it("생성정보와 계정 보고 중 더 최근 성공 시각을 선택한다", () => {
    expect(
      latestSyncSuccess(
        status({
          last_success_at: "2026-08-16T01:00:00Z",
          account_report_last_success_at: "2026-08-16T02:00:00Z",
        }),
      ),
    ).toBe("2026-08-16T02:00:00Z");
  });

  it("한 채널의 시각이 깨졌으면 정상인 다른 채널을 선택한다", () => {
    expect(
      latestSyncSuccess(
        status({
          last_success_at: "not-a-date",
          account_report_last_success_at: "2026-08-16T02:00:00Z",
        }),
      ),
    ).toBe("2026-08-16T02:00:00Z");
  });

  it("모든 성공 시각이 깨졌으면 오류 표시를 위해 원문을 보존한다", () => {
    expect(latestSyncSuccess(status({ last_success_at: "not-a-date" }))).toBe("not-a-date");
  });

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

  it("생성정보와 계정·거래 보고의 대기·실패를 합산한다", () => {
    const value = status({
      pending: 2,
      failed: 1,
      account_report_pending: 3,
      account_report_failed: 2,
      account_report_dead: 4,
    });
    expect(syncPendingCount(value)).toBe(5);
    expect(syncFailedCount(value)).toBe(7);
  });
});
