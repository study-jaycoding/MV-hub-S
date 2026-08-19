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

  const persist = (
    nextCards: SceneCard[],
    nextEdges: SceneEdge[],
    nextGroups: SceneGroup[] = groupsRef.current,
    opts?: { undo?: boolean; removedForward?: SceneCardRemoval[] },
  ) => {
    // 실행 중 표시는 화면 전용이다. 저장·undo 스냅샷에는 완료/대기 상태만 남긴다.
    const next = {
      cards: settleComfyRunning(nextCards),
      edges: nextEdges,
      groups: nextGroups,
    };
    if (opts?.undo !== false) {
      // 이 커밋이 카드 소속을 명시적으로 제거했다면(comfy 워크플로 교체 등), 그 전이 정보를
      // undo 엔트리에 싣는다 — undo 는 이걸 근거로만 부활시키고 redo 는 다시 제거한다(검증 P1).
      undoStackRef.current.push(
        opts?.removedForward?.length
          ? { ...lastCommitRef.current, removedForward: opts.removedForward }
          : lastCommitRef.current,
      );
      if (undoStackRef.current.length > 200) undoStackRef.current.shift();
      redoStackRef.current = [];
    }
    lastCommitRef.current = next;
    onChangeRef.current(next);
    if (opts?.undo === false) persistSceneHistory(sceneIdRef.current);
  };

  const commitDerivedState = (snapshot: SceneSnap) => {
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
    // removedForward 는 스택 엔트리 전용 전이 메타 — 복원 상태(lastCommit·저장분)에는 싣지 않는다.
    const { removedForward: _transitionMeta, ...stateOnly } = snapshot;
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
  const propagateGenIdsToHistory = (cardId: string, latest: SceneCard) => {
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

  const pruneGenIdsFromHistory = (cardId: string, removed: Set<string>) => {
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
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    // 전이 메타는 그 전이의 양쪽 끝을 오갈 때 계속 쓰이므로 redo 엔트리에 그대로 옮겨 싣는다.
    redoStackRef.current.push(
      previous.removedForward?.length
        ? { ...lastCommitRef.current, removedForward: previous.removedForward }
        : lastCommitRef.current,
    );
    restoreState(previous, { revive: previous.removedForward });
  };

  const redo = () => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(
      next.removedForward?.length
        ? { ...lastCommitRef.current, removedForward: next.removedForward }
        : lastCommitRef.current,
    );
    restoreState(next, { remove: next.removedForward });
  };

  return {
    persist,
    syncCommitBaseline,
    persistSceneHistory,
    restoreSceneHistory,
    commitDerivedState,
    hasUncommittedCardsOrEdges,
    propagateGenIdsToHistory,
    pruneGenIdsFromHistory,
    undo,
    redo,
  };
}
