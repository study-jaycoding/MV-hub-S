import { describe, expect, it } from "vitest";
import { paginateUsageItems } from "../src/lib/usagePagination";

describe("usage pagination", () => {
  it("returns the requested page and leaves a short final page", () => {
    const page = paginateUsageItems(Array.from({ length: 12 }, (_, index) => index + 1), 3, 5);

    expect(page).toEqual({
      items: [11, 12],
      page: 3,
      pageSize: 5,
      totalPages: 3,
    });
  });

  it("clamps invalid and out-of-range pages", () => {
    expect(paginateUsageItems([1, 2, 3], 99, 5).page).toBe(1);
    expect(paginateUsageItems([1, 2, 3], 0, 5).page).toBe(1);
    expect(paginateUsageItems([], Number.NaN, Number.NaN)).toEqual({
      items: [],
      page: 1,
      pageSize: 5,
      totalPages: 1,
    });
  });
});
