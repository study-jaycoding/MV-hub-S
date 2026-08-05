export const SCENE_MIN_ZOOM = 0.05;
export const SCENE_MAX_ZOOM = 2.5;
export const SCENE_VIEW_RECT_EPS = 0.5;

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
  eps = SCENE_VIEW_RECT_EPS,
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
