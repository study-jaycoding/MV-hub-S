import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import { getAccountNamespace } from "../../lib/accountScope";
import { uid, settleComfyRunning, type Scene, type SceneRef } from "../../lib/scenes";
import { onCanvasMemoryReturn } from "../../lib/popupWindows";
import { comfyRunningIn } from "../../lib/sceneComfyRunningStore";
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
import { CARD_W, CARD_H, liveSceneGroups } from "../../lib/sceneDerive";
import type { SceneCard } from "../../lib/scenes";
import type { SceneSnap } from "../../lib/sceneUndoStore";
import { createCanvasGestures, type CanvasGestureActive } from "./gestures";

let lastOpenEpoch = 0;

export type CanvasInputCommand = CanvasEditCommand | CanvasComfyCommand;

// 기존 history/input 엔진은 이 세션의 내부다. 화면의 좌표/선택/패널 상태는 Board에 남긴다.
// GPU 보기 모드에서도 받는 명령 — 실행 결과 반영(승인된 비동기)·파생뿐(features/canvas/gpu, 계약 readonly 허용 목록)
const VIEW_MODE_ALLOWED: ReadonlySet<string> = new Set(["refreshComfyMetadata", "showComfyRunning", "updateComfyRuntime", "saveComfyOutputs", "synchronizeReferences"]);

