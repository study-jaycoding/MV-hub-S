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
  type SceneHistory,
  type SceneSnap,
} from "./sceneUndoStore";

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
    opts?: { undo?: boolean },
  ) => {
    // 실행 중 표시는 화면 전용이다. 저장·undo 스냅샷에는 완료/대기 상태만 남긴다.
    const next = {
      cards: settleComfyRunning(nextCards),
      edges: nextEdges,
      groups: nextGroups,
    };
    if (opts?.undo !== false) {
      undoStackRef.current.push(lastCommitRef.current);
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

  const restoreState = (snapshot: SceneSnap) => {
    // 결과 대표 선택은 편집 이력과 별개이므로 현재 화면 값을 유지한다.
    const restored = {
      ...snapshot,
      cards: preserveRepresentatives(snapshot.cards, cardsRef.current),
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
    redoStackRef.current.push(lastCommitRef.current);
    restoreState(previous);
  };

  const redo = () => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(lastCommitRef.current);
    restoreState(next);
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
