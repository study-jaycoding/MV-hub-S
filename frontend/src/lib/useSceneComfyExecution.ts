import { useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Generation } from "../types";
import { computeMaxParallel, createBatchTracker, createLimiter, type StepOutcome } from "./comfyRunState";
import type { ComfyOutput } from "./comfyApi";
import {
  executeSceneComfy,
  isSceneComfyConfigCurrent,
  type SceneComfyConfigSnapshot,
} from "./sceneComfyExecutor";
import {
  buildExecutionPlan,
  buildGenerationExecutionPlan,
  resolvePortEdges,
  type ComfyOutputsById,
  type SceneExecutionPlan,
  type SceneGenerationRun,
} from "./sceneEdges";
import { setComfyRunning as setStoredComfyRunning } from "./sceneComfyRunningStore";
import {
  cardBatch,
  type SceneCard,
  type SceneComfyCfg,
  type SceneEdge,
  type SceneGroup,
} from "./scenes";

interface SaveComfyOptions {
  silent?: boolean;
  elapsedSeconds?: number;
  outputs?: ComfyOutput[];
  configSnapshot?: SceneComfyConfigSnapshot;
}

interface UseSceneComfyExecutionOptions {
  sceneIdRef: MutableRefObject<string>;
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  groupsRef: MutableRefObject<SceneGroup[]>;
  genDataRef: MutableRefObject<Record<string, Generation>>;
  refParents: Record<string, string[]>;
  setCards: Dispatch<SetStateAction<SceneCard[]>>;
  flushPending: () => void;
  patchComfyCfg: (
    cardId: string,
    patch: Partial<SceneComfyCfg>,
    opts?: { undo?: boolean; defer?: boolean },
  ) => void;
  persist: (
    cards: SceneCard[],
    edges: SceneEdge[],
    groups?: SceneGroup[],
    opts?: { undo?: boolean },
  ) => void;
  saveComfyToLibrary: (cardId: string, opts?: SaveComfyOptions) => Promise<void>;
  onGenerateCard?: (batch?: number) => void;
  onRenderCards?: (cardIds: string[], batch?: number) => void | Promise<void>;
  onRenderCardRuns?: (runs: SceneGenerationRun[]) => void | Promise<void>;
  onComfyRunningChange?: (items: { id: string; name: string }[]) => void;
}

