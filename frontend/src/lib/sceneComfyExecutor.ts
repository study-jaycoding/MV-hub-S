import type { Generation } from "../types";
import { comfyApi, ComfyUnresolvedRunError, type ComfyOutput, type ComfyRunMedia, type ComfyCanvasSubmission } from "./comfyApi";
import type { CanvasDocumentPort } from "../features/canvas/api";
import { getAccountNamespace, getConnectionKey } from "./accountScope";
import { getApiPause, getAuthToken } from "./http";
import { isCanvasFloating } from "./popupWindows";
import { COMFY_CANVAS_RUNS_FEATURE, hubHasFeature } from "./hubFeatures";
import { fetchBlob } from "./download";
import {
  prepareSceneComfyInputs,
  comfySceneFingerprints,
  sameComfyParamValues,
  samePreparedSceneComfyInputs,
  type PreparedSceneComfyInputs,
} from "./sceneComfyInputs";
import {
  randomizeExposedSeedParams,
  randomizeWorkflowSeeds,
} from "./sceneComfySeeds";
import type { ComfyOutputsById } from "./sceneEdges";
import type { SceneCard, SceneComfyCfg, SceneEdge } from "./scenes";
import { assetIdentity } from "../shared/contracts/assets";

export interface SceneComfyConfigSnapshot {
  name?: string;
  content: string;
  paramValues: Record<string, string | number | boolean>;
  params?: SceneComfyCfg["params"];
}

export interface SceneComfyRunInputSnapshot extends PreparedSceneComfyInputs {
  // 배치 seed 무작위화까지 마친, 실제 Comfy API에 전달한 값. 자동 저장 메타도 이 값을 쓴다.
  executedParamValues: Record<string, string | number | boolean>;
  serverManaged?: boolean;
}

// API 요청이 시작된 뒤에는 결과물을 버리지 않는다. superseded는 현재 카드에 연결해도 되는지만 결정한다.
export interface SceneComfyExecutionResult {
  outputs: ComfyOutput[];
  inputSnapshot: SceneComfyRunInputSnapshot;
  superseded: boolean;
  serverManaged?: boolean;
}

export interface ExecuteSceneComfyOptions {
  projectId?: string;
  cardId: string;
  cards: SceneCard[];
  edges: SceneEdge[];
  genData: Record<string, Generation>;
  refParents: Record<string, string[]>;
  overlay?: ComfyOutputsById;
  varySeed: boolean;
  configSnapshot?: SceneComfyConfigSnapshot;
  getLiveCards?: () => SceneCard[];
  getLiveEdges?: () => SceneEdge[];
  getLiveGenData?: () => Record<string, Generation>;
  getLiveRefParents?: () => Record<string, string[]>;
  onRunPrepared?: (snapshot: SceneComfyRunInputSnapshot) => void | Promise<void>;
  canvas?: { sceneId: string; runGroupId: string; copyIndex: number; document: CanvasDocumentPort };
  // 실행 중 워크플로·노출 파라미터가 교체되면 이미 시작한 옛 실행 결과를 버린다.
  isRunCurrent?: () => boolean;
}

export interface SceneComfyExecutorDependencies {
  fetchMedia: (url: string, name: string) => Promise<Blob | null>;
  run: typeof comfyApi.run;
  randomizeContent: typeof randomizeWorkflowSeeds;
  randomizeParams: typeof randomizeExposedSeedParams;
  origin: typeof comfyApi.canvasOrigin;
}

const defaultDependencies: SceneComfyExecutorDependencies = {
  fetchMedia: fetchBlob,
  run: (...args) => comfyApi.run(...args),
  randomizeContent: randomizeWorkflowSeeds,
  randomizeParams: randomizeExposedSeedParams,
  origin: () => comfyApi.canvasOrigin(),
};

export class SceneComfyRunSupersededError extends Error {
  constructor() {
    super("실행 중 Comfy 입력이 변경되었습니다");
    this.name = "SceneComfyRunSupersededError";
  }
}

export const COMFY_CONFLICT_MESSAGE = "이 카드에 처리 중인 Comfy 실행이 있습니다. 완료 또는 미회수 실행 정리 후 다시 실행하세요.";
export class SceneComfyReservationError extends Error {
  constructor(readonly status: "conflict" | "stale" | "storage_failed") {
    super(status === "conflict" ? COMFY_CONFLICT_MESSAGE : status === "storage_failed"
      ? "Comfy 실행 예약을 저장하지 못했습니다. 저장 상태를 확인하세요." : "Comfy 실행 대상이 변경되어 제출하지 않았습니다.");
  }
}

// status·outputs 같은 실행 결과 필드는 비교하지 않는다. 사용자가 실행 입력 자체(content·paramValues)를
// 바꿨는지만 판정해, running/done 패치 때문에 정상 실행이 스스로 stale 처리되지 않게 한다.
export function isSceneComfyConfigCurrent(
  cards: SceneCard[],
  cardId: string,
  snapshot: SceneComfyConfigSnapshot,
): boolean {
  const card = cards.find((candidate) => candidate.id === cardId);
  return (
    card?.kind === "comfy" &&
    card.comfyCfg?.content === snapshot.content &&
    sameComfyParamValues(card.comfyCfg.paramValues, snapshot.paramValues)
  );
}

