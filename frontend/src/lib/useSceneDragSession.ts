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

export function useSceneDragSession(): BeginSceneDrag {
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

  useEffect(
    () => () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
    },
    [],
  );

  return begin;
}
