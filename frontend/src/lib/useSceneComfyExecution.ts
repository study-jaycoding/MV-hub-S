import { useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Generation } from "../types";
import { computeMaxParallel, createBatchTracker, createLimiter, type StepOutcome } from "./comfyRunState";
import type { ComfyOutput } from "./comfyApi";
import {
  executeSceneComfy,
  isSceneComfyConfigCurrent,
  SceneComfyRunSupersededError,
  type SceneComfyConfigSnapshot,
  type SceneComfyExecutionResult,
  type SceneComfyRunInputSnapshot,
} from "./sceneComfyExecutor";
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
import { setComfyRunning as setStoredComfyRunning } from "./sceneComfyRunningStore";
import { flashMsg } from "./flash";
import {
  cardBatch,
  type SceneCard,
  type SceneComfyCfg,
  type SceneEdge,
  type SceneModelCfg,
} from "./scenes";

export interface SaveComfyOptions {
  silent?: boolean;
  elapsedSeconds?: number;
  outputs?: ComfyOutput[];
  configSnapshot?: SceneComfyConfigSnapshot;
  inputSnapshot?: SceneComfyRunInputSnapshot;
  isInputCurrent?: () => boolean;
}

export interface SaveComfyResult {
  saved: number;
  failed: number;
}

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

// 완료 정산의 done 패치 조각 — 저장 attach(saveComfyToLibrary)가 카드 outputs 를 이미
// 갱신했으면(saved_generation_id 마킹 포함) 그대로 두고, attach 가 안 됐으면(저장 API 실패·
// 텍스트 전용 출력) 실행 결과를 여기서 붙인다. 저장이 실패해도 결과가 카드에서 사라지면
// 안 된다(dev 동작 보존 — 저장은 실패 표시, 표시는 유지).
export function doneOutputsPatch(
  currentOutputs: SceneComfyCfg["outputs"],
  latestOutputs: ComfyOutput[],
): Partial<SceneComfyCfg> {
  const latestUrls = latestOutputs
    .filter((output) => (output.kind === "image" || output.kind === "video") && output.url)
    .map((output) => output.url as string);
  const currentUrls = new Set(
    (currentOutputs || []).filter((output) => output.url).map((output) => output.url as string),
  );
  // '일부 일치'로는 부족하다 — 이전 실행과 URL 이 겹치는 다중 출력에서 새 영상만 누락될 수
  // 있으므로, 이 실행의 미디어 URL 전부가 카드에 반영됐을 때만 attach 완료로 본다.
  const attachApplied =
    latestUrls.length > 0 && latestUrls.every((url) => currentUrls.has(url));
  return attachApplied ? {} : { outputs: latestOutputs, output: null };
}

// 카드에 기록된 runId가 일치할 때만 상태를 바꾼다. 이전 실행의 finally/실패 응답이 새 실행을 덮지 못한다.
export function patchOwnedComfyRun(
  cards: SceneCard[],
  cardId: string,
  runId: number,
  patch: Partial<SceneComfyCfg>,
): SceneCard[] {
  let changed = false;
  const next = cards.map((card) => {
    if (card.id !== cardId || card.kind !== "comfy" || card.comfyCfg?.runId !== runId) return card;
    changed = true;
    return { ...card, comfyCfg: { ...card.comfyCfg, ...patch } };
  });
  return changed ? next : cards;
}

interface UseSceneComfyExecutionOptions {
  sceneIdRef: MutableRefObject<string>;
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  genDataRef: MutableRefObject<Record<string, Generation>>;
  refParents: Record<string, string[]>;
  setCards: Dispatch<SetStateAction<SceneCard[]>>;
  flushPending: () => void;
  patchComfyCfg: (
    cardId: string,
    patch: Partial<SceneComfyCfg>,
    opts?: { undo?: boolean; defer?: boolean },
  ) => void;
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
}

