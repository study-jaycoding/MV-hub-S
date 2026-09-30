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
  // 사각형 표시 — 상태 setter 도, 요소를 직접 옮기는 함수도 된다(캔버스는 직접, 2026-09-29).
  setMarquee: (rect: MarqueeRect | null) => void;
  beginDrag: BeginSceneDrag;
  cellSelector: string;
  keyOf: (element: HTMLElement) => Key | null | undefined;
  secondary?: MarqueeSecondary<Secondary>;
  preserveSelectionOnEmptyDrag?: boolean;
  preventDefault?: boolean;
  onPlainClick?: () => void;
  // 있으면 끄는 동안 선택 상태를 바꾸지 않고 이 함수로 화면에만 미리 보여 준다. 손을 떼거나 끌기가 취소되면(blur) 마지막
  //  결과를 한 번에 확정한다 — 걸음마다 선택을 바꾸면 캔버스 전체를 다시 그려 12% 에서 프레임이 떨어졌다(2026-09-30 실측).
  //  null 로 부르면 미리보기를 거두고 화면을 마지막으로 그린 선택대로 되돌린다(확정 직전).
  previewSelection?: (
    selected: ReadonlySet<Key> | null,
    secondary: ReadonlySet<Secondary> | null,
  ) => void;
}

const sameSet = <Key>(left: ReadonlySet<Key>, right: ReadonlySet<Key>) =>
  left.size === right.size && [...left].every((value) => right.has(value));

/** 배경 드래그의 사각형 표시·교차 선택·클릭 해제 수명주기를 공통 관리한다.
 *  begin = 끌기 시작. settle = 화면에 보이는 미리보기 결과를 지금 확정한다(끌기는 계속. 다음 프레임을 기다리는 마지막
 *  움직임은 아직 화면에 없으니 넣지 않는다 — 걸음마다 확정하던 종전과 같다) — 다른 입력(키·새 마우스 누름)이 선택을
 *  읽기 전에 부른다. forget = 버린 끌기(씬 전환 abort)의 미리보기를 확정하지 않고 잊는다. */
export function useSceneMarqueeSelection<Key, Secondary = never>(
  options: UseSceneMarqueeSelectionOptions<Key, Secondary>,
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // 확정했지만 아직 다시 그리기 전의 선택 — 손 뗌을 놓친 채 새 범위 선택을 시작하면 settle 이 막 확정한 값이 props
  //  (selected)에는 아직 없다(Codex P1: Shift 로 이어 고르면 옛 선택이 기준이 됐다). 한 번 그리면 props 가 따라잡으니 비운다.
  const settledRef = useRef<{ selected: Set<Key>; secondary: Set<Secondary> | null } | null>(null);
  settledRef.current = null;
  const settleRef = useRef<(() => void) | null>(null);
  const settle = useCallback(() => settleRef.current?.(), []);
  const forget = useCallback(() => {
    settleRef.current = null;
  }, []);

  const begin = useCallback((event: ReactMouseEvent): boolean => {
    if (event.button !== 0) return false;
    const current = optionsRef.current;
    const surface = current.surfaceRef.current;
    const hitRoot = current.hitRootRef?.current ?? surface;
    if (!surface || !hitRoot) return false;
    if (current.preventDefault) event.preventDefault();

    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const settled = settledRef.current;
    const previous = new Set(settled ? settled.selected : current.selected);
    const previousSecondary = new Set(settled?.secondary ?? current.secondary?.selected ?? []);
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    // 아직 확정하지 않은 마지막 결과 — 미리보기가 없으면 걸음마다 바로 확정한다(종전 동작).
    let pending: { next: Set<Key>; nextSecondary: Set<Secondary> | null } | null = null;
    const commit = () => {
      if (!pending) return;
      const { next, nextSecondary } = pending;
      pending = null;
      const latest = optionsRef.current;
      // 미리보기 표시를 먼저 거둔다 — 확정 뒤 같은 입력이 선택을 또 바꿔도(Esc 로 비우기 등) 화면이 React 가 비교하는
      //  기준(마지막으로 그린 상태)과 같아야 바뀐 카드만 다시 쓰는 React 가 맞게 그린다. 같은 처리 안이라 깜빡이지 않는다.
      latest.previewSelection?.(null, null);
      settledRef.current = { selected: next, secondary: nextSecondary };
      latest.setSelected((selected) => (sameSet(selected, next) ? selected : next));
      if (nextSecondary && latest.secondary) {
        latest.secondary.setSelected((selected) =>
          sameSet(selected, nextSecondary) ? selected : nextSecondary,
        );
      }
    };
    settleRef.current = commit;
    // 끝난 끌기만 비운다 — 손 뗌을 놓친 채 새 끌기를 시작하면 새 begin 이 먼저 자기 commit 을 걸어 둔다.
    const done = () => {
      if (settleRef.current === commit) settleRef.current = null;
    };

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
      // 같은 사각형으로 그룹도 함께 잡는다 — 전체를 감싸 끌 때 카드만 움직이고 그룹은 남는
      // 문제를 없앤다. 선택 합치기 규칙(추가선택·빈 드래그 보존)은 카드와 똑같이 적용한다.
      const second = latest.secondary;
      let nextSecondary: Set<Secondary> | null = null;
      if (second) {
        const boxedSecondary = marqueeHits<Secondary>(
          hitRoot,
          second.cellSelector,
          b,
          [],
          second.keyOf,
          second.hitMode ?? "contain",
        );
        // 그룹의 '빈 결과 보존'은 카드도 하나도 안 잡혔을 때만 — 카드 B 만 새로 감쌌는데 이전
        // 그룹 A 가 되살아나 B 를 끌 때 A 까지 움직였다(코덱스 레인B P2). 추가선택(Shift/Ctrl)은
        // resolveMarqueeSelection 이 먼저 합치므로 영향 없다.
        nextSecondary = resolveMarqueeSelection(
          previousSecondary,
          boxedSecondary,
          additive,
          !!latest.preserveSelectionOnEmptyDrag && boxed.size === 0,
        );
      }
      pending = { next, nextSecondary };
      if (latest.previewSelection) latest.previewSelection(next, nextSecondary);
      else commit();
    };

    const up = () => {
      const latest = optionsRef.current;
      latest.setMarquee(null);
      commit();
      done();
      if (!moved && !additive) {
        if (latest.onPlainClick) latest.onPlainClick();
        else latest.setSelected(new Set());
      }
    };

    // blur 취소도 마지막 움직임까지 반영한다(종전과 같음) — 미리보기였다면 여기서 확정한다.
    current.beginDrag(move, up, () => {
      optionsRef.current.setMarquee(null);
      commit();
      done();
    });
    return true;
  }, []);

  return { begin, settle, forget };
}
