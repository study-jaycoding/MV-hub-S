export const SCENE_MIN_ZOOM = 0.05;
export const SCENE_MAX_ZOOM = 2.5;
// 뷰포트 밖 이 canvas px 까지는 카드를 유지한다(가장자리 팝인 완화). 다이얼: 줄이면 메모리↓·팝인↑
export const SCENE_CULL_MARGIN = 1500;
// 보이는 범위(viewRect)는 네 변 중 하나가 이 canvas px 넘게 움직일 때만 새로 잡는다 — 팬·줌마다
// SceneBoard 전체를 다시 그리지 않게. 여백의 1/3 이라 갱신 전에도 나머지 2/3 가 팝인을 막는다.
export const SCENE_CULL_REFRESH_DISTANCE = SCENE_CULL_MARGIN / 3;
// 툴바에 보이는 % 가 이 값 이하이면 카드의 작은 조각을 숨긴다(Jay 2026-09-29 시안 승인, scene.css '멀리서 볼 때 단순화').
export const SCENE_LOD_PCT = 25;
// 툴바 % 가 이 값 미만이면 카드 글을 읽을 수 없다 — 넘치는 칸의 아래 흐림(scene.css)을 뺀다. 흐림은 칸마다 합성 레이어를
// 늘려(41% 실측 레이어 97 → 184, 메인 스레드 +10%) 넘치는 칸이 많이 보이는 저배율일수록 비싸다.
export const SCENE_TEXT_FAR_PCT = 50;

export interface SceneCamera {
  z: number;
  x: number;
  y: number;
}

export interface SceneViewportSize {
  width: number;
  height: number;
}

export interface SceneWorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneViewRect {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** 씬 파일·저장본에서 온 확대값을 화면이 만들 수 있는 범위로 맞춘다 — 범위 밖(z:3·z:0·NaN)이면 점 격자 층의 64px 여백
 *  가정(최대 22px×2.5)이 깨지고, 0 이면 격자 계산이 NaN 이 된다(Codex 2026-09-29). */
export function clampSceneZoom(z: number | undefined): number {
  return Number.isFinite(z) ? Math.min(SCENE_MAX_ZOOM, Math.max(SCENE_MIN_ZOOM, z as number)) : 1;
}

export function clientToScenePoint(
  clientX: number,
  clientY: number,
  viewportLeft: number,
  viewportTop: number,
  camera: SceneCamera,
) {
  return {
    x: (clientX - viewportLeft - camera.x) / camera.z,
    y: (clientY - viewportTop - camera.y) / camera.z,
  };
}

export function sceneViewRect(
  camera: SceneCamera,
  viewport: SceneViewportSize,
): SceneViewRect {
  return {
    l: -camera.x / camera.z,
    t: -camera.y / camera.z,
    r: (viewport.width - camera.x) / camera.z,
    b: (viewport.height - camera.y) / camera.z,
  };
}

export function sameSceneViewRect(
  left: SceneViewRect | null,
  right: SceneViewRect,
  eps = SCENE_CULL_REFRESH_DISTANCE,
) {
  return (
    !!left &&
    Math.abs(left.l - right.l) <= eps &&
    Math.abs(left.t - right.t) <= eps &&
    Math.abs(left.r - right.r) <= eps &&
    Math.abs(left.b - right.b) <= eps
  );
}

/** 커서 아래 월드 좌표를 고정한 채 한 단계 확대하거나 축소한다. */
export function zoomSceneCameraAt(
  camera: SceneCamera,
  cursorX: number,
  cursorY: number,
  deltaY: number,
  minZoom = SCENE_MIN_ZOOM,
  maxZoom = SCENE_MAX_ZOOM,
): SceneCamera {
  const nextZoom = Math.min(
    maxZoom,
    Math.max(minZoom, camera.z * (deltaY < 0 ? 1.1 : 1 / 1.1)),
  );
  if (nextZoom === camera.z) return camera;
  const ratio = nextZoom / camera.z;
  return {
    z: nextZoom,
    x: cursorX - (cursorX - camera.x) * ratio,
    y: cursorY - (cursorY - camera.y) * ratio,
  };
}

export function centerSceneCamera(
  camera: SceneCamera,
  viewport: SceneViewportSize,
  worldX: number,
  worldY: number,
): SceneCamera {
  return {
    z: camera.z,
    x: viewport.width / 2 - worldX * camera.z,
    y: viewport.height / 2 - worldY * camera.z,
  };
}

export function panSceneCamera(
  camera: SceneCamera,
  deltaX: number,
  deltaY: number,
): SceneCamera {
  return { z: camera.z, x: camera.x + deltaX, y: camera.y + deltaY };
}

/** 월드 사각형들이 화면 안에 여백을 두고 들어오도록 카메라를 계산한다. */
export function frameSceneRects(
  rects: readonly SceneWorldRect[],
  viewport: SceneViewportSize,
  maxZoom: number,
  padding = 0.82,
  minZoom = SCENE_MIN_ZOOM,
): SceneCamera | null {
  if (!rects.length) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const zoom = Math.min(
    maxZoom,
    Math.max(
      minZoom,
      Math.min((viewport.width * padding) / width, (viewport.height * padding) / height),
    ),
  );
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    z: zoom,
    x: viewport.width / 2 - centerX * zoom,
    y: viewport.height / 2 - centerY * zoom,
  };
}
