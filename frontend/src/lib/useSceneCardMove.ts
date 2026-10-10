import { useCallback, useLayoutEffect, useRef } from "react";
import type { Dispatch, MouseEvent as ReactMouseEvent, MutableRefObject, SetStateAction } from "react";
import { moveCardsFromOrigins, rewindSceneMove, snapSceneGrid, updateSceneEjectedCards } from "./sceneInteractions";
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

/** 보드를 통째로 끄는 동안(아래 '빠른 길') SceneBoard 가 쥐는 손잡이 — 끌기가 끝나면 비운다. */
export interface SceneLayerMove {
  /** 캔버스 층에만 밀어 둔 이동량을 좌표(ref·상태)에 넣는다. 저장은 하지 않는다 — 부른 쪽이 한다. */
  settle: () => void;
  /** 이동량을 버리고 층을 제자리로 — 씬 전환으로 끌기를 버릴 때. */
  drop: () => void;
}

interface UseSceneCardMoveOptions {
  canvasRef: { readonly current: HTMLDivElement | null };
  layerMoveRef: MutableRefObject<SceneLayerMove | null>;
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  groupsRef: MutableRefObject<SceneGroup[]>;
  selectedRef: MutableRefObject<Set<string>>;
  selectedGroupIdsRef: MutableRefObject<Set<string>>;
  groupFramesRef: MutableRefObject<GroupFrame[]>;
  zoomRef: MutableRefObject<number>;
  /** 화면 좌표 → 캔버스 좌표(지금의 팬·줌으로). 끈 거리는 캔버스 좌표로 잰다. */
  toCanvas: (clientX: number, clientY: number) => { x: number; y: number };
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
  /** 끌기 하나의 시작과 끝 — 그 사이의 저장은 되돌리기 한 단계로 묶인다(lib/useSceneHistory). rewind = 끌기 전 좌표로 되감기. */
  beginGesture: (rewind?: <Snapshot extends { cards: SceneCard[]; groups: SceneGroup[] }>(snapshot: Snapshot) => Snapshot) => void;
  endGesture: () => void;
  ejectSpeed: number;
}

