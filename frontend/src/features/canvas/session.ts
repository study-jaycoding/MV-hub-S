import { getAccountNamespace } from "../../lib/accountScope";
import {
  confirmSceneWrite, listScenes, listPersistedScenes, updateScenesWith,
  variantIds, importScene, mergeScenesFromBackup, type SceneSnapshot,
  type Scene, type SceneCard, type SceneEdge,
} from "../../lib/scenes";
import {
  prepareCanvasGenerationLinks, settleCanvasGenerationAttempt, discardCanvasGenerationAttempt,
  reconcileCanvasGenerationAttempts, type CanvasGenerationLink, type ResolvedCanvasGenerationLink,
} from "../../lib/canvasGenerationRecovery";
import { applyRelink, type RelinkTarget } from "./assetRefs";
import { sameSceneContent } from "../../lib/sceneAbsorb";
import { mergeCardLinksIntoScenes, type CardLink } from "../../lib/sceneCardLinks";
import { comfySceneFingerprints } from "../../lib/sceneComfyInputs";
import type { ComfyApplicationReceipt, ComfyAttemptTarget, ComfyCanvasResolution, ComfyCanvasRun, PreparedComfyAttempt, ReserveResult } from "../../lib/comfyRunState";
import { applyComfyResolution } from "./comfyCommands";

// 영속 대상은 열린 화면의 세대와 별개다. 다른 씬을 보고 있어도 원래 씬에 정산할 수 있다.
export interface CanvasTarget { readonly accountNamespace: string; readonly sceneId: string }
export type CanvasCommand =
  | { type: "resolveComfy"; resolution: ComfyCanvasResolution; canWrite: () => boolean }
  | { type: "ackComfy"; receipt: ComfyApplicationReceipt; canWrite: () => boolean }
  | { type: "submitComfy"; attemptId: string; canWrite: () => boolean }
  | { type: "discardUnsubmittedComfy"; attempt: ComfyCanvasRun; canWrite: () => boolean }
  | { type: "reserveGeneration"; links: CanvasGenerationLink[]; createdAt: number }
  | { type: "settleGeneration" | "discardGeneration"; cardId: string; generationId: string }
  | { type: "reconcileGenerations"; links: ResolvedCanvasGenerationLink[]; now: number }
  | { type: "insertPlanCards"; cards: SceneCard[]; edges: SceneEdge[]; expected: Scene }
  | { type: "appendTaskCards"; cards: SceneCard[]; receiptId: string }
  | { type: "editCardPrompt"; cardId: string; prompt: string }
  | { type: "recordCamera"; camera: Scene["camera"] }
  | { type: "linkCardResults"; cardId: string; generationIds: string[] };

export interface CanvasWriteReceipt { readonly queued: boolean; readonly confirmed: Promise<boolean>; readonly settled?: Promise<boolean> }
export interface CanvasDocumentPort {
  snapshot(target: CanvasTarget, persisted?: boolean): Scene | undefined;
  commit(target: CanvasTarget, command: CanvasCommand): CanvasWriteReceipt;
  flush(target: CanvasTarget): CanvasWriteReceipt;
  reserveComfyAttempt(target: ComfyAttemptTarget, prepared: PreparedComfyAttempt): Promise<ReserveResult>;
}

export const canvasTarget = (sceneId: string): CanvasTarget => Object.freeze({ accountNamespace: getAccountNamespace(), sceneId });
const authorized = (target: CanvasTarget) => target.accountNamespace === getAccountNamespace();
const stopped = (): CanvasWriteReceipt => ({ queued: false, confirmed: Promise.resolve(false) });

