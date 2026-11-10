import { describe, expect, it } from "vitest";

import { listPopCols, listPopScale } from "../src/components/scene/cards/ListCard";

// 리스트 크게 보기(Jay 2026-11-10 시안 확정) — 칸 104px·행 44px 고정, 모두 보이게, 5줄 넘으면 열을 늘리되 5열까지,
//  가용 폭 80%·높이 75% 를 넘으면 줄이고 격자 48px·행 32px 아래면 스크롤. 화면(막) 1920×1000 → 가용 1872×888.
const BIG = { availW: 1872, availH: 888 };
// 레이아웃 크기(칸 152·번호 글씨 29 → 틈 18.95·둘레 여백 15.95, 몸통 여백 8·테두리 2) — 시안과 같은 계산
const GAP = 29 * 0.55 + 3, PAD = 29 * 0.55;
const gridSize = (cols: number, rows: number) => ({
  w: 4 + 16 + 2 * PAD + cols * 152 + (cols - 1) * GAP,
  h: 4 + 16 + 2 * PAD + rows * 152 + (rows - 1) * GAP,
});

describe("listPopCols", () => {
  it("5줄까지는 노드와 같은 열", () => {
    expect(listPopCols(13, 3)).toBe(3);
    expect(listPopCols(12, 3)).toBe(3);
    expect(listPopCols(15, 3)).toBe(3);
  });

  it("5줄을 넘으면 열을 늘리되 5열까지", () => {
    expect(listPopCols(16, 3)).toBe(4);
    expect(listPopCols(30, 3)).toBe(5);
    expect(listPopCols(50, 3)).toBe(5);
    expect(listPopCols(80, 3)).toBe(5);
  });

  it("칸이 적으면 칸 수만큼, 노드가 6열 이상이어도 5열까지", () => {
    expect(listPopCols(2, 3)).toBe(2);
    expect(listPopCols(4, 6)).toBe(4);
    expect(listPopCols(8, 6)).toBe(5);
    expect(listPopCols(0, 3)).toBe(1);
  });
});

describe("listPopScale", () => {
  it("그림 2(13개 · 3열 5줄) — 칸 104px, 모두 보임", () => {
    const { w, h } = gridSize(3, 5);
    const s = listPopScale({ item: 152, grid: true, w, h, ...BIG });
    expect(Math.round(152 * s.k)).toBe(104);
    expect(s.h).toBe(h);
  });

  it("30개(5열 6줄) — 가용 높이 75% 에 맞춰 칸을 줄임(96px), 모두 보임", () => {
    const { w, h } = gridSize(5, 6);
    const s = listPopScale({ item: 152, grid: true, w, h, ...BIG });
    expect(h * s.k).toBeCloseTo(888 * 0.75, 5);
    expect(Math.round(152 * s.k)).toBe(96);
    expect(s.h).toBe(h);
  });

  it("80개(5열 16줄) — 칸 48px 에서 멈추고 보일 높이를 잘라 스크롤", () => {
    const { w, h } = gridSize(5, 16);
    const s = listPopScale({ item: 152, grid: true, w, h, ...BIG });
    expect(152 * s.k).toBeCloseTo(48, 5);
    expect(s.h * s.k).toBeCloseTo(888 * 0.75, 5);
    expect(s.h).toBeLessThan(h);
  });

  it("행 리스트 — 행 44px, 너무 길면 32px 에서 멈추고 스크롤", () => {
    expect(24 * listPopScale({ item: 24, grid: false, w: 220, h: 300, ...BIG }).k).toBeCloseTo(44, 5);
    const long = listPopScale({ item: 24, grid: false, w: 220, h: 2000, ...BIG });
    expect(24 * long.k).toBeCloseTo(32, 5);
    expect(long.h * long.k).toBeCloseTo(888 * 0.75, 5);
  });

  it("폭 상한은 스크롤로 못 풀어 그대로 지킨다(아주 넓은 행 리스트)", () => {
    const s = listPopScale({ item: 24, grid: false, w: 3000, h: 100, ...BIG });
    expect(3000 * s.k).toBeCloseTo(1872 * 0.8, 5);
    expect(s.h).toBe(100);
  });

  it("폭·높이 상한이 같이 걸리면 폭으로 본다(바닥 없음)", () => {
    // 정확히 같게 떨어지는 수(가용 2000×1000 → 상한 1600×750)
    const s = listPopScale({ item: 24, grid: false, w: 3200, h: 1500, availW: 2000, availH: 1000 });
    expect(s.k).toBe(0.5);
    expect(s.h).toBe(1500);
  });

  it("높이 때문에 스크롤하면서 폭이 바닥보다 먼저 걸리면 폭을 지킨다", () => {
    const s = listPopScale({ item: 24, grid: false, w: 1497.6, h: 2220, ...BIG });
    expect(s.k).toBeCloseTo(1, 5); // 바닥 32/24 대신 폭 상한 1
    expect(s.h * s.k).toBeCloseTo(888 * 0.75, 5);
  });

  it("작은 화면(1366×768 → 가용 1318×656)에서도 높이 75% 안", () => {
    const { w, h } = gridSize(3, 5);
    const s = listPopScale({ item: 152, grid: true, w, h, availW: 1318, availH: 656 });
    expect(h * s.k).toBeCloseTo(656 * 0.75, 5);
  });

  it("칸을 못 재면 원래 크기(1)보다 키우지 않는다", () => {
    expect(listPopScale({ item: 0, grid: false, w: 200, h: 300, ...BIG }).k).toBe(1);
    expect(listPopScale({ item: Number.NaN, grid: true, w: 600, h: 2000, ...BIG }).k).toBeCloseTo(666 / 2000, 5);
  });
});
