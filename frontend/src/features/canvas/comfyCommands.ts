import type { MutableRefObject } from "react";
import { variantIds, type Scene, type SceneCard, type SceneComfyCfg } from "../../lib/scenes";
import { comfySceneFingerprints } from "../../lib/sceneComfyInputs";
import type { ComfyApplicationReceipt, ComfyCanvasResolution } from "../../lib/comfyRunState";
import { markCardGenerationsRemoved } from "../../lib/sceneCardLinks";
import { settleCanvasGenerationAttempt } from "../../lib/canvasGenerationRecovery";
import { ownEntry } from "../../lib/ownEntry";
import type { useSceneInputCommit } from "../../lib/useSceneInputCommit";
import type { useSceneHistory } from "../../lib/useSceneHistory";

export type ComfyConfigEdit = Pick<SceneComfyCfg, "name" | "content" | "nodeCount" | "paramExposed" | "paramValues" | "params">;

/** 즉시 응답과 재시작 복구가 공유하는 반영. 저장/ACK는 호출자가 영수증과 함께 확정한다. */
export function applyComfyResolution(scene: Scene, resolution: ComfyCanvasResolution): { scene: Scene; receipt: ComfyApplicationReceipt | null } {
  const run = scene.comfyRuns?.find(item => item.attemptId === resolution.attempt_id);
  if (!run || run.originHubId !== resolution.origin.hub_id || run.originDeviceId !== resolution.origin.device_id)
    return { scene, receipt: null };
  if (run.receipt && run.receipt.resultRevision >= resolution.result_revision)
    return { scene, receipt: run.receipt.resultRevision === resolution.result_revision ? run.receipt : null };
  if (["accepted", "running", "saving"].includes(resolution.state)) {
    const owner = scene.comfyCardRuns?.[run.cardId];
    if (owner?.groupId === run.runGroupId && owner.groupSeq === run.groupSeq && owner.settledState === "not_found")
      return { scene: { ...scene, comfyCardRuns: { ...scene.comfyCardRuns, [run.cardId]: { ...owner, settledState: undefined } } }, receipt: null };
  }
  if (["needs_collect", "not_found", "origin_mismatch"].includes(resolution.state)) {
    const owner = scene.comfyCardRuns?.[run.cardId];
    if (!owner || owner.groupId !== run.runGroupId || owner.groupSeq !== run.groupSeq || owner.settledState === resolution.state)
      return { scene, receipt: null };
    return { scene: { ...scene, comfyCardRuns: { ...scene.comfyCardRuns, [run.cardId]: { ...owner,
      settledState: resolution.state as "needs_collect" | "not_found" | "origin_mismatch" } } }, receipt: null };
  }
  if (!["saved", "failed", "dismissed", "linked"].includes(resolution.state)) return { scene, receipt: null };
  if (resolution.state === "linked") {
    if (!resolution.disposition) return { scene, receipt: null };
    const receipt = { attemptId: run.attemptId, resultRevision: resolution.result_revision, disposition: resolution.disposition };
    return { scene: { ...scene, comfyRuns: scene.comfyRuns!.map(item => item === run ? { ...item, localState: "applied", receipt } : item) }, receipt };
  }
  const card = scene.cards.find(item => item.id === run.cardId && item.kind === "comfy");
  const fp = card && comfySceneFingerprints(scene, card.id);
  const owner = scene.comfyCardRuns?.[run.cardId];
  const matches = fp && fp.configFp === run.configFp && fp.inputFp === run.inputFp
    && owner?.groupId === run.runGroupId && owner.groupSeq === run.groupSeq;
  const disposition = !card ? "card_missing" : !matches ? "superseded" : resolution.disposition || "attached";
  const receipt: ComfyApplicationReceipt = { attemptId: run.attemptId, resultRevision: resolution.result_revision, disposition };
  let next: Scene = { ...scene, comfyRuns: scene.comfyRuns!.map(item => item === run ? { ...item, localState: "applied", receipt } : item) };
  if (disposition !== "attached" || !card || !owner) return { scene: next, receipt };

  const outputs = resolution.outputs.filter(output => output.state !== "deleted" && output.state !== "unavailable"
    && (output.generation_id || (output.kind === "text" && output.text !== undefined)));
  // 사용자가 지운 출력도 서버에서는 성공한 copy다. 다시 연결하지 않되 대표의 순서는 지킨다.
  const successful = resolution.state === "saved" && resolution.outputs.length > 0;
  const representative = successful && (owner.representative?.groupId !== run.runGroupId
    || run.copyIndex > owner.representative.copyIndex
    || (run.copyIndex === owner.representative.copyIndex && run.attemptId === owner.representative.attemptId));
  const ids = outputs.flatMap(output => output.generation_id ? [output.generation_id] : []);
  const deletedIds = new Set(resolution.outputs.filter(output => output.state === "deleted").map(output => output.generation_id));
  const genIds = [...new Set([...variantIds(card), ...ids])].filter(id => !deletedIds.has(id));
  if (outputs.length || representative) {
    const updated = { ...card, genIds,
      ...(representative ? { genId: ids[ids.length - 1] || null,
        comfyCfg: { ...card.comfyCfg, output: null, outputs: outputs.map(output => ({ kind: output.kind,
          ...(output.text !== undefined ? { text: output.text } : {}),
          ...(output.generation_id ? { saved_generation_id: output.generation_id } : {}) })) } } : {}) };
    next = { ...next, cards: scene.cards.map(item => item === card ? updated : item) };
  }
  const current = { ...owner, ...(representative ? { representative: { groupId: run.runGroupId, copyIndex: run.copyIndex, attemptId: run.attemptId } } : {}) };
  const pending = next.comfyRuns!.some(item => item.cardId === card.id && item.runGroupId === run.runGroupId
    && item.groupSeq === run.groupSeq && item.localState !== "applied");
  next = { ...next, comfyCardRuns: { ...scene.comfyCardRuns, [card.id]: { ...current,
    ...(pending ? {} : { settledState: current.representative ? "done" : resolution.state === "dismissed" ? "dismissed" : "failed" }) } } };
  return { scene: next, receipt };
}
export type ComfyRuntimeUpdate = Pick<SceneComfyCfg, "runId" | "status" | "error" | "output" | "outputs">;
export type CanvasComfyCommand =
  | { type: "editComfyParam"; cardId: string; key: string; value: string | number | boolean }
  | { type: "replaceComfyWorkflow"; cardId: string; workflow: { name: string; content: string; nodeCount: number } }
  | { type: "saveComfyConfig"; cardId: string; cfg: ComfyConfigEdit }
  | { type: "refreshComfyMetadata"; cardId: string; expectedContent: string; nodeCount: number }
  | { type: "showComfyRunning"; runs: { cardId: string; runId: number }[] }
  | { type: "updateComfyRuntime"; cardId: string; patch: ComfyRuntimeUpdate; expectedRunId?: number }
  | { type: "recoverCardGeneration"; cardId: string; generationId: string; createdAtById: Record<string, string> }
  | { type: "saveComfyOutputs"; cardId: string; expectedContent: string | undefined;
      savedResults: { url: string; generation_id: string }[]; executedOutputs?: SceneComfyCfg["outputs"] };

