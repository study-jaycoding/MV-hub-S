import type { Generation } from "../types";
import { comfyApi, type ComfyOutput, type ComfyRunMedia } from "./comfyApi";
import { fetchBlob } from "./download";
import { driveTextParams, gatherComfyMedia } from "./sceneComfyInputs";
import {
  randomizeExposedSeedParams,
  randomizeWorkflowSeeds,
} from "./sceneComfySeeds";
import type { ComfyOutputsById } from "./sceneEdges";
import type { SceneCard, SceneEdge } from "./scenes";

export interface SceneComfyConfigSnapshot {
  content: string;
  paramValues: Record<string, string | number | boolean>;
}

export interface ExecuteSceneComfyOptions {
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
  // 실행 중 워크플로·노출 파라미터가 교체되면 이미 시작한 옛 실행 결과를 버린다.
  isRunCurrent?: () => boolean;
}

export interface SceneComfyExecutorDependencies {
  fetchMedia: (url: string, name: string) => Promise<Blob | null>;
  run: typeof comfyApi.run;
  randomizeContent: typeof randomizeWorkflowSeeds;
  randomizeParams: typeof randomizeExposedSeedParams;
}

const defaultDependencies: SceneComfyExecutorDependencies = {
  fetchMedia: fetchBlob,
  run: comfyApi.run,
  randomizeContent: randomizeWorkflowSeeds,
  randomizeParams: randomizeExposedSeedParams,
};

export class SceneComfyRunSupersededError extends Error {
  constructor() {
    super("실행 중 워크플로우가 변경되었습니다");
    this.name = "SceneComfyRunSupersededError";
  }
}

function sameParamValues(
  left: Record<string, string | number | boolean> | undefined,
  right: Record<string, string | number | boolean>,
): boolean {
  const actual = left || {};
  const leftKeys = Object.keys(actual);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    rightKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(actual, key) && actual[key] === right[key],
    )
  );
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
    sameParamValues(card.comfyCfg.paramValues, snapshot.paramValues)
  );
}

function assertRunCurrent(options: ExecuteSceneComfyOptions): void {
  if (options.isRunCurrent && !options.isRunCurrent()) {
    throw new SceneComfyRunSupersededError();
  }
}

// SceneBoard 상태를 직접 변경하지 않는 단일 Comfy 실행 경계.
// 필요한 미디어를 모두 확보한 뒤에만 API를 호출해 입력 슬롯이 밀리는 부분 실행을 막는다.
export async function executeSceneComfy(
  options: ExecuteSceneComfyOptions,
  dependencies: Partial<SceneComfyExecutorDependencies> = {},
): Promise<ComfyOutput[]> {
  const deps = { ...defaultDependencies, ...dependencies };
  const card = options.cards.find((candidate) => candidate.id === options.cardId);
  const baseContent = options.configSnapshot?.content ?? card?.comfyCfg?.content;
  const baseParams = options.configSnapshot?.paramValues ?? card?.comfyCfg?.paramValues ?? {};
  if (!baseContent) throw new Error("워크플로우가 없습니다");
  assertRunCurrent(options);

  const wanted = gatherComfyMedia(
    options.cardId,
    options.cards,
    options.edges,
    options.genData,
    options.overlay,
  );
  const media: ComfyRunMedia[] = [];
  for (const item of wanted) {
    assertRunCurrent(options);
    const blob = await deps.fetchMedia(item.url, item.name);
    if (!blob) throw new Error(`입력을 불러오지 못했습니다: ${item.name}`);
    media.push({ type: item.type, name: item.name, blob });
  }

  // 큰 입력을 받는 동안 교체됐다면 유료/장시간 API 호출 자체를 시작하지 않는다.
  assertRunCurrent(options);

  // 미디어를 받는 동안 연결 텍스트가 편집될 수 있으므로 API 호출 직전에 최신 그래프를 다시 읽는다.
  const liveCards = options.getLiveCards?.() ?? options.cards;
  const liveEdges = options.getLiveEdges?.() ?? options.edges;
  const driven = driveTextParams(
    options.cardId,
    baseParams,
    card?.comfyCfg?.params,
    liveCards,
    liveEdges,
    options.refParents,
    options.overlay,
  );
  const content = options.varySeed ? deps.randomizeContent(baseContent) : baseContent;
  const paramValues = options.varySeed ? deps.randomizeParams(driven) : driven;
  const result = await deps.run(content, paramValues, media);
  // API 호출은 취소할 수 없지만, 완료 전에 교체된 실행의 결과가 새 카드로 넘어가지는 않게 한다.
  assertRunCurrent(options);
  return result.outputs;
}
