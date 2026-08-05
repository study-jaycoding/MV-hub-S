// 캔버스 생성카드의 실제 Higgsfield 요청 재료와 실행 중 변경 감지용 지문.
// Comfy 런타임 출력은 실행마다 달라지는 정상 값이므로 고정 오버레이로 치환하고,
// 모델·파라미터·정적 텍스트·레퍼런스 및 동적 출력의 연결 순서만 비교한다.
import type { ChipRef } from "./promptEditor";
import {
  collectGenModel,
  collectGenRefs,
  collectGenText,
  comfyDeclaredKinds,
  resolvePortEdges,
  type ComfyOutputsById,
} from "./sceneEdges";
import { variantIds, type SceneCard, type SceneEdge } from "./scenes";

export interface SceneGenerationJobInput {
  cardId: string;
  model: string;
  params: Record<string, unknown>;
  refs: ChipRef[];
  text: string;
}

export interface SceneGenerationInputSnapshot {
  generationIds: string[];
  comfyIds: string[];
  fingerprints: Record<string, string | null>;
}

function connectedOverlayComfyIds(
  cardId: string,
  cardsById: Map<string, SceneCard>,
  resolvedEdges: SceneEdge[],
  overlay?: ComfyOutputsById,
): string[] {
  if (!overlay) return [];
  const candidates = new Set(Object.keys(overlay));
  const found = new Set<string>();
  const visited = new Set<string>();
  const stack = resolvedEdges.filter((edge) => edge.to === cardId).map((edge) => edge.from);
  while (stack.length) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const source = cardsById.get(id);
    if (!source) continue;
    if (source.kind === "comfy") {
      if (candidates.has(id)) found.add(id);
      continue;
    }
    // 동적 미디어 ref를 전달할 수 있는 컨테이너만 거슬러 간다. text는 프롬프트 경로라 제외한다.
    if (source.kind === "list") {
      for (const edge of resolvedEdges) if (edge.to === id) stack.push(edge.from);
    }
  }
  return [...found];
}

