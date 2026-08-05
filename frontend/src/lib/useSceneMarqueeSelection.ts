import { useCallback, useRef } from "react";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  SetStateAction,
} from "react";
import {
  computeMarquee,
  marqueeHits,
  resolveMarqueeSelection,
  type MarqueeRect,
} from "./marquee";
import type { BeginSceneDrag } from "./useSceneDragSession";

interface ElementRef {
  readonly current: HTMLElement | null;
}

interface UseSceneMarqueeSelectionOptions<Key> {
  selected: ReadonlySet<Key>;
  surfaceRef: ElementRef;
  hitRootRef?: ElementRef;
  setSelected: Dispatch<SetStateAction<Set<Key>>>;
  setMarquee: Dispatch<SetStateAction<MarqueeRect | null>>;
  beginDrag: BeginSceneDrag;
  cellSelector: string;
  keyOf: (element: HTMLElement) => Key | null | undefined;
  preserveSelectionOnEmptyDrag?: boolean;
  preventDefault?: boolean;
  onPlainClick?: () => void;
}

const sameSet = <Key>(left: ReadonlySet<Key>, right: ReadonlySet<Key>) =>
  left.size === right.size && [...left].every((value) => right.has(value));

/** 배경 드래그의 사각형 표시·교차 선택·클릭 해제 수명주기를 공통 관리한다. */
export function useSceneMarqueeSelection<Key>(
  options: UseSceneMarqueeSelectionOptions<Key>,
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  return useCallback((event: ReactMouseEvent): boolean => {
    if (event.button !== 0) return false;
    const current = optionsRef.current;
    const surface = current.surfaceRef.current;
    const hitRoot = current.hitRootRef?.current ?? surface;
    if (!surface || !hitRoot) return false;
    if (current.preventDefault) event.preventDefault();

    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const previous = new Set(current.selected);
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;

    const move = (moveEvent: MouseEvent) => {
      if (
        !moved &&
        Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 4
      ) {
        return;
      }
      moved = true;
      const latest = optionsRef.current;
      const { rect, b } = computeMarquee(surface, start, moveEvent);
      latest.setMarquee(rect);
      const boxed = marqueeHits<Key>(
        hitRoot,
        latest.cellSelector,
        b,
        [],
        latest.keyOf,
      );
      const next = resolveMarqueeSelection(
        previous,
        boxed,
        additive,
        !!latest.preserveSelectionOnEmptyDrag,
      );
      latest.setSelected((selected) => (sameSet(selected, next) ? selected : next));
    };

    const up = () => {
      const latest = optionsRef.current;
      latest.setMarquee(null);
      if (!moved && !additive) {
        if (latest.onPlainClick) latest.onPlainClick();
        else latest.setSelected(new Set());
      }
    };

    current.beginDrag(move, up, () => optionsRef.current.setMarquee(null));
    return true;
  }, []);
}