export function useCanvasSession(options: Omit<Parameters<typeof useSceneHistory>[0], "onChange"> & {
  onChange: (snapshot: SceneSnap) => CanvasWriteReceipt | void;
  layerMoveRef: MutableRefObject<SceneLayerMove | null>;
  generationDataRef?: { readonly current: Readonly<Record<string, Generation>> };
  cardSize?: (card: SceneCard) => { w: number; h: number };
  sourceScene?: Scene;
  onReceiveScene?: (sceneId: string, switched: boolean, replaced: boolean) => void;
  /** GPU 보기 모드의 사용자 편집 허용(isFrozen 과 따로) — 거짓이면 사용자 변경 입구(편집 명령·레퍼런스 넣기·붙여넣기·되돌리기·다시하기·제스처
   *  시작)를 거절한다. 씬 수신·실패 정리·Comfy 결과(승인된 비동기 결과)·참조 동기화(파생)는 막지 않는다. 없으면 늘 허용. */
  editAllowed?: () => boolean;
  onEditRefused?: () => void;
}) {
  // 값 반환을 버리는 래퍼를 두지 않는다. B의 history가 이 편집의 영수증을 그대로 받는다.
  const history = useSceneHistory({ ...options, onChange: snapshot => options.onChange(snapshot) });
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
  const editOk = () => !options.editAllowed || options.editAllowed();
  /** 사용자 변경 입구 — 보기 모드면 안내 한 번 하고 거짓(실행하지 않는다) */
  const userGate = () => {
    if (editOk()) return true;
    options.onEditRefused?.();
    return false;
  };
  // 제스처는 보기 모드에서 시작하지 않는다(시작 손잡이가 빈 손잡이를 돌려준다 — current 가 거짓일 때와 같다)
  const gestures = createCanvasGestures({ cardsRef: options.cardsRef, edgesRef: options.edgesRef, groupsRef: options.groupsRef,
    setCards: options.setCards, setGroups: options.setGroups, history, current: () => current() && editOk(),
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
    // 실행 결과 반영(승인된 비동기 — Comfy 진행·결과·메타 갱신)·참조 동기화(파생)는 보기 모드에서도 받는다. 그 밖은 사용자 변경이다 —
    //  Comfy 라도 설정 바꾸기·워크플로 교체·결과 되찾기(recoverCardGeneration)는 사용자가 누른 것이라 거절한다(11-11 리뷰: 되찾기 창이 보기 모드에 남았다).
    if (!VIEW_MODE_ALLOWED.has(command.type) && !userGate()) return false;
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
      if (command.type === "removeCardVariants") history.pruneGenIdsFromHistory(command.cardId, new Set(command.removedIds)); // 저장보다 먼저 — 저장이 기록을 복제해 보존 슬롯에 예약한다
      input.applyCards(edit.snapshot.cards, edit.policy === "deferred" ? "deferUser" : edit.policy === "derived" ? "persistDerived" : "persistUser");
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
  // 캔버스 창이 값을 돌려주기 전에 — 끌기 끝맺음 → 밀린 입력 확정. 그래야 돌려준 되돌리기·다시 실행 기록과 넘긴 씬이 서로 맞다.
  const settle = () => {
    if (!current()) return;
    gestureActiveRef.current?.finish();
    input.flushPending();
    history.endGesture();
  };
  const lifecycle = useRef({ flush, dispose, settle }); lifecycle.current = { flush, dispose, settle };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => lifecycle.current.dispose();
  }, []);
  useEffect(() => onCanvasMemoryReturn(() => lifecycle.current.settle()), []);
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
    const cards = settleComfyRunning(source.cards, comfyRunningIn(getAccountNamespace(), source.id));
    // 묶음 모양이 아닌 항목은 버린다(손상 씬 — sceneDerive.liveSceneGroups). 멀쩡하면 같은 배열이라 바뀜 비교가 그대로다.
    const incoming = { cards, edges: freezeLegacyCollectorOrder(cards, source.edges), groups: liveSceneGroups(source.groups) };
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
    if (!switched && source.comfyCardRuns) {
      for (const card of incoming.cards) {
        const previous = options.cardsRef.current.find(item => item.id === card.id);
        if (card.kind === "comfy" && source.comfyCardRuns[card.id]?.representative
          && previous?.comfyCfg?.content === card.comfyCfg?.content
          && (JSON.stringify(previous?.genIds) !== JSON.stringify(card.genIds)
            || JSON.stringify(previous?.comfyCfg?.outputs) !== JSON.stringify(card.comfyCfg?.outputs)))
          history.propagateGenIdsToHistory(card.id, card);
      }
    }
    if (switched || incoming.cards !== options.cardsRef.current) options.setCards(incoming.cards);
    if (switched || incoming.edges !== options.edgesRef.current) options.setEdges(incoming.edges);
    if (switched || incoming.groups !== options.groupsRef.current) options.setGroups(incoming.groups);
    if (replaced) {
      options.cardsRef.current = incoming.cards;
      options.edgesRef.current = incoming.edges;
      options.groupsRef.current = incoming.groups;
    }
    options.onReceiveScene?.(source.id, switched, replaced);
    const received = replaced && history.differsFromCommit(incoming); // replaced 는 참조 비교다 — 값이 같으면 기록 전체를 복제하지 않는다
    history.syncCommitBaseline(incoming);
    if (received) history.checkpointReceived();
    // scene 속성의 실제 수신에만 반응한다. 내부 편집은 이 경로로 덮어쓰지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id, source?.cards, source?.edges, source?.groups]);
  const addReferences = (references: SceneRef[], center: { x: number; y: number }, size: { w: number; h: number }, connectToGenerationIds?: string[]) => {
    if (!current() || !userGate()) return null;
    const appended = appendSceneReferenceCards({ ...snapshot(), refs: references, center, cardWidth: size.w, cardHeight: size.h, connectToGenerationIds, makeId: uid });
    if (!appended.createdCards.length) return null;
    reflect({ ...snapshot(), edges: appended.edges });
    const cards = appended.connectedTargetIds.length ? withCanvasReferences(appended.cards, appended.edges, generations()) : appended.cards;
    input.applyCards(cards, "persistUser");
    return { createdCardIds: appended.createdCards.map(card => card.id), connectedTargetIds: appended.connectedTargetIds };
  };
  const pasteNodes = (clipboard: SceneClipboard, position?: { x: number; y: number; cardWidth: number; cardHeight: number }) => {
    if (!current() || !clipboard.cards.length || !userGate()) return null;
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
  const undo = () => { if (current() && userGate()) { input.flushPending(); history.undo(); synchronizeReferences(); } };
  const redo = () => { if (current() && userGate()) { input.flushPending(); history.redo(); synchronizeReferences(); } };
  return { target, commit, flush, dispose, gestures,
    snapshot: () => current() ? snapshot() : undefined, addReferences, pasteNodes, relinkAssets, undo, redo };
}