function reservation(scene: Scene | undefined, target: ComfyAttemptTarget, prepared: PreparedComfyAttempt): { result: ReserveResult; scene?: Scene } {
  const fingerprints = scene && comfySceneFingerprints(scene, prepared.cardId);
  if (!scene || !fingerprints || fingerprints.configFp !== prepared.configFp || fingerprints.inputFp !== prepared.inputFp)
    return { result: { status: "stale" } };
  const existing = scene.comfyRuns?.find(run => run.attemptId === prepared.attemptId);
  if (existing) {
    const same = existing.originHubId === target.originHubId && existing.originDeviceId === target.originDeviceId
      && (Object.keys(prepared) as (keyof PreparedComfyAttempt)[]).every(key => existing[key] === prepared[key]);
    return { result: same && existing.localState !== "applied"
      ? { status: "reserved", attempt: existing, groupSeq: existing.groupSeq } : { status: "stale" } };
  }
  if (scene.comfyRuns?.some(run => run.cardId === prepared.cardId && run.runGroupId !== prepared.runGroupId && run.localState !== "applied"
    && run.originHubId === target.originHubId && run.originDeviceId === target.originDeviceId))
    return { result: { status: "conflict" } };
  const owner = scene.comfyCardRuns?.[prepared.cardId];
  // 처리된 옛 groupId를 다시 써서 새 묶음을 앞지르지 않는다.
  if (owner?.groupId !== prepared.runGroupId && scene.comfyRuns?.some(run => run.runGroupId === prepared.runGroupId && run.cardId === prepared.cardId))
    return { result: { status: "stale" } };
  const groupSeq = owner?.groupId === prepared.runGroupId ? owner.groupSeq : (owner?.groupSeq || 0) + 1;
  const attempt: ComfyCanvasRun = { ...prepared, version: 1, originHubId: target.originHubId,
    originDeviceId: target.originDeviceId, groupSeq, localState: "reserved" };
  return { result: { status: "reserved", attempt, groupSeq }, scene: { ...scene,
    comfyRuns: [...(scene.comfyRuns || []), attempt], comfyCardRuns: { ...scene.comfyCardRuns,
      [prepared.cardId]: owner?.groupId === prepared.runGroupId ? owner : { groupId: prepared.runGroupId, groupSeq } } } };
}

/** groupSeq는 최신 문서 위 연산에서 배정한다. 큐 성공 뒤에도 실제 attempt/소유권을 확인한다. */
export async function reserveComfyAttempt(target: ComfyAttemptTarget, prepared: PreparedComfyAttempt): Promise<ReserveResult> {
  target = Object.freeze({ ...target });
  prepared = Object.freeze({ ...prepared });
  if (!authorized(target) || !target.originHubId || !target.originDeviceId || !prepared.attemptId || !prepared.runGroupId
    || !Number.isSafeInteger(prepared.copyIndex) || prepared.copyIndex < 0) return { status: "stale" };
  const initial = reservation(listScenes(null).find(scene => scene.id === target.sceneId), target, prepared);
  if (initial.result.status !== "reserved") return initial.result;
  const write = confirmSceneWrite(() => updateScenesWith(null, scenes => {
    const decision = reservation(scenes.find(scene => scene.id === target.sceneId), target, prepared);
    return decision.scene ? scenes.map(scene => scene.id === target.sceneId ? decision.scene! : scene) : null;
  }));
  if (!write.value || !await write.confirmed) return { status: "storage_failed" };
  if (!authorized(target)) return { status: "stale" };
  const persisted = listPersistedScenes(null).find(scene => scene.id === target.sceneId);
  const final = reservation(persisted, target, prepared).result;
  if (final.status !== "reserved") return final;
  const attempt = persisted?.comfyRuns?.find(run => run.attemptId === prepared.attemptId);
  const owner = persisted?.comfyCardRuns?.[prepared.cardId];
  if (!attempt || owner?.groupId !== attempt.runGroupId || owner.groupSeq !== attempt.groupSeq) return { status: "stale" };
  return { status: "reserved", attempt, groupSeq: attempt.groupSeq };
}

