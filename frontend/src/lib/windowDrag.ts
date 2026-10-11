// ── 놓친 mouseup ──
//  단추를 다 뗀 채 온 움직임·창을 떠남(blur)·pointercancel 은 끌기의 끝이다(조작 규칙 21 — 캔버스 밖의 끌기도 같다). 전엔 move·up 만
//  걸어, mouseup 을 놓친 마퀴·창 이동·재생헤드가 단추를 뗀 마우스를 계속 따라왔다(2026-10-11 Codex 통합 검토·격리 실측).
//  그때 onUp 을 **그 이벤트**(mousemove·blur·pointercancel)로 부른다 — 뗀 뒤의 자리는 onMove 에 넘기지 않는다. 놓쳐서 끝난 것을
//  가려야 하는 쪽(클릭 판정·끝점 확정)은 dragLost(e) 로 본다. 리스너는 스스로 떼지 않는다 — mouseup 때처럼 onUp 이 remove 를 부른다.
type Guard = { move: (e: MouseEvent) => void; end: (e: Event) => void; up: (e: Event) => void };
const guards = new WeakMap<object, Guard>(); // onMove → 실제로 건 리스너(remove 가 같은 것을 뗀다)

function guardOf(onMove: (e: never) => void, onUp: (e: Event) => void): Guard {
  let guard = guards.get(onMove);
  if (!guard) {
    const made: Guard = {
      // '눌린 단추가 하나도 없다'로 본다 — 가운데 단추의 화면 이동(buttons 4)도 이 도우미를 쓴다
      move: (e) => (e.buttons === 0 ? made.up(e) : (onMove as (e: MouseEvent) => void)(e)),
      end: (e) => made.up(e),
      up: onUp,
    };
    guards.set(onMove, (guard = made));
  }
  guard.up = onUp;
  return guard;
}

/** 끌기가 놓쳐서 끝났는가 — mouseup·pointerup 이 아닌 것(단추 없는 움직임·blur·pointercancel)으로 끝났다. */
export const dragLost = (e?: Event): boolean => !!e && e.type !== "mouseup" && e.type !== "pointerup";

const MOUSE_END = ["mouseup", "blur"];
const POINTER_END = ["pointerup", "pointercancel", "blur"];

export function addWindowMouseDrag(
  onMove: (e: MouseEvent) => void,
  onUp: (e: Event) => void,
): void {
  const guard = guardOf(onMove, onUp);
  window.addEventListener("mousemove", guard.move);
  for (const type of MOUSE_END) window.addEventListener(type, guard.end);
}

export function removeWindowMouseDrag(
  onMove: (e: MouseEvent) => void,
  _onUp?: (e: Event) => void,
): void {
  const guard = guards.get(onMove);
  if (!guard) return;
  window.removeEventListener("mousemove", guard.move);
  for (const type of MOUSE_END) window.removeEventListener(type, guard.end);
}

export function addWindowPointerDrag(
  onMove: (e: PointerEvent) => void,
  onUp: (e: Event) => void,
): void {
  const guard = guardOf(onMove, onUp);
  window.addEventListener("pointermove", guard.move);
  for (const type of POINTER_END) window.addEventListener(type, guard.end);
}

export function removeWindowPointerDrag(
  onMove: (e: PointerEvent) => void,
  _onUp?: (e: Event) => void,
): void {
  const guard = guards.get(onMove);
  if (!guard) return;
  window.removeEventListener("pointermove", guard.move);
  for (const type of POINTER_END) window.removeEventListener(type, guard.end);
}

/** 끌어 옮기는 창의 자리 — 머리(위쪽 줄)가 화면 안에 남게 한다. 밖으로 나가면 다시 잡을 수 없다(2026-10-10 실측: 컷 정보 창). */
export function keepHeadReachable(x: number, y: number, width: number): { x: number; y: number } {
  const keep = 80; // 가로로 이만큼은 보이게
  return {
    x: Math.max(keep - width, Math.min(window.innerWidth - keep, x)),
    y: Math.max(0, Math.min(window.innerHeight - 40, y)),
  };
}
