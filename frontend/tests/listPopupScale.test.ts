import { describe, expect, it } from "vitest";

import { listPopScale } from "../src/components/scene/cards/ListCard";

// 리스트 크게 보기 배율(Jay 2026-11-10 "적정 비율로" — Codex 합의 규칙). 화면 = 1920×1000 막(가용 1872×888), 1366×768 막(가용 1318×656).
const BIG = { availW: 1872, availH: 888 };
const tile = (k: number, item: number) => Math.round(k * item);

describe("listPopScale", () => {
  it("그림 1 — 기본 폭 노드는 지금처럼 보이던 칸의 2배(약 55px)", () => {
    const k = listPopScale({ w: 152, h: 202, shown: 0.655, item: 42, grid: true, ...BIG });
    expect(k).toBeCloseTo(1.31, 5);
    expect(tile(k, 42)).toBe(55);
  });

  it("그림 2 — 넓혀 둔 노드(칸 152)는 칸 104px 로 묶인다", () => {
    const k = listPopScale({ w: 635, h: 790, shown: 0.4, item: 152, grid: true, ...BIG });
    expect(tile(k, 152)).toBe(104);
    expect(Math.round(635 * k)).toBe(434);
  });

  it("크게 확대해 본 노드도 칸 104px — 캔버스 위 노드보다 작아질 수 있다", () => {
    const k = listPopScale({ w: 635, h: 790, shown: 1, item: 152, grid: true, ...BIG });
    expect(tile(k, 152)).toBe(104);
    expect(k).toBeLessThan(1);
  });

  it("아주 멀리서 본 노드는 칸 48px 까지는 키운다", () => {
    const k = listPopScale({ w: 152, h: 202, shown: 0.1, item: 42, grid: true, ...BIG });
    expect(tile(k, 42)).toBe(48);
  });

  it("행 리스트는 행 높이 32~44px", () => {
    expect(tile(listPopScale({ w: 220, h: 300, shown: 1, item: 24, grid: false, ...BIG }), 24)).toBe(44);
    expect(tile(listPopScale({ w: 220, h: 300, shown: 0.3, item: 24, grid: false, ...BIG }), 24)).toBe(32);
    expect(tile(listPopScale({ w: 220, h: 300, shown: 0.8, item: 24, grid: false, ...BIG }), 24)).toBe(38);
  });

  it("좁고 긴 노드는 가용 높이 75%, 넓고 낮은 노드는 가용 폭 80% 에 걸린다", () => {
    const tall = listPopScale({ w: 160, h: 2000, shown: 1, item: 42, grid: true, ...BIG });
    expect(2000 * tall).toBeCloseTo(888 * 0.75, 5);
    const wide = listPopScale({ w: 3000, h: 100, shown: 1, item: 42, grid: true, ...BIG });
    expect(3000 * wide).toBeCloseTo(1872 * 0.8, 5);
  });

  it("작은 화면(1366×768)에서는 전체 높이 상한이 먼저 걸린다", () => {
    const k = listPopScale({ w: 635, h: 790, shown: 0.4, item: 152, grid: true, availW: 1318, availH: 656 });
    expect(790 * k).toBeCloseTo(656 * 0.75, 5);
    expect(tile(k, 152)).toBeLessThan(104);
  });

  it("칸을 못 재면 2배와 전체 상한만 — 옛 '최소 원래 크기'로 키우지 않는다", () => {
    expect(listPopScale({ w: 152, h: 202, shown: 0.3, item: 0, grid: false, ...BIG })).toBeCloseTo(0.6, 5);
    expect(listPopScale({ w: 635, h: 790, shown: 0.4, item: Number.NaN, grid: true, ...BIG })).toBeCloseTo(0.8, 5);
  });
});
