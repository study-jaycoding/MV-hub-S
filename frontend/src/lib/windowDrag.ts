export function addWindowMouseDrag(
  onMove: (e: MouseEvent) => void,
  onUp: (e: MouseEvent) => void,
): void {
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

export function removeWindowMouseDrag(
  onMove: (e: MouseEvent) => void,
  onUp: (e: MouseEvent) => void,
): void {
  window.removeEventListener("mousemove", onMove);
  window.removeEventListener("mouseup", onUp);
}

export function addWindowPointerDrag(
  onMove: (e: PointerEvent) => void,
  onUp: (e: PointerEvent) => void,
): void {
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

export function removeWindowPointerDrag(
  onMove: (e: PointerEvent) => void,
  onUp: (e: PointerEvent) => void,
): void {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
}
