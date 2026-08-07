import { describe, expect, it } from "vitest";
import {
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

  it("출처 없는 synced는 안전망에 맡기고 브라우저 변경만 즉시 반영한다", () => {
    expect(shouldRefreshManageForLibrarySync(undefined)).toBe(false);
    expect(shouldRefreshManageForLibrarySync([])).toBe(false);
    expect(shouldRefreshManageForLibrarySync([{ mutation_id: "m1" }])).toBe(true);
  });
});
