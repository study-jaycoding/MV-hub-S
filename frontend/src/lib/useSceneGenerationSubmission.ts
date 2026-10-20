import { captureSubmissionScope, assertOperationContextCurrent } from "../app/operationContext";
import { prepareCreateSubmission } from "../features/generation/api";
import { runSubmission } from "../features/generation/api";
// 캔버스 제출의 준비·정책 검사·중복 방지·결과 정산을 조정한다. 문서 상태와 저장 확정은 기존 소유자에 둔다.
import { useRef } from "react";
import { api } from "../api";
import type { Generation, ModelParam, WorkspaceContext } from "../types";
import { listScenes, variantIds, type Scene, type SceneModelCfg } from "./scenes";
import { resolvePortEdges, type SceneGenerationRun } from "./sceneEdges";
import { buildSceneGenerationJobInput, type SceneGenerationJobInput } from "./sceneGenerationInputs";
import { acquireSceneGeneration, executeSceneGenerationBatch } from "./sceneGenerationSubmission";
import { buildSpotlightCreateBody } from "./spotlightSubmit";
import { resolveAutoAspectRatio } from "./aspectAuto";
import { isGenerationWorkspaceReady } from "./workspaceContext";
import { currentModelPolicy, modelBlockMessage } from "./modelPolicy";
import { modelAllowed } from "./modelPolicyCore";
import type { useCanvasGenerationLinks } from "./useCanvasGenerationLinks";
import type { useGenerationCardActions } from "./useGenerationCardActions";

type CanvasLinks = ReturnType<typeof useCanvasGenerationLinks>;
interface Options {
  activeScene: Scene | null;
  workspaceContext: WorkspaceContext;
  sceneWorkspaceBlock: string | null;
  generationProjectId?: string;
  batchCount: number;
  armedFolder: { projectId: string; path: string } | null;
  armedAutoTags: Set<string>;
  flushScenePending: (sceneId: string) => void;
  prepareCanvasGenerationBatch: CanvasLinks["prepareCanvasGenerationBatch"];
  confirmCanvasGeneration: CanvasLinks["confirmCanvasGeneration"];
  settleCanvasGeneration: CanvasLinks["settleCanvasGeneration"];
  discardCanvasGeneration: CanvasLinks["discardCanvasGeneration"];
  onRegenerate: ReturnType<typeof useGenerationCardActions>["onRegenerate"];
  flash: (message: string) => void;
  reportPromptError: (message: string | null) => void;
  mergeFacetTags: (tags: string[]) => void;
  reload: () => unknown;
  bumpBoard: () => void;
}

