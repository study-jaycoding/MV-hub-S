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
  selectedGroupIdsRef: MutableRefObject<Set<string>>;
  groupFramesRef: MutableRefObject<GroupFrame[]>;
  zoomRef: MutableRefObject<number>;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  setCards: Dispatch<SetStateAction<SceneCard[]>>;
  setGroups: Dispatch<SetStateAction<SceneGroup[]>>;
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
    // 함께 끌 그룹 — 선택된 그룹 중 '수동 rect'를 가진 것만이다. 자동 그룹은 프레임을 멤버
    // 카드에서 계산하므로 카드가 움직이면 알아서 따라온다(여기서 건드리면 이중으로 움직인다).
    const movingRects = new Map<string, { x: number; y: number; w: number; h: number }>();
    if (selected.has(cardId)) {
      for (const group of current.groupsRef.current) {
        if (group.rect && current.selectedGroupIdsRef.current.has(group.id)) {
          movingRects.set(group.id, { ...group.rect });
        }
      }
    }
    // 함께 끌 그룹의 멤버는 선택 여부와 상관없이 같이 옮긴다. 프레임은 rect ∪ 멤버 카드라
    // (sceneDerive.groupFrame) 멤버 하나만 제자리에 남아도 프레임이 그쪽으로 늘어난다.
    const movingMemberIds = movingRects.size
      ? current.groupsRef.current
          .filter((group) => movingRects.has(group.id))
          .flatMap((group) => group.cardIds)
      : [];
    const targetIds = selected.has(cardId)
      ? [...new Set([...selected, ...movingMemberIds])]
      : [cardId];
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
      // 프레임이 카드와 같이 움직이는 그룹은 이탈 판정에서 뺀다 — 프레임을 벗어날 수가 없다.
      if (!group || movingRects.has(group.id)) continue;
      const frame = frameByGroup.get(group.id);
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

      // 선택된 그룹의 rect 를 카드와 같은 만큼 옮긴다. 원본 dx/dy 가 아니라 '기준 카드가 실제로
      // 간 거리'를 쓴다 — 격자 스냅이 걸리면 둘이 어긋나 프레임만 반 칸 밀린다.
      if (movingRects.size) {
        const movedAnchor = result.cards.find((card) => card.id === cardId);
        if (movedAnchor) {
          const appliedX = movedAnchor.x - anchor.x;
          const appliedY = movedAnchor.y - anchor.y;
          const nextGroups = latest.groupsRef.current.map((group) => {
            const origin = movingRects.get(group.id);
            return origin
              ? { ...group, rect: { ...origin, x: origin.x + appliedX, y: origin.y + appliedY } }
              : group;
          });
          latest.groupsRef.current = nextGroups;
          latest.setGroups(nextGroups);
        }
      }

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
