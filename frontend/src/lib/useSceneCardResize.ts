import { useCallback, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import type { CanvasCardResizeHandle, CanvasGestures } from "../features/canvas/api";
import { resizeSceneCard } from "./sceneInteractions";
import type { SceneCard } from "./scenes";
import type { BeginSceneDrag } from "./useSceneDragSession";

interface UseSceneCardResizeOptions {
  cardsRef: { readonly current: SceneCard[] };
  zoomRef: MutableRefObject<number>;
  gestures: CanvasGestures;
  onEnd: () => void;
  beginDrag: BeginSceneDrag;
  /** 누르고 있는 동안 되돌리기·묶기·정렬을 받지 않게 한다(카드·그룹 끌기와 같다 — SceneBoard 의 holdMove). */
  hold: () => void;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
}

/** 카드 우하단 핸들의 좌표 계산·드래그 수명주기를 관리한다. */
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
    let handle: CanvasCardResizeHandle;

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
      handle.preview(result.size);
    };

    const commit = () => {
      handle.finish();
      optionsRef.current.onEnd();
    };

    current.beginDrag(move, commit, commit, () => {
      const latest = optionsRef.current;
      if (!resized) {
        const fresh = latest.cardsRef.current.find((item) => item.id === cardId);
        if (fresh) startSize = sizeOf(fresh);
      }
      handle.rebase();
    }, () => {
      handle.cancel();
      optionsRef.current.onEnd();
    });
    // 앞 끌기를 beginDrag가 확정한 뒤, 이 문서와 대상에 묶인 손잡이를 연다.
    handle = current.gestures.beginCardResize(cardId);
    current.hold();
  }, []);
}