/** 카드 클릭 선택과 단일·복수 카드 이동 수명주기를 관리한다. */
export function useSceneCardMove(options: UseSceneCardMoveOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // 보드를 통째로 끄는 빠른 길(아래)의 층 맞춤 — 다시 그릴 때마다(커밋 직후, 화면에 칠하기 전) 캔버스 층의 translate 를 '보여야 할
  //  이동량 − 지금 좌표에 들어 있는 이동량'으로 맞춘다. 좌표가 어느 길로 바뀌든(놓기·단축키 앞·저장 앞의 확정) 같은 프레임에 층이
  //  따라와 깜박이지 않는다.
  const layerSyncRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    layerSyncRef.current?.();
  });

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
    // 잡은 자리의 캔버스 좌표 — 끈 거리를 화면 px ÷ 지금 줌으로 재면, 끄는 중 휠로 줌을 바꿨을 때 잡은 자리가 마우스에서 어긋났다
    //  (2026-10-10 격리 실측: (38,29)px). 누른 순간의 캔버스 좌표와 지금 마우스의 캔버스 좌표의 차로 잰다.
    const startCanvas = current.toCanvas(start.x, start.y);
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
    // 통째로 옮기는 그룹 — 위의 '고른 rect 그룹'에 더해, 여러 장을 끌 때 살아 있는 멤버가 **전부** 끄는 대상에 든 그룹.
    //  그런 그룹은 프레임이 카드와 같이 가는 것이 맞다: rect 를 같이 옮기고, 멤버는 '빠른 이탈'과 놓을 때의 재배정에서 뺀다.
    //  안 그러면 Ctrl+A 로 전부 끌어 놓을 때 ① 카드가 같이 옮겨 온 옆 그룹의 **옛 자리**(시작 때 프레임)에 떨어져 그 그룹으로
    //  넘어가거나(속도와 무관) ② 빠르게 끌면 전부 이탈해, 비게 된 그룹이 지워졌다(2026-10-10 캔버스 실측: 그룹 32 → 31,
    //  되풀이하면 20 → 9. Ctrl+Z 로만 돌아왔다). 헤더를 잡고 그룹을 끄는 길(useSceneGroupMove — 재배정 없음)과 같아진다.
    //  한 장만 끌 때의 편입·이탈은 그대로다.
    const wholeGroupIds = new Set(movingRects.keys());
    const liveTargets = new Set(targetIds.filter((id) => cardsById.has(id)));
    if (liveTargets.size > 1) {
      for (const group of current.groupsRef.current) {
        const live = group.cardIds.filter((id) => cardsById.has(id));
        if (!live.length || !live.every((id) => liveTargets.has(id))) continue;
        wholeGroupIds.add(group.id);
        if (group.rect) movingRects.set(group.id, { ...group.rect });
      }
    }
    const wholeMemberIds = new Set(
      current.groupsRef.current.filter((group) => wholeGroupIds.has(group.id)).flatMap((group) => group.cardIds),
    );
    const origins: Record<string, { x: number; y: number }> = {};
    for (const targetId of targetIds) {
      const card = cardsById.get(targetId);
      if (card) origins[targetId] = { x: card.x, y: card.y };
    }
    const anchor = origins[cardId];
    if (!anchor) return;

    // ── 보드를 통째로 끄는 빠른 길 ──
    // 모든 카드가 끄는 대상이고 rect 가 있는 그룹도 전부 같이 가면, 보드 안의 것이 전부 같은 만큼 움직인다. 그때는 걸음마다 카드 N장과
    //  연결선을 다시 그리지 않고 캔버스 층(.scene-canvas — 그룹 틀·카드·연결선이 다 들어 있다)을 CSS translate 로 통째로 민다.
    //  합성만 다시 하면 된다(2026-10-10 격리 실측: 412장을 전부 끌 때 걸음마다 다시 그려 화면 갱신이 초당 약 6번이었다).
    //  좌표(ref·상태)는 놓을 때 한 번 넣는다. translate 는 팬·줌이 쓰는 transform 과 다른 속성이다(useSceneViewport.applyTransform).
    //  끄는 중에 좌표가 필요한 일(단축키·저장 확정)이 생기면 SceneBoard 가 layerMoveRef.settle 로 먼저 넣게 한다.
    //  알고 두는 것: 끄는 중 미니맵은 놓을 때 따라온다 · 끄는 중 줌을 바꾸면 다음 마우스 이동까지 층이 옛 배율만큼 밀려 있다 ·
    //  끄는 중 새로 생긴 카드는 층과 같이 밀려 보이다가 놓을 때 제자리로 간다.
    const canvas = current.canvasRef.current;
    const wholeBoard =
      !!canvas &&
      liveTargets.size > 1 &&
      current.cardsRef.current.every((card) => !!origins[card.id]) &&
      current.groupsRef.current.every((group) => !group.rect || movingRects.has(group.id));
    let want = { x: 0, y: 0 }; // 보여야 할 이동량(격자에 맞춘 값)
    let rawWant = { x: 0, y: 0 }; // 그 값을 낳은 마우스 이동량 — 좌표에 넣을 때 그대로 쓴다
    let shown = { x: 0, y: 0 }; // 지금 화면의 좌표(커밋된 상태)에 들어 있는 이동량 — 커밋 때만 다시 읽는다
    let settled = { x: 0, y: 0 }; // 좌표(ref)에 이미 넣은 이동량
    let closing = false; // 손을 뗐다 — 다음 커밋에서 층을 제자리로
    const paintLayer = () => {
      if (!canvas) return;
      canvas.toggleAttribute("data-layer-move", true); // 합성기만으로 밀리게 하는 표시(scene.css) — 끌기가 끝나면 뗀다
      const zoom = optionsRef.current.zoomRef.current;
      const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
      const lagX = want.x - shown.x;
      const lagY = want.y - shown.y;
      canvas.style.translate = lagX || lagY ? `${lagX * scale}px ${lagY * scale}px` : "";
    };
    const syncLayer = () => {
      const shownAnchor = optionsRef.current.cardsRef.current.find((card) => card.id === cardId);
      // 기준 카드가 사라졌으면(끄는 중 삭제) 맞은 것으로 본다 — 층을 밀린 채로 남기지 않는다
      shown = shownAnchor ? { x: shownAnchor.x - anchor.x, y: shownAnchor.y - anchor.y } : want;
      if (closing) endLayer(); // 놓은 뒤의 첫 커밋 — 좌표가 들어왔다
      else paintLayer();
    };
    const endLayer = () => {
      if (canvas) {
        canvas.style.translate = "";
        canvas.toggleAttribute("data-layer-move", false);
      }
      if (layerSyncRef.current === syncLayer) layerSyncRef.current = null;
    };
    const settleLayerMove = () => {
      // 넣을 것이 없다 — 아직 움직이지 않았거나 이미 넣었다. 좌표를 다시 계산해 덮지 않는다: 움직이지 않았는데 격자 밖 카드가
      //  격자로 끌려가거나, 넣은 뒤 다른 코드가 바꾼 좌표를 놓는 순간 되돌리게 된다(Codex 코드 리뷰).
      if (want.x === settled.x && want.y === settled.y) return;
      settled = want;
      const latest = optionsRef.current;
      // 최신 카드에 좌표만 입힌다 — 끄는 사이 바뀐 다른 값(생성 결과·글)은 그대로 둔다
      const result = moveCardsFromOrigins(latest.cardsRef.current, origins, cardId, anchor, rawWant.x, rawWant.y);
      if (!result.changed) return;
      const nextGroups = movingRects.size
        ? latest.groupsRef.current.map((group) => {
            const origin = movingRects.get(group.id);
            return origin ? { ...group, rect: { ...origin, x: origin.x + result.dx, y: origin.y + result.dy } } : group;
          })
        : latest.groupsRef.current;
      latest.cardsRef.current = result.cards;
      latest.groupsRef.current = nextGroups;
      latest.setCards(result.cards);
      if (movingRects.size) latest.setGroups(nextGroups);
    };
    const layerMove: SceneLayerMove = {
      settle: settleLayerMove,
      drop: () => {
        endLayer();
        if (optionsRef.current.layerMoveRef.current === layerMove) optionsRef.current.layerMoveRef.current = null;
      },
    };

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
      if (!group || wholeMemberIds.has(targetId)) continue;
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

      const point = latest.toCanvas(moveEvent.clientX, moveEvent.clientY);
      const dragged = { x: point.x - startCanvas.x, y: point.y - startCanvas.y };
      if (wholeBoard) {
        rawWant = dragged;
        const next = {
          x: snapSceneGrid(anchor.x + rawWant.x) - anchor.x,
          y: snapSceneGrid(anchor.y + rawWant.y) - anchor.y,
        };
        if (next.x === want.x && next.y === want.y) return;
        want = next; // 시작 자리로 되돌아온 0 도 그대로 반영한다
        relocated = true;
        paintLayer();
        return;
      }
      const result = moveCardsFromOrigins(
        latest.cardsRef.current,
        origins,
        cardId,
        anchor,
        dragged.x,
        dragged.y,
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
      if (wholeBoard) settleLayerMove(); // 층에만 있던 이동량을 좌표에 넣고 나서 확정한다
      const nextGroups = latest.reassignGroups(
        targetIds.filter((id) => !wholeMemberIds.has(id)),
        startFrames.filter((item) => !wholeGroupIds.has(item.id)),
        ejected,
      );
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
      if (wholeBoard) {
        closing = true;
        if (latest.layerMoveRef.current === layerMove) latest.layerMoveRef.current = null;
      }
    };
    // 놓은 뒤 — 좌표에 넣을 것이 남았으면 그 커밋(syncLayer)이 층을 되돌린다. 남은 것이 없으면 지금 되돌린다.
    const closeLayer = () => {
      if (wholeBoard && want.x === shown.x && want.y === shown.y) endLayer();
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
      closeLayer();
      latest.endGesture();
    };

    if (wholeBoard) {
      layerSyncRef.current = syncLayer;
      current.layerMoveRef.current = layerMove;
    }
    current.beginDrag(move, up, () => {
      cleanupDrag();
      if (relocated) commitMovedCards();
      closeLayer();
      optionsRef.current.endGesture();
    });
    // 묶음은 여기서 연다 — 손을 뗀 것을 놓친 앞 끌기가 남아 있었다면 위 beginDrag 가 그것을 먼저 확정하고 닫는다(앞 끌기의 묶음으로).
    //  되돌리기의 시작점은 이 끌기가 옮기는 카드·네모의 끌기 전 자리다.
    current.beginGesture((snapshot) => rewindSceneMove(snapshot, origins, movingRects));
  }, []);
}