interface Context {
  sceneId: string;
  cardsRef: MutableRefObject<SceneCard[]>;
  input: Pick<ReturnType<typeof useSceneInputCommit>, "applyCards">;
  history: Pick<ReturnType<typeof useSceneHistory>, "propagateGenIdsToHistory">;
}

export function isCanvasComfyCommand(command: { type: string }): command is CanvasComfyCommand {
  return ["editComfyParam", "replaceComfyWorkflow", "saveComfyConfig", "refreshComfyMetadata",
    "showComfyRunning", "updateComfyRuntime", "recoverCardGeneration", "saveComfyOutputs"].includes(command.type);
}

// 같은 실행의 저장 마킹이 붙은 출력은 마킹 없는 실행 응답으로 덮지 않는다.
export function doneOutputsPatch(currentOutputs: SceneComfyCfg["outputs"], latestOutputs: NonNullable<SceneComfyCfg["outputs"]>): ComfyRuntimeUpdate {
  const mediaUrls = latestOutputs.filter(o => (o.kind === "image" || o.kind === "video") && o.url).map(o => o.url);
  const currentUrls = new Set((currentOutputs || []).map(o => o.url).filter(Boolean));
  return mediaUrls.length > 0 && mediaUrls.every(url => currentUrls.has(url)) ? {} : { outputs: latestOutputs, output: null };
}

