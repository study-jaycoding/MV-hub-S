import { describe, expect, it } from "vitest";
import { clampFloatingPanelPosition } from "../src/lib/useFloatingPanel";

describe("clampFloatingPanelPosition", () => {
  it("창 머리뿐 아니라 창 전체가 화면 안에 들어오도록 보정한다", () => {
    expect(
      clampFloatingPanelPosition(
        { x: 0, y: 431 },
        { width: 320, height: 380 },
        { width: 1180, height: 723 },
      ),
    ).toEqual({ x: 8, y: 335 });
  });

  it("화면보다 큰 저장 크기도 안전 여백 안쪽에서 시작한다", () => {
    expect(
      clampFloatingPanelPosition(
        { x: 2600, y: 1500 },
        { width: 1600, height: 1000 },
        { width: 1180, height: 723 },
      ),
    ).toEqual({ x: 8, y: 8 });
  });
});
