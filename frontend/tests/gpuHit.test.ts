import { describe, expect, it } from "vitest";
import { buildHitIndex, hitTop, isOccluded, queryRect, type HitBox } from "../src/features/canvas/gpu/gpuHit";

const box = (id: string, x = 0, y = 0, z = 0, w = 100, h = 100): HitBox => ({ id, x, y, z, w, h });

describe("GPU 공간 색인", () => {
  it("빈 색인·빈 곳·잘못된 질의", () => {
    const ix = buildHitIndex([]);
    expect(hitTop(ix, 0, 0)).toBeNull();
    expect(queryRect(ix, { l: -100, t: -100, r: 100, b: 100 })).toEqual([]);
    expect(queryRect(ix, { l: 1, t: 1, r: 0, b: 0 })).toEqual([]);
    expect(queryRect(ix, { l: 0, t: 0, r: Infinity, b: 0 })).toEqual([]);
    expect(isOccluded(ix, box("a"))).toBe(false);
  });

  it("음수 좌표·격자 경계·네 모서리와 테두리를 포함", () => {
    const a = box("a", -100, -100);
    const ix = buildHitIndex([a], 50);
    for (const [x, y] of [[-100, -100], [0, -100], [0, 0], [-100, 0], [-50, -50]]) expect(hitTop(ix, x, y)).toBe(a);
    expect(hitTop(ix, 0.001, 0)).toBeNull();
    expect(hitTop(ix, -100.001, 0)).toBeNull();
    expect(queryRect(ix, { l: 0, t: 0, r: 10, b: 10 })).toEqual([a]);
  });

  it("z가 큰 것이 앞, 같은 z면 입력 배열에서 나중에 그린 것이 앞", () => {
    const a = box("a", 0, 0, 2), b = box("b", 0, 0, 1), c = box("c", 0, 0, 2);
    expect(hitTop(buildHitIndex([a, b]), 50, 50)).toBe(a);
    expect(hitTop(buildHitIndex([a, b, c]), 50, 50)).toBe(c);
    expect(hitTop(buildHitIndex([c, a, b]), 50, 50)).toBe(a);
  });

  it("여러 칸을 덮는 상자도 질의 결과에 한 번만 포함", () => {
    const a = box("large", -1000, -1000, 0, 2000, 2000), b = box("small", 900, 900, 1);
    const ix = buildHitIndex([a, b], 100);
    expect(queryRect(ix, { l: -2000, t: -2000, r: 2000, b: 2000 })).toEqual([a, b]);
    expect(queryRect(ix, { l: -10, t: -10, r: 10, b: 10 })).toEqual([a]);
    expect(hitTop(ix, 950, 950)).toBe(b);
    expect(hitTop(ix, -999, -999)).toBe(a);
  });

  it("극단적으로 큰 상자는 빈 칸을 만들지 않고 같은 순서로 판정", () => {
    const a = box("huge", -1e6, -1e6, 0, 2e6, 2e6), b = box("small");
    const ix = buildHitIndex([a, b]);
    expect(ix.cells.size).toBe(1);
    expect(hitTop(ix, 50, 50)).toBe(b);
    expect(hitTop(buildHitIndex([b, a]), 50, 50)).toBe(a);
    expect(hitTop(ix, 900_000, 900_000)).toBe(a);
    expect(queryRect(ix, { l: 0, t: 0, r: 10, b: 10 })).toHaveLength(2);
  });

  it("일부라도 앞의 상자와 면적으로 겹치면 가림, 같은 z·뒷상자·닿기만 함은 제외", () => {
    const a = box("a");
    expect(isOccluded(buildHitIndex([a, box("b", 99, 99, 1)]), a)).toBe(true);
    expect(isOccluded(buildHitIndex([a, box("b", 99, 99, 0)]), a)).toBe(false);
    expect(isOccluded(buildHitIndex([a, box("b", 99, 99, -1)]), a)).toBe(false);
    expect(isOccluded(buildHitIndex([a, box("b", 100, 0, 1)]), a)).toBe(false);
    expect(isOccluded(buildHitIndex([a]), a)).toBe(false);
    expect(isOccluded(buildHitIndex([a, box("b", 10, 10, 1, 10, 10)]), a)).toBe(true);
  });

  it("0 크기·유효하지 않은 격자나 크기", () => {
    const a = box("point", 0, 0, 0, 0, 0);
    expect(hitTop(buildHitIndex([a]), 0, 0)).toBe(a);
    for (const cell of [0, -1, Infinity, NaN]) expect(() => buildHitIndex([], cell)).toThrow(RangeError);
    expect(() => buildHitIndex([box("bad", 0, 0, 0, -1)])).toThrow(RangeError);
  });

  it("2,000장 빌드 중앙값 10ms 미만·점 판정은 해당 칸만 읽는다", () => {
    const boxes = Array.from({ length: 2000 }, (_, i) => box(String(i), (i % 50) * 300, Math.floor(i / 50) * 250, i, 150, 120));
    buildHitIndex(boxes);
    const times = Array.from({ length: 7 }, () => {
      const start = performance.now();
      buildHitIndex(boxes);
      return performance.now() - start;
    }).sort((a, b) => a - b);
    expect(times[3]).toBeLessThan(10);
    const ix = buildHitIndex(boxes);
    let reads = 0;
    for (const b of boxes) {
      const x = b.x;
      Object.defineProperty(b, "x", { get: () => { reads++; return x; } });
    }
    expect(hitTop(ix, 10, 10)?.id).toBe("0");
    expect(reads).toBeLessThan(20);
  });
});
