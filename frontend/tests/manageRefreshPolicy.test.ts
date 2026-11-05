import { describe, expect, it } from "vitest";
import {
  manageRefreshDelay,
  shouldRefreshManageForLibrarySync,
  shouldRunManageFallbackRefresh,
} from "../src/lib/manageRefreshPolicy";

describe("관리 창 안전망 갱신 정책", () => {
  it("숨겨진 관리 창에서는 안전망 요청을 보내지 않는다", () => {
    expect(
      shouldRunManageFallbackRefresh({
        hidden: true,
        lastRefreshAt: 0,
        now: 30_000,
      }),
    ).toBe(false);
  });

  it("실시간 갱신 직후 5초 동안 안전망 요청을 합친다", () => {
    expect(
      shouldRunManageFallbackRefresh({
        hidden: false,
        lastRefreshAt: 10_000,
        now: 14_999,
      }),
    ).toBe(false);
    expect(
      shouldRunManageFallbackRefresh({
        hidden: false,
        lastRefreshAt: 10_000,
        now: 15_000,
      }),
    ).toBe(true);
  });

  it("출처 없는 manage 신호는 마지막 재조회 뒤 10초 간격, 출처 있는 변경은 바로", () => {
    // 방금(2초 전) 다시 읽었다 — 출처 없는 신호는 남은 8초를 기다린다
    expect(manageRefreshDelay({ originless: true, lastRefreshAt: 10_000, now: 12_000 })).toBe(8_000);
    // 오래전에 읽었으면 지금처럼 0.18초
    expect(manageRefreshDelay({ originless: true, lastRefreshAt: 0, now: 60_000 })).toBe(180);
    // 사람의 편집(출처 있음)은 간격과 상관없이 0.18초
    expect(manageRefreshDelay({ originless: false, lastRefreshAt: 10_000, now: 12_000 })).toBe(180);
  });

  it("출처 없는 synced는 안전망에 맡기고 브라우저 변경만 즉시 반영한다", () => {
    expect(shouldRefreshManageForLibrarySync(undefined)).toBe(false);
    expect(shouldRefreshManageForLibrarySync([])).toBe(false);
    expect(shouldRefreshManageForLibrarySync([{ mutation_id: "m1" }])).toBe(true);
  });
});
