import { useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  preserveRepresentatives,
  settleComfyRunning,
  variantIds,
  type Scene,
  type SceneCard,
  type SceneEdge,
  type SceneGroup,
} from "./scenes";
import {
  loadSceneHistory,
  sameSnap,
  saveSceneHistory as saveStoredSceneHistory,
  type SceneCardRemoval,
  type SceneHistory,
  type SceneSnap,
} from "./sceneUndoStore";
import {
  markCardGenerationsRemoved,
  mergeCardLinksIntoScenes,
  reviveCardGenerations,
  serverCardLinks,
} from "./sceneCardLinks";
import { relinkCards, type RelinkTarget } from "./sceneAssetRelink";

interface UseSceneHistoryOptions {
  sceneId: string;
  initialSnapshot: SceneSnap;
  sceneIdRef: MutableRefObject<string>;
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  groupsRef: MutableRefObject<SceneGroup[]>;
  setCards: Dispatch<SetStateAction<SceneCard[]>>;
  setEdges: Dispatch<SetStateAction<SceneEdge[]>>;
  setGroups: Dispatch<SetStateAction<SceneGroup[]>>;
  clearSelection: () => void;
  onChange: (patch: Partial<Scene>) => void;
  // 씬을 바꾸는 틈(SceneBoard 의 switchingRef) — 손에 든 카드가 떠난 씬의 것인 동안은 저장도 되돌리기도 받지 않는다.
  //  받으면 떠난 씬의 카드가 부모의 '지금 활성 씬'(새 씬)에 쓰이고, 새 씬의 되돌리기 기록에 떠난 씬의 모습이 쌓인다.
  frozenRef: MutableRefObject<boolean>;
}

