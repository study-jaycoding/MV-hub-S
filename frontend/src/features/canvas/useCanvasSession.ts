import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import { getAccountNamespace } from "../../lib/accountScope";
import { uid, settleComfyRunning, type Scene, type SceneRef } from "../../lib/scenes";
import { isComfyRunning } from "../../lib/sceneComfyRunningStore";
import { freezeLegacyCollectorOrder } from "../../lib/sceneEdges";
import { appendSceneReferenceCards, pasteSceneClipboard, type SceneClipboard } from "../../lib/sceneInteractions";
import { useSceneHistory } from "../../lib/useSceneHistory";
import { useSceneInputCommit } from "../../lib/useSceneInputCommit";
import type { SceneLayerMove } from "../../lib/useSceneCardMove";
import type { Generation } from "../../types";
import { createCanvasDocumentPort, type CanvasWriteReceipt } from "./session";
import { applyCanvasEdit, type CanvasEditCommand, type CanvasSnapshot } from "./edits";
import { withCanvasReferences } from "./references";
import { relinkCards, type RelinkTarget } from "./assetRefs";
import { applyCanvasComfyCommand, isCanvasComfyCommand, type CanvasComfyCommand } from "./comfyCommands";
import { CARD_W, CARD_H } from "../../lib/sceneDerive";
import type { SceneCard } from "../../lib/scenes";
import { createCanvasGestures, type CanvasGestureActive } from "./gestures";

let lastOpenEpoch = 0;

export type CanvasInputCommand = CanvasEditCommand | CanvasComfyCommand;

