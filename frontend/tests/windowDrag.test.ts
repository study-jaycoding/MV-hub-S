// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addWindowMouseDrag,
  addWindowPointerDrag,
  dragLost,
  removeWindowMouseDrag,
  removeWindowPointerDrag,
} from "../src/lib/windowDrag";

// 끌기 하나 — 실제 쓰는 곳처럼 onUp 이 remove 를 부른다(도우미는 스스로 떼지 않는다).
function mouseDrag() {
  const moves: number[] = [];
  const ends: Event[] = [];
  const onMove = (e: MouseEvent) => moves.push(e.clientX);
  const onUp = (e: Event) => {
    ends.push(e);
    removeWindowMouseDrag(onMove, onUp);
  };
  addWindowMouseDrag(onMove, onUp);
  return { moves, ends, onMove, onUp };
}
const move = (clientX: number, buttons: number) => window.dispatchEvent(new MouseEvent("mousemove", { clientX, buttons }));

describe("창 전역 끌기 도우미 — 놓친 mouseup", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    vi.restoreAllMocks();
  });

  it("단추가 눌린 움직임은 그대로 넘기고 mouseup 으로 끝난다", () => {
    const d = mouseDrag();
    move(10, 1);
    move(20, 1);
    window.dispatchEvent(new MouseEvent("mouseup", { clientX: 20 }));
    move(30, 1);
    expect(d.moves).toEqual([10, 20]);
    expect(d.ends.map((e) => e.type)).toEqual(["mouseup"]);
    expect(dragLost(d.ends[0])).toBe(false);
  });

  it("단추를 다 뗀 채 온 움직임은 끌기의 끝이다 — 그 자리는 넘기지 않고, 뒤의 움직임도 따라오지 않는다", () => {
    const d = mouseDrag();
    move(10, 1);
    move(99, 0); // mouseup 을 놓쳤다
    move(120, 0);
    move(130, 1);
    expect(d.moves).toEqual([10]);
    expect(d.ends).toHaveLength(1);
    expect(dragLost(d.ends[0])).toBe(true);
  });

  it("가운데 단추만 눌린 움직임(화면 이동)은 끊지 않는다", () => {
    const d = mouseDrag();
    move(10, 4);
    expect(d.moves).toEqual([10]);
    expect(d.ends).toHaveLength(0);
    d.onUp(new MouseEvent("mouseup"));
  });

  it("창을 떠나면(blur) 끝난다", () => {
    const d = mouseDrag();
    move(10, 1);
    window.dispatchEvent(new Event("blur"));
    move(40, 1);
    expect(d.moves).toEqual([10]);
    expect(d.ends.map((e) => e.type)).toEqual(["blur"]);
    expect(dragLost(d.ends[0])).toBe(true);
  });

  it("remove 뒤에는 아무것도 불리지 않는다(blur 포함)", () => {
    const onMove = vi.fn();
    const onUp = vi.fn();
    addWindowMouseDrag(onMove, onUp);
    removeWindowMouseDrag(onMove, onUp);
    move(10, 1);
    move(10, 0);
    window.dispatchEvent(new MouseEvent("mouseup"));
    window.dispatchEvent(new Event("blur"));
    expect(onMove).not.toHaveBeenCalled();
    expect(onUp).not.toHaveBeenCalled();
  });

  it("같은 콜백으로 두 번 걸어도(mouseup 을 놓친 채 다시 누름) 한 번씩만 불린다", () => {
    const onMove = vi.fn();
    const onUp = vi.fn(() => removeWindowMouseDrag(onMove, onUp));
    addWindowMouseDrag(onMove, onUp);
    addWindowMouseDrag(onMove, onUp);
    move(10, 1);
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onUp).toHaveBeenCalledTimes(1);
  });

  it("포인터 끌기 — 단추 없는 움직임·pointercancel·blur 에 끝난다", () => {
    for (const lose of [
      () => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 77, buttons: 0 })),
      () => window.dispatchEvent(new Event("pointercancel")),
      () => window.dispatchEvent(new Event("blur")),
    ]) {
      const moves: number[] = [];
      const ends: Event[] = [];
      const onMove = (e: PointerEvent) => moves.push(e.clientX);
      const onUp = (e: Event) => {
        ends.push(e);
        removeWindowPointerDrag(onMove, onUp);
      };
      addWindowPointerDrag(onMove, onUp);
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 5, buttons: 1 }));
      lose();
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 50, buttons: 1 }));
      expect(moves).toEqual([5]);
      expect(ends).toHaveLength(1);
      expect(dragLost(ends[0])).toBe(true);
    }
  });

  it("pointerup 은 놓친 것이 아니다", () => {
    expect(dragLost(new Event("pointerup"))).toBe(false);
    expect(dragLost(undefined)).toBe(false); // 이벤트 없이 부른 정리(코드가 직접 끝냄)
  });
});