// SceneBoard의 Comfy 실행 수명주기 전용 훅.
// 그래프 상태는 ref로 읽고, 저장은 주입받은 기존 커밋 경계를 통해서만 수행한다.
export function useSceneComfyExecution({
  sceneIdRef,
  cardsRef,
  edgesRef,
  groupsRef,
  genDataRef,
  refParents,
  setCards,
  flushPending,
  patchComfyCfg,
  persist,
  saveComfyToLibrary,
  onGenerateCard,
  onRenderCards,
  onRenderCardRuns,
  onComfyRunningChange,
}: UseSceneComfyExecutionOptions) {
  const orchestratingRef = useRef(false);
  const [comfyWaitingIds, setComfyWaitingIds] = useState<Set<string>>(new Set());
  const [runningComfyIds, setRunningComfyIds] = useState<Map<string, number>>(new Map());
  const runningComfyRef = useRef<Map<string, number>>(new Map());

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

  const runComfyRaw = (
    cardId: string,
    overlay: ComfyOutputsById | undefined,
    varySeed: boolean,
    configSnapshot?: SceneComfyConfigSnapshot,
  ) =>
    executeSceneComfy({
      cardId,
      cards: cardsRef.current,
      edges: edgesRef.current,
      genData: genDataRef.current,
      refParents,
      overlay,
      varySeed,
      configSnapshot,
      getLiveCards: () => cardsRef.current,
      getLiveEdges: () => edgesRef.current,
      isRunCurrent: configSnapshot
        ? () => isSceneComfyConfigCurrent(cardsRef.current, cardId, configSnapshot)
        : undefined,
    });

  const runComfy = async (cardId: string): Promise<boolean> => {
    flushPending();
    const card = cardsRef.current.find((candidate) => candidate.id === cardId);
    if (!card?.comfyCfg?.content) return false;
    const batch = cardBatch(card);
    const sceneId = sceneIdRef.current;
    const configSnapshot: SceneComfyConfigSnapshot = {
      content: card.comfyCfg.content,
      paramValues: { ...(card.comfyCfg.paramValues || {}) },
    };
    const isRunCurrent = () =>
      sceneIdRef.current === sceneId &&
      isSceneComfyConfigCurrent(cardsRef.current, cardId, configSnapshot);
    patchComfyCfg(cardId, { status: "running", error: null }, { undo: false });
    markComfyRunning([cardId], true);
    try {
      let firstReason: unknown;
      const settledSets = await Promise.allSettled(
        Array.from({ length: batch }, async () => {
          const startedAt = Date.now();
          try {
            const outputs = await runComfyRaw(cardId, undefined, batch > 1, configSnapshot);
            return { outputs, elapsed: (Date.now() - startedAt) / 1000 };
          } catch (error) {
            if (firstReason === undefined) firstReason = error;
            throw error;
          }
        }),
      );
      if (!isRunCurrent()) return false;
      if (settledSets.some((result) => result.status === "rejected")) throw firstReason;
      const sets = settledSets.map(
        (result) =>
          (result as PromiseFulfilledResult<{ outputs: ComfyOutput[]; elapsed: number }>).value,
      );
      patchComfyCfg(
        cardId,
        {
          status: "done",
          outputs: sets[sets.length - 1].outputs,
          output: null,
          error: null,
        },
        { undo: false },
      );
      for (const result of sets) {
        if (!isRunCurrent()) return false;
        await saveComfyToLibrary(cardId, {
          silent: true,
          elapsedSeconds: result.elapsed,
          outputs: result.outputs,
          configSnapshot,
        });
      }
      return isRunCurrent();
    } catch (error) {
      // 교체된 옛 실행의 실패까지 새 워크플로 카드에 덮어쓰지 않는다.
      if (isRunCurrent()) {
        patchComfyCfg(
          cardId,
          {
            status: "failed",
            error: error instanceof Error ? error.message : "실행 실패",
          },
          { undo: false },
        );
      }
      return false;
    } finally {
      markComfyRunning([cardId], false);
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
  ): Promise<{ runs: SceneGenerationRun[]; aborted: boolean }> => {
    flushPending();
    const configSnapshots = new Map<string, SceneComfyConfigSnapshot>();
    for (const card of cardsRef.current) {
      if (
        card.kind === "comfy" &&
        plan.comfyIds.includes(card.id) &&
        card.comfyCfg?.content
      ) {
        configSnapshots.set(card.id, {
          content: card.comfyCfg.content,
          paramValues: { ...(card.comfyCfg.paramValues || {}) },
        });
      }
    }

    if (plan.comfyIds.length) {
      markComfyRunning(plan.comfyIds, true);
      const running = cardsRef.current.map((card) =>
        card.kind === "comfy" && plan.comfyIds.includes(card.id)
          ? {
              ...card,
              comfyCfg: { ...(card.comfyCfg || {}), status: "running" as const, error: null },
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
      if (sceneIdRef.current === sceneId && isConfigCurrent(id)) {
        const next = cardsRef.current.map((card) => {
          if (card.kind !== "comfy" || card.id !== id) return card;
          if (final.rep) {
            return {
              ...card,
              comfyCfg: {
                ...(card.comfyCfg || {}),
                status: "done" as const,
                outputs: final.rep.outputs,
                output: null,
                error:
                  final.failCount > 0
                    ? `${final.failCount}/${batch} 실패${final.firstError ? `: ${final.firstError}` : ""}`
                    : null,
              },
            };
          }
          return {
            ...card,
            comfyCfg: {
              ...(card.comfyCfg || {}),
              status: "failed" as const,
              error: final.firstError || "실행 실패",
            },
          };
        });
        cardsRef.current = next;
        setCards(next);
        persist(next, edgesRef.current, groupsRef.current, { undo: false });
      }
      releaseRunning(id);
    };

    type CopyResult = {
      runs: SceneGenerationRun[];
      overlay: ComfyOutputsById;
      elapsed: Record<string, number>;
      aborted: boolean;
    };
    const runOneCopy = async (copyIndex: number): Promise<CopyResult> => {
      const overlay: ComfyOutputsById = {};
      const elapsed: Record<string, number> = {};
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
            sceneIdRef.current !== sceneId ||
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
            const outputs = await limiter.run(() =>
              sceneIdRef.current !== sceneId
                ? Promise.reject(new Error("scene changed"))
                : runComfyRaw(
                    step.id,
                    overlay,
                    varySeed,
                    configSnapshots.get(step.id),
                  ),
            );
            if (
              !isConfigCurrent(step.id) ||
              step.dependsOn.some((dependency) => !isConfigCurrent(dependency))
            ) {
              aborted = true;
              noteStepSettled(step.id, copyIndex, { kind: "skipped" });
              return;
            }
            overlay[step.id] = outputs;
            elapsed[step.id] = (Date.now() - startedAt) / 1000;
            noteStepSettled(step.id, copyIndex, {
              kind: "success",
              outputs,
              elapsed: elapsed[step.id],
            });
          } catch (error) {
            if (sceneIdRef.current !== sceneId || !isConfigCurrent(step.id)) {
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
      if (!arePlanConfigsCurrent()) aborted = true;
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
      return { runs, overlay, elapsed, aborted };
    };

    const copies = await Promise.all(
      Array.from({ length: batch }, (_, copyIndex) => runOneCopy(copyIndex)),
    );
    let aborted =
      copies.some((copy) => copy.aborted) ||
      sceneIdRef.current !== sceneId ||
      !arePlanConfigsCurrent();
    if (!aborted && sceneIdRef.current === sceneId) {
      for (const comfyId of plan.comfyIds) {
        if (aborted) break;
        for (const copy of copies) {
          if (!arePlanConfigsCurrent()) {
            aborted = true;
            break;
          }
          const outputs = copy.overlay[comfyId];
          if (outputs?.length) {
            await saveComfyToLibrary(comfyId, {
              silent: true,
              elapsedSeconds: copy.elapsed[comfyId],
              outputs,
              configSnapshot: configSnapshots.get(comfyId),
            });
            if (!arePlanConfigsCurrent()) {
              aborted = true;
              break;
            }
          }
        }
      }
    }
    for (const id of plan.comfyIds) releaseRunning(id);
    return { runs: aborted ? [] : copies.flatMap((copy) => copy.runs), aborted };
  };

  const orchestrateGenerate = async (generationId: string) => {
    const cardsById = new Map(cardsRef.current.map((card) => [card.id, card] as const));
    const resolved = resolvePortEdges(cardsById, edgesRef.current);
    const plan = buildGenerationExecutionPlan(generationId, cardsById, resolved);
    if (!plan.comfyIds.length) {
      onGenerateCard?.(cardBatch(cardsById.get(generationId)));
      return;
    }
    if (orchestratingRef.current) return;
    orchestratingRef.current = true;
    setComfyWaitingIds(new Set([generationId]));
    const sceneId = sceneIdRef.current;
    try {
      const batch = cardBatch(cardsById.get(generationId));
      const { runs, aborted } = await runPlanComfyCopies(plan, sceneId, batch);
      const matchingRuns = runs.filter((run) => run.cardId === generationId);
      if (!aborted && sceneIdRef.current === sceneId && matchingRuns.length) {
        await onRenderCardRuns?.(matchingRuns);
      }
    } finally {
      orchestratingRef.current = false;
      setComfyWaitingIds(new Set());
    }
  };

  const orchestrateRender = async (renderId: string, checkedGenerationIds: string[]) => {
    if (orchestratingRef.current) return;
    orchestratingRef.current = true;
    const sceneId = sceneIdRef.current;
    try {
      const cardsById = new Map(cardsRef.current.map((card) => [card.id, card] as const));
      const resolved = resolvePortEdges(cardsById, edgesRef.current);
      const unchecked = new Set(cardsById.get(renderId)?.unchecked || []);
      const directComfyIds = resolved
        .filter((edge) => edge.to === renderId)
        .map((edge) => cardsById.get(edge.from))
        .filter(
          (card): card is SceneCard => card?.kind === "comfy" && !unchecked.has(card.id),
        )
        .map((card) => card.id);
      const plan = buildExecutionPlan(
        checkedGenerationIds,
        directComfyIds,
        cardsById,
        resolved,
      );
      const batch = cardBatch(cardsById.get(renderId));
      if (plan.comfyIds.length) {
        setComfyWaitingIds(
          new Set(plan.generationIds.length ? plan.generationIds : checkedGenerationIds),
        );
        const { runs, aborted } = await runPlanComfyCopies(plan, sceneId, batch);
        if (!aborted && sceneIdRef.current === sceneId && runs.length) {
          await onRenderCardRuns?.(runs);
        }
      } else {
        const { runnableGenIds, aborted } = await runPlanComfy(plan, sceneId);
        if (!aborted && sceneIdRef.current === sceneId && runnableGenIds.length) {
          await onRenderCards?.(runnableGenIds, batch);
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
