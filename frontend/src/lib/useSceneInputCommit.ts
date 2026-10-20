import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { SceneCard, SceneEdge, SceneGroup } from "./scenes";
import type { SceneLayerMove } from "./useSceneCardMove";
import type { useSceneHistory } from "./useSceneHistory";
import { holdUnload } from "./unloadGuard";

type SceneHistory = ReturnType<typeof useSceneHistory>;
interface UseSceneInputCommitOptions {
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  groupsRef: MutableRefObject<SceneGroup[]>;
  setCards: Dispatch<SetStateAction<SceneCard[]>>;
  switchingRef: MutableRefObject<boolean>;
  layerMoveRef: MutableRefObject<SceneLayerMove | null>;
  persist: SceneHistory["persist"];
  hasUncommittedSnapshot: SceneHistory["hasUncommittedSnapshot"];
  canPersist?: () => boolean;
}

export type ApplyCardsMode = "live" | "deferUser" | "persistUser" | "persistDerived";

// 문서 세션 내부에서 입력 저장 시점만 조정한다. 반영 모드와 Undo 선택은 UI에 공개하지 않는다.
export function useSceneInputCommit({
  cardsRef, edgesRef, groupsRef, setCards, switchingRef, layerMoveRef, persist, hasUncommittedSnapshot, canPersist,
}: UseSceneInputCommitOptions) {
  // ── C3: 텍스트·comfy 파라미터 입력은 묶어서 저장해 키 입력마다 저장 연산을 만들지 않는다.
  //  화면(setCards)·cardsRef 는 즉시 갱신(생성이 최신값을 읽음), 저장(persist)만 디바운스. 밀린 저장은
  //  입력 blur·언마운트·씬 전환(App 이 flushPending 호출) 시 저장 큐로 넘긴다. IndexedDB 확정과는 별개다.
  const pendingPersistRef = useRef<number | undefined>(undefined);
  // 아직 저장으로 넘기지 않은 입력이 **처음 생긴 시각**. 계속 치면 400ms 디바운스가 끝없이 밀려 저장이
  // 한 번도 안 나가는데, 저장이 IndexedDB 로 가면서 창을 닫는 순간의 저장은 끝난다는 보장이 없어졌다
  // (종전 localStorage 는 그 자리에서 끝났다). 그래서 첫 미저장 입력에서 2초가 지나면 치는 중이어도
  // 저장을 내보낸다 — 잃을 수 있는 구간을 줄이는 것이지 없애는 것은 아니다.
  const pendingSinceRef = useRef<number | undefined>(undefined);
  useEffect(() => () => holdUnload("scene-save:input", false), []);
  const cancelPendingInput = () => {
    if (pendingPersistRef.current !== undefined) {
      clearTimeout(pendingPersistRef.current);
      pendingPersistRef.current = undefined;
    }
    pendingSinceRef.current = undefined;
    holdUnload("scene-save:input", false);
  };
  const flushPending = () => {
    cancelPendingInput();
    // 씬을 바꾸는 틈(새 씬은 왔고 그 카드는 아직 안 그려졌다 — 위 switchingRef)에는 확정할 것이 없다 — 손에 든 카드는 **떠난 씬**의 것이라,
    //  여기서 저장하면 방금 연 씬이 앞 씬의 카드로 덮인다(2026-10-10 실측: 씬 탭을 25ms 안에 연달아 누르면 9/9, 새로 고침 뒤에도 남음).
    //  떠난 씬의 밀린 편집은 전환 직전의 flushPending 이 이미 확정했다.
    if (switchingRef.current || (canPersist && !canPersist())) return;
    // 층에만 있던 전체 끌기의 이동량을 좌표에 넣는다 — 안 넣으면 끄는 중 씬을 바꿀 때 그 이동이 저장에서 빠진다(걸음마다 좌표를
    //  바꾸는 평소 길은 여기서 저장됐다).
    layerMoveRef.current?.settle();
    if (!hasUncommittedSnapshot(cardsRef.current, edgesRef.current, groupsRef.current)) return; // 밀린 편집 없음
    persist(cardsRef.current, edgesRef.current); // 사용자 편집 확정 → undo:true
  };
  const flushPendingRef = useRef(flushPending);
  flushPendingRef.current = flushPending;
  // 파생 저장(실행 상태·생성 결과 반영·연결 레퍼런스 맞춤) 앞에서 부른다 — 치던 글이 있으면 그것부터 한 단계로 확정한다(조작 규칙 44).
  //  파생 저장은 손에 든 카드 전체를 '저장된 것'으로 삼는데 거기에 아직 저장 전인 글도 들어 있어, 뒤의 입력 확정이 '바뀐 것 없음'으로
  //  끝났다 — 그 글의 단계가 없어 Ctrl+Z 가 그 앞의 편집까지 되감았다. 밀린 입력이 있을 때만 한다: 늘 하면 순차 실행 중 화면에만 올려 둔
  //  값(applyCards 의 live)이 사용자 단계로 쌓인다.
  const confirmPendingInput = () => {
    if (pendingSinceRef.current !== undefined) flushPending();
  };
  const scheduleInputPersist = () => {
    const now = Date.now();
    if (pendingSinceRef.current === undefined) pendingSinceRef.current = now;
    holdUnload("scene-save:input", true);
    if (pendingPersistRef.current !== undefined) clearTimeout(pendingPersistRef.current);
    const wait = Math.max(0, Math.min(400, pendingSinceRef.current + 2000 - now));
    pendingPersistRef.current = window.setTimeout(() => {
      pendingPersistRef.current = undefined;
      flushPendingRef.current();
    }, wait);
  };
  // ── 카드 반영 어댑터 — 화면(cardsRef+setCards)은 항상 즉시, 저장은 mode 로 구분. Comfy 실행부가
  //  persist/scheduleInputPersist 를 직접 부르지 않고 이 하나로만 카드를 반영하게 해 결합을 좁힌다(P4 준비).
  //   · live          : 화면만(저장 안 함) — 순차 실행 중 다음 노드가 최신 출력을 읽게
  //   · deferUser     : 사용자 입력 → 저장 디바운스(blur/실행 시 flush)
  //   · persistUser   : 사용자 편집 확정 저장(undo 스택에 쌓임)
  //   · persistDerived: 실행상태·파생 저장(undo 스택 제외)
  const applyCards = (
    nextCards: SceneCard[],
    mode: ApplyCardsMode,
    persistOpts?: {
      removedForward?: { cardId: string; genIds: string[] }[];
      addedForward?: { cardId: string; genIds: string[] }[];
    },
  ) => {
    if (mode === "persistDerived") confirmPendingInput(); // 손에 든 카드가 아직 '파생 변경 전'일 때
    cardsRef.current = nextCards;
    setCards(nextCards);
    if (mode === "live") return;
    if (mode === "deferUser") {
      scheduleInputPersist();
      return;
    }
    persist(nextCards, edgesRef.current, groupsRef.current, {
      undo: mode !== "persistDerived",
      ...persistOpts,
    });
  };
  return { flushPending, flushPendingRef, confirmPendingInput, scheduleInputPersist, applyCards, cancelPendingInput };
}