// SceneBoard의 화면 상태는 건드리지 않고, 저장 커밋과 undo/redo 스택만 소유한다.
export function useSceneHistory({
  sceneId,
  initialSnapshot,
  sceneIdRef,
  cardsRef,
  edgesRef,
  groupsRef,
  setCards,
  setEdges,
  setGroups,
  clearSelection,
  onChange,
  frozenRef,
}: UseSceneHistoryOptions) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 저장된 최근 커밋과 현재 씬이 이어질 때만 기존 스택을 복원한다.
  const bootHistoryRef = useRef<SceneHistory | null>(null);
  if (bootHistoryRef.current === null) {
    const stored = loadSceneHistory(sceneId);
    bootHistoryRef.current =
      stored && sameSnap(stored.lastCommit, initialSnapshot)
        ? stored
        : { undo: [], redo: [], lastCommit: initialSnapshot };
  }

  const undoStackRef = useRef(bootHistoryRef.current.undo);
  const redoStackRef = useRef(bootHistoryRef.current.redo);
  const lastCommitRef = useRef(bootHistoryRef.current.lastCommit);

  const syncCommitBaseline = (snapshot: SceneSnap) => {
    lastCommitRef.current = snapshot;
  };

  const resetUndoHistory = () => {
    undoStackRef.current = [];
    redoStackRef.current = [];
  };

  const persistSceneHistory = (targetSceneId: string) => {
    saveStoredSceneHistory(targetSceneId, {
      undo: undoStackRef.current,
      redo: redoStackRef.current,
      lastCommit: lastCommitRef.current,
    });
  };

  const restoreSceneHistory = (targetSceneId: string, incoming: SceneSnap) => {
    const stored = loadSceneHistory(targetSceneId);
    if (stored && sameSnap(stored.lastCommit, incoming)) {
      undoStackRef.current = stored.undo;
      redoStackRef.current = stored.redo;
      lastCommitRef.current = stored.lastCommit;
    } else {
      resetUndoHistory();
    }
  };

  // 전이 메타를 스택 엔트리에 싣는다. 메타가 없으면 원본 객체를 그대로 둔다 — 전체 지문 비교
  // (sameSnap)가 현재 씬 props 와 일치해야 하므로 쓸데없이 새 객체를 만들지 않는다.
  const carryTransition = (
    base: SceneSnap,
    meta?: { removedForward?: SceneCardRemoval[]; addedForward?: SceneCardRemoval[] },
  ): SceneSnap =>
    meta?.removedForward?.length || meta?.addedForward?.length
      ? {
          ...base,
          ...(meta.removedForward?.length ? { removedForward: meta.removedForward } : {}),
          ...(meta.addedForward?.length ? { addedForward: meta.addedForward } : {}),
        }
      : base;

  // 한 번의 끌기(누르고 있는 동안)에 난 저장은 되돌리기 한 단계로 묶는다. 끄는 중에 저장이 끼면(카메라 저장 앞의 확정·삭제) 놓을 때의
  //  저장과 따로 쌓여, 한 번 끈 것을 되돌리는 데 Ctrl+Z 가 두 번 들었다(2026-10-10 격리 실측 — 첫 번째는 헛돌거나 중간 자리로 갔다).
  //  묶음의 첫 저장만 되돌리기 엔트리(그 저장 직전의 모습)를 쌓고, 뒤 저장은 그 엔트리에 전이 메타만 보탠다.
  //  · rewind: 엔트리로 쌓을 '직전의 모습'을 끌기 전 좌표로 되감는 함수 — 끄는 중에 낀 파생 저장(생성 결과 반영, undo:false)이
  //    lastCommit 을 이미 옮긴 좌표로 바꿔 놓았을 수 있다(안 되감으면 Ctrl+Z 가 끌기 전이 아니라 그 중간 자리로 갔다 — Codex 코드 리뷰).
  //  · depth: 그 엔트리를 쌓은 직후의 스택 높이. 엔트리 객체로 기억하지 않는다 — 생성 결과 반영(propagate…)이 스택의 객체를 새로 만든다.
  const gestureRef = useRef<{ depth: number; rewind?: (snapshot: SceneSnap) => SceneSnap } | null>(null);
  const beginGesture = (rewind?: (snapshot: SceneSnap) => SceneSnap) => {
    gestureRef.current = { depth: -1, rewind };
  };
  const endGesture = () => {
    gestureRef.current = null;
  };

  const persist = (
    nextCards: SceneCard[],
    nextEdges: SceneEdge[],
    nextGroups: SceneGroup[] = groupsRef.current,
    opts?: {
      undo?: boolean;
      removedForward?: SceneCardRemoval[];
      addedForward?: SceneCardRemoval[];
    },
  ) => {
    if (frozenRef.current) return; // 씬을 바꾸는 틈 — 이 카드는 떠난 씬의 것이다(위 frozenRef)
    // 실행 중 표시는 화면 전용이다. 저장·undo 스냅샷에는 완료/대기 상태만 남긴다.
    const next = {
      cards: settleComfyRunning(nextCards),
      edges: nextEdges,
      groups: nextGroups,
    };
    if (opts?.undo !== false) {
      // 이 커밋이 카드 소속을 명시적으로 제거했다면(comfy 워크플로 교체 등) 또는 추가했다면
      // (떨어진 생성물 붙이기), 그 전이 정보를 undo 엔트리에 싣는다 — undo/redo 는 이걸
      // 근거로만 부활·제거한다("스냅샷에 있으니" 추론 금지, 검증 P1).
      const gesture = gestureRef.current;
      const stack = undoStackRef.current;
      if (gesture && stack.length > 0 && gesture.depth === stack.length) {
        // 같은 끌기의 뒤 저장 — 새 단계를 쌓지 않는다. 이 저장이 뺀·붙인 소속만 그 엔트리에 보탠다(되돌릴 때 같이 되살린다).
        if (opts?.removedForward?.length || opts?.addedForward?.length) {
          const top = stack[stack.length - 1];
          stack[stack.length - 1] = {
            ...top,
            removedForward: [...(top.removedForward ?? []), ...(opts.removedForward ?? [])],
            addedForward: [...(top.addedForward ?? []), ...(opts.addedForward ?? [])],
          };
        }
      } else {
        const base = gesture?.rewind ? gesture.rewind(lastCommitRef.current) : lastCommitRef.current;
        stack.push(carryTransition(base, opts));
        if (stack.length > 200) stack.shift();
        if (gesture) gesture.depth = stack.length;
      }
      redoStackRef.current = [];
    }
    lastCommitRef.current = next;
    onChangeRef.current(next);
    if (opts?.undo === false) persistSceneHistory(sceneIdRef.current);
  };

  const commitDerivedState = (snapshot: SceneSnap) => {
    if (frozenRef.current) return;
    const settled = { ...snapshot, cards: settleComfyRunning(snapshot.cards) };
    lastCommitRef.current = settled;
    onChangeRef.current(settled);
    persistSceneHistory(sceneIdRef.current);
  };

  const hasUncommittedCardsOrEdges = (nextCards: SceneCard[], nextEdges: SceneEdge[]) =>
    nextCards !== lastCommitRef.current.cards || nextEdges !== lastCommitRef.current.edges;

  const restoreState = (
    snapshot: SceneSnap,
    transition?: { revive?: SceneCardRemoval[]; remove?: SceneCardRemoval[] },
  ) => {
    // 결과 대표 선택은 편집 이력과 별개이므로 현재 화면 값을 유지한다.
    const restoredCards = preserveRepresentatives(snapshot.cards, cardsRef.current);
    const sceneIdNow = sceneIdRef.current;
    // ① 전이 의도를 먼저 기록한다(검증 P1 — "스냅샷에 있으니 부활" 추론 금지, 전이 메타만).
    //    · undo(역방향): 그 커밋이 제거했던 소속을 명시적으로 부활
    //    · redo(정방향): 같은 소속을 다시 제거
    //    기록이 ②병합보다 먼저라야, 병합이 이 전이를 도로 무르지 않는다(오버레이가 가림).
    for (const delta of transition?.revive || []) {
      reviveCardGenerations(sceneIdNow, delta.cardId, delta.genIds);
    }
    for (const delta of transition?.remove || []) {
      void markCardGenerationsRemoved(sceneIdNow, delta.cardId, delta.genIds);
    }
    // ② 서버가 아는 소속(다른 브라우저에서 담은 결과)을 복원본에도 합친다 — 과거 스냅샷엔
    //    없어서 undo 가 세션 내내 그 결과를 숨기던 문제(합의 FE-P1-4).
    const merged = mergeCardLinksIntoScenes(
      [{ id: sceneIdNow, cards: restoredCards }],
      serverCardLinks(sceneIdNow),
    );
    // 전이 메타는 스택 엔트리 전용 — 복원 상태(lastCommit·저장분)에는 싣지 않는다.
    const {
      removedForward: _removedMeta,
      addedForward: _addedMeta,
      ...stateOnly
    } = snapshot;
    const restored = {
      ...stateOnly,
      cards: merged ? (merged[0].cards as SceneCard[]) : restoredCards,
    };
    lastCommitRef.current = restored;
    cardsRef.current = restored.cards;
    edgesRef.current = restored.edges;
    groupsRef.current = restored.groups;
    setCards(restored.cards);
    setEdges(restored.edges);
    setGroups(restored.groups);
    clearSelection();
    onChangeRef.current(restored);
  };

  // 자동으로 누적된 생성 결과를 과거 스냅샷에도 반영해 undo 시 결과가 사라지지 않게 한다.
  // 아래 셋(과거 스냅샷 고치기)도 틈에는 받지 않는다 — 넘어온 카드·값은 떠난 씬의 것이고 기록은 이미 새 씬의 것이다
  //  (틈에 끝난 Comfy 저장이 떠난 씬의 결과 목록을 새 씬의 되돌리기 기록에 넣었다 — Codex 코드 리뷰).
  const propagateGenIdsToHistory = (cardId: string, latest: SceneCard) => {
    if (frozenRef.current) return;
    const latestIds = variantIds(latest);
    const patchCard = (card: SceneCard): SceneCard => {
      if (card.id !== cardId || card.kind !== latest.kind) return card;
      if (card.kind === "comfy" && card.comfyCfg?.content !== latest.comfyCfg?.content) return card;
      const genId =
        card.genId && latestIds.includes(card.genId) ? card.genId : latest.genId;
      return {
        ...card,
        genIds: latest.genIds,
        genId,
        ...(latest.kind === "comfy"
          ? { comfyCfg: { ...(card.comfyCfg || {}), outputs: latest.comfyCfg?.outputs } }
          : {}),
      };
    };
    const patchSnapshot = (snapshot: SceneSnap): SceneSnap => ({
      ...snapshot,
      cards: snapshot.cards.map(patchCard),
    });
    undoStackRef.current = undoStackRef.current.map(patchSnapshot);
    redoStackRef.current = redoStackRef.current.map(patchSnapshot);
    persistSceneHistory(sceneIdRef.current);
  };

  // 자산 자동 복구(옛 참조 → 원본 경로)를 과거 스냅샷에도 입혀, undo/redo 가 옛 참조를 되살리지 않게 한다.
  const propagateAssetRelinkToHistory = (workspaceId: string, found: Map<string, RelinkTarget>) => {
    if (frozenRef.current) return;
    const patchSnapshot = (snapshot: SceneSnap): SceneSnap => {
      const { cards, changed } = relinkCards(snapshot.cards, workspaceId, found);
      return changed ? { ...snapshot, cards } : snapshot;
    };
    undoStackRef.current = undoStackRef.current.map(patchSnapshot);
    redoStackRef.current = redoStackRef.current.map(patchSnapshot);
    persistSceneHistory(sceneIdRef.current);
  };

  const pruneGenIdsFromHistory = (cardId: string, removed: Set<string>) => {
    if (frozenRef.current) return;
    const patchCard = (card: SceneCard): SceneCard => {
      if (card.id !== cardId) return card;
      const genIds = variantIds(card).filter((id) => !removed.has(id));
      const genId = card.genId && !removed.has(card.genId) ? card.genId : genIds[0] ?? null;
      return { ...card, genIds, genId };
    };
    const patchSnapshot = (snapshot: SceneSnap): SceneSnap => ({
      ...snapshot,
      cards: snapshot.cards.map(patchCard),
    });
    undoStackRef.current = undoStackRef.current.map(patchSnapshot);
    redoStackRef.current = redoStackRef.current.map(patchSnapshot);
    persistSceneHistory(sceneIdRef.current);
  };

  const undo = () => {
    if (frozenRef.current) return;
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    // 전이 메타는 그 전이의 양쪽 끝을 오갈 때 계속 쓰이므로 redo 엔트리에 그대로 옮겨 싣는다.
    redoStackRef.current.push(carryTransition(lastCommitRef.current, previous));
    // 역방향 — 그 커밋이 뺀 것은 되살리고, 붙인 것은 뗀다.
    restoreState(previous, {
      revive: previous.removedForward,
      remove: previous.addedForward,
    });
  };

  const redo = () => {
    if (frozenRef.current) return;
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(carryTransition(lastCommitRef.current, next));
    // 정방향 — 다시 빼고, 다시 붙인다.
    restoreState(next, { remove: next.removedForward, revive: next.addedForward });
  };

  return {
    persist,
    syncCommitBaseline,
    persistSceneHistory,
    restoreSceneHistory,
    commitDerivedState,
    hasUncommittedCardsOrEdges,
    beginGesture,
    endGesture,
    propagateGenIdsToHistory,
    propagateAssetRelinkToHistory,
    pruneGenIdsFromHistory,
    undo,
    redo,
  };
}
