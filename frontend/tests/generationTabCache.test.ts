import { describe, expect, it } from "vitest";
import {
  GENERATION_TAB_CACHE_FRESH_MS,
  generationTabCacheIsFresh,
} from "../src/lib/useGenerationLibraryData";

describe("생성물 탭 캐시 신선도", () => {
  const entry = { gens: [], hasMore: false, sig: "team:q", loadedAt: 1_000 };

  it("같은 필터로 짧게 탭을 왕복하면 네트워크 재조회를 생략한다", () => {
    expect(generationTabCacheIsFresh(entry, "team:q", 1_000 + GENERATION_TAB_CACHE_FRESH_MS - 1)).toBe(true);
  });

  it("필터가 달라지거나 15초가 지나면 최신 목록을 다시 받는다", () => {
    expect(generationTabCacheIsFresh(entry, "team:other", 1_001)).toBe(false);
    expect(generationTabCacheIsFresh(entry, "team:q", 1_000 + GENERATION_TAB_CACHE_FRESH_MS)).toBe(false);
  });

  it("시계가 뒤로 움직인 비정상 값은 신선한 캐시로 오판하지 않는다", () => {
    expect(generationTabCacheIsFresh(entry, "team:q", 999)).toBe(false);
  });
});
