import { useCallback, useRef } from "react";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { CanvasGestures, CanvasMoveHandle } from "../features/canvas/api";
import { snapSceneGrid } from "./sceneInteractions";
import {
  sceneGroupClickSelection,
  sceneGroupDragTargetIds,
} from "./sceneGroupSelection";
import type { SceneCard, SceneGroup } from "./scenes";
import type { BeginSceneDrag } from "./useSceneDragSession";
import { endSceneDragPointer, holdSceneDragPointer } from "./useSceneCardMove";

interface UseSceneGroupMoveOptions {
  cardsRef: { readonly current: SceneCard[] };
  groupsRef: { readonly current: SceneGroup[] };
  selectedGroupIdsRef: MutableRefObject<Set<string>>;
  selectedRef: MutableRefObject<Set<string>>;
  /** 화면 좌표 → 캔버스 좌표(지금의 팬·줌으로). 끈 거리는 캔버스 좌표로 잰다 — 카드 끌기(useSceneCardMove)와 같다. */
  toCanvas: (clientX: number, clientY: number) => { x: number; y: number };
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setSelectedGroupIds: Dispatch<SetStateAction<Set<string>>>;
  setDraggingIds: Dispatch<SetStateAction<readonly string[]>>;
  beginDrag: BeginSceneDrag;
  gestures: CanvasGestures;
  onEnd: () => void;
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
    const startCanvas = current.toCanvas(start.x, start.y); // 끄는 중 줌이 바뀌어도 잡은 자리가 마우스를 따라오게(카드 끌기와 같다)
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
    const origins: Record<string, { x: number; y: number }> = Object.create(null);
    for (const memberId of memberIds) {
      const card = cardsById.get(memberId);
      if (card) origins[memberId] = { x: card.x, y: card.y };
    }

    const anchorId = memberIds[0];
    const anchor = anchorId ? origins[anchorId] : undefined;
    // 네모를 같이 옮길 그룹 — 잡은(고른) 그룹에 더해, 살아 있는 멤버가 **전부** 같이 가는 그룹(카드 끌기의 '통째로 옮기는 그룹'과 같은
    //  규칙 — lib/useSceneCardMove). 범위 선택으로 두 그룹을 고른 뒤 한 그룹의 머리를 누르면 그룹 선택은 그 하나로 줄지만 카드 선택은 둘 다
    //  남는다: 그 머리를 끌면 다른 그룹은 카드만 떠나고 네모가 옛 자리에 남은 채 저장됐다(조작 규칙 45).
    const moving = new Set(memberIds);
    const goesWhole = (item: SceneGroup) => {
      const live = item.cardIds.filter((cardId) => cardsById.has(cardId));
      return live.length > 0 && live.every((cardId) => moving.has(cardId));
    };
    const originalRects = new Map(
      current.groupsRef.current
        .filter((item) => item.rect && (targetGroupIdSet.has(item.id) || goesWhole(item)))
        .map((item) => [item.id, { ...item.rect! }] as const),
    );
    let lastOffset = { x: Number.NaN, y: Number.NaN };
    let moved = false;
    let relocated = false;
    let handle: CanvasMoveHandle;

    const move = (moveEvent: MouseEvent) => {
      if (
        !moved &&
        Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 4
      ) {
        return;
      }
      const latest = optionsRef.current;
      if (!moved) {
        // 카드 끌기의 '빠른 그리기'(SceneBoard 의 moveOrigins)는 여기서 켜지 않는다 — 그룹 머리로 끄는 멤버는 고르지 않은 카드가
        //  섞이는 길이고(그 그리기는 고른 카드에만 쓴다), 따로 잰 이득도 없다. 걸음마다 left/top 으로 옮긴다.
        latest.setDraggingIds(memberIds);
        latest.setSelectedGroupIds(new Set(targetGroupIds));
        holdSceneDragPointer(latest.scrollRef.current); // 카드 끌기와 같다(useSceneCardMove)
      }
      moved = true;
      latest.scrollRef.current?.classList.add("dragging");

      const point = latest.toCanvas(moveEvent.clientX, moveEvent.clientY);
      const dx = point.x - startCanvas.x;
      const dy = point.y - startCanvas.y;
      const offset = anchor
        ? { dx: snapSceneGrid(anchor.x + dx) - anchor.x, dy: snapSceneGrid(anchor.y + dy) - anchor.y }
        : { dx, dy };

      if (offset.dx === lastOffset.x && offset.dy === lastOffset.y) return;
      lastOffset = { x: offset.dx, y: offset.dy };
      if (
        (anchor || originalRects.size > 0) &&
        (offset.dx !== 0 || offset.dy !== 0)
      ) {
        relocated = true;
      }

      handle.preview({
        positions: Object.fromEntries(memberIds.map((id) => [id, { x: origins[id].x + offset.dx, y: origins[id].y + offset.dy }])),
        rects: Object.fromEntries([...originalRects].map(([id, rect]) => [id, { ...rect, x: rect.x + offset.dx, y: rect.y + offset.dy }])),
      });
    };

    const cleanupDrag = (dropped: boolean, discarded = false) => {
      const latest = optionsRef.current;
      latest.scrollRef.current?.classList.remove("dragging");
      endSceneDragPointer((dropped || discarded) && moved, discarded);
      latest.setDraggingIds([]);
    };

    const up = () => {
      cleanupDrag(true);
      const latest = optionsRef.current;
      if (relocated) {
        handle.finish();
        latest.onEnd();
        return;
      }
      handle.finish();
      latest.onEnd();
      latest.setSelectedGroupIds((previous) =>
        sceneGroupClickSelection(previous, groupId, additive),
      );
    };

    // 그룹 선택과 카드 선택은 별개다 — 선택 밖 그룹을 새로 잡을 때만 카드 선택을 해제한다.
    if (!keepCardSelection) current.setSelected(new Set());
    current.beginDrag(move, up, () => {
      cleanupDrag(false);
      handle.finish();
      optionsRef.current.onEnd();
    }, () => {
      // 끄는 중에 밖에서 씬이 갱신됐다 — 받은 값에는 이 끌기의 좌표가 없다. 마지막 카드·네모 기하를 다시 얹는다.
      //  더 움직이지 않고 놓으면 네모만 가고 멤버는 끌기 전 자리에 남은 채 저장됐다. 마지막 걸음을 받은 값 위에 다시 얹는다
      //  (카드 끌기의 같은 자리 — lib/useSceneCardMove). 모든 멤버를 놓는다: 기준 카드만 보고 건너뛰지 않는다.
      if (Number.isNaN(lastOffset.x)) return; // 아직 한 걸음도 넣지 않았다
      handle.rebase();
    }, () => {
      // Esc — 이동만 버린다(29회차, Jay 안 A — 카드 끌기와 같다: lib/useSceneCardMove). 멤버는 끌기 전 자리로, 네모는 끌기 전 네모로.
      //  저장은 '버리는 저장'(되돌리기 단계를 쌓지 않는다). 머리를 누르기만 했으면(relocated 아님) 그룹 선택도 바꾸지 않는다(up 의 클릭 선택은
      //  놓기의 것이다).
      cleanupDrag(false, true);
      handle.cancel();
      optionsRef.current.onEnd();
    });
    // 앞 끌기가 남아 있었다면 위 beginDrag 가 그것을 먼저 확정하고 닫는다 — 그다음에 이 끌기의 묶음을 연다
    handle = current.gestures.beginGroupMove(memberIds, [...originalRects.keys()]);
    return true;
  }, []);
}