export function useSceneGenerationSubmission({
  activeScene, workspaceContext, sceneWorkspaceBlock, generationProjectId, batchCount,
  armedFolder, armedAutoTags, flushScenePending, prepareCanvasGenerationBatch, confirmCanvasGeneration,
  settleCanvasGeneration, discardCanvasGeneration, onRegenerate, flash, reportPromptError,
  mergeFacetTags, reload, bumpBoard,
}: Options) {
  const uiContext = useRef({ sceneId: activeScene?.id });
  if (uiContext.current.sceneId !== activeScene?.id) uiContext.current = { sceneId: activeScene?.id };
  // 같은 생성물의 재생성이 도는 동안의 다시 누름은 pending 연결을 만들기 **전에** 막는다(조작 규칙 39 — 누름마다 유료 요청이 하나씩 나갔다).
  const sceneRegenInFlightRef = useRef(new Set<string>());
  const onSceneRegenerate = async (g: Generation) => {
    if (!activeScene) return;
    const blocked = modelBlockMessage(g.model); // 못 쓰는 모델은 pending 링크를 만들기 전에 거절
    if (blocked) {
      flash(blocked);
      return;
    }
    if (sceneRegenInFlightRef.current.has(g.id)) {
      flash("재생성 처리 중입니다 — 완료 후 다시 누르세요.");
      return;
    }
    const operationScope = captureSubmissionScope(workspaceContext);
    sceneRegenInFlightRef.current.add(g.id);
    try {
      flushScenePending(activeScene.id);
      const latest = listScenes(null).find((scene) => scene.id === activeScene.id) || activeScene;
      const target = latest.cards.find((card) => variantIds(card).includes(g.id));
      if (!target) {
        flash("재생성 결과를 쌓을 캔버스 카드를 찾지 못했습니다.");
        return;
      }
      const link = (await prepareCanvasGenerationBatch(activeScene.id, [target.id]))[0];
      if (!operationScope.isCurrent!()) return;
      if (!link) {
        flash("재생성 위치를 저장하지 못해 제출을 중단했습니다.");
        return;
      }
      await onRegenerate(g, link, () => discardCanvasGeneration(link), {
        scope: operationScope,
        destination: { confirm: () => confirmCanvasGeneration([link]), apply: generation => settleCanvasGeneration(link, generation) },
      });
    } finally {
      sceneRegenInFlightRef.current.delete(g.id);
    }
  };
  // ── 렌더(배치) 노드 ── 연결된 생성카드들을 각자 자기 모델·refs·텍스트로 한 번에 생성한다.
  //  · 각 카드의 연결 모델(collectGenModel)·연결 텍스트(collectGenText)·카드 refs 로 body 를 조립(하단 프롬프트 재사용).
  //  · 모델 노드가 없는 카드는 Render 클릭 시점의 하단 프롬프트 모델로 생성(카드 Generate 바와 같은 규칙).
  //    모델 노드가 2개 이상이거나 모델 미설정 노드면 건너뛴다. 잡은 전부 한 번에 제출하고 초과분은 서버 큐가 순서대로 처리.
  const genParamsCacheRef = useRef<Record<string, ModelParam[]>>({}); // 모델별 파라미터 스키마 캐시(auto 비율 해석용)
  // 씬별 렌더 진행 가드 — 같은 씬의 더블클릭만 막고, 느린 요청 중 다른 씬 작업은 허용한다.
  const renderingSceneIdsRef = useRef(new Set<string>());
  // 생성 1건의 조립 재료는 sceneGenerationInputs 공용 순수 함수가 만든다(실행 지문과 제출 규칙 공유).
  // job 목록 제출(공통) — 모델 파라미터 선로드→body 조립→각 job 1회씩 병렬 create→카드에 결과 id 누적.
  //  ★배치 반복은 호출자가 jobs 를 늘려서(같은 카드 N개) 결정한다 — 여기선 job 1개=1장.
  const submitGenJobs = async (
    requestedJobs: SceneGenerationJobInput[],
    skipped: number, // 모델을 정할 수 없어 건너뛴 생성카드 수(카드 단위)
    scene: Scene,
    projectId: string | undefined,
    folderPath: string | undefined,
  ) => {
    if (!isGenerationWorkspaceReady(workspaceContext)) {
      flash("워크스페이스 정보를 확인하는 중입니다. 잠시 후 다시 실행하세요.");
      return;
    }
    if (sceneWorkspaceBlock) {
      flash(sceneWorkspaceBlock);
      return;
    }
    // 그룹에서 못 쓰는 모델은 pending 기록·업로드보다 먼저 걸러낸다(로컬 거절이 유령 표식을 남기지 않게 — 코덱스 P1).
    const policy = currentModelPolicy();
    if (policy.status === "loading") {
      flash("그룹 모델 설정을 확인하는 중입니다. 잠시 후 다시 실행하세요.");
      return;
    }
    const blockedCards = new Set(
      requestedJobs.filter((job) => !modelAllowed(policy, job.model)).map((job) => job.cardId),
    );
    const jobs = blockedCards.size
      ? requestedJobs.filter((job) => modelAllowed(policy, job.model))
      : requestedJobs;
    if (!jobs.length && blockedCards.size) {
      flash(
        `선택한 카드의 모델을 모두 ${policy.groupName ? `'${policy.groupName}' 그룹` : "이 그룹"}에서 쓸 수 없습니다. ` +
          "모델 노드에서 다른 모델을 고르세요.",
      );
      return;
    }
    if (!jobs.length) {
      flash(
        skipped
          ? "모델을 정할 수 없는 생성 카드뿐입니다. 모델 노드를 하나만 연결해 모델을 고르거나, 모델 노드를 모두 떼고 하단 프롬프트에서 모델을 고르세요."
          : "생성할 카드가 없습니다.",
      );
      return;
    }
    // 같은 모델 요청은 파라미터 조회 1회를 공유하되, 다른 모델 작업은 독립적으로 준비·제출한다.
    // 예전처럼 모든 모델 조회·body 조립을 먼저 Promise.all로 기다리면 느린 1건이 전체 시작을 막는다.
    const paramLoads = new Map<string, Promise<void>>();
    const ensureModelParams = (model: string): Promise<void> => {
      if (model in genParamsCacheRef.current) return Promise.resolve();
      const pending = paramLoads.get(model);
      if (pending) return pending;
      const load = api
        .modelParams(model)
        .then((r) => {
          genParamsCacheRef.current[model] = r.params;
        })
        .catch(() => {
          // 실패는 캐시하지 않는다 — 다음 렌더에서 다시 시도한다. 이번 작업은 빈 스키마로 계속 진행.
        });
      paramLoads.set(model, load);
      return load;
    };

    const submittedUi = uiContext.current;
    const operationWorkspace = { ...workspaceContext };
    const operationScope = captureSubmissionScope(operationWorkspace);
    const canvasLinks = await prepareCanvasGenerationBatch(
      scene.id,
      jobs.map((job) => job.cardId),
    );
    if (!operationScope.isCurrent!()) return;
    if (canvasLinks.length !== jobs.length) {
      flash("캔버스 생성 위치를 저장하지 못해 제출을 중단했습니다.");
      return;
    }
    const linkedJobs = jobs.map((job, index) => ({
      ...job,
      canvasLink: canvasLinks[index],
    }));

    reportPromptError(null);
    const invalidCards = new Map<string, string>();
    const generationCards = scene.cards.filter((card) => card.kind === "generation");
    const summary = await executeSceneGenerationBatch(
      linkedJobs.map((job) => ({ cardId: job.cardId, input: job })),
      async (j) => {
        try {
          await ensureModelParams(j.model);
          const tunable = genParamsCacheRef.current[j.model] || [];
          const assignmentProjectId = j.assignment?.projectId ?? projectId;
          const assignmentFolderPath = j.assignment?.folderPath ?? folderPath;
          const assignmentTags = j.assignment?.tags || [];
          const { body, error } = buildSpotlightCreateBody({
            text: j.text,
            inlineRefs: [],
            trayRefs: j.refs,
            parts: [],
            displayPrompt: j.text,
            model: j.model,
            optionValues: j.params,
            tags: assignmentTags,
            armedAutoTags: [...armedAutoTags],
            activeProjectId: assignmentProjectId,
            folderPath: assignmentFolderPath,
          });
          if (error || !body) {
            if (j.canvasLink && operationScope.isCurrent!()) discardCanvasGeneration(j.canvasLink);
            // 같은 카드의 배치 반복은 한 번만 알리고, 유효한 다른 카드는 계속 제출한다.
            const cardNumber = generationCards.findIndex((card) => card.id === j.cardId) + 1;
            invalidCards.set(j.cardId, `생성 카드 ${cardNumber}: ${error || "생성 요청을 만들 수 없습니다."}`);
            if (operationScope.isCurrent!() && uiContext.current === submittedUi) reportPromptError([...invalidCards.values()].join("\n"));
            return null;
          }
          body.params = await resolveAutoAspectRatio(body.params || {}, tunable, j.refs);
          assertOperationContextCurrent(operationScope.operation!);
          return { body, canvasLink: j.canvasLink };
        } catch (error) {
          if (j.canvasLink && operationScope.isCurrent!()) discardCanvasGeneration(j.canvasLink);
          throw error;
        }
      },
      async ({ body, canvasLink }) => {
        const result = await runSubmission(prepareCreateSubmission(body, operationWorkspace, canvasLink, operationScope), canvasLink ? {
          confirm: () => confirmCanvasGeneration([canvasLink]),
          apply: generation => settleCanvasGeneration(canvasLink, generation),
        } : undefined);
        if (canvasLink && (result.outcome.kind === "rejected" || result.outcome.kind === "prepare_failed") && operationScope.isCurrent!()) discardCanvasGeneration(canvasLink);
        return result;
      },
    );
    if (!operationScope.isCurrent!() || uiContext.current !== submittedUi) return;
    const { successes, buildFail, submitFail: createFail, submitUnknown, applyFail } = summary;
    if (!successes.length && buildFail === jobs.length) {
      flash(`생성 요청을 만들 수 없습니다(요청 ${buildFail}건 실패, 모델 미확정 카드 ${skipped}개).`);
      return;
    }
    // 연결은 요청 전에 입력 순서대로 저장됐다. 여기서는 성공 수와 표시 데이터만 정산한다.
    const byCard = new Map<string, string[]>();
    const freshGens: Generation[] = successes.flatMap(item => item.result.generation ? [item.result.generation] : []);
    if (freshGens.length) mergeFacetTags(freshGens.flatMap((item) => item.tags || []));
    for (const success of successes) {
      const arr = byCard.get(success.cardId) || [];
      if (success.result.generation) arr.push(success.result.generation.id);
      byCard.set(success.cardId, arr);
    }
    const notes: string[] = [];
    // 하단 프롬프트 모델로 나간 카드는 어떤 모델인지 드러낸다(숨은 '남은 모델' 방지).
    const fallbackJobs = jobs.filter((job) => job.modelSource === "fallback");
    if (fallbackJobs.length) {
      const label = fallbackJobs[0].modelName || fallbackJobs[0].model;
      const cardCount = new Set(fallbackJobs.map((job) => job.cardId)).size;
      notes.push(`모델 노드 없음 → 하단 모델(${label}) ${cardCount}개`);
    }
    if (skipped) notes.push(`모델 미확정 ${skipped}개`);
    if (blockedCards.size) notes.push(`쓸 수 없는 모델 제외 ${blockedCards.size}개`);
    if (buildFail) notes.push(`요청 실패 ${buildFail}개`);
    if (createFail) notes.push(`제출 실패 ${createFail}장`);
    if (submitUnknown) notes.push(`접수 여부 모름 ${submitUnknown}장 — 다시 누르기 전에 목록 확인`); // 들어갔을 수 있다(Jay 결정 2A)
    if (applyFail) notes.push("화면 반영 실패 — 재시작 시 자동 복구");
    flash(
      `${byCard.size}개 카드에서 생성 시작(${freshGens.length}장)` +
        (notes.length ? ` · ${notes.join(" · ")}` : ""),
    );
    void reload();
    bumpBoard();
  };
  // ── 렌더(배치) 노드 ── 연결된 생성카드들을 각자 연결 모델(없으면 fallbackModel)·refs·텍스트로 batch 장씩 한 번에 생성.
  //  · comfy 없는(또는 comfy 결과를 짝으로 나누지 않는) 경로. 각 카드를 batch 수만큼 복제해 병렬 제출.
  //  · fallbackModel 은 실행 훅이 Render 클릭 시점에 읽은 하단 프롬프트 모델 — 여기서 다시 읽지 않는다.
  const generateCards = async (
    cardIds: string[],
    batchOverride?: number,
    fallbackModel?: SceneModelCfg | null,
  ) => {
    if (!activeScene || !cardIds.length) return;
    const sceneId = activeScene.id;
    const release = acquireSceneGeneration(renderingSceneIdsRef.current, sceneId);
    if (!release) {
      flash("이 씬은 이미 생성 요청을 제출하고 있습니다.");
      return;
    }
    try {
      const scene = listScenes(null).find((s) => s.id === sceneId) || activeScene;
      const cardsById = new Map(scene.cards.map((c) => [c.id, c] as const));
      const resolved = resolvePortEdges(cardsById, scene.edges);
      // 렌더 노드의 배치수(노드별)로 각 잡을 복제. 없으면 하단 스포트라이트 배치.
      const batch = Math.max(1, batchOverride ?? batchCount);
      const projectId =
        generationProjectId && generationProjectId !== "none" ? generationProjectId : undefined;
      const folderPath =
        armedFolder && armedFolder.projectId === projectId ? armedFolder.path : undefined;
      const jobs: SceneGenerationJobInput[] = [];
      const unresolved = new Set<string>(); // 모델을 정할 수 없는 생성카드(노드 2개 이상·미설정 노드·폴백 없음)
      for (const cid of cardIds) {
        const job = buildSceneGenerationJobInput(cid, cardsById, resolved, undefined, fallbackModel);
        if (!job) {
          if (cardsById.get(cid)?.kind === "generation") unresolved.add(cid);
          continue;
        }
        for (let i = 0; i < batch; i++) jobs.push({ ...job }); // 각 잡 × 배치수
      }
      await submitGenJobs(jobs, unresolved.size, scene, projectId, folderPath);
    } finally {
      release();
    }
  };
  // ── 배치 짝 생성 ── 상류 comfy 를 배치수만큼 병렬 실행한 결과(runs)를 받아, 각 run 을 그 comfy 결과(overlay)와
  //  짝지어 1장씩 병렬 생성한다. SceneBoard 오케스트레이터가 runs 를 만들어 이 함수를 1회 호출한다
  //  (씬별 실행 가드에 조용히 막히지 않도록 반드시 1회). run 마다 overlay 가 달라 서로 다른 comfy 결과로 생성.
  const generateCardRuns = async (
    runs: SceneGenerationRun[],
    fallbackModel?: SceneModelCfg | null,
  ) => {
    if (!activeScene || !runs.length) return;
    const sceneId = activeScene.id;
    const release = acquireSceneGeneration(renderingSceneIdsRef.current, sceneId);
    if (!release) {
      flash("이 씬은 이미 생성 요청을 제출하고 있습니다.");
      return;
    }
    try {
      const scene = listScenes(null).find((s) => s.id === sceneId) || activeScene;
      const cardsById = new Map(scene.cards.map((c) => [c.id, c] as const));
      const resolved = resolvePortEdges(cardsById, scene.edges);
      const projectId =
        generationProjectId && generationProjectId !== "none" ? generationProjectId : undefined;
      const folderPath =
        armedFolder && armedFolder.projectId === projectId ? armedFolder.path : undefined;
      const jobs: SceneGenerationJobInput[] = [];
      const unresolved = new Set<string>(); // 카드 단위 — run 수(배치)로 세면 알림이 부풀려진다
      for (const run of runs) {
        const job = buildSceneGenerationJobInput(
          run.cardId,
          cardsById,
          resolved,
          run.comfyOutputsById,
          fallbackModel,
        );
        if (!job) {
          if (cardsById.get(run.cardId)?.kind === "generation") unresolved.add(run.cardId);
          continue;
        }
        jobs.push(job); // run 하나당 1장(overlay 로 그 짝의 comfy 결과 주입)
      }
      await submitGenJobs(jobs, unresolved.size, scene, projectId, folderPath);
    } finally {
      release();
    }
  };
  return { onSceneRegenerate, generateCards, generateCardRuns };
}
