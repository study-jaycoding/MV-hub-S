import { useCallback, useEffect, useRef } from "react";
import {
  createSceneDragSession,
  type SceneDragSession,
} from "./sceneDragSession";

export type BeginSceneDrag = (
  move: (event: MouseEvent) => void,
  up: (event: MouseEvent) => void,
  onCancel?: () => void,
) => void;

/** begin = 끌기 시작. abort = 도는 끌기를 **마지막 움직임을 반영하지 않고** 버린다(up·취소 콜백도 안 부른다) —
 *  씬 전환처럼 옛 끌기가 새 화면에 한 번 더 쓰이면 안 될 때(Codex 2026-09-29). blur 취소는 마지막 움직임을 반영한다. */
export function useSceneDragSession(): { begin: BeginSceneDrag; abort: () => void } {
  const sessionRef = useRef<SceneDragSession<MouseEvent> | null>(null);

  const begin = useCallback<BeginSceneDrag>((move, up, onCancel) => {
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
    sessionRef.current.begin(move, up, onCancel);
  }, []);
  const abort = useCallback(() => sessionRef.current?.dispose(), []);

  useEffect(
    () => () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
    },
    [],
  );

  return { begin, abort };
}