export function changeCanvas(scene: Scene, command: CanvasCommand): Scene | null {
  let cards = scene.cards;
  switch (command.type) {
    case "discardUnsubmittedComfy": {
      if (!command.canWrite()) return null;
      const run = scene.comfyRuns?.find(item => item.attemptId === command.attempt.attemptId);
      if (!run || run.localState === "applied" || run.receipt || JSON.stringify(run) !== JSON.stringify(command.attempt)) return scene;
      const remaining = scene.comfyRuns!.filter(item => item !== run);
      const owner = scene.comfyCardRuns?.[run.cardId];
      const settle = owner?.groupId === run.runGroupId && owner.groupSeq === run.groupSeq
        && !remaining.some(item => item.cardId === run.cardId && item.runGroupId === run.runGroupId && item.localState !== "applied");
      return { ...scene, comfyRuns: remaining, ...(settle ? { comfyCardRuns: { ...scene.comfyCardRuns,
        [run.cardId]: { ...owner, settledState: owner.representative ? "done" : "failed" } } } : {}) };
    }
    case "resolveComfy": return command.canWrite() ? applyComfyResolution(scene, command.resolution).scene : null;
    case "ackComfy": {
      if (!command.canWrite()) return null;
      const runs = scene.comfyRuns?.filter(run => run.attemptId !== command.receipt.attemptId
        || run.receipt?.resultRevision !== command.receipt.resultRevision || run.receipt?.disposition !== command.receipt.disposition);
      return runs?.length === scene.comfyRuns?.length ? scene : { ...scene, comfyRuns: runs };
    }
    case "submitComfy": {
      if (!command.canWrite()) return null;
      return { ...scene, comfyRuns: scene.comfyRuns?.map(run => run.attemptId === command.attemptId && run.localState === "reserved"
        ? { ...run, localState: "submitted" } : run) };
    }
    case "editCardPrompt": return null; // 사용자 입력은 열린 Board의 세션만 받는다.
    case "recordCamera": return { ...scene, camera: command.camera };
    case "reserveGeneration":
      if (command.links.some(link => link.scene_id !== scene.id)) return null;
      cards = prepareCanvasGenerationLinks(cards, command.links, command.createdAt).cards;
      break;
    case "settleGeneration":
      cards = settleCanvasGenerationAttempt(cards, command.cardId, command.generationId); break;
    case "discardGeneration":
      cards = discardCanvasGenerationAttempt(cards, command.cardId, command.generationId); break;
    case "reconcileGenerations":
      cards = reconcileCanvasGenerationAttempts(cards, scene.id, command.links, command.now).cards; break;
    case "insertPlanCards":
      if (!sameSceneContent(scene, command.expected)) return null;
      return { ...scene, cards: command.cards, edges: command.edges };
    case "appendTaskCards": {
      if (scene.mcpAttachmentReceipts?.includes(command.receiptId)) return scene;
      const ids = new Set(cards.map(card => card.id));
      return { ...scene, cards: [...cards, ...command.cards.filter(card => !ids.has(card.id))],
        mcpAttachmentReceipts: [...(scene.mcpAttachmentReceipts || []), command.receiptId] };
    }
    case "linkCardResults":
      cards = cards.map(card => {
        if (card.id !== command.cardId || !command.generationIds.length) return card;
        const genIds = [...variantIds(card)];
        for (const id of command.generationIds) if (!genIds.includes(id)) genIds.push(id);
        return { ...card, genIds, genId: command.generationIds[0], status: "pending" as const };
      });
      break;
    default: return null;
  }
  return cards === scene.cards ? scene : { ...scene, cards };
}

