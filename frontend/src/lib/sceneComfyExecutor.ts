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

  const wanted = gatherComfyMedia(
    options.cardId,
    options.cards,
    options.edges,
    options.genData,
    options.overlay,
  );
  const media: ComfyRunMedia[] = [];
  for (const item of wanted) {
    const blob = await deps.fetchMedia(item.url, item.name);
    if (!blob) throw new Error(`입력을 불러오지 못했습니다: ${item.name}`);
    media.push({ type: item.type, name: item.name, blob });
  }

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
  return result.outputs;
}
