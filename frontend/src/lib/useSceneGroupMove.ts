import { useCallback, useRef } from "react";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  SetStateAction,
} from "react";
import { moveCardsFromOrigins } from "./sceneInteractions";
import {
  sceneGroupClickSelection,
  sceneGroupDragTargetIds,
} from "./sceneGroupSelection";
import type { SceneCard, SceneEdge, SceneGroup } from "./scenes";
import type { BeginSceneDrag } from "./useSceneDragSession";

interface UseSceneGroupMoveOptions {
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  groupsRef: MutableRefObject<SceneGroup[]>;
  selectedGroupIdsRef: MutableRefObject<Set<string>>;
  selectedRef: MutableRefObject<Set<string>>;
  zoomRef: MutableRefObject<number>;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  setCards: Dispatch<SetStateAction<SceneCard[]>>;
  setGroups: Dispatch<SetStateAction<SceneGroup[]>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setSelectedGroupIds: Dispatch<SetStateAction<Set<string>>>;
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
    const targetGroupIds = sceneGroupDragTargetIds(
      current.selectedGroupIdsRef.current,
      groupId,
      additive,
    );
    const targetGroupIdSet = new Set(targetGroupIds);
    const start = { x: event.clientX, y: event.clientY };
    const cardsById = new Map(
      current.cardsRef.current.map((card) => [card.id, card] as const),
    );
    // 이미 선택돼 있던 그룹을 잡았다면 '선택한 것 전체를 옮긴다'는 뜻이다 — 그룹 멤버뿐 아니라
    // 선택된 카드(그룹 밖 카드 포함)도 함께 옮기고, 카드 선택도 지우지 않는다.
    // 선택 밖 그룹을 새로 잡은 것이면 종전대로 그 그룹만 옮기고 카드 선택은 해제한다.
    const keepCardSelection = current.selectedGroupIdsRef.current.has(groupId);
    const memberIds = Array.from(
      new Set(
        [
          ...current.groupsRef.current
            .filter((item) => targetGroupIdSet.has(item.id))
            .flatMap((item) => item.cardIds),
          ...(keepCardSelection ? current.selectedRef.current : []),
        ].filter((cardId) => cardsById.has(cardId)),
      ),
    );
    const origins: Record<string, { x: number; y: number }> = {};
    for (const memberId of memberIds) {
      const card = cardsById.get(memberId);
      if (card) origins[memberId] = { x: card.x, y: card.y };
    }

    const anchorId = memberIds[0];
    const anchor = anchorId ? origins[anchorId] : undefined;
    const originalRects = new Map(
      current.groupsRef.current
        .filter((item) => targetGroupIdSet.has(item.id) && item.rect)
        .map((item) => [item.id, { ...item.rect! }] as const),
    );
    let lastRects = new Map(originalRects);
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
      if (!moved) {
        latest.setDraggingIds(memberIds);
        latest.setSelectedGroupIds(new Set(targetGroupIds));
      }
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
        (anchor || originalRects.size > 0) &&
        (movedCards.dx !== 0 || movedCards.dy !== 0)
      ) {
        relocated = true;
      }

      if (movedCards.changed) {
        latest.cardsRef.current = movedCards.cards;
        latest.setCards(movedCards.cards);
      }
      if (originalRects.size) {
        lastRects = new Map(
          [...originalRects].map(([id, rect]) => [
            id,
            { ...rect, x: rect.x + movedCards.dx, y: rect.y + movedCards.dy },
          ]),
        );
        latest.setGroups((previous) =>
          previous.map((item) => {
            const rect = lastRects.get(item.id);
            return rect ? { ...item, rect } : item;
          }),
        );
      }
    };

    const commitMovedGroup = () => {
      const latest = optionsRef.current;
      const nextGroups = originalRects.size
        ? latest.groupsRef.current.map((item) => {
            const rect = lastRects.get(item.id);
            return rect ? { ...item, rect } : item;
          })
        : latest.groupsRef.current;
      if (originalRects.size) latest.setGroups(nextGroups);
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
      latest.setSelectedGroupIds((previous) =>
        sceneGroupClickSelection(previous, groupId, additive),
      );
    };

    // 그룹 선택과 카드 선택은 별개다 — 선택 밖 그룹을 새로 잡을 때만 카드 선택을 해제한다.
    if (!keepCardSelection) current.setSelected(new Set());
    current.beginDrag(move, up, () => {
      cleanupDrag();
      if (relocated) commitMovedGroup();
    });
    return true;
  }, []);
}
