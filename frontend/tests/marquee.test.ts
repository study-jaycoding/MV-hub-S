import { describe, expect, it } from "vitest";
import { resolveMarqueeSelection } from "../src/lib/marquee";

describe("resolveMarqueeSelection", () => {
  it("일반 마퀴는 기존 선택을 교차 카드로 교체한다", () => {
    expect(
      [...resolveMarqueeSelection(new Set(["old"]), new Set(["a", "b"]), false, true)],
    ).toEqual(["a", "b"]);
  });

  it("추가 마퀴는 기존 선택과 교차 카드를 합친다", () => {
    expect(
      [...resolveMarqueeSelection(new Set(["old"]), new Set(["new"]), true, false)],
    ).toEqual(["old", "new"]);
  });

  it("빈 마퀴의 선택 유지 정책을 화면별로 적용한다", () => {
    const previous = new Set(["old"]);

    expect([...resolveMarqueeSelection(previous, new Set(), false, true)]).toEqual(["old"]);
    expect([...resolveMarqueeSelection(previous, new Set(), false, false)]).toEqual([]);
  });
});
