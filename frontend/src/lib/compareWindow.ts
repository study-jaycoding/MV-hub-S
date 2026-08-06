export interface CompareWindowRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const COMPARE_WINDOW_MIN_WIDTH = 560;
export const COMPARE_WINDOW_MIN_HEIGHT = 360;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum));

export function moveCompareWindow(
  start: CompareWindowRect,
  deltaX: number,
  deltaY: number,
  viewportWidth: number,
  viewportHeight: number,
): CompareWindowRect {
  return {
    ...start,
    left: clamp(start.left + deltaX, 0, viewportWidth - start.width),
    top: clamp(start.top + deltaY, 0, viewportHeight - start.height),
  };
}

export function resizeCompareWindow(
  start: CompareWindowRect,
  deltaX: number,
  deltaY: number,
  viewportWidth: number,
  viewportHeight: number,
): CompareWindowRect {
  const availableWidth = Math.max(0, viewportWidth - start.left);
  const availableHeight = Math.max(0, viewportHeight - start.top);
  const minimumWidth = Math.min(COMPARE_WINDOW_MIN_WIDTH, availableWidth);
  const minimumHeight = Math.min(COMPARE_WINDOW_MIN_HEIGHT, availableHeight);
  return {
    ...start,
    width: clamp(start.width + deltaX, minimumWidth, availableWidth),
    height: clamp(start.height + deltaY, minimumHeight, availableHeight),
  };
}

export function fitCompareWindowToViewport(
  rect: CompareWindowRect,
  viewportWidth: number,
  viewportHeight: number,
): CompareWindowRect {
  const width = Math.min(rect.width, viewportWidth);
  const height = Math.min(rect.height, viewportHeight);
  return moveCompareWindow(
    { ...rect, width, height },
    0,
    0,
    viewportWidth,
    viewportHeight,
  );
}
