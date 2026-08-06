import { describe, expect, it } from "vitest";
import {
  COMPARE_WINDOW_MIN_HEIGHT,
  COMPARE_WINDOW_MIN_WIDTH,
  fitCompareWindowToViewport,
  moveCompareWindow,
  resizeCompareWindow,
} from "../src/lib/compareWindow";

const start = { left: 100, top: 80, width: 900, height: 600 };

describe("compareWindow", () => {
  it("이동할 때 창 전체가 화면 밖으로 빠져나가지 않는다", () => {
    expect(moveCompareWindow(start, -500, -500, 1200, 800)).toEqual({
      ...start,
      left: 0,
      top: 0,
    });
    expect(moveCompareWindow(start, 500, 500, 1200, 800)).toEqual({
      ...start,
      left: 300,
      top: 200,
    });
  });

  it("크기 조절은 최소 크기와 현재 화면 경계를 지킨다", () => {
    expect(resizeCompareWindow(start, -1000, -1000, 1200, 800)).toEqual({
      ...start,
      width: COMPARE_WINDOW_MIN_WIDTH,
      height: COMPARE_WINDOW_MIN_HEIGHT,
    });
    expect(resizeCompareWindow(start, 1000, 1000, 1200, 800)).toEqual({
      ...start,
      width: 1100,
      height: 720,
    });
  });

  it("브라우저 창이 작아지면 비교 창도 새 화면 안으로 복귀한다", () => {
    expect(fitCompareWindowToViewport(start, 800, 500)).toEqual({
      left: 0,
      top: 0,
      width: 800,
      height: 500,
    });
  });
});
