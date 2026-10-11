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
  /** 끌기 하나의 시작과 끝 — 그 사이의 저장은 되돌리기 한 단계로 묶인다(lib/useSceneHistory). rewind = 끌기 전 크기로 되감기. */
  beginGesture: (rewind?: <Snapshot extends { cards: SceneCard[] }>(snapshot: Snapshot) => Snapshot) => void;
  endGesture: () => void;
  /** 누르고 있는 동안 되돌리기·묶기·정렬을 받지 않게 한다(카드·그룹 끌기와 같다 — SceneBoard 의 holdMove). */
  hold: () => void;
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
    let written = { w: card.w, h: card.h }; // 끌기 전에 카드에 적혀 있던 크기(정한 적 없으면 없다) — 되돌리기의 시작점
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
      const latest = optionsRef.current;
      if (resized) latest.persist(latest.cardsRef.current, latest.edgesRef.current);
      latest.endGesture();
    };

    current.beginDrag(move, commit, commit, () => {
      // 끄는 중에 밖에서 씬이 갱신됐다 — 받은 카드에는 저장 전인 이 크기가 없다(더 움직이지 않고 놓으면 늘린 크기가 사라졌다).
      //  마지막으로 넣은 크기를 받은 카드에 다시 입힌다. 다시 계산하지 않는다 — 그사이 줌이 바뀌었으면 다른 값이 나온다(Codex 설계 검토).
      const latest = optionsRef.current;
      if (!resized) {
        // 누르기만 했다 — 쥔 것이 없으니 받은 크기를 새 출발점으로 삼는다. 누른 순간의 크기를 쥐고 있으면, 밖에서 커진 카드가
        //  첫 걸음에 옛 크기 + 이동량으로 줄어 저장된다(Codex 코드 리뷰). 카드에 크기를 적지는 않는다.
        const fresh = latest.cardsRef.current.find((item) => item.id === cardId);
        if (fresh) {
          lastSize = startSize = sizeOf(fresh);
          written = { w: fresh.w, h: fresh.h };
        }
        return;
      }
      const nextCards = latest.cardsRef.current.map((item) =>
        item.id === cardId ? { ...item, w: lastSize.w, h: lastSize.h } : item,
      );
      latest.cardsRef.current = nextCards;
      latest.setCards(nextCards);
    });
    // 묶음은 여기서 연다(앞 끌기가 남아 있었다면 위 beginDrag 가 그것을 먼저 확정하고 닫는다). 크기 조절도 끌기다(조작 규칙 44):
    //  · 누르고 있는 동안의 Ctrl+Z 는 받지 않는다 — 받으면 되돌린 화면 위에 다음 걸음이 쥐고 있던 시작 크기로 다시 크기를 넣고, 놓을 때의
    //    저장이 다시 하기를 지웠다.
    //  · 끄는 중에 낀 파생 저장(Comfy 응답 등)이 중간 크기를 '저장된 것'으로 굳혀도, 되돌리기는 끌기 전 크기로 간다.
    current.beginGesture((snapshot) => ({
      ...snapshot,
      cards: snapshot.cards.map((item) => (item.id === cardId ? { ...item, w: written.w, h: written.h } : item)),
    }));
    current.hold();
  }, []);
}
