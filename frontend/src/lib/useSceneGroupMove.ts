import { useCallback, useRef } from "react";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  SetStateAction,
} from "react";
import { moveCardsFromOrigins } from "./sceneInteractions";
import type { SceneCard, SceneEdge, SceneGroup } from "./scenes";
import type { BeginSceneDrag } from "./useSceneDragSession";

interface UseSceneGroupMoveOptions {
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  groupsRef: MutableRefObject<SceneGroup[]>;
  zoomRef: MutableRefObject<number>;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  setCards: Dispatch<SetStateAction<SceneCard[]>>;
  setGroups: Dispatch<SetStateAction<SceneGroup[]>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setDraggingIds: Dispatch<SetStateAction<readonly string[]>>;
  beginDrag: BeginSceneDrag;
  reconcileGenerationRefs: (cards: SceneCard[], edges: SceneEdge[]) => SceneCard[];
  persist: (cards: SceneCard[], edges: SceneEdge[], groups?: SceneGroup[]) => void;
}

/** 그룹 헤더 클릭 선택과 그룹 멤버·수동 프레임 이동 수명주기를 관리한다. */
export function useSceneGroupMove(options: UseSceneGroupMoveOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  return useCallback((event: ReactMouseEvent, groupId: string): boolean => {
    const current = optionsRef.current;
    const group = current.groupsRef.current.find((item) => item.id === groupId);
    if (!group) return false;

    event.preventDefault();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const start = { x: event.clientX, y: event.clientY };
    const cardsById = new Map(
      current.cardsRef.current.map((card) => [card.id, card] as const),
    );
    const memberIds = group.cardIds.filter((cardId) => cardsById.has(cardId));
    const origins: Record<string, { x: number; y: number }> = {};
    for (const memberId of memberIds) {
      const card = cardsById.get(memberId);
      if (card) origins[memberId] = { x: card.x, y: card.y };
    }

    const anchorId = memberIds[0];
    const anchor = anchorId ? origins[anchorId] : undefined;
    const originalRect = group.rect ? { ...group.rect } : undefined;
    let lastRect = originalRect;
    let lastOffset = { x: Number.NaN, y: Number.NaN };
    let moved = false;
    let relocated = false;

    const move = (moveEvent: MouseEvent) => {
      if (
        !moved &&
        Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 4
      ) {
        return;
      }
      const latest = optionsRef.current;
      if (!moved) latest.setDraggingIds(memberIds);
      moved = true;
      latest.scrollRef.current?.classList.add("dragging");

      const zoom = latest.zoomRef.current;
      const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
      const dx = (moveEvent.clientX - start.x) / safeZoom;
      const dy = (moveEvent.clientY - start.y) / safeZoom;
      const movedCards = anchorId && anchor
        ? moveCardsFromOrigins(
            latest.cardsRef.current,
            origins,
            anchorId,
            anchor,
            dx,
            dy,
          )
        : {
            cards: latest.cardsRef.current,
            dx,
            dy,
            changed: false,
          };

      if (movedCards.dx === lastOffset.x && movedCards.dy === lastOffset.y) return;
      lastOffset = { x: movedCards.dx, y: movedCards.dy };
      if (
        (anchor || originalRect) &&
        (movedCards.dx !== 0 || movedCards.dy !== 0)
      ) {
        relocated = true;
      }

      if (movedCards.changed) {
        latest.cardsRef.current = movedCards.cards;
        latest.setCards(movedCards.cards);
      }
      if (originalRect) {
        lastRect = {
          ...originalRect,
          x: originalRect.x + movedCards.dx,
          y: originalRect.y + movedCards.dy,
        };
        latest.setGroups((previous) =>
          previous.map((item) =>
            item.id === groupId ? { ...item, rect: lastRect } : item,
          ),
        );
      }
    };

    const commitMovedGroup = () => {
      const latest = optionsRef.current;
      const nextGroups = originalRect && lastRect
        ? latest.groupsRef.current.map((item) =>
            item.id === groupId ? { ...item, rect: lastRect } : item,
          )
        : latest.groupsRef.current;
      if (originalRect) latest.setGroups(nextGroups);
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
    };

    const up = () => {
      cleanupDrag();
      const latest = optionsRef.current;
      if (relocated) {
        commitMovedGroup();
        return;
      }
      latest.setSelected((previous) => {
        if (!additive) return new Set(memberIds);
        const next = new Set(previous);
        const allSelected = memberIds.every((cardId) => next.has(cardId));
        for (const memberId of memberIds) {
          allSelected ? next.delete(memberId) : next.add(memberId);
        }
        return next;
      });
    };

    current.beginDrag(move, up, () => {
      cleanupDrag();
      if (relocated) commitMovedGroup();
    });
    return true;
  }, []);
}
