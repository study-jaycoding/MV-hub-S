import { describe, expect, it } from "vitest";
import {
  shouldRefreshManageForLibrarySync,
  shouldRunManageFallbackRefresh,
} from "../src/lib/manageRefreshPolicy";

describe("관리 창 안전망 갱신 정책", () => {
  it("실시간 갱신이 진행 중이면 안전망 요청을 추가하지 않는다", () => {
    expect(
      shouldRunManageFallbackRefresh({
        loading: true,
        lastLoadAt: 0,
        now: 30_000,
      }),
    ).toBe(false);
  });

  it("실시간 갱신이 방금 시작됐으면 완료 여부와 무관하게 5초 동안 합친다", () => {
    expect(
      shouldRunManageFallbackRefresh({
        loading: false,
        lastLoadAt: 10_000,
        now: 14_999,
      }),
    ).toBe(false);
    expect(
      shouldRunManageFallbackRefresh({
        loading: false,
        lastLoadAt: 10_000,
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
