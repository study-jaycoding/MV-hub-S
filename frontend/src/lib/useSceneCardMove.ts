import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
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

// 마지막으로 눌린 포인터의 번호 — 끄는 동안 그 포인터를 보드에 쥐여 줄 때 쓴다. 끌기는 mousedown 으로 시작해 번호를 모른다
//  (마우스는 늘 같은 번호지만 펜은 누를 때마다 다르다). 눌린 적이 없으면(null) 쥐지 않는다.
let pressedPointerId: number | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", (event) => { pressedPointerId = event.pointerId; }, true);
}

// 지금 포인터를 쥐고 있는 보드 — 끌기는 한 번에 하나라 하나만 둔다.
let heldPointer: { board: HTMLElement; pointerId: number } | null = null;

/**
 * 카드·그룹을 끄는 동안 그 포인터를 보드가 쥔다(포인터 캡처). 끌기가 끝나면 releaseSceneDragPointer 로 놓는다.
 *
 * 전엔 `.scene-board.dragging .scene-card { pointer-events: none }` 한 줄이 끄는 동안 카드를 마우스에서 떼어 놓았다 — 겹친 뒤 카드가
 * hover 를 받아 포트·강조가 끄는 카드 위로 튀어나오지 않게(2026-07-24). 그 줄은 끌기의 시작과 끝마다 카드와 그 안의 요소 6천여
 * 개의 스타일을 다시 계산했다(pointer-events 는 자식으로 내려간다 — 2026-10-11 격리 실측: 시작·끝에 각 40~55ms).
 * 쥐고 있는 동안 브라우저는 마우스 밑을 찾지 않고 hover·mouseenter·mouseup 을 전부 쥔 요소(보드)로 보낸다 — 스타일은 하나도 안 바뀐다.
 */
export function holdSceneDragPointer(board: HTMLElement | null): void {
  const pointerId = pressedPointerId;
  if (!board || pointerId === null) return;
  heldPointer = { board, pointerId };
  try {
    board.setPointerCapture?.(pointerId);
  } catch {
    // 그 포인터가 이미 떼어졌다 — 쥐지 않고 간다
  }
}

/**
 * 쥔 포인터를 놓는다 — 끌기가 **어느 길로 끝나든** 부른다: 놓기(어느 단추의 mouseup 이든)·창을 떠남·놓친 mouseup·다음 끌기·
 * 씬 전환(SceneBoard)·화면이 내려감. 쥔 것이 없으면 아무 일도 없다.
 * 브라우저가 스스로 놓는 것은 단추를 **전부** 뗐을 때뿐이다 — 왼쪽으로 끄는 중에 오른쪽 단추를 눌렀다 놓으면 끌기는 그 mouseup 으로
 * 끝나는데 캡처는 왼쪽을 뗄 때까지 남았고, 씬 전환·화면 내려감은 끌기를 콜백 없이 버려서 놓지 않았다(Codex 리뷰 P3).
 */
export function releaseSceneDragPointer(): void {
  if (!heldPointer) return;
  const { board, pointerId } = heldPointer;
  heldPointer = null;
  try {
    board.releasePointerCapture?.(pointerId);
  } catch {
    // 이미 놓였다
  }
}

/**
 * 끌어 놓은 직후의 click 한 번을 삼킨다 — 옛 규칙이 덤으로 하던 일이다. 브라우저는 누른 요소와 뗀 요소가 같으면 click 을 보내는데
 * 끄는 카드는 마우스를 따라와 늘 같다: 리스트의 행을 잡고 끌면 놓는 순간 그 행의 선택이 뒤집힌다(옛 규칙에서는 뗀 요소가 카드 밑의
 * 것이라 click 이 카드로 가지 않았다). click 은 mouseup 과 같은 작업 안에서 오므로, 오지 않았으면 다음 작업에서 거둔다.
 * **삼키는 것은 그 놓기에 딸린 한 번이다** — 삼켰으면 바로 거두고, 새 누름(mousedown)이 시작돼도 거둔다(그 뒤의 click 은 놓기의 것이
 * 아니다). 타이머만 믿으면 그것이 돌기 전에 온 클릭이 전부 삼켜진다: 입력은 타이머보다 먼저 처리돼, 놓은 직후 화면을 다시 그리느라
 * 바쁜 사이(카드가 많은 씬)에 누른 것이 통째로 사라졌다(2026-10-12 격리 실측: 놓자마자 누른 씬 탭 세 번이 전부 안 먹음 20/20).
 */