// 세션의 target 검사 뒤에만 호출한다. 소비자는 저장 방식이나 전체 카드 사본을 넘기지 않는다.
export function applyCanvasComfyCommand(command: CanvasComfyCommand, { sceneId, cardsRef, input, history }: Context): boolean {
  const cards = cardsRef.current;
  if (command.type === "showComfyRunning") {
    const runs = new Map(command.runs.map(run => [run.cardId, run.runId]));
    if (!cards.some(card => card.kind === "comfy" && runs.has(card.id))) return false;
    input.applyCards(cards.map(card => card.kind === "comfy" && runs.has(card.id)
      ? { ...card, comfyCfg: { ...card.comfyCfg, runId: runs.get(card.id), status: "running", error: null } } : card), "live");
    return true;
  }
  const card = cards.find(item => item.id === command.cardId);
  if (!card || (command.type !== "recoverCardGeneration" && card.kind !== "comfy")) return false;
  if (command.type === "recoverCardGeneration") {
    const added = !variantIds(card).includes(command.generationId);
    const next = settleCanvasGenerationAttempt(cards, card.id, command.generationId).map(item => {
      if (item.id !== card.id) return item;
      const genIds = [...variantIds(item)].sort((a, b) => {
        const at = ownEntry(command.createdAtById, a) || "", bt = ownEntry(command.createdAtById, b) || "";
        return at < bt ? -1 : at > bt ? 1 : 0;
      });
      return { ...item, genIds };
    });
    input.applyCards(next, "persistUser", { addedForward: added ? [{ cardId: card.id, genIds: [command.generationId] }] : undefined });
    return true;
  }
  const cfg = card.comfyCfg || {};
  let next: SceneCard;
  let mode: Parameters<Context["input"]["applyCards"]>[1] = "persistDerived";
  let removedForward: { cardId: string; genIds: string[] }[] | undefined;
  switch (command.type) {
    case "editComfyParam":
      next = { ...card, comfyCfg: { ...cfg, paramValues: { ...cfg.paramValues, [command.key]: command.value } } };
      mode = "deferUser";
      break;
    case "replaceComfyWorkflow":
    case "saveComfyConfig": {
      const edit: ComfyConfigEdit = {};
      if (command.type === "replaceComfyWorkflow") {
        const { name, content, nodeCount } = command.workflow;
        Object.assign(edit, { name, content, nodeCount, paramExposed: [], paramValues: {}, params: [] });
      } else {
        // 구조적으로 넓은 모달 값이 들어와도 실행상태/출력은 편집 필드가 아니다.
        for (const key of ["name", "content", "nodeCount", "paramExposed", "paramValues", "params"] as const) {
          if (Object.prototype.hasOwnProperty.call(command.cfg, key)) Object.assign(edit, { [key]: command.cfg[key] });
        }
      }
      const editedContent = Object.prototype.hasOwnProperty.call(edit, "content") ? edit.content : cfg.content;
      const changed = command.type === "replaceComfyWorkflow" || (cfg.content || "") !== (editedContent || "");
      next = { ...card, comfyCfg: { ...cfg, ...edit } };
      if (changed) {
        const genIds = variantIds(card).filter(Boolean);
        removedForward = genIds.length ? [{ cardId: card.id, genIds }] : [];
        if (genIds.length) void markCardGenerationsRemoved(sceneId, card.id, genIds);
        next = { ...next, genId: null, genIds: [], comfyCfg: { ...next.comfyCfg, outputs: [], output: null, status: "idle", error: null } };
      }
      mode = "persistUser";
      break;
    }
    case "refreshComfyMetadata":
      if (cfg.content !== command.expectedContent) return false;
      next = { ...card, comfyCfg: { ...cfg, nodeCount: command.nodeCount, status: "idle", error: null } };
      break;
    case "updateComfyRuntime": {
      if (command.expectedRunId !== undefined && cfg.runId !== command.expectedRunId) return false;
      const patch: ComfyRuntimeUpdate = {};
      for (const key of ["runId", "status", "error", "output", "outputs"] as const) {
        if (Object.prototype.hasOwnProperty.call(command.patch, key)) Object.assign(patch, { [key]: command.patch[key] });
      }
      if (patch.status === "done" && patch.outputs) {
        const { outputs, output: _output, ...rest } = patch;
        next = { ...card, comfyCfg: { ...cfg, ...rest, ...doneOutputsPatch(cfg.outputs, outputs) } };
      } else next = { ...card, comfyCfg: { ...cfg, ...patch } };
      break;
    }
    case "saveComfyOutputs": {
      if (cfg.content !== command.expectedContent) return false;
      const byUrl = new Map(command.savedResults.map(saved => [saved.url, saved.generation_id]));
      const savedIds = command.savedResults.map(saved => saved.generation_id);
      const outputs = (command.executedOutputs ?? cfg.outputs ?? []).map(output => output.url && byUrl.has(output.url)
        ? { ...output, saved_generation_id: byUrl.get(output.url) } : output);
      const genIds = [...(card.genIds || [])];
      for (const id of savedIds) if (id && !genIds.includes(id)) genIds.push(id);
      next = { ...card, genIds, genId: savedIds[savedIds.length - 1] || card.genId || genIds[genIds.length - 1] || null,
        comfyCfg: { ...cfg, outputs } };
      break;
    }
  }
  input.applyCards(cards.map(item => item.id === card.id ? next : item), mode, removedForward ? { removedForward } : undefined);
  if (command.type === "saveComfyOutputs") history.propagateGenIdsToHistory(card.id, next);
  return true;
}
