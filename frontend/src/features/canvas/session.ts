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

// 영속 대상은 열린 화면의 세대와 별개다. 다른 씬을 보고 있어도 원래 씬에 정산할 수 있다.
export interface CanvasTarget { readonly accountNamespace: string; readonly sceneId: string }
export type CanvasCommand =
  | { type: "reserveGeneration"; links: CanvasGenerationLink[]; createdAt: number }
  | { type: "settleGeneration" | "discardGeneration"; cardId: string; generationId: string }
  | { type: "reconcileGenerations"; links: ResolvedCanvasGenerationLink[]; now: number }
  | { type: "insertPlanCards"; cards: SceneCard[]; edges: SceneEdge[]; expected: Scene }
  | { type: "appendTaskCards"; cards: SceneCard[]; receiptId: string }
  | { type: "editCardPrompt"; cardId: string; prompt: string }
  | { type: "recordCamera"; camera: Scene["camera"] }
  | { type: "linkCardResults"; cardId: string; generationIds: string[] };

export interface CanvasWriteReceipt { readonly queued: boolean; readonly confirmed: Promise<boolean> }
export interface CanvasDocumentPort {
  snapshot(target: CanvasTarget, persisted?: boolean): Scene | undefined;
  commit(target: CanvasTarget, command: CanvasCommand): CanvasWriteReceipt;
  flush(target: CanvasTarget): CanvasWriteReceipt;
}

export const canvasTarget = (sceneId: string): CanvasTarget => Object.freeze({ accountNamespace: getAccountNamespace(), sceneId });
const authorized = (target: CanvasTarget) => target.accountNamespace === getAccountNamespace();
const stopped = (): CanvasWriteReceipt => ({ queued: false, confirmed: Promise.resolve(false) });

export function changeCanvas(scene: Scene, command: CanvasCommand): Scene | null {
  let cards = scene.cards;
  switch (command.type) {
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
}): CanvasDocumentPort {
  const snapshot = (target: CanvasTarget, persisted = false) => authorized(target)
    ? (persisted ? listPersistedScenes(null) : listScenes(null)).find(scene => scene.id === target.sceneId) : undefined;
  const flush = (target: CanvasTarget): CanvasWriteReceipt => {
    if (!authorized(target)) return stopped();
    const result = confirmSceneWrite(() => { adapter.flushPending(target.sceneId); return !!snapshot(target); });
    return { queued: result.value, confirmed: result.confirmed.then(ok => result.value && ok && authorized(target)
      && JSON.stringify(snapshot(target, true)) === JSON.stringify(snapshot(target))) };
  };
  return { snapshot, flush, commit(target, command) {
    if (!authorized(target)) return stopped();
    const result = confirmSceneWrite(() => {
      if (command.type === "editCardPrompt") return adapter.editPrompt?.(target.sceneId, command.cardId, command.prompt) ?? false;
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
    return { queued: result.value, confirmed: result.confirmed.then(ok => result.value && ok && authorized(target)) };
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
