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
) => void;

/** begin = 끌기 시작. abort = 도는 끌기를 **마지막 움직임을 반영하지 않고** 버린다(up·취소 콜백도 안 부른다) —
 *  씬 전환처럼 옛 끌기가 새 화면에 한 번 더 쓰이면 안 될 때(Codex 2026-09-29). blur 취소는 마지막 움직임을 반영한다.
 *  settle = 남은 끌기를 blur 처럼 끝낸다(밀린 걸음 반영 + 취소 콜백) — 새 누름이 시작 좌표를 읽기 전에 부른다.
 *  rebase = 도는 끌기의 onRebase 를 부른다(lib/sceneDragSession) — 씬 동기화가 같은 씬의 값을 갈아 끼운 직후에. */
export function useSceneDragSession(): { begin: BeginSceneDrag; abort: () => void; settle: () => void; rebase: () => void } {
  const sessionRef = useRef<SceneDragSession<MouseEvent> | null>(null);

  const begin = useCallback<BeginSceneDrag>((move, up, onCancel, onRebase) => {
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
    sessionRef.current.begin(move, up, onCancel, onRebase);
  }, []);
  const abort = useCallback(() => sessionRef.current?.dispose(), []);
  const settle = useCallback(() => sessionRef.current?.settle(), []);
  const rebase = useCallback(() => sessionRef.current?.rebase(), []);

  useEffect(
    () => () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
    },
    [],
  );

  return { begin, abort, settle, rebase };
}
