import { useCallback, useRef } from "react";
import type { Dispatch, MouseEvent as ReactMouseEvent, MutableRefObject, SetStateAction } from "react";
import { moveCardsFromOrigins, updateSceneEjectedCards } from "./sceneInteractions";
import { ackDone } from "./sceneRecentDoneStore";
import {
  variantIds,
  type SceneCard,
  type SceneEdge,
  type SceneGroup,
} from "./scenes";
import type { BeginSceneDrag } from "./useSceneDragSession";

interface GroupFrame {
  id: string;
  frame: { x: number; y: number; w: number; h: number };
}

interface UseSceneCardMoveOptions {
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  groupsRef: MutableRefObject<SceneGroup[]>;
  selectedRef: MutableRefObject<Set<string>>;
  groupFramesRef: MutableRefObject<GroupFrame[]>;
  zoomRef: MutableRefObject<number>;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  setCards: Dispatch<SetStateAction<SceneCard[]>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setDraggingIds: Dispatch<SetStateAction<readonly string[]>>;
  setEjectedIds: Dispatch<SetStateAction<Set<string>>>;
  beginDrag: BeginSceneDrag;
  cardSize: (card: SceneCard) => { w: number; h: number };
  collectRecipe: (cardId: string) => Set<string>;
  reassignGroups: (
    cardIds: string[],
    startFrames: GroupFrame[],
    ejected: Set<string>,
  ) => SceneGroup[];
  reconcileGenerationRefs: (cards: SceneCard[], edges: SceneEdge[]) => SceneCard[];
  persist: (cards: SceneCard[], edges: SceneEdge[], groups?: SceneGroup[]) => void;
  ejectSpeed: number;
}

/** 카드 클릭 선택과 단일·복수 카드 이동 수명주기를 관리한다. */
export function useSceneCardMove(options: UseSceneCardMoveOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  return useCallback((event: ReactMouseEvent, cardId: string) => {
    const current = optionsRef.current;
    const cardsById = new Map(
      current.cardsRef.current.map((card) => [card.id, card] as const),
    );
    const clickedCard = cardsById.get(cardId);
    if (!clickedCard) return;
    if (clickedCard.kind === "generation" || clickedCard.kind === "comfy") {
      ackDone(variantIds(clickedCard));
    }

    const fromRow = !!(event.target as HTMLElement | null)?.closest?.(
      ".scene-listrow, .scene-listthumb",
    );
    const chainSelection = event.shiftKey;
    const accumulate = event.ctrlKey || event.metaKey;
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;

    const selected = current.selectedRef.current;
    const targetIds = selected.has(cardId) ? [...selected] : [cardId];
    const origins: Record<string, { x: number; y: number }> = {};
    for (const targetId of targetIds) {
      const card = cardsById.get(targetId);
      if (card) origins[targetId] = { x: card.x, y: card.y };
    }
    const anchor = origins[cardId];
    if (!anchor) return;

    const startFrames = current.groupFramesRef.current.map((item) => ({
      id: item.id,
      frame: { ...item.frame },
    }));
    const groupByCard = new Map<string, SceneGroup>();
    for (const group of current.groupsRef.current) {
      for (const memberId of group.cardIds) groupByCard.set(memberId, group);
    }
    const frameByGroup = new Map(startFrames.map((item) => [item.id, item.frame] as const));
    const memberFrames = new Map<string, GroupFrame["frame"]>();
    for (const targetId of targetIds) {
      const group = groupByCard.get(targetId);
      const frame = group ? frameByGroup.get(group.id) : undefined;
      if (frame) memberFrames.set(targetId, frame);
    }

    let ejected = new Set<string>();
    let velocityWindow = {
      time: performance.now(),
      x: start.x,
      y: start.y,
      speed: 0,
    };
    let relocated = false;

    const move = (moveEvent: MouseEvent) => {
      if (!moved && Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 4) {
        return;
      }
      const latest = optionsRef.current;
      if (!moved) latest.setDraggingIds(targetIds);
      moved = true;
      latest.scrollRef.current?.classList.add("dragging");

      const now = performance.now();
      const elapsed = now - velocityWindow.time;
      if (elapsed >= 30) {
        velocityWindow = {
          time: now,
          x: moveEvent.clientX,
          y: moveEvent.clientY,
          speed:
            Math.hypot(
              moveEvent.clientX - velocityWindow.x,
              moveEvent.clientY - velocityWindow.y,
            ) / elapsed,
        };
      }

      const zoom = latest.zoomRef.current;
      const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
      const result = moveCardsFromOrigins(
        latest.cardsRef.current,
        origins,
        cardId,
        anchor,
        (moveEvent.clientX - start.x) / safeZoom,
        (moveEvent.clientY - start.y) / safeZoom,
      );
      if (!result.changed) return;

      relocated = true;
      latest.cardsRef.current = result.cards;
      latest.setCards(result.cards);

      if (memberFrames.size) {
        const movedById = new Map(result.cards.map((card) => [card.id, card] as const));
        const centers = new Map<string, { x: number; y: number }>();
        for (const memberId of memberFrames.keys()) {
          const card = movedById.get(memberId);
          if (!card) continue;
          const size = latest.cardSize(card);
          centers.set(memberId, {
            x: card.x + size.w / 2,
            y: card.y + size.h / 2,
          });
        }
        const ejection = updateSceneEjectedCards(
          ejected,
          memberFrames,
          centers,
          velocityWindow.speed,
          latest.ejectSpeed,
        );
        ejected = ejection.ejected;
        if (ejection.changed) latest.setEjectedIds(new Set(ejected));
      }
    };

    const commitMovedCards = () => {
      const latest = optionsRef.current;
      const nextGroups = latest.reassignGroups(targetIds, startFrames, ejected);
      const nextCards = latest.reconcileGenerationRefs(
        latest.cardsRef.current,
        latest.edgesRef.current,
      );
      latest.cardsRef.current = nextCards;
      latest.setCards(nextCards);
      latest.persist(nextCards, latest.edgesRef.current, nextGroups);
    };

    const cleanupDrag = () => {
      const latest = optionsRef.current;
      latest.scrollRef.current?.classList.remove("dragging");
      latest.setDraggingIds([]);
      if (ejected.size) latest.setEjectedIds(new Set());
    };

    const up = () => {
      cleanupDrag();
      const latest = optionsRef.current;
      if (relocated) {
        commitMovedCards();
      } else if (fromRow) {
        // 리스트/렌더 행 클릭은 행 자체의 onClick이 처리한다.
      } else if (chainSelection) {
        const recipe = latest.collectRecipe(cardId);
        latest.setSelected((previous) =>
          accumulate ? new Set([...previous, ...recipe]) : recipe,
        );
      } else {
        latest.setSelected((previous) => {
          if (accumulate) {
            const next = new Set(previous);
            next.has(cardId) ? next.delete(cardId) : next.add(cardId);
            return next;
          }
          return new Set([cardId]);
        });
      }
    };

    current.beginDrag(move, up, () => {
      cleanupDrag();
      if (relocated) commitMovedCards();
    });
  }, []);
}
