import { useCallback, useEffect, useRef } from "react";
import {
  createSceneDragSession,
  type SceneDragSession,
} from "./sceneDragSession";

export type BeginSceneDrag = (
  move: (event: MouseEvent) => void,
  up: (event: MouseEvent) => void,
  onCancel?: () => void,
  /** 끄는 중에 밖에서 카드·그룹이 갈렸을 때 — 끌기가 쥔 값(옮긴 자리·늘린 크기)을 새 값 위에 다시 얹는다. 값을 끄는 중에 바꾸는 끌기만 건다. */
  onRebase?: () => void,
  /** Esc 로 끌기를 버릴 때 — 끌기가 옮긴 자리·늘린 크기를 끌기 전으로 되돌린다(lib/sceneDragSession 의 discard). 거는 끌기만 Esc 로 버려진다. */
  onDiscard?: () => void,
) => void;

/** begin = 끌기 시작. abort = 도는 끌기를 **마지막 움직임을 반영하지 않고** 버린다(up·취소 콜백도 안 부른다) —
 *  씬 전환처럼 옛 끌기가 새 화면에 한 번 더 쓰이면 안 될 때(Codex 2026-09-29). blur 취소는 마지막 움직임을 반영한다.
 *  settle = 남은 끌기를 blur 처럼 끝낸다(밀린 걸음 반영 + 취소 콜백) — 새 누름이 시작 좌표를 읽기 전에 부른다.
 *  rebase = 도는 끌기의 onRebase 를 부른다(lib/sceneDragSession) — 씬 동기화가 같은 씬의 값을 갈아 끼운 직후에.
 *  discard = Esc — 도는 끌기의 onDiscard 를 부르고 끝낸다(밀린 걸음은 버린다). 버렸으면 true. */
export function useSceneDragSession(): {
  begin: BeginSceneDrag; abort: () => void; settle: () => void; rebase: () => void; discard: () => boolean;
} {
  const sessionRef = useRef<SceneDragSession<MouseEvent> | null>(null);

  const begin = useCallback<BeginSceneDrag>((move, up, onCancel, onRebase, onDiscard) => {
    if (!sessionRef.current) {
      sessionRef.current = createSceneDragSession<MouseEvent>({
        addListener: (type, listener) =>
          window.addEventListener(type, listener as EventListener),
        removeListener: (type, listener) =>
          window.removeEventListener(type, listener as EventListener),
        requestFrame: (callback) => requestAnimationFrame(callback),
        cancelFrame: (id) => cancelAnimationFrame(id),
      });
    }
    sessionRef.current.begin(move, up, onCancel, onRebase, onDiscard);
  }, []);
  const abort = useCallback(() => sessionRef.current?.dispose(), []);
  const settle = useCallback(() => sessionRef.current?.settle(), []);
  const rebase = useCallback(() => sessionRef.current?.rebase(), []);
  const discard = useCallback(() => sessionRef.current?.discard() ?? false, []);

  useEffect(
    () => () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
    },
    [],
  );

  return { begin, abort, settle, rebase, discard };
}
