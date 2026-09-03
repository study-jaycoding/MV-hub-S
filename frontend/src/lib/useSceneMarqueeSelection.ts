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
  type MarqueeHitMode,
  type MarqueeRect,
} from "./marquee";
import type { BeginSceneDrag } from "./useSceneDragSession";

interface ElementRef {
  readonly current: HTMLElement | null;
}

// 같은 사각형으로 함께 잡아야 하는 두 번째 대상(캔버스의 그룹) — 선택 상태가 카드와 따로
// 관리되므로 채널을 하나 더 받는다. 없으면 종전과 똑같이 동작한다.
interface MarqueeSecondary<Key> {
  selected: ReadonlySet<Key>;
  setSelected: Dispatch<SetStateAction<Set<Key>>>;
  cellSelector: string;
  keyOf: (element: HTMLElement) => Key | null | undefined;
  /** 기본 contain — 그룹은 완전히 감쌌을 때만 잡는다(안쪽 카드 몇 개만 고를 때 딸려오면 곤란). */
  hitMode?: MarqueeHitMode;
}

interface UseSceneMarqueeSelectionOptions<Key, Secondary = never> {
  selected: ReadonlySet<Key>;
  surfaceRef: ElementRef;
  hitRootRef?: ElementRef;
  setSelected: Dispatch<SetStateAction<Set<Key>>>;
  setMarquee: Dispatch<SetStateAction<MarqueeRect | null>>;
  beginDrag: BeginSceneDrag;
  cellSelector: string;
  keyOf: (element: HTMLElement) => Key | null | undefined;
  secondary?: MarqueeSecondary<Secondary>;
  preserveSelectionOnEmptyDrag?: boolean;
  preventDefault?: boolean;
  onPlainClick?: () => void;
}

const sameSet = <Key>(left: ReadonlySet<Key>, right: ReadonlySet<Key>) =>
  left.size === right.size && [...left].every((value) => right.has(value));

/** 배경 드래그의 사각형 표시·교차 선택·클릭 해제 수명주기를 공통 관리한다. */
export function useSceneMarqueeSelection<Key, Secondary = never>(
  options: UseSceneMarqueeSelectionOptions<Key, Secondary>,
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
    const previousSecondary = new Set(current.secondary?.selected ?? []);
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
      // 같은 사각형으로 그룹도 함께 잡는다 — 전체를 감싸 끌 때 카드만 움직이고 그룹은 남는
      // 문제를 없앤다. 선택 합치기 규칙(추가선택·빈 드래그 보존)은 카드와 똑같이 적용한다.
      const second = latest.secondary;
      if (second) {
        const boxedSecondary = marqueeHits<Secondary>(
          hitRoot,
          second.cellSelector,
          b,
          [],
          second.keyOf,
          second.hitMode ?? "contain",
        );
        const nextSecondary = resolveMarqueeSelection(
          previousSecondary,
          boxedSecondary,
          additive,
          !!latest.preserveSelectionOnEmptyDrag,
        );
        second.setSelected((selected) =>
          sameSet(selected, nextSecondary) ? selected : nextSecondary,
        );
      }
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