// 호출부가 한 번 resolve한 엣지를 여러 생성카드에 재사용할 수 있도록 이 함수는 resolvedEdges를 받는다.
export function buildSceneGenerationJobInput(
  cardId: string,
  cardsById: Map<string, SceneCard>,
  resolvedEdges: SceneEdge[],
  overlay?: ComfyOutputsById,
): SceneGenerationJobInput | null {
  const card = cardsById.get(cardId);
  if (!card || card.kind !== "generation") return null;
  const modelCfg = collectGenModel(cardId, cardsById, resolvedEdges);
  if (!modelCfg?.model) return null;

  const gatheredText = collectGenText(cardId, cardsById, resolvedEdges, overlay);
  const text = gatheredText.count > 0 ? gatheredText.text : card.prompt || "";
  const collectedComfyRefs = collectGenRefs(cardId, cardsById, resolvedEdges, overlay);
  const contributingComfyIds = connectedOverlayComfyIds(
    cardId,
    cardsById,
    resolvedEdges,
    overlay,
  );
  const overlayComfyGenIds = new Set(
    contributingComfyIds.flatMap((id) => {
      const source = cardsById.get(id);
      return source?.kind === "comfy" ? variantIds(source) : [];
    }),
  );
  // List 경유 Comfy는 이전 저장 결과가 card.refs에 from_card로 남아 있을 수 있다.
  // 이번 실행 overlay가 있으면 같은 Comfy의 옛 ref를 빼고 현재 복사본 출력으로 교체한다.
  const cardRefs = (card.refs || []).filter(
    (ref) =>
      !(
        ref.from_card &&
        ref.source_gen_id &&
        overlayComfyGenIds.has(ref.source_gen_id)
      ),
  );
  const cardRefPaths = new Set(cardRefs.map((ref) => ref.file_path));
  const comfyRefs = collectedComfyRefs.filter(
    (ref) => !cardRefPaths.has(ref.file_path),
  );
  const refs: ChipRef[] = [...cardRefs, ...comfyRefs].map((ref) => ({
    file_path: ref.file_path,
    type: ref.type === "video" ? "video" : ref.type === "audio" ? "audio" : "image",
    role: "", // buildSpotlightCreateBody가 최종 @Image/@Video/@Audio 번호를 매긴다.
    name: ref.name ?? "",
    thumb: ref.thumb ?? "",
    source_gen_id: ref.source_gen_id ?? undefined,
  }));
  return {
    cardId,
    model: modelCfg.model,
    params: { ...(modelCfg.params || {}) },
    refs,
    text,
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function jobFingerprint(job: SceneGenerationJobInput | null): string | null {
  if (!job) return null;
  // thumb는 표시용 캐시 URL이라 제외한다. URL 갱신만으로 유료 실행이 취소되면 안 된다.
  return JSON.stringify(
    canonicalValue({
      model: job.model,
      params: job.params,
      text: job.text,
      refs: job.refs.map((ref) => ({
        file_path: ref.file_path,
        type: ref.type,
        name: ref.name,
        source_gen_id: ref.source_gen_id ?? null,
      })),
    }),
  );
}

// 실제 Comfy 출력값 대신 카드별 고정 표식을 넣는다. 출력 URL·텍스트는 달라도 연결 위치와 순서는
// 동일한 지문이 되고, 워크플로우가 출력 종류를 선언하지 않은 경우에는 보수적으로 media+text 양쪽을 본다.
function markerOverlay(
  comfyIds: readonly string[],
  cardsById: Map<string, SceneCard>,
): ComfyOutputsById {
  const overlay: ComfyOutputsById = {};
  for (const id of comfyIds) {
    const card = cardsById.get(id);
    if (card?.kind !== "comfy") continue;
    const declared = comfyDeclaredKinds(card.comfyCfg?.content);
    const unknown = !declared.media && !declared.text;
    const outputs: ComfyOutputsById[string] = [];
    if (declared.media || unknown) {
      outputs.push({ kind: "image", url: `scene-marker://${encodeURIComponent(id)}/media` });
    }
    if (declared.text || unknown) {
      outputs.push({ kind: "text", text: `__SCENE_COMFY_TEXT_${id}__` });
    }
    overlay[id] = outputs;
  }
  return overlay;
}

function cardsForFingerprint(
  cardsById: Map<string, SceneCard>,
  comfyIds: readonly string[],
): Map<string, SceneCard> {
  const dynamicComfyGenIds = new Set(
    comfyIds.flatMap((id) => {
      const card = cardsById.get(id);
      return card?.kind === "comfy" ? variantIds(card) : [];
    }),
  );
  return new Map(
    [...cardsById].map(([id, card]) => {
      if (card.kind === "generation" && card.refs?.length && dynamicComfyGenIds.size) {
        // 리스트/렌더를 거친 Comfy 저장 결과는 자동 저장 때 old genId→new genId로 정상 교체된다.
        // 그 Comfy에서 파생된 연결 ref만 제외하고, 사용자가 직접 넣은 ref(from_card 아님)는 보존한다.
        const refs = card.refs.filter(
          (ref) =>
            !(
              ref.from_card &&
              ref.source_gen_id &&
              dynamicComfyGenIds.has(ref.source_gen_id)
            ),
        );
        return [id, refs.length === card.refs.length ? card : { ...card, refs }] as const;
      }
      if (card.kind !== "comfy") return [id, card] as const;
      // 자동 저장이 붙이는 genId/genIds와 런타임 결과·상태는 정상 실행 중에도 바뀐다.
      // 워크플로 설정·이름·paramValues는 보존하고 결과 캐시만 제거한다.
      return [
        id,
        {
          ...card,
          genId: null,
          genIds: [],
          comfyCfg: card.comfyCfg
            ? {
                ...card.comfyCfg,
                output: null,
                outputs: [],
                status: "idle" as const,
                error: null,
              }
            : undefined,
        },
      ] as const;
    }),
  );
}

export function captureSceneGenerationInputSnapshot(
  generationIds: readonly string[],
  comfyIds: readonly string[],
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): SceneGenerationInputSnapshot {
  const normalizedGenerationIds = [...new Set(generationIds)].sort();
  const normalizedComfyIds = [...new Set(comfyIds)].sort();
  const fingerprintCards = cardsForFingerprint(cardsById, normalizedComfyIds);
  const resolved = resolvePortEdges(fingerprintCards, edges);
  const emptyOverlay: ComfyOutputsById = {};
  const dynamicOverlay = markerOverlay(normalizedComfyIds, fingerprintCards);
  const fingerprints: Record<string, string | null> = {};

  for (const cardId of normalizedGenerationIds) {
    const withoutRuntimeOutputs = jobFingerprint(
      buildSceneGenerationJobInput(cardId, fingerprintCards, resolved, emptyOverlay),
    );
    const withDynamicMarkers = jobFingerprint(
      buildSceneGenerationJobInput(cardId, fingerprintCards, resolved, dynamicOverlay),
    );
    fingerprints[cardId] = JSON.stringify([withoutRuntimeOutputs, withDynamicMarkers]);
  }
  return {
    generationIds: normalizedGenerationIds,
    comfyIds: normalizedComfyIds,
    fingerprints,
  };
}

export function isSceneGenerationInputSnapshotCurrent(
  snapshot: SceneGenerationInputSnapshot,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): boolean {
  const current = captureSceneGenerationInputSnapshot(
    snapshot.generationIds,
    snapshot.comfyIds,
    cardsById,
    edges,
  );
  return JSON.stringify(current) === JSON.stringify(snapshot);
}