function assertRunCurrent(options: ExecuteSceneComfyOptions): void {
  if (options.isRunCurrent && !options.isRunCurrent()) {
    throw new SceneComfyRunSupersededError();
  }
}

function currentPreparedInputs(
  options: ExecuteSceneComfyOptions,
  baseParams: Record<string, string | number | boolean>,
): PreparedSceneComfyInputs {
  return prepareSceneComfyInputs(
    options.cardId,
    baseParams,
    options.getLiveCards?.() ?? options.cards,
    options.getLiveEdges?.() ?? options.edges,
    options.getLiveGenData?.() ?? options.genData,
    options.getLiveRefParents?.() ?? options.refParents,
    options.overlay,
    options.canvas ? options.canvas.document.snapshot({ accountNamespace: getAccountNamespace(), sceneId: options.canvas.sceneId })?.comfyCardRuns || {} : undefined,
  );
}

function assertPreparedInputsCurrent(
  options: ExecuteSceneComfyOptions,
  baseParams: Record<string, string | number | boolean>,
  prepared: PreparedSceneComfyInputs,
): void {
  assertRunCurrent(options);
  if (!samePreparedSceneComfyInputs(prepared, currentPreparedInputs(options, baseParams))) {
    throw new SceneComfyRunSupersededError();
  }
}