// 기존 화면 알림/목록 병합은 어댑터에 남긴다. 외부 feature에는 이 저장용 patch를 노출하지 않는다.
export function createCanvasDocumentPort(adapter: {
  flushPending: (sceneId: string) => void;
  write?: (sceneId: string, value: Pick<Scene, "cards" | "edges" | "groups" | "mcpAttachmentReceipts" | "camera">) => boolean;
  editPrompt?: (sceneId: string, cardId: string, prompt: string) => boolean;
  changed?: (sceneId: string, executionOnly: boolean) => void;
}): CanvasDocumentPort {
  const snapshot = (target: CanvasTarget, persisted = false) => authorized(target)
    ? (persisted ? listPersistedScenes(null) : listScenes(null)).find(scene => scene.id === target.sceneId) : undefined;
  const flush = (target: CanvasTarget): CanvasWriteReceipt => {
    if (!authorized(target)) return stopped();
    const result = confirmSceneWrite(() => { adapter.flushPending(target.sceneId); return !!snapshot(target); });
    return { queued: result.value, confirmed: result.confirmed.then(ok => result.value && ok && authorized(target)
      && JSON.stringify(snapshot(target, true)) === JSON.stringify(snapshot(target))) };
  };
  return { snapshot, flush, async reserveComfyAttempt(target, prepared) {
    const result = await reserveComfyAttempt(target, prepared);
    if (authorized(target)) adapter.changed?.(target.sceneId, true);
    return result;
  }, commit(target, command) {
    if (!authorized(target)) return stopped();
    let wroteComfy = false;
    let executionOnly = true;
    const result = confirmSceneWrite(() => {
      if (command.type === "editCardPrompt") return adapter.editPrompt?.(target.sceneId, command.cardId, command.prompt) ?? false;
      if (command.type === "resolveComfy" || command.type === "ackComfy" || command.type === "submitComfy" || command.type === "discardUnsubmittedComfy") {
        if (!command.canWrite()) return false;
        const before = snapshot(target);
        if (!before) return false;
        const preview = changeCanvas(before, command);
        if (preview === before) return true;
        executionOnly = !preview || preview.cards === before.cards;
        adapter.flushPending(target.sceneId);
        if (!authorized(target) || !command.canWrite()) return false;
        wroteComfy = true;
        return updateScenesWith(null, scenes => {
          if (!authorized(target) || !command.canWrite()) return null;
          const fresh = scenes.find(scene => scene.id === target.sceneId);
          if (!fresh) return null;
          const settled = changeCanvas(fresh, command);
          return settled && settled !== fresh ? scenes.map(scene => scene.id === target.sceneId ? settled : scene) : null;
        });
      }
      // 백그라운드 재시도에서 실제 변경이 없으면 열린 보드의 입력 디바운스를 깨우지 않는다.
      if (command.type === "reconcileGenerations" || command.type === "discardGeneration" || command.type === "settleGeneration") {
        const before = snapshot(target);
        if (!before) return false;
        if (changeCanvas(before, command) === before) return true;
      }
      adapter.flushPending(target.sceneId);
      if (!authorized(target)) return false;
      const current = snapshot(target);
      if (!current) return false;
      const next = changeCanvas(current, command);
      if (!next) return false;
      if (next === current) return true;
      const patch = { cards: next.cards, edges: next.edges, groups: next.groups, mcpAttachmentReceipts: next.mcpAttachmentReceipts,
        ...(command.type === "recordCamera" ? { camera: next.camera } : {}) };
      return adapter.write ? adapter.write(target.sceneId, patch) : updateScenesWith(null, scenes => {
        const fresh = scenes.find(scene => scene.id === target.sceneId);
        if (!fresh) return null;
        const settled = changeCanvas(fresh, command);
        return settled && settled !== fresh ? scenes.map(scene => scene.id === target.sceneId ? settled : scene) : null;
      });
    });
    // 보통 문서 편집과 같이 working 반영을 즉시 전달한다. 저장 대기 뒤 카드 사본을 다시
    // 전달하면 그동안 Board에서 친 미저장 입력을 덮으므로, 확정 통지는 실행 필드만 보낸다.
    if (wroteComfy && result.value && authorized(target)) adapter.changed?.(target.sceneId, executionOnly);
    return { queued: result.value, confirmed: result.confirmed.then(ok => {
      if (wroteComfy && ok && authorized(target)) adapter.changed?.(target.sceneId, true);
      return result.value && ok && authorized(target);
    }) };
  } };
}

// 파일 재연결은 여러 씬의 순수 연산 하나로 접수한다. 열린 보드·Undo 투영은 기존 어댑터가 맡는다.
export function relinkCanvasDocuments(accountNamespace: string, found: Map<string, RelinkTarget>): boolean {
  if (accountNamespace !== getAccountNamespace()) return false;
  return updateScenesWith(null, current => {
    const result = applyRelink(current, found);
    return result.changed ? result.scenes : null;
  });
}

export function restoreCanvasCardLinks(accountNamespace: string, links: CardLink[]): boolean {
  if (accountNamespace !== getAccountNamespace()) return false;
  return updateScenesWith(null, current => mergeCardLinksIntoScenes(current, links));
}

export function importCanvasSnapshot(accountNamespace: string, snapshot: SceneSnapshot): Scene | null {
  return accountNamespace === getAccountNamespace() ? importScene(null, snapshot) : null;
}

export function restoreCanvasDocuments(accountNamespace: string, scenes: Scene[]) {
  if (accountNamespace !== getAccountNamespace()) return { ok: false, added: [] as Scene[] };
  return mergeScenesFromBackup(null, scenes);
}
