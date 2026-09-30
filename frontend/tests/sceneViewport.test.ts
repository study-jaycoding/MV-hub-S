import { describe, expect, it } from "vitest";
import {
  centerSceneCamera,
  clampSceneZoom,
  clientToScenePoint,
  frameSceneRects,
  minimapViewBox,
  panSceneCamera,
  SCENE_CULL_REFRESH_DISTANCE,
  SCENE_MAX_ZOOM,
  SCENE_MIN_ZOOM,
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

  it("미니맵 보는 영역 상자는 지도 안으로 자르고 정수 px 로 — 조금이라도 보이면 최소 1px(Codex)", () => {
    expect(minimapViewBox(10.4, 20.6, 60.2, 50.5, 180, 130)).toEqual({ x: 10, y: 21, w: 50, h: 30 });
    expect(minimapViewBox(-30, -10, 100.3, 200, 180, 130)).toEqual({ x: 0, y: 0, w: 100, h: 130 }); // 가장자리에서 잘림
    expect(minimapViewBox(50.2, 40, 50.4, 40.3, 180, 130)).toEqual({ x: 50, y: 40, w: 1, h: 1 }); // 아주 작아도 1px
    expect(minimapViewBox(200, 150, 260, 190, 180, 130)).toEqual({ x: 180, y: 130, w: 0, h: 0 }); // 지도 밖
    // 오른쪽·아래 끝에 1px 미만만 걸쳐도 지도 안에 보인다 — 반올림으로 x=180 에 놓이면 안 보였다(Codex)
    expect(minimapViewBox(179.6, 129.7, 180.4, 130.5, 180, 130)).toEqual({ x: 179, y: 129, w: 1, h: 1 });
    // 잘리지 않은 상자를 옮기기만 하면 크기는 그대로다 — 양 끝을 따로 반올림하면 50·51 로 흔들려 걸음마다 다시 칠했다
    const moved = [10.4, 10.6, 10.8].map((x) => minimapViewBox(x, 5.3, x + 50.1, 35.3, 180, 130));
    expect(new Set(moved.map((box) => `${box.w}x${box.h}`))).toEqual(new Set(["50x30"]));
  });

  it("씬 파일에서 온 확대값은 화면이 만들 수 있는 범위로 맞춘다(격자 층 여백·NaN 방지, Codex)", () => {
    expect(clampSceneZoom(3)).toBe(SCENE_MAX_ZOOM);
    expect(clampSceneZoom(0)).toBe(SCENE_MIN_ZOOM);
    expect(clampSceneZoom(Number.NaN)).toBe(1);
    expect(clampSceneZoom(undefined)).toBe(1);
    expect(clampSceneZoom(0.4)).toBe(0.4);
  });

  it("보이는 범위는 네 변 중 하나가 500 canvas px 넘게 움직일 때만 새로 잡는다", () => {
    const viewport = { width: 2560, height: 1400 };
    const far = { z: 0.25, x: 0, y: 0 };
    const current = sceneViewRect(far, viewport);
    expect(SCENE_CULL_REFRESH_DISTANCE).toBe(500);
    expect(sameSceneViewRect(null, current)).toBe(false); // 첫 측정은 바로
    // 25% 에서 화면 124px 이동 = 496 canvas px → 그대로, 126px = 504 → 새로
    expect(sameSceneViewRect(current, sceneViewRect(panSceneCamera(far, 124, 0), viewport))).toBe(true);
    expect(sameSceneViewRect(current, sceneViewRect(panSceneCamera(far, 126, 0), viewport))).toBe(false);
    // 25% 에서 축소 한 칸 = 변마다 512 → 새로
    expect(sameSceneViewRect(current, sceneViewRect(zoomSceneCameraAt(far, 1280, 700, 1), viewport))).toBe(false);
    // 100% 에서 확대 한 칸 = 변마다 116 → 그대로(좁아진 화면은 이미 그린 범위 안)
    const near = { z: 1, x: 0, y: 0 };
    const nearRect = sceneViewRect(near, viewport);
    expect(sameSceneViewRect(nearRect, sceneViewRect(zoomSceneCameraAt(near, 1280, 700, -1), viewport))).toBe(true);
    // 창을 600px 넓힘 → 새로
    expect(sameSceneViewRect(nearRect, sceneViewRect(near, { width: 3160, height: 1400 }))).toBe(false);
  });
});
