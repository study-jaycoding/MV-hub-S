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

/** 끌어 옮기는 창의 자리 — 머리(위쪽 줄)가 화면 안에 남게 한다. 밖으로 나가면 다시 잡을 수 없다(2026-10-10 실측: 컷 정보 창). */
export function keepHeadReachable(x: number, y: number, width: number): { x: number; y: number } {
  const keep = 80; // 가로로 이만큼은 보이게
  return {
    x: Math.max(keep - width, Math.min(window.innerWidth - keep, x)),
    y: Math.max(0, Math.min(window.innerHeight - 40, y)),
  };
}
