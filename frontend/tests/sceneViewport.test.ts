import { describe, expect, it } from "vitest";
import {
  centerSceneCamera,
  clientToScenePoint,
  frameSceneRects,
  panSceneCamera,
  sameSceneViewRect,
  sceneViewRect,
  zoomSceneCameraAt,
} from "../src/lib/sceneViewport";

describe("scene viewport calculations", () => {
  it("클라이언트 좌표를 팬·줌이 적용된 캔버스 좌표로 변환한다", () => {
    expect(clientToScenePoint(310, 270, 10, 20, { z: 2, x: 100, y: 50 })).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("현재 카메라가 보여주는 월드 사각형을 계산한다", () => {
    expect(sceneViewRect({ z: 2, x: -100, y: -50 }, { width: 800, height: 600 })).toEqual({
      l: 50,
      t: 25,
      r: 450,
      b: 325,
    });
  });

  it("휠 확대 전후에 커서 아래 월드 좌표를 유지한다", () => {
    const before = { z: 1, x: 100, y: 50 };
    const after = zoomSceneCameraAt(before, 250, 150, -1);

    expect(after.z).toBeCloseTo(1.1);
    expect(after.x).toBeCloseTo(85);
    expect(after.y).toBeCloseTo(40);
    expect((250 - before.x) / before.z).toBeCloseTo((250 - after.x) / after.z);
    expect((150 - before.y) / before.z).toBeCloseTo((150 - after.y) / after.z);
  });

  it("줌 상한과 하한을 넘지 않는다", () => {
    expect(zoomSceneCameraAt({ z: 2.5, x: 10, y: 20 }, 100, 100, -1)).toEqual({
      z: 2.5,
      x: 10,
      y: 20,
    });
    expect(zoomSceneCameraAt({ z: 0.05, x: 10, y: 20 }, 100, 100, 1)).toEqual({
      z: 0.05,
      x: 10,
      y: 20,
    });
  });

  it("미니맵이 지정한 월드 지점을 화면 중앙에 둔다", () => {
    expect(
      centerSceneCamera({ z: 0.5, x: 0, y: 0 }, { width: 800, height: 600 }, 200, 100),
    ).toEqual({ z: 0.5, x: 300, y: 250 });
  });

  it("화면 이동은 줌을 유지하고 마우스 이동량만큼 팬을 옮긴다", () => {
    expect(panSceneCamera({ z: 0.5, x: 100, y: 200 }, 30, -40)).toEqual({
      z: 0.5,
      x: 130,
      y: 160,
    });
  });

  it("여러 사각형 전체를 프레이밍하고 최대 줌을 지킨다", () => {
    expect(
      frameSceneRects(
        [
          { x: 0, y: 0, w: 100, h: 100 },
          { x: 300, y: 200, w: 100, h: 100 },
        ],
        { width: 800, height: 600 },
        1,
      ),
    ).toEqual({ z: 1, x: 200, y: 150 });
  });

  it("아주 큰 장면은 최소 줌에서 멈추고 빈 목록은 계산하지 않는다", () => {
    expect(
      frameSceneRects(
        [{ x: 0, y: 0, w: 100_000, h: 100_000 }],
        { width: 800, height: 600 },
        1,
      ),
    ).toEqual({ z: 0.05, x: -2100, y: -2200 });
    expect(frameSceneRects([], { width: 800, height: 600 }, 1)).toBeNull();
  });

  it("컬링 사각형의 미세한 차이는 동일한 화면으로 취급한다", () => {
    const current = { l: 10, t: 20, r: 30, b: 40 };
    expect(sameSceneViewRect(current, { l: 10.4, t: 19.6, r: 30.5, b: 39.5 })).toBe(true);
    expect(sameSceneViewRect(current, { l: 10.6, t: 20, r: 30, b: 40 })).toBe(false);
  });
});
