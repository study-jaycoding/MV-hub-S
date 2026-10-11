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

    const sizeOf = (item: SceneCard) => ({
      w: item.w ?? optionsRef.current.defaultSize.w,
      h: item.h ?? optionsRef.current.defaultSize.h,
    });
    let startSize = sizeOf(card);
    const start = { x: event.clientX, y: event.clientY };
    let resized = false;
    let lastSize = startSize; // 마지막으로 넣은 크기 — 줌이 그사이 바뀌어도 그대로 다시 넣을 수 있게 계산 결과를 둔다

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
      lastSize = result.size;
      latest.cardsRef.current = result.cards;
      latest.setCards(result.cards);
    };

    const commit = () => {
      if (!resized) return;
      const latest = optionsRef.current;
      latest.persist(latest.cardsRef.current, latest.edgesRef.current);
    };

    current.beginDrag(move, commit, commit, () => {
      // 끄는 중에 밖에서 씬이 갱신됐다 — 받은 카드에는 저장 전인 이 크기가 없다(더 움직이지 않고 놓으면 늘린 크기가 사라졌다).
      //  마지막으로 넣은 크기를 받은 카드에 다시 입힌다. 다시 계산하지 않는다 — 그사이 줌이 바뀌었으면 다른 값이 나온다(Codex 설계 검토).
      const latest = optionsRef.current;
      if (!resized) {
        // 누르기만 했다 — 쥔 것이 없으니 받은 크기를 새 출발점으로 삼는다. 누른 순간의 크기를 쥐고 있으면, 밖에서 커진 카드가
        //  첫 걸음에 옛 크기 + 이동량으로 줄어 저장된다(Codex 코드 리뷰). 카드에 크기를 적지는 않는다.
        const fresh = latest.cardsRef.current.find((item) => item.id === cardId);
        if (fresh) lastSize = startSize = sizeOf(fresh);
        return;
      }
      const nextCards = latest.cardsRef.current.map((item) =>
        item.id === cardId ? { ...item, w: lastSize.w, h: lastSize.h } : item,
      );
      latest.cardsRef.current = nextCards;
      latest.setCards(nextCards);
    });
  }, []);
}