// 기존 history/input 엔진은 이 세션의 내부다. 화면의 좌표/선택/패널 상태는 Board에 남긴다.
export function useCanvasSession(options: Parameters<typeof useSceneHistory>[0] & {
  layerMoveRef: MutableRefObject<SceneLayerMove | null>;
  generationDataRef?: { readonly current: Readonly<Record<string, Generation>> };
  cardSize?: (card: SceneCard) => { w: number; h: number };
  sourceScene?: Scene;
  onReceiveScene?: (sceneId: string, switched: boolean, replaced: boolean) => void;
}) {
  const history = useSceneHistory(options);
  const input = useSceneInputCommit({ ...options, switchingRef: options.frozenRef,
    persist: history.persist, hasUncommittedSnapshot: history.hasUncommittedSnapshot, canPersist: () => current() });
  const account = getAccountNamespace();
  const target = useMemo(() => Object.freeze({ accountNamespace: account, sceneId: options.sceneId, openEpoch: ++lastOpenEpoch }), [account, options.sceneId]);
  const live = useRef(target); live.current = target;
  const mounted = useRef(true);
  const gestureActiveRef = useRef<CanvasGestureActive | null>(null);
  const current = () => mounted.current && live.current === target && target.accountNamespace === getAccountNamespace()
    && options.sceneIdRef.current === target.sceneId && !options.frozenRef.current;
  const snapshot = (): CanvasSnapshot => ({ cards: options.cardsRef.current, edges: options.edgesRef.current, groups: options.groupsRef.current });
  const generations = () => options.generationDataRef?.current || {};
  const gestures = createCanvasGestures({ cardsRef: options.cardsRef, edgesRef: options.edgesRef, groupsRef: options.groupsRef,
    setCards: options.setCards, setGroups: options.setGroups, history, current,
    withGenerationRefs: (cards, edges) => withCanvasReferences(cards, edges, generations()),
    cardSize: options.cardSize || (card => ({ w: card.w ?? CARD_W, h: card.h ?? CARD_H })), activeRef: gestureActiveRef });
  const reflect = (next: CanvasSnapshot) => {
    if (next.edges !== options.edgesRef.current) { options.edgesRef.current = next.edges; options.setEdges(next.edges); }
    if (next.groups !== options.groupsRef.current) { options.groupsRef.current = next.groups; options.setGroups(next.groups); }
  };
  const synchronizeReferences = () => {
    const edit = applyCanvasEdit(snapshot(), { type: "synchronizeReferences" }, generations());
    if (edit) input.applyCards(edit.snapshot.cards, "persistDerived");
  };
  const commit = useCallback((command: CanvasInputCommand): boolean => {
    if (!current()) return false;
    if (isCanvasComfyCommand(command)) {
      if (command.type === "updateComfyRuntime" || command.type === "refreshComfyMetadata" || command.type === "saveComfyOutputs")
        input.confirmPendingInput();
      return applyCanvasComfyCommand(command, { sceneId: options.sceneId, cardsRef: options.cardsRef, input, history });
    } else {
      if (command.type === "selectCardVariant") input.flushPending();
      else if (command.type === "synchronizeReferences" || command.type === "removeCardVariants") input.confirmPendingInput();
      const edit = applyCanvasEdit(snapshot(), command, generations());
      if (!edit) return false;
      reflect(edit.snapshot);
      input.applyCards(edit.snapshot.cards, edit.policy === "deferred" ? "deferUser" : edit.policy === "derived" ? "persistDerived" : "persistUser");
      if (command.type === "removeCardVariants") history.pruneGenIdsFromHistory(command.cardId, new Set(command.removedIds));
    }
    return true;
  }, [target, input.applyCards, history.propagateGenIdsToHistory]);
  const flush = (): CanvasWriteReceipt => {
    if (!current()) return { queued: false, confirmed: Promise.resolve(false) };
    return createCanvasDocumentPort({ flushPending: () => input.flushPending() }).flush(target);
  };
  const dispose = () => {
    if (!mounted.current || live.current !== target) return;
    if (target.accountNamespace === getAccountNamespace() && options.sceneIdRef.current === target.sceneId) {
      input.flushPending();
      history.endGesture();
      history.persistSceneHistory(target.sceneId);
    }
    input.cancelPendingInput();
    gestureActiveRef.current = null;
    mounted.current = false;
  };
  const lifecycle = useRef({ flush, dispose }); lifecycle.current = { flush, dispose };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => lifecycle.current.dispose();
  }, []);
  useEffect(() => {
    const hide = () => { lifecycle.current.flush(); };
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("pagehide", hide); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  const source = options.sourceScene;
  useEffect(() => {
    if (!source) return;
    const cards = settleComfyRunning(source.cards, isComfyRunning);
    const incoming = { cards, edges: freezeLegacyCollectorOrder(cards, source.edges), groups: source.groups || [] };
    const switched = options.sceneIdRef.current !== source.id;
    if (switched) {
      input.cancelPendingInput();
      history.endGesture();
      gestureActiveRef.current = null;
      history.persistSceneHistory(options.sceneIdRef.current);
      options.sceneIdRef.current = source.id;
      history.restoreSceneHistory(source.id, incoming);
    }
    const replaced = !switched && (incoming.cards !== options.cardsRef.current || incoming.edges !== options.edgesRef.current || incoming.groups !== options.groupsRef.current);
    if (switched || incoming.cards !== options.cardsRef.current) options.setCards(incoming.cards);
    if (switched || incoming.edges !== options.edgesRef.current) options.setEdges(incoming.edges);
    if (switched || incoming.groups !== options.groupsRef.current) options.setGroups(incoming.groups);
    if (replaced) {
      options.cardsRef.current = incoming.cards;
      options.edgesRef.current = incoming.edges;
      options.groupsRef.current = incoming.groups;
    }
    options.onReceiveScene?.(source.id, switched, replaced);
    history.syncCommitBaseline(incoming);
    // scene 속성의 실제 수신에만 반응한다. 내부 편집은 이 경로로 덮어쓰지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id, source?.cards, source?.edges, source?.groups]);
  const addReferences = (references: SceneRef[], center: { x: number; y: number }, size: { w: number; h: number }, connectToGenerationIds?: string[]) => {
    if (!current()) return null;
    const appended = appendSceneReferenceCards({ ...snapshot(), refs: references, center, cardWidth: size.w, cardHeight: size.h, connectToGenerationIds, makeId: uid });
    if (!appended.createdCards.length) return null;
    reflect({ ...snapshot(), edges: appended.edges });
    const cards = appended.connectedTargetIds.length ? withCanvasReferences(appended.cards, appended.edges, generations()) : appended.cards;
    input.applyCards(cards, "persistUser");
    return { createdCardIds: appended.createdCards.map(card => card.id), connectedTargetIds: appended.connectedTargetIds };
  };
  const pasteNodes = (clipboard: SceneClipboard, position?: { x: number; y: number; cardWidth: number; cardHeight: number }) => {
    if (!current() || !clipboard.cards.length) return null;
    const pasted = pasteSceneClipboard(options.cardsRef.current, options.edgesRef.current, clipboard, uid, undefined, position);
    reflect({ ...snapshot(), edges: pasted.edges });
    input.applyCards(withCanvasReferences(pasted.cards, pasted.edges, generations()), "persistUser");
    return { pastedCardIds: pasted.pastedCardIds, nextClipboard: pasted.nextClipboard };
  };
  const relinkAssets = (workspaceId: string, found: Map<string, RelinkTarget>) => {
    if (!current()) return 0;
    input.flushPending();
    const result = relinkCards(options.cardsRef.current, workspaceId, found);
    if (result.changed) input.applyCards(result.cards, "persistDerived");
    history.propagateAssetRelinkToHistory(workspaceId, found);
    return result.changed;
  };
  const undo = () => { if (current()) { input.flushPending(); history.undo(); synchronizeReferences(); } };
  const redo = () => { if (current()) { input.flushPending(); history.redo(); synchronizeReferences(); } };
  return { target, commit, flush, dispose, gestures,
    snapshot: () => current() ? snapshot() : undefined, addReferences, pasteNodes, relinkAssets, undo, redo };
}