function swallowDropClick(): void {
  const stop = () => {
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("mousedown", stop, true);
  };
  const swallow = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
    stop();
  };
  window.addEventListener("click", swallow, true);
  window.addEventListener("mousedown", stop, true);
  window.setTimeout(stop, 0);
}

/** 카드·그룹 끌기의 끝에서 부른다 — 쥔 포인터를 놓고, 실제로 끌다가 손을 떼어 끝난 것이면 뒤따르는 click 을 삼킨다. */
export function endSceneDragPointer(droppedAfterMove: boolean): void {
  releaseSceneDragPointer();
  if (droppedAfterMove) swallowDropClick();
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
  /** **지금**의 그룹 틀(카드·그룹 ref 에서 계산) — 렌더가 잡아 둔 값이 아니다. 남은 끌기를 끝낸 바로 그 누름(SceneBoard settleDrag)에서는
   *  방금 확정된 카드·그룹이 아직 안 그려져, 렌더의 틀로 재배정하면 옮겨 간 그룹의 옛 자리에 놓은 카드가 그 그룹에 들어간다(Codex 코드 리뷰). */
  groupFrames: () => GroupFrame[];
  zoomRef: MutableRefObject<number>;
  /** 화면 좌표 → 캔버스 좌표(지금의 팬·줌으로). 끈 거리는 캔버스 좌표로 잰다. */
  toCanvas: (clientX: number, clientY: number) => { x: number; y: number };
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  setCards: Dispatch<SetStateAction<SceneCard[]>>;
  setGroups: Dispatch<SetStateAction<SceneGroup[]>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  setDraggingIds: Dispatch<SetStateAction<readonly string[]>>;
  /** 일부만 끄는 동안 보드가 끄는 카드의 바깥 틀을 translate 로 그릴 수 있게 한다(SceneBoard 의 moveOrigins) — 첫 걸음에 끌기 전
   *  자리 표를 올리고, 끝나면 null. 실제로 그렇게 그릴지는 보드가 정한다(고른 카드 40장 이상·화면 배율 등 — 조건이 안 맞으면 전처럼
   *  left/top 으로 그린다). 좌표는 어느 쪽이든 걸음마다 넣는다. 보드를 통째로 끄는 빠른 길에서는 올리지 않는다(캔버스 층 하나를 민다). */
  setMoveOrigins: (origins: Readonly<Record<string, { x: number; y: number }>> | null) => void;
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
  // 끄는 중에 화면이 내려가면 끌기 세션은 콜백 없이 버려진다 — 쥔 포인터는 여기서 놓는다(그룹 끌기의 것도 같은 하나다)
  useEffect(() => releaseSceneDragPointer, []);

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
      // 쥔 카드 하나로 잰다(전부 같은 만큼 간다) — 기준 카드가 사라졌으면(밖에서 지워짐) 남은 카드로. 전엔 기준 카드만 봐서, 그것만
      //  사라지면 남은 카드가 놓을 때까지 끌기 전 자리로 돌아가 보였다(Codex 코드 리뷰).
      const cards = optionsRef.current.cardsRef.current;
      const held = cards.find((card) => card.id === cardId) ?? cards.find((card) => !!origins[card.id]);
      // 쥔 카드가 하나도 안 남았으면(끄는 중 전부 삭제) 맞은 것으로 본다 — 층을 밀린 채로 남기지 않는다
      shown = held ? { x: held.x - origins[held.id].x, y: held.y - origins[held.id].y } : want;
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

    const startFrames = current.groupFrames().map((item) => ({
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
    let applied = { x: 0, y: 0 }; // (일부만 끌 때) 좌표에 마지막으로 넣은 이동량 — 격자에 맞춘 값

    // 끌기가 쥔 카드·네모를 '끌기 전 자리 + (dx, dy)'에 다시 놓는다 — 끄는 중에 밖에서 카드·그룹이 갈렸을 때만(아래 beginDrag 의 onRebase).
    //  받은 값(생성 결과·글)은 그대로 두고 좌표만 얹는다. 기준 카드만 보고 건너뛰지 않는다 — 밖 갱신이 일부만 되돌렸을 수 있다(Codex 설계 검토).
    //  속도 표본·이탈 판정은 건드리지 않는다(실제 마우스 움직임이 아니다).
    const place = (dx: number, dy: number) => {
      const latest = optionsRef.current;
      const nextCards = latest.cardsRef.current.map((card) => {
        const origin = origins[card.id];
        return origin ? { ...card, x: origin.x + dx, y: origin.y + dy } : card;
      });
      latest.cardsRef.current = nextCards;
      latest.setCards(nextCards);
      if (!movingRects.size) return;
      const nextGroups = latest.groupsRef.current.map((group) => {
        const origin = movingRects.get(group.id);
        return origin ? { ...group, rect: { ...origin, x: origin.x + dx, y: origin.y + dy } } : group;
      });
      latest.groupsRef.current = nextGroups;
      latest.setGroups(nextGroups);
    };

    const move = (moveEvent: MouseEvent) => {
      if (!moved && Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 4) {
        return;
      }
      const latest = optionsRef.current;
      if (!moved) {
        latest.setDraggingIds(targetIds);
        // 좌표를 넣기 **전에** 올린다 — 보드가 이 순간 손에 든 카드(카드 속이 쥐고 있는 객체)를 기억해 둔다
        if (!wholeBoard) latest.setMoveOrigins(origins);
        holdSceneDragPointer(latest.scrollRef.current); // 끌기가 시작된 뒤에만 쥔다(누르기만 한 것은 클릭이다)
      }
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
      applied = { x: result.dx, y: result.dy };
      latest.cardsRef.current = result.cards;
      latest.setCards(result.cards);

      // 선택된 그룹의 rect 를 카드와 같은 만큼 옮긴다. 마우스의 원본 이동량이 아니라 **격자에 맞춘 이동량**(result.dx/dy —
      // 기준 카드가 실제로 간 거리)을 쓴다 — 격자 스냅이 걸리면 둘이 어긋나 프레임만 반 칸 밀린다. 옮겨진 기준 카드를 찾아
      // 재지 않는다: 끄는 사이 기준 카드가 밖에서 지워지면 네모만 멈춰, 엇갈린 채 저장됐다(Codex 코드 리뷰).
      if (movingRects.size) {
        const nextGroups = latest.groupsRef.current.map((group) => {
          const origin = movingRects.get(group.id);
          return origin
            ? { ...group, rect: { ...origin, x: origin.x + result.dx, y: origin.y + result.dy } }
            : group;
        });
        latest.groupsRef.current = nextGroups;
        latest.setGroups(nextGroups);
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

    const cleanupDrag = (dropped: boolean) => {
      const latest = optionsRef.current;
      latest.scrollRef.current?.classList.remove("dragging");
      endSceneDragPointer(dropped && moved);
      latest.setDraggingIds([]);
      latest.setMoveOrigins(null); // 놓을 때의 좌표 확정과 같은 커밋에서 바깥 틀이 left/top 으로 돌아온다
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
      cleanupDrag(true);
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
      cleanupDrag(false);
      if (relocated) commitMovedCards();
      closeLayer();
      optionsRef.current.endGesture();
    }, () => {
      // 끄는 중에 밖에서 씬이 갱신됐다(생성 결과 도착 등) — 받은 카드에는 저장 전인 이 끌기의 좌표가 없다. 그대로 두면 끌던 카드가
      //  끌기 전 자리로 돌아가 보이고, 더 움직이지 않고 놓으면 그 자리가 저장됐다(2026-10-11 캔버스 실측 3/3). 좌표에 넣어 둔 만큼을
      //  다시 얹는다: 일부만 끌 때는 마지막 걸음, 판을 밀 때는 좌표에 확정해 둔 만큼(0 이어도 — 층이 나머지를 보여 준다).
      //  놓을 때의 '이미 넣었으면 다시 계산하지 않는다'(settleLayerMove)는 그대로다 — 좌표를 끌기가 쥐는 것은 밖에서 갈렸을 때뿐이다.
      if (!moved) return;
      if (wholeBoard) place(settled.x, settled.y);
      else place(applied.x, applied.y);
    });
    // 묶음은 여기서 연다 — 손을 뗀 것을 놓친 앞 끌기가 남아 있었다면 위 beginDrag 가 그것을 먼저 확정하고 닫는다(앞 끌기의 묶음으로).
    //  되돌리기의 시작점은 이 끌기가 옮기는 카드·네모의 끌기 전 자리다.
    current.beginGesture((snapshot) => rewindSceneMove(snapshot, origins, movingRects));
  }, []);
}