// SceneBoard 상태를 직접 변경하지 않는 단일 Comfy 실행 경계.
// 필요한 미디어를 모두 확보한 뒤에만 API를 호출해 입력 슬롯이 밀리는 부분 실행을 막는다.
export async function executeSceneComfy(
  options: ExecuteSceneComfyOptions,
  dependencies: Partial<SceneComfyExecutorDependencies> = {},
): Promise<SceneComfyExecutionResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const durable = hubHasFeature(COMFY_CANVAS_RUNS_FEATURE);
  const canvas = durable ? options.canvas : undefined;
  if (durable && !canvas) throw new Error("Comfy 캔버스 저장 창구가 없습니다");
  const accountNamespace = getAccountNamespace(), connection = getConnectionKey(), token = getAuthToken();
  const target = canvas && { accountNamespace, sceneId: canvas.sceneId };
  const initialScene = target && canvas?.document.snapshot(target);
  const fingerprints = initialScene && comfySceneFingerprints({ ...initialScene, cards: options.cards, edges: options.edges }, options.cardId);
  const current = () => accountNamespace === getAccountNamespace() && connection === getConnectionKey() && token === getAuthToken()
    && !getApiPause() && !isCanvasFloating() && (!options.isRunCurrent || options.isRunCurrent());
  const assertDurableCurrent = () => {
    if (!canvas || !target) return;
    const scene = canvas.document.snapshot(target);
    const fp = scene && comfySceneFingerprints({ ...scene, cards: options.getLiveCards?.() ?? options.cards,
      edges: options.getLiveEdges?.() ?? options.edges }, options.cardId);
    if (!current() || !fp || !fingerprints || fp.configFp !== fingerprints.configFp || fp.inputFp !== fingerprints.inputFp)
      throw new SceneComfyRunSupersededError();
    if (options.configSnapshot && !isSceneComfyConfigCurrent(options.getLiveCards?.() ?? options.cards, options.cardId, options.configSnapshot))
      throw new SceneComfyRunSupersededError();
  };
  const card = options.cards.find((candidate) => candidate.id === options.cardId);
  const baseContent = options.configSnapshot?.content ?? card?.comfyCfg?.content;
  const baseParams = options.configSnapshot?.paramValues ?? card?.comfyCfg?.paramValues ?? {};
  if (!baseContent) throw new Error("워크플로우가 없습니다");
  assertRunCurrent(options);

  const initialInputs = prepareSceneComfyInputs(
    options.cardId,
    baseParams,
    options.cards,
    options.edges,
    options.genData,
    options.refParents,
    options.overlay,
    canvas ? initialScene?.comfyCardRuns || {} : undefined,
  );
  const media: ComfyRunMedia[] = [];
  for (const item of initialInputs.media) {
    assertRunCurrent(options);
    const blob = await deps.fetchMedia(item.url, item.name);
    if (!blob) throw new Error(`입력을 불러오지 못했습니다: ${item.name}`);
    media.push({ ...assetIdentity(item), type: item.type, name: item.name, blob,
      source_url: item.url, source_gen_id: item.source_gen_id, role: `${item.type === "video" ? "@Video" : "@Image"}${media.filter(m => m.type === item.type).length + 1}` });
  }

  // 큰 입력을 받는 동안 교체됐다면 유료/장시간 API 호출 자체를 시작하지 않는다.
  assertRunCurrent(options);

  // 미디어를 받는 동안 연결 텍스트가 편집될 수 있으므로 API 호출 직전에 최신 그래프를 다시 읽는다.
  const prepared = currentPreparedInputs(options, baseParams);
  // 이미 받은 blob과 현재 미디어 슬롯이 다르면 잘못된 파일로 실행하지 않는다. 텍스트는 위 prepared의
  // 최신값을 그대로 사용해, 다운로드 중 편집을 허용하던 기존 동작을 유지한다.
  if (!samePreparedSceneComfyInputs(initialInputs, prepared)) {
    throw new SceneComfyRunSupersededError();
  }
  const content = options.varySeed ? deps.randomizeContent(baseContent) : baseContent;
  const paramValues = options.varySeed
    ? deps.randomizeParams(prepared.drivenParamValues)
    : prepared.drivenParamValues;
  const inputSnapshot: SceneComfyRunInputSnapshot = {
    // blob을 실제로 받은 최초 URL을 보존한다. 실행 직전 pending 결과의 URL만 해소된 경우에도
    // API에는 이 목록으로 전달했으므로, 라이브러리 메타도 그 실제 실행 입력과 일치해야 한다.
    media: initialInputs.media.map((item) => ({ ...item })),
    drivenParamValues: { ...prepared.drivenParamValues },
    textParamKeys: [...prepared.textParamKeys],
    inputFingerprint: prepared.inputFingerprint,
    executedParamValues: { ...paramValues },
    ...(canvas ? { serverManaged: true } : {}),
  };
  if (options.onRunPrepared) {
    await options.onRunPrepared(inputSnapshot);
    assertPreparedInputsCurrent(options, baseParams, prepared);
  }
  assertDurableCurrent();
  let submission: ComfyCanvasSubmission | undefined;
  if (canvas && target && fingerprints) {
    const origin = await deps.origin();
    assertDurableCurrent();
    const result = await canvas.document.reserveComfyAttempt({ ...target, originHubId: origin.hub_id, originDeviceId: origin.device_id }, {
      ...fingerprints, cardId: options.cardId, attemptId: crypto.randomUUID(), runGroupId: canvas.runGroupId, copyIndex: canvas.copyIndex,
    });
    if (result.status !== "reserved") throw new SceneComfyReservationError(result.status);
    assertDurableCurrent();
    const attempt = result.attempt;
    const owns = () => {
      const saved = canvas.document.snapshot(target, true);
      const owner = saved?.comfyCardRuns?.[attempt.cardId];
      const mark = saved?.comfyRuns?.find(run => run.attemptId === attempt.attemptId);
      const fp = saved && comfySceneFingerprints(saved, attempt.cardId);
      return current() && !!mark && mark.localState !== "applied" && mark.runGroupId === attempt.runGroupId
        && mark.cardId === attempt.cardId && mark.copyIndex === attempt.copyIndex
        && mark.originHubId === attempt.originHubId && mark.originDeviceId === attempt.originDeviceId
        && mark.groupSeq === attempt.groupSeq && mark.configFp === attempt.configFp && mark.inputFp === attempt.inputFp
        && fp?.configFp === attempt.configFp && fp.inputFp === attempt.inputFp
        && owner?.groupId === attempt.runGroupId && owner.groupSeq === attempt.groupSeq;
    };
    if (!owns()) throw new SceneComfyRunSupersededError();
    submission = { canvas_run: { attempt_id: attempt.attemptId, run_group_id: attempt.runGroupId, group_seq: attempt.groupSeq,
      copy_index: attempt.copyIndex, scene_id: target.sceneId, card_id: attempt.cardId, config_fp: attempt.configFp, input_fp: attempt.inputFp },
      save_meta: { name: options.configSnapshot?.name || card?.comfyCfg?.name || "Comfy" },
      isCurrent: () => { try { assertDurableCurrent(); return current(); } catch { return false; } } };
    // 접수 시도 기록도 서버 요청 전에 확정한다. 제출 여부가 불명확하면 복구 조회만 하고 재생성하지 않는다.
    const submitted = canvas.document.commit(target, { type: "submitComfy", attemptId: attempt.attemptId, canWrite: current });
    if (!submitted.queued || !await submitted.confirmed) throw new SceneComfyReservationError("storage_failed");
    assertDurableCurrent();
    if (!owns()) throw new SceneComfyRunSupersededError();
  }
  try {
    const result = submission ? await deps.run(content, paramValues, media, options.projectId, submission) : options.projectId
      ? await deps.run(content, paramValues, media, options.projectId)
      : await deps.run(content, paramValues, media);
    // API 호출은 취소할 수 없지만, 완료 전에 바뀐 입력의 결과도 라이브러리에는 남긴다.
    // superseded 표식만 붙여 현재 카드 연결을 막는다.
    let superseded = false;
    try {
      assertPreparedInputsCurrent(options, baseParams, prepared);
    } catch (error) {
      if (!(error instanceof SceneComfyRunSupersededError)) throw error;
      superseded = true;
    }
    return { outputs: result.outputs, inputSnapshot, superseded, ...(submission ? { serverManaged: true } : {}) };
  } catch (error) {
    if (error instanceof ComfyUnresolvedRunError) throw error;
    // 실패 응답도 입력 교체 뒤 현재 카드에 표시되면 안 된다. 교체가 아니면 원래 오류를 보존한다.
    assertPreparedInputsCurrent(options, baseParams, prepared);
    throw error;
  }
}
