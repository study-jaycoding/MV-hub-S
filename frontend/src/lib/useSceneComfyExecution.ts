import type { CanvasComfyCommand, ComfyRuntimeUpdate, CanvasDocumentPort } from "../features/canvas/api";
export { doneOutputsPatch } from "../features/canvas/api";
import type { SaveComfyOptions, SaveComfyResult } from "./sceneComfyLibrary";
import { useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { Generation } from "../types";
import { computeMaxParallel, createBatchTracker, createLimiter, type ComfyCanvasRun, type StepOutcome } from "./comfyRunState";
import { comfyApi, ComfyUnresolvedRunError, type ComfyOutput } from "./comfyApi";
import {
  executeSceneComfy,
  isSceneComfyConfigCurrent,
  SceneComfyRunSupersededError,
  COMFY_CONFLICT_MESSAGE,
  type SceneComfyConfigSnapshot,
  type SceneComfyExecutionResult,
  type SceneComfyRunInputSnapshot,
} from "./sceneComfyExecutor";
import { getAccountNamespace, getConnectionKey } from "./accountScope";
import { getAuthToken } from "./http";
import { COMFY_CANVAS_RUNS_FEATURE, hubHasFeature } from "./hubFeatures";
import { isCanvasFloating } from "./popupWindows";
import { notifyCanvasComfyRuns } from "./useCanvasComfyRuns";
import {
  prepareSceneComfyInputs,
  samePreparedSceneComfyInputs,
} from "./sceneComfyInputs";
import {
  buildGenerationExecutionPlan,
  buildRenderExecutionPlan,
  isGenerationExecutionPlanCurrent,
  isRenderExecutionPlanCurrent,
  type ComfyOutputsById,
  type SceneExecutionPlan,
  type SceneGenerationRun,
  resolvePortEdges,
} from "./sceneEdges";
import {
  captureSceneGenerationInputSnapshot,
  collectSceneGenerationAssignment,
  isSceneGenerationInputSnapshotCurrent,
  type SceneGenerationAssignment,
} from "./sceneGenerationInputs";
import { comfyRunningScope, isComfyAttemptActive, isComfyRunning, setComfyRunning as setStoredComfyRunning } from "./sceneComfyRunningStore";
import { flashMsg } from "./flash";
import { t } from "./i18n";
import {
  cardBatch,
  type SceneCard,
  type SceneEdge,
  type SceneModelCfg,
} from "./scenes";

// 워크플로를 읽는 중의 실행을 막을 때의 안내(카드 단추는 잠겨 있고, 본문 결과물의 재생성·연결된 렌더에서 오는 실행이 여기 닿는다).
export const WORKFLOW_LOADING_MESSAGE = "워크플로를 읽는 중입니다 — 끝난 뒤 실행하세요.";

export type { SaveComfyOptions, SaveComfyResult } from "./sceneComfyLibrary";

interface CompletedComfySave {
  cardId: string;
  options: SaveComfyOptions;
  outputCount: number;
}

// 저장 API 실패 하나가 같은 배치의 나머지 원격 완료 결과를 막지 않게 각각 끝까지 정산한다.
export async function saveCompletedComfyResults(
  completed: CompletedComfySave[],
  saveComfyToLibrary: (cardId: string, opts?: SaveComfyOptions) => Promise<SaveComfyResult>,
): Promise<SaveComfyResult> {
  let saved = 0;
  let failed = 0;
  for (const item of completed) {
    try {
      const result = await saveComfyToLibrary(item.cardId, item.options);
      saved += result.saved;
      failed += result.failed;
    } catch {
      failed += item.outputCount;
    }
  }
  return { saved, failed };
}

// 결과 저장의 안내 — **한 번에** 낸다. 토스트는 마지막 문구만 남아, 둘로 내면 앞의 '일부 저장 못 함'이 바로 뒤의
//  '이전 결과는 저장함'에 덮였다(60회차). supersededSaved = 입력이 바뀌어 이전 실행 결과를 내 작업에 저장했다.
//  lead = 같은 실행에서 함께 알릴 실행 오류(결과 회수 못 함) — 따로 내면 그것이 저장 안내를 덮었다(Codex 검토).
export function comfySaveNotice(failed: boolean, supersededSaved: boolean, lead?: string | null): string | null {
  const save = failed
    ? supersededSaved
      ? "입력이 바뀌어 이전 실행 결과는 내 작업에 저장했습니다 — 일부는 저장하지 못했습니다"
      : "일부 Comfy 결과를 내 작업에 저장하지 못했습니다"
    : supersededSaved ? "입력이 바뀌어 이전 실행 결과는 내 작업에 저장했습니다" : null;
  return [lead, save].filter(Boolean).join(" · ") || null;
}

interface UseSceneComfyExecutionOptions {
  canvasDocument?: CanvasDocumentPort;
  projectId?: string;
  sceneIdRef: MutableRefObject<string>;
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  genDataRef: MutableRefObject<Record<string, Generation>>;
  refParents: Record<string, string[]>;
  flushPending: () => void;
  // 이 렌더의 세션 commit을 실행 완료까지 유지한다. 최신 options ref로 재지정하지 않는다.
  commitDocument: (command: CanvasComfyCommand) => boolean;
  isDocumentCurrent: () => boolean;
  saveComfyToLibrary: (cardId: string, opts?: SaveComfyOptions) => Promise<SaveComfyResult>;
  onGenerateCard?: (
    cardId: string,
    batch?: number,
    assignment?: SceneGenerationAssignment | null,
  ) => void;
  onRenderCards?: (
    cardIds: string[],
    batch?: number,
    fallbackModel?: SceneModelCfg | null,
  ) => void | Promise<void>;
  onRenderCardRuns?: (
    runs: SceneGenerationRun[],
    fallbackModel?: SceneModelCfg | null,
  ) => void | Promise<void>;
  // 모델 노드 없는 생성카드가 쓸 하단 프롬프트 모델 — Render/Generate 클릭 시점에 1회 읽어 comfy 완료 뒤
  // 제출까지 그대로 전달한다(실행 중 하단 모델을 바꿔도 유료 요청에 섞이지 않게).
  getGenerationFallbackModel?: () => SceneModelCfg | null;
  onComfyRunningChange?: (items: { id: string; name: string }[]) => void;
  // 그 카드가 워크플로를 읽는 중인가(JSON 놓기·↻ — SceneBoard 의 comfyBusy). 읽는 중의 실행은 교체 전 워크플로로 나간다 — 입구마다(카드의 실행 단추·
  //  본문 결과물의 재생성·연결된 렌더 카드) 막지 않고 여기 한 곳에서 막는다(28회차 ③, Codex 코드 리뷰 P2).
  isWorkflowLoading?: (cardId: string) => boolean;
}

// SceneBoard의 Comfy 실행 수명주기 전용 훅.
// 그래프 상태는 ref로 읽고, 저장은 주입받은 기존 커밋 경계를 통해서만 수행한다.
export function useSceneComfyExecution({
  canvasDocument,
  projectId,
  sceneIdRef,
  cardsRef,
  edgesRef,
  genDataRef,
  refParents,
  flushPending,
  commitDocument,
  isDocumentCurrent,
  saveComfyToLibrary,
  onGenerateCard,
  onRenderCards,
  onRenderCardRuns,
  getGenerationFallbackModel,
  onComfyRunningChange,
  isWorkflowLoading,
}: UseSceneComfyExecutionOptions) {
  const orchestratingRef = useRef(false);
  const [comfyWaitingIds, setComfyWaitingIds] = useState<Set<string>>(new Set());
  const [runningComfyIds, setRunningComfyIds] = useState<Map<string, number>>(new Map());
  const runningComfyRef = useRef<Map<string, number>>(new Map());
  const nextRunIdRef = useRef(0);
  const runOwnersRef = useRef<Map<string, number>>(new Map());
  const refParentsRef = useRef(refParents);
  refParentsRef.current = refParents;
  const readScene = () => canvasDocument?.snapshot({ accountNamespace: getAccountNamespace(), sceneId: sceneIdRef.current });
  const conflictNotice = async (ids: string[]): Promise<string | null> => {
    if (!readScene()?.comfyRuns?.some(run => ids.includes(run.cardId) && run.localState !== "applied")) return null;
    const account = getAccountNamespace(), sceneId = sceneIdRef.current, connection = getConnectionKey(), token = getAuthToken();
    const current = () => account === getAccountNamespace() && sceneId === sceneIdRef.current && connection === getConnectionKey()
      && token === getAuthToken() && !isCanvasFloating() && isDocumentCurrent();
    try {
      const origin = await comfyApi.canvasOrigin();
      if (!current()) return "Comfy 실행 대상이 변경되어 제출하지 않았습니다.";
      const blocking = readScene()?.comfyRuns?.filter(run => ids.includes(run.cardId) && run.localState !== "applied"
        && run.originHubId === origin.hub_id && run.originDeviceId === origin.device_id) || [];
      return !blocking.length || await clearUnconfirmedRuns(blocking, account, current) ? null : COMFY_CONFLICT_MESSAGE;
    } catch {
      return "Comfy 실행 정보를 확인하지 못했습니다. 잠시 후 다시 실행하세요.";
    }
  };
  // 전송했지만 접수 여부를 모르는 기록은 저절로 지우지 않아 카드가 막힌다 — 사람이 다시 실행할 때 확인을 받고 지운다. 안내는 카드에 하나지만 복사본은 여럿이라,
  //  지우기 직전에 서버에 다시 물어 전부 없을 때만 묻는다. 하나라도 살아 있거나 어느 창에서 돌고 있으면 지우지 않는다(그 결과가 카드에 못 붙고 다시 실행으로 두 번 돈다).
  //  서버에 묻거나 지우는 사이 상황이 바뀔 수 있어, 묻기 전·확인 창 직전·기록 하나를 지울 때마다 다시 본다.
  const clearUnconfirmedRuns = async (blocking: ComfyCanvasRun[], account: string, current: () => boolean): Promise<boolean> => {
    const sceneId = sceneIdRef.current;
    const scope = comfyRunningScope(account, sceneId);
    const idle = () => !blocking.some(run => isComfyAttemptActive(account, run.attemptId) || isComfyRunning(run.cardId, scope));
    // 남은 기록이 그대로이고 그 카드에 다른 미적용 시도가 없을 때만 — 다른 PC 의 시도는 여기서 확인할 수 없다
    const clearable = (rest: ComfyCanvasRun[]) => {
      const scene = readScene();
      const unapplied = scene?.comfyRuns?.filter(run => rest.some(item => item.cardId === run.cardId) && run.localState !== "applied") || [];
      return current() && idle() && unapplied.length === rest.length && rest.every(run => {
        const now = unapplied.find(item => item.attemptId === run.attemptId);
        return now?.localState === "submitted" && !now.receipt && scene?.comfyCardRuns?.[run.cardId]?.settledState === "not_found";
      });
    };
    if (!clearable(blocking)) return false;
    const { runs } = await comfyApi.resolveCanvasRuns(blocking.map(run => run.attemptId));
    const states = new Map(runs.map(item => [item.attempt_id, item.state]));
    if (!clearable(blocking) || !blocking.every(run => ["not_found", "unknown"].includes(states.get(run.attemptId) || ""))) return false;
    if (!window.confirm(t("이전 Comfy 실행이 접수됐는지 확인하지 못했습니다. 기록을 지우고 다시 실행할까요? 접수된 실행이면 두 번 실행될 수 있습니다."))) return false;
    const canWrite = () => current() && idle();
    // 카드의 현재 묶음을 마지막에 지운다 — 그 묶음이 비면 접수 안내가 풀려 나머지를 못 지운다(옛 편집 채택으로 묶음이 섞일 수 있다)
    const latestGroup = (run: ComfyCanvasRun) => readScene()?.comfyCardRuns?.[run.cardId]?.groupId === run.runGroupId ? 1 : 0;
    const ordered = [...blocking].sort((a, b) => latestGroup(a) - latestGroup(b));
    for (const [index, run] of ordered.entries()) {
      if (!clearable(ordered.slice(index))) return false;
      const attempt = readScene()?.comfyRuns?.find(item => item.attemptId === run.attemptId);
      if (!attempt || !canvasDocument) return false;
      const cleanup = canvasDocument.commit({ accountNamespace: account, sceneId }, { type: "discardUnsubmittedComfy", attempt, canWrite });
      if (!cleanup.queued || !await cleanup.confirmed) return false;
    }
    return !readScene()?.comfyRuns?.some(run => blocking.some(item => item.attemptId === run.attemptId));
  };
  const newGroup = (cardId: string) => {
    const before = readScene()?.comfyCardRuns?.[cardId]?.groupId;
    const runGroupId = crypto.randomUUID();
    return { runGroupId, current: () => {
      const group = readScene()?.comfyCardRuns?.[cardId]?.groupId;
      return group === before || group === runGroupId;
    } };
  };

  const notifyComfyRunning = () => {
    if (!onComfyRunningChange) return;
    const items = [...runningComfyRef.current.keys()]
      .map((id) => {
        const card = cardsRef.current.find((candidate) => candidate.id === id);
        return card?.kind === "comfy"
          ? { id, name: card.comfyCfg?.name || "Comfy" }
          : null;
      })
      .filter((item): item is { id: string; name: string } => !!item);
    onComfyRunningChange(items);
  };

  // count 방식이라 직접 실행과 렌더 실행이 겹쳐도 마지막 실행이 끝날 때 표시가 꺼진다.
  const markComfyRunning = (ids: string[], on: boolean, scope: string) => {
    const next = new Map(runningComfyRef.current);
    for (const id of ids) {
      const count = (next.get(id) || 0) + (on ? 1 : -1);
      if (count > 0) next.set(id, count);
      else next.delete(id);
    }
    runningComfyRef.current = next;
    setRunningComfyIds(next);
    setStoredComfyRunning(ids, on, scope);
    notifyComfyRunning();
  };

  const runOwnerKey = (sceneId: string, cardId: string) => `${sceneId}\u0000${cardId}`;
  const claimComfyRun = (sceneId: string, cardId: string): number => {
    const runId = ++nextRunIdRef.current;
    runOwnersRef.current.set(runOwnerKey(sceneId, cardId), runId);
    return runId;
  };
  const ownsComfyRun = (sceneId: string, cardId: string, runId: number) =>
    sceneIdRef.current === sceneId &&
    runOwnersRef.current.get(runOwnerKey(sceneId, cardId)) === runId &&
    cardsRef.current.find((card) => card.id === cardId)?.comfyCfg?.runId === runId;
  const releaseComfyRun = (sceneId: string, cardId: string, runId: number) => {
    const key = runOwnerKey(sceneId, cardId);
    if (runOwnersRef.current.get(key) === runId) runOwnersRef.current.delete(key);
  };
  const patchComfyRunIfOwner = (
    sceneId: string,
    cardId: string,
    runId: number,
    patch: ComfyRuntimeUpdate,
  ) => {
    if (!ownsComfyRun(sceneId, cardId, runId)) return false;
    return commitDocument({ type: "updateComfyRuntime", cardId, patch, expectedRunId: runId });
  };

  const runComfyRaw = async (
    cardId: string,
    overlay: ComfyOutputsById | undefined,
    varySeed: boolean,
    configSnapshot?: SceneComfyConfigSnapshot,
    isRunCurrent?: () => boolean,
    group?: { runGroupId: string; copyIndex: number; current: () => boolean },
  ): Promise<SceneComfyExecutionResult> => {
    const inputsById = new Map(cardsRef.current.map(card => [card.id, card]));
    const destination = collectSceneGenerationAssignment(cardId, inputsById, resolvePortEdges(inputsById, edgesRef.current));
    const execution = await executeSceneComfy({
      projectId: destination?.projectId || projectId,
      cardId,
      cards: cardsRef.current,
      edges: edgesRef.current,
      genData: genDataRef.current,
      refParents: refParentsRef.current,
      overlay,
      varySeed,
      configSnapshot,
      ...(group && canvasDocument ? { canvas: { sceneId: sceneIdRef.current, runGroupId: group.runGroupId,
        copyIndex: group.copyIndex, document: canvasDocument } } : {}),
      getLiveCards: () => cardsRef.current,
      getLiveEdges: () => edgesRef.current,
      getLiveGenData: () => genDataRef.current,
      getLiveRefParents: () => refParentsRef.current,
      isRunCurrent: () => isDocumentCurrent() && (!group || (group.current() && !isCanvasFloating())) && (isRunCurrent ? isRunCurrent()
        : !configSnapshot || isSceneComfyConfigCurrent(cardsRef.current, cardId, configSnapshot)),
    });
    return execution;
  };

  const isInputCurrent = (
    cardId: string,
    configSnapshot: SceneComfyConfigSnapshot,
    inputSnapshot: SceneComfyRunInputSnapshot,
    overlay?: ComfyOutputsById,
  ) =>
    isSceneComfyConfigCurrent(cardsRef.current, cardId, configSnapshot) &&
    samePreparedSceneComfyInputs(
      inputSnapshot,
      prepareSceneComfyInputs(
        cardId,
        configSnapshot.paramValues,
        cardsRef.current,
        edgesRef.current,
        genDataRef.current,
        refParentsRef.current,
        overlay,
        hubHasFeature(COMFY_CANVAS_RUNS_FEATURE) ? readScene()?.comfyCardRuns || {} : undefined,
      ),
    );

  // 한 실행 단계에서 같은 cards/edges 참조를 여러 번 검사한다. 의미 비교는 그래프 순회가 필요하므로
  // 상태 참조가 실제로 바뀐 경우에만 다시 계산해 배치·다중 Comfy에서 가드 자체가 지연을 만들지 않게 한다.
  const createSceneStateGuard = (
    sceneId: string,
    evaluate: (cards: SceneCard[], edges: SceneEdge[]) => boolean,
  ) => {
    let lastCards: SceneCard[] | undefined;
    let lastEdges: SceneEdge[] | undefined;
    let lastResult = false;
    return () => {
      if (!isDocumentCurrent() || sceneIdRef.current !== sceneId) return false;
      const currentCards = cardsRef.current;
      const currentEdges = edgesRef.current;
      if (currentCards === lastCards && currentEdges === lastEdges) return lastResult;
      lastCards = currentCards;
      lastEdges = currentEdges;
      lastResult = evaluate(currentCards, currentEdges);
      return lastResult;
    };
  };

  const runComfy = async (cardId: string): Promise<boolean> => {
    if (!isDocumentCurrent()) return false;
    flushPending();
    const serverManaged = hubHasFeature(COMFY_CANVAS_RUNS_FEATURE);
    if (serverManaged) {
      const notice = await conflictNotice([cardId]);
      if (notice) { flashMsg(notice); return false; }
    }
    const group = serverManaged ? newGroup(cardId) : undefined;
    const card = cardsRef.current.find((candidate) => candidate.id === cardId);
    if (!card?.comfyCfg?.content) return false;
    if (isWorkflowLoading?.(cardId)) {
      flashMsg(WORKFLOW_LOADING_MESSAGE); // 교체 전 워크플로로 나가는 실행 — 시작하지 않는다(28회차 ③)
      return false;
    }
    const batch = cardBatch(card);
    const sceneId = sceneIdRef.current;
    const runningScope = comfyRunningScope(getAccountNamespace(), sceneId);
    const configSnapshot: SceneComfyConfigSnapshot = {
      name: card.comfyCfg.name,
      content: card.comfyCfg.content,
      paramValues: { ...(card.comfyCfg.paramValues || {}) },
      params: card.comfyCfg.params?.map((param) => ({
        ...param,
        choices: param.choices ? [...param.choices] : param.choices,
      })),
    };
    const isRunCurrent = () =>
      isDocumentCurrent() && sceneIdRef.current === sceneId &&
      isSceneComfyConfigCurrent(cardsRef.current, cardId, configSnapshot);
    const runId = serverManaged ? 0 : claimComfyRun(sceneId, cardId);
    if (!serverManaged && !commitDocument({ type: "updateComfyRuntime", cardId, patch: { runId, status: "running", error: null } })) {
      releaseComfyRun(sceneId, cardId, runId); return false;
    }
    markComfyRunning([cardId], true, runningScope);
    try {
      const settledSets = await Promise.allSettled(
        Array.from({ length: batch }, async (_, copyIndex) => {
          const startedAt = Date.now();
          const execution = await runComfyRaw(
            cardId,
            undefined,
            batch > 1,
            configSnapshot,
            isRunCurrent,
            group && { ...group, copyIndex },
          );
          return { ...execution, elapsed: (Date.now() - startedAt) / 1000 };
        }),
      );
      const sets = settledSets
        .filter((result): result is PromiseFulfilledResult<SceneComfyExecutionResult & { elapsed: number }> =>
          result.status === "fulfilled",
        )
        .map((result) => result.value);
      const saveResult = await saveCompletedComfyResults(
        sets.filter(result => !result.serverManaged).map((result) => {
          const inputStillCurrent = () =>
            !result.superseded &&
            isRunCurrent() &&
            isInputCurrent(cardId, configSnapshot, result.inputSnapshot);
          return {
            cardId,
            outputCount: result.outputs.filter((output) =>
              (output.kind === "image" || output.kind === "video") && !!output.url,
            ).length,
            options: {
              silent: true,
              elapsedSeconds: result.elapsed,
              outputs: result.outputs,
              configSnapshot,
              inputSnapshot: result.inputSnapshot,
              isInputCurrent: inputStillCurrent,
            },
          };
        }),
        saveComfyToLibrary,
      );
      const rejected = settledSets.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (serverManaged) {
        if (rejected) flashMsg(rejected.reason instanceof Error ? rejected.reason.message : "Comfy 실행을 마치지 못했습니다");
        return !rejected && isRunCurrent() && sets.every(result => !result.superseded);
      }
      const inputsStillCurrent =
        isRunCurrent() &&
        sets.every(
          (result) =>
            !result.superseded &&
            isInputCurrent(cardId, configSnapshot, result.inputSnapshot),
        );
      const superseded = !inputsStillCurrent || sets.some((result) => result.superseded);
      const unresolved = rejected?.reason instanceof ComfyUnresolvedRunError ? rejected.reason.message : null;
      const saveNotice = comfySaveNotice(!!saveResult.failed, superseded && !!saveResult.saved, unresolved);
      if (saveNotice) flashMsg(saveNotice);
      if (rejected) {
        if (rejected.reason instanceof ComfyUnresolvedRunError) {
          patchComfyRunIfOwner(sceneId, cardId, runId, { status: "failed", error: rejected.reason.message });
        } else if (rejected.reason instanceof SceneComfyRunSupersededError || superseded) {
          patchComfyRunIfOwner(sceneId, cardId, runId, { status: "idle", error: null });
        } else {
          patchComfyRunIfOwner(sceneId, cardId, runId, {
            status: "failed",
            error: rejected.reason instanceof Error ? rejected.reason.message : "실행 실패",
          });
        }
        return false;
      }
      if (!inputsStillCurrent) {
        patchComfyRunIfOwner(sceneId, cardId, runId, { status: "idle", error: null });
        return false;
      }
      const latestOutputs = sets[sets.length - 1]?.outputs || [];
      return patchComfyRunIfOwner(sceneId, cardId, runId, {
        status: "done",
        outputs: latestOutputs,
        error: null,
      });
    } catch (error) {
      if (serverManaged) { flashMsg(error instanceof Error ? error.message : "Comfy 실행 실패"); return false; }
      // 교체된 실행은 소유 중인 옛 running만 idle로 돌리고, 새 실행 상태는 건드리지 않는다.
      if (error instanceof SceneComfyRunSupersededError || !isRunCurrent())
        patchComfyRunIfOwner(sceneId, cardId, runId, { status: "idle", error: null });
      else
        patchComfyRunIfOwner(sceneId, cardId, runId, {
          status: "failed",
          error: error instanceof Error ? error.message : "실행 실패",
        });
      return false;
    } finally {
      if (serverManaged) notifyCanvasComfyRuns();
      markComfyRunning([cardId], false, runningScope);
      releaseComfyRun(sceneId, cardId, runId);
    }
  };

  const runPlanComfy = async (
    plan: SceneExecutionPlan,
    sceneId: string,
  ): Promise<{ runnableGenIds: string[]; aborted: boolean }> => {
    const failed = new Set<string>(plan.skippedByCycle);
    const runnableGenIds: string[] = [];
    for (const step of plan.steps) {
      if (!isDocumentCurrent() || sceneIdRef.current !== sceneId) return { runnableGenIds, aborted: true };
      const dependencyFailed = step.dependsOn.some((dependency) => failed.has(dependency));
      if (step.kind === "comfy") {
        if (dependencyFailed) {
          failed.add(step.id);
          continue;
        }
        if (!(await runComfy(step.id))) failed.add(step.id);
      } else if (!dependencyFailed) {
        runnableGenIds.push(step.id);
      }
    }
    return { runnableGenIds, aborted: false };
  };

  const runPlanComfyCopies = async (
    plan: SceneExecutionPlan,
    sceneId: string,
    batch: number,
    isPlanCurrent: () => boolean,
  ): Promise<{ runs: SceneGenerationRun[]; aborted: boolean }> => {
    flushPending();
    const serverManaged = hubHasFeature(COMFY_CANVAS_RUNS_FEATURE);
    if (serverManaged) {
      const notice = await conflictNotice(plan.comfyIds);
      if (notice) { flashMsg(notice); return { runs: [], aborted: true }; }
    }
    const groups = new Map(serverManaged ? plan.comfyIds.map(id => [id, newGroup(id)] as const) : []);
    if (plan.comfyIds.some((id) => isWorkflowLoading?.(id))) {
      flashMsg(WORKFLOW_LOADING_MESSAGE); // 배치도 시작하지 않는다 — 옛 설정을 잡아 돌리게 된다(28회차 ③)
      return { runs: [], aborted: true };
    }
    const executionStillCurrent = () =>
      isDocumentCurrent() && sceneIdRef.current === sceneId && isPlanCurrent();
    const configSnapshots = new Map<string, SceneComfyConfigSnapshot>();
    for (const card of cardsRef.current) {
      if (
        card.kind === "comfy" &&
        plan.comfyIds.includes(card.id) &&
        card.comfyCfg?.content
      ) {
        configSnapshots.set(card.id, {
          name: card.comfyCfg.name,
          content: card.comfyCfg.content,
          paramValues: { ...(card.comfyCfg.paramValues || {}) },
          params: card.comfyCfg.params?.map((param) => ({
            ...param,
            choices: param.choices ? [...param.choices] : param.choices,
          })),
        });
      }
    }

    const runIds = new Map<string, number>(
      serverManaged ? [] : plan.comfyIds.map((id) => [id, claimComfyRun(sceneId, id)]),
    );
    const runningScope = comfyRunningScope(getAccountNamespace(), sceneId);

    if (plan.comfyIds.length) {
      if (!serverManaged && !commitDocument({ type: "showComfyRunning", runs: [...runIds].map(([cardId, runId]) => ({ cardId, runId })) })) {
        runIds.forEach((runId, id) => releaseComfyRun(sceneId, id, runId));
        return { runs: [], aborted: true };
      }
      markComfyRunning(plan.comfyIds, true, runningScope);
    }

    const varySeed = batch > 1;
    const isConfigCurrent = (id: string) => {
      const snapshot = configSnapshots.get(id);
      return !snapshot || isSceneComfyConfigCurrent(cardsRef.current, id, snapshot);
    };
    const arePlanConfigsCurrent = () => plan.comfyIds.every(isConfigCurrent);
    const limiter = createLimiter(computeMaxParallel(batch, plan.comfyIds.length));
    const tracker = createBatchTracker<ComfyOutput[]>(plan.comfyIds, batch);
    const finalized = new Map<
      string,
      { outputs: ComfyOutput[] | null; failCount: number; firstError?: string }
    >();
    const releaseRunning = (id: string) => {
      if (tracker.releaseOnce(id)) markComfyRunning([id], false, runningScope);
    };
    const noteStepSettled = (
      id: string,
      copyIndex: number,
      outcome: StepOutcome<ComfyOutput[]>,
    ) => {
      const final = tracker.settle(id, copyIndex, outcome);
      if (!final) return;
      finalized.set(id, {
        outputs: final.rep?.outputs || null,
        failCount: final.failCount,
        firstError: final.firstError,
      });
      releaseRunning(id);
    };

    type CopyResult = {
      runs: SceneGenerationRun[];
      overlay: ComfyOutputsById;
      elapsed: Record<string, number>;
      inputSnapshots: Record<string, SceneComfyRunInputSnapshot>;
      superseded: Record<string, boolean>;
      aborted: boolean;
    };
    const runOneCopy = async (copyIndex: number): Promise<CopyResult> => {
      const overlay: ComfyOutputsById = {};
      const elapsed: Record<string, number> = {};
      const inputSnapshots: Record<string, SceneComfyRunInputSnapshot> = {};
      const superseded: Record<string, boolean> = {};
      const failed = new Set<string>(plan.skippedByCycle);
      let aborted = false;
      const stepPromises = new Map<string, Promise<void>>();
      for (const step of plan.steps) {
        if (step.kind !== "comfy") continue;
        const promise = (async () => {
          await Promise.all(
            step.dependsOn
              .map((dependency) => stepPromises.get(dependency))
              .filter((item): item is Promise<void> => !!item),
          );
          if (
            !executionStillCurrent() ||
            !isConfigCurrent(step.id) ||
            step.dependsOn.some((dependency) => !isConfigCurrent(dependency))
          ) {
            aborted = true;
            noteStepSettled(step.id, copyIndex, { kind: "skipped" });
            return;
          }
          if (step.dependsOn.some((dependency) => failed.has(dependency))) {
            failed.add(step.id);
            noteStepSettled(step.id, copyIndex, { kind: "skipped" });
            return;
          }
          try {
            const startedAt = Date.now();
            const execution = await limiter.run(() =>
              !executionStillCurrent()
                ? Promise.reject(new SceneComfyRunSupersededError())
                : runComfyRaw(
                    step.id,
                    overlay,
                    varySeed,
                    configSnapshots.get(step.id),
                    () => executionStillCurrent() && isConfigCurrent(step.id),
                    groups.has(step.id) ? { ...groups.get(step.id)!, copyIndex } : undefined,
                  ),
            );
            overlay[step.id] = execution.outputs;
            inputSnapshots[step.id] = execution.inputSnapshot;
            superseded[step.id] = execution.superseded;
            elapsed[step.id] = (Date.now() - startedAt) / 1000;
            if (
              execution.superseded ||
              !executionStillCurrent() ||
              !isConfigCurrent(step.id) ||
              step.dependsOn.some((dependency) => !isConfigCurrent(dependency))
            ) {
              aborted = true;
              noteStepSettled(step.id, copyIndex, {
                kind: "success",
                outputs: execution.outputs,
                elapsed: elapsed[step.id],
              });
              return;
            }
            noteStepSettled(step.id, copyIndex, {
              kind: "success",
              outputs: execution.outputs,
              elapsed: elapsed[step.id],
            });
          } catch (error) {
            if (
              !executionStillCurrent() ||
              !isConfigCurrent(step.id) ||
              error instanceof SceneComfyRunSupersededError
            ) {
              aborted = true;
              noteStepSettled(step.id, copyIndex, { kind: "skipped" });
              return;
            }
            failed.add(step.id);
            noteStepSettled(step.id, copyIndex, {
              kind: "failed",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
        stepPromises.set(step.id, promise);
      }
      await Promise.all(stepPromises.values());
      const inputsCurrent = Object.entries(inputSnapshots).every(([id, snapshot]) => {
        const configSnapshot = configSnapshots.get(id);
        const current =
          !!configSnapshot &&
          isInputCurrent(id, configSnapshot, snapshot, overlay);
        return current;
      });
      if (!arePlanConfigsCurrent() || !inputsCurrent) aborted = true;
      const runs: SceneGenerationRun[] = aborted
        ? []
        : plan.steps
            .filter(
              (step) =>
                step.kind === "generation" &&
                !step.dependsOn.some((dependency) => failed.has(dependency)),
            )
            .map((step) => ({
              batchIndex: copyIndex,
              cardId: step.id,
              comfyOutputsById: { ...overlay },
            }));
      return { runs, overlay, elapsed, inputSnapshots, superseded, aborted };
    };

    const copies = await Promise.all(
      Array.from({ length: batch }, (_, copyIndex) => runOneCopy(copyIndex)),
    );
    const areAllInputsCurrent = () =>
      copies.every((copy) =>
        Object.entries(copy.inputSnapshots).every(([id, snapshot]) => {
          const configSnapshot = configSnapshots.get(id);
          return (
            !!configSnapshot &&
            !copy.superseded[id] &&
            isInputCurrent(id, configSnapshot, snapshot, copy.overlay)
          );
        }),
      );
    let aborted =
      copies.some((copy) => copy.aborted) ||
      !executionStillCurrent() ||
      !arePlanConfigsCurrent() ||
      !areAllInputsCurrent();
    const saveResult = await saveCompletedComfyResults(
      (serverManaged ? [] : plan.comfyIds).flatMap((comfyId) =>
        copies.flatMap((copy) => {
          const outputs = copy.overlay[comfyId];
          const inputSnapshot = copy.inputSnapshots[comfyId];
          const configSnapshot = configSnapshots.get(comfyId);
          if (!outputs?.length || !inputSnapshot || !configSnapshot) return [];
          const inputStillCurrent = () =>
            !copy.superseded[comfyId] &&
            executionStillCurrent() &&
            arePlanConfigsCurrent() &&
            isInputCurrent(comfyId, configSnapshot, inputSnapshot, copy.overlay);
          return [{
            cardId: comfyId,
            outputCount: outputs.filter(
              (output) => (output.kind === "image" || output.kind === "video") && !!output.url,
            ).length,
            options: {
              silent: true,
              elapsedSeconds: copy.elapsed[comfyId],
              outputs,
              configSnapshot,
              inputSnapshot,
              isInputCurrent: inputStillCurrent,
            },
          }];
        }),
      ),
      saveComfyToLibrary,
    );
    if (!executionStillCurrent() || !arePlanConfigsCurrent() || !areAllInputsCurrent()) {
      aborted = true;
    }
    const wasSuperseded =
      aborted ||
      copies.some((copy) => Object.values(copy.superseded).some(Boolean));
    const saveNotice = comfySaveNotice(!!saveResult.failed, wasSuperseded && !!saveResult.saved);
    if (saveNotice) flashMsg(saveNotice);
    for (const id of plan.comfyIds) releaseRunning(id);
    if (serverManaged) {
      const failed = [...finalized.values()].find(result => result.firstError);
      if (failed) flashMsg(failed.firstError!);
      notifyCanvasComfyRuns();
    }
    // 실행 소유자만 최종 상태를 정산한다. 중간에 새 실행이 시작되면 runId가 달라져 이 블록은 아무것도 못 바꾼다.
    for (const id of plan.comfyIds) {
      const runId = runIds.get(id);
      if (runId == null) continue;
      const final = finalized.get(id);
      const nodeCurrent =
        !aborted &&
        executionStillCurrent() &&
        isConfigCurrent(id) &&
        copies.every((copy) => {
          const snapshot = copy.inputSnapshots[id];
          const configSnapshot = configSnapshots.get(id);
          return (
            !!snapshot &&
            !!configSnapshot &&
            !copy.superseded[id] &&
            isInputCurrent(id, configSnapshot, snapshot, copy.overlay)
          );
        });
      let committed: boolean;
      if (!nodeCurrent) {
        committed = patchComfyRunIfOwner(sceneId, id, runId, { status: "idle", error: null });
      } else if (final?.outputs) {
        committed = patchComfyRunIfOwner(sceneId, id, runId, {
          status: "done",
          outputs: final.outputs,
          error:
            final.failCount > 0
              ? `${final.failCount}/${batch} 실패${final.firstError ? `: ${final.firstError}` : ""}`
              : null,
        });
      } else {
        committed = patchComfyRunIfOwner(sceneId, id, runId, {
          status: "failed",
          error: final?.firstError || "실행 실패",
        });
      }
      if (!committed) aborted = true; // 떠난 세션 결과로 후속 생성 요청을 제출하지 않는다.
      releaseComfyRun(sceneId, id, runId);
    }
    return { runs: aborted ? [] : copies.flatMap((copy) => copy.runs), aborted };
  };

  const orchestrateGenerate = async (generationId: string) => {
    if (!isDocumentCurrent()) return;
    flushPending();
    const cardsById = new Map(cardsRef.current.map((card) => [card.id, card] as const));
    const plan = buildGenerationExecutionPlan(generationId, cardsById, edgesRef.current);
    if (!plan.comfyIds.length) {
      const resolved = resolvePortEdges(cardsById, edgesRef.current);
      onGenerateCard?.(
        generationId,
        cardBatch(cardsById.get(generationId)),
        collectSceneGenerationAssignment(generationId, cardsById, resolved) ?? null,
      );
      return;
    }
    if (orchestratingRef.current) {
      // 다른 카드가 실행 중이면 클릭이 조용히 버려지던 문제 — 왜 안 되는지 알린다.
      flashMsg("이 씬은 이미 생성 요청을 제출하고 있습니다.");
      return;
    }
    orchestratingRef.current = true;
    setComfyWaitingIds(new Set([generationId]));
    const sceneId = sceneIdRef.current;
    const fallbackModel = getGenerationFallbackModel?.() ?? null; // 클릭 시점 고정
    const generationInputSnapshot = captureSceneGenerationInputSnapshot(
      plan.generationIds,
      plan.comfyIds,
      cardsById,
      edgesRef.current,
    );
    const isPlanCurrent = createSceneStateGuard(sceneId, (currentCards, currentEdges) => {
      const liveCards = new Map(currentCards.map((card) => [card.id, card] as const));
      return (
        isGenerationExecutionPlanCurrent(
          plan,
          generationId,
          liveCards,
          currentEdges,
        ) &&
        isSceneGenerationInputSnapshotCurrent(
          generationInputSnapshot,
          liveCards,
          currentEdges,
        )
      );
    });
    try {
      const batch = cardBatch(cardsById.get(generationId));
      const { runs, aborted } = await runPlanComfyCopies(
        plan,
        sceneId,
        batch,
        isPlanCurrent,
      );
      const matchingRuns = runs.filter((run) => run.cardId === generationId);
      if (!aborted && isPlanCurrent() && matchingRuns.length) {
        await onRenderCardRuns?.(matchingRuns, fallbackModel);
      }
    } finally {
      orchestratingRef.current = false;
      setComfyWaitingIds(new Set());
    }
  };

  const orchestrateRender = async (renderId: string) => {
    if (!isDocumentCurrent()) return;
    if (orchestratingRef.current) {
      // 위와 동일 — 실행 중 뮤텍스에 막힌 Render 클릭을 무음으로 버리지 않는다.
      flashMsg("이 씬은 이미 생성 요청을 제출하고 있습니다.");
      return;
    }
    orchestratingRef.current = true;
    const sceneId = sceneIdRef.current;
    const fallbackModel = getGenerationFallbackModel?.() ?? null; // 클릭 시점 고정
    try {
      const cardsById = new Map(cardsRef.current.map((card) => [card.id, card] as const));
      const plan = buildRenderExecutionPlan(renderId, cardsById, edgesRef.current);
      const batch = cardBatch(cardsById.get(renderId));
      const generationInputSnapshot = captureSceneGenerationInputSnapshot(
        plan.generationIds,
        plan.comfyIds,
        cardsById,
        edgesRef.current,
      );
      const isPlanCurrent = createSceneStateGuard(sceneId, (currentCards, currentEdges) => {
        const liveCards = new Map(currentCards.map((card) => [card.id, card] as const));
        return (
          isRenderExecutionPlanCurrent(plan, renderId, liveCards, currentEdges) &&
          isSceneGenerationInputSnapshotCurrent(
            generationInputSnapshot,
            liveCards,
            currentEdges,
          )
        );
      });
      if (plan.comfyIds.length) {
        setComfyWaitingIds(new Set(plan.generationIds));
        const { runs, aborted } = await runPlanComfyCopies(
          plan,
          sceneId,
          batch,
          isPlanCurrent,
        );
        if (!aborted && isPlanCurrent() && runs.length) {
          await onRenderCardRuns?.(runs, fallbackModel);
        }
      } else {
        const { runnableGenIds, aborted } = await runPlanComfy(plan, sceneId);
        if (!aborted && isPlanCurrent() && runnableGenIds.length) {
          await onRenderCards?.(runnableGenIds, batch, fallbackModel);
        }
      }
    } finally {
      orchestratingRef.current = false;
      setComfyWaitingIds(new Set());
    }
  };

  return {
    comfyWaitingIds,
    runningComfyIds,
    runComfy,
    orchestrateGenerate,
    orchestrateRender,
    comfyPlanRunning: () => orchestratingRef.current,
  };
}