// SceneBoard의 Comfy 실행 수명주기 전용 훅.
// 그래프 상태는 ref로 읽고, 저장은 주입받은 기존 커밋 경계를 통해서만 수행한다.
export function useSceneComfyExecution({
  sceneIdRef,
  cardsRef,
  edgesRef,
  genDataRef,
  refParents,
  setCards,
  flushPending,
  patchComfyCfg,
  saveComfyToLibrary,
  onGenerateCard,
  onRenderCards,
  onRenderCardRuns,
  getGenerationFallbackModel,
  onComfyRunningChange,
}: UseSceneComfyExecutionOptions) {
  const orchestratingRef = useRef(false);
  const [comfyWaitingIds, setComfyWaitingIds] = useState<Set<string>>(new Set());
  const [runningComfyIds, setRunningComfyIds] = useState<Map<string, number>>(new Map());
  const runningComfyRef = useRef<Map<string, number>>(new Map());
  const nextRunIdRef = useRef(0);
  const runOwnersRef = useRef<Map<string, number>>(new Map());
  const refParentsRef = useRef(refParents);
  refParentsRef.current = refParents;

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
  const markComfyRunning = (ids: string[], on: boolean) => {
    const next = new Map(runningComfyRef.current);
    for (const id of ids) {
      const count = (next.get(id) || 0) + (on ? 1 : -1);
      if (count > 0) next.set(id, count);
      else next.delete(id);
    }
    runningComfyRef.current = next;
    setRunningComfyIds(next);
    setStoredComfyRunning(ids, on);
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
    patch: Partial<SceneComfyCfg>,
  ) => {
    if (!ownsComfyRun(sceneId, cardId, runId)) return false;
    patchComfyCfg(cardId, patch, { undo: false });
    return true;
  };

  const runComfyRaw = async (
    cardId: string,
    overlay: ComfyOutputsById | undefined,
    varySeed: boolean,
    configSnapshot?: SceneComfyConfigSnapshot,
    isRunCurrent?: () => boolean,
  ): Promise<SceneComfyExecutionResult> => {
    const execution = await executeSceneComfy({
      cardId,
      cards: cardsRef.current,
      edges: edgesRef.current,
      genData: genDataRef.current,
      refParents: refParentsRef.current,
      overlay,
      varySeed,
      configSnapshot,
      getLiveCards: () => cardsRef.current,
      getLiveEdges: () => edgesRef.current,
      getLiveGenData: () => genDataRef.current,
      getLiveRefParents: () => refParentsRef.current,
      isRunCurrent:
        isRunCurrent ||
        (configSnapshot
          ? () => isSceneComfyConfigCurrent(cardsRef.current, cardId, configSnapshot)
          : undefined),
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
      if (sceneIdRef.current !== sceneId) return false;
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
    flushPending();
    const card = cardsRef.current.find((candidate) => candidate.id === cardId);
    if (!card?.comfyCfg?.content) return false;
    const batch = cardBatch(card);
    const sceneId = sceneIdRef.current;
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
      sceneIdRef.current === sceneId &&
      isSceneComfyConfigCurrent(cardsRef.current, cardId, configSnapshot);
    const runId = claimComfyRun(sceneId, cardId);
    patchComfyCfg(cardId, { runId, status: "running", error: null }, { undo: false });
    markComfyRunning([cardId], true);
    try {
      const settledSets = await Promise.allSettled(
        Array.from({ length: batch }, async () => {
          const startedAt = Date.now();
          const execution = await runComfyRaw(
            cardId,
            undefined,
            batch > 1,
            configSnapshot,
            isRunCurrent,
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
        sets.map((result) => {
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
      const inputsStillCurrent =
        isRunCurrent() &&
        sets.every(
          (result) =>
            !result.superseded &&
            isInputCurrent(cardId, configSnapshot, result.inputSnapshot),
        );
      const superseded = !inputsStillCurrent || sets.some((result) => result.superseded);
      if (saveResult.failed) flashMsg("일부 Comfy 결과를 내 작업에 저장하지 못했습니다");
      if (superseded && saveResult.saved) {
        flashMsg("입력이 바뀌어 이전 실행 결과는 내 작업에 저장했습니다");
      }
      if (rejected) {
        if (rejected.reason instanceof SceneComfyRunSupersededError || superseded) {
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
      patchComfyRunIfOwner(sceneId, cardId, runId, {
        status: "done",
        ...doneOutputsPatch(
          cardsRef.current.find((c) => c.id === cardId)?.comfyCfg?.outputs,
          latestOutputs,
        ),
        error: null,
      });
      return true;
    } catch (error) {
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
      markComfyRunning([cardId], false);
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
      if (sceneIdRef.current !== sceneId) return { runnableGenIds, aborted: true };
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
    const executionStillCurrent = () =>
      sceneIdRef.current === sceneId && isPlanCurrent();
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
      plan.comfyIds.map((id) => [id, claimComfyRun(sceneId, id)]),
    );

    if (plan.comfyIds.length) {
      markComfyRunning(plan.comfyIds, true);
      const running = cardsRef.current.map((card) =>
        card.kind === "comfy" && plan.comfyIds.includes(card.id)
          ? {
              ...card,
              comfyCfg: {
                ...(card.comfyCfg || {}),
                runId: runIds.get(card.id),
                status: "running" as const,
                error: null,
              },
            }
          : card,
      );
      cardsRef.current = running;
      setCards(running);
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
      if (tracker.releaseOnce(id)) markComfyRunning([id], false);
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
      plan.comfyIds.flatMap((comfyId) =>
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
    if (saveResult.failed) flashMsg("일부 Comfy 결과를 내 작업에 저장하지 못했습니다");
    if (wasSuperseded && saveResult.saved) {
      flashMsg("입력이 바뀌어 이전 실행 결과는 내 작업에 저장했습니다");
    }
    for (const id of plan.comfyIds) releaseRunning(id);
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
      if (!nodeCurrent) {
        patchComfyRunIfOwner(sceneId, id, runId, { status: "idle", error: null });
      } else if (final?.outputs) {
        patchComfyRunIfOwner(sceneId, id, runId, {
          status: "done",
          ...doneOutputsPatch(
            cardsRef.current.find((c) => c.id === id)?.comfyCfg?.outputs,
            final.outputs,
          ),
          error:
            final.failCount > 0
              ? `${final.failCount}/${batch} 실패${final.firstError ? `: ${final.firstError}` : ""}`
              : null,
        });
      } else {
        patchComfyRunIfOwner(sceneId, id, runId, {
          status: "failed",
          error: final?.firstError || "실행 실패",
        });
      }
      releaseComfyRun(sceneId, id, runId);
    }
    return { runs: aborted ? [] : copies.flatMap((copy) => copy.runs), aborted };
  };

  const orchestrateGenerate = async (generationId: string) => {
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
  };
}
