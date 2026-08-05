import { useCallback, useRef } from "react";
import type { Dispatch, MouseEvent as ReactMouseEvent, MutableRefObject, SetStateAction } from "react";
import { resizeSceneCard } from "./sceneInteractions";
import type { SceneCard, SceneEdge } from "./scenes";
import type { BeginSceneDrag } from "./useSceneDragSession";

interface UseSceneCardResizeOptions {
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  zoomRef: MutableRefObject<number>;
  setCards: Dispatch<SetStateAction<SceneCard[]>>;
  persist: (cards: SceneCard[], edges: SceneEdge[]) => void;
  beginDrag: BeginSceneDrag;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
}

/** 카드 우하단 핸들의 크기 계산·드래그 수명주기·최종 저장을 관리한다. */
export function useSceneCardResize(options: UseSceneCardResizeOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  return useCallback((event: ReactMouseEvent, cardId: string) => {
    event.stopPropagation();
    event.preventDefault();
    const current = optionsRef.current;
    const card = current.cardsRef.current.find((item) => item.id === cardId);
    if (!card) return;

    const startSize = {
      w: card.w ?? current.defaultSize.w,
      h: card.h ?? current.defaultSize.h,
    };
    const start = { x: event.clientX, y: event.clientY };
    let resized = false;

    const move = (moveEvent: MouseEvent) => {
      const latest = optionsRef.current;
      const result = resizeSceneCard({
        cards: latest.cardsRef.current,
        cardId,
        startSize,
        clientDelta: {
          x: moveEvent.clientX - start.x,
          y: moveEvent.clientY - start.y,
        },
        zoom: latest.zoomRef.current,
        minSize: latest.minSize,
      });
      if (!result.changed) return;
      resized = true;
      latest.cardsRef.current = result.cards;
      latest.setCards(result.cards);
    };

    const commit = () => {
      if (!resized) return;
      const latest = optionsRef.current;
      latest.persist(latest.cardsRef.current, latest.edgesRef.current);
    };

    current.beginDrag(move, commit, commit);
  }, []);
}
