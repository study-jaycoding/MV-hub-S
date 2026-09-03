import { describe, expect, it } from "vitest";
import { marqueeHits, resolveMarqueeSelection } from "../src/lib/marquee";

// querySelectorAll + getBoundingClientRect 만 쓰는 함수라 최소 스텁으로 충분하다.
const gridOf = (cells: { key: string; left: number; top: number; right: number; bottom: number }[]) =>
  ({
    querySelectorAll: () =>
      cells.map((cell) => ({
        getBoundingClientRect: () => cell,
        dataset: { key: cell.key },
      })),
  }) as unknown as HTMLElement;

describe("marqueeHits — 잡는 기준", () => {
  const grid = gridOf([
    { key: "inside", left: 20, top: 20, right: 40, bottom: 40 },
    { key: "overlap", left: 90, top: 90, right: 200, bottom: 200 }, // 모서리만 걸친다
  ]);
  const box = { x0: 0, y0: 0, x1: 100, y1: 100 };
  const keyOf = (el: HTMLElement) => el.dataset.key;

  it("기본(intersect)은 살짝만 걸쳐도 잡는다 — 카드 선택", () => {
    expect([...marqueeHits<string>(grid, ".x", box, [], keyOf)].sort()).toEqual([
      "inside",
      "overlap",
    ]);
  });

  it("contain 은 완전히 감쌌을 때만 잡는다 — 그룹 선택", () => {
    // 그룹은 크다. 걸치기만 해도 잡히면 안쪽 카드 몇 개를 고를 때마다 딸려온다.
    expect([...marqueeHits<string>(grid, ".x", box, [], keyOf, "contain")]).toEqual(["inside"]);
  });
});

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
