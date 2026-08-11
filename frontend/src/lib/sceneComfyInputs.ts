// Comfy 노드 실행 입력(미디어·연결텍스트) 수집 — SceneBoard 에서 분리한 순수 로직(React·ref 무관, 인자만으로 계산).
//  실행부(runComfyRaw)가 cards/edges/genData/refParents 를 넘기면 그대로 계산한다. 테스트 대상.
import {
  collectListInputs,
  comfyOutputMedia,
  incomingTextOf,
  comfyTextDriveKeys,
  resolveEdgeRole,
  resolvePortEdges,
  type ComfyOutputsById,
} from "./sceneEdges";
import { refMediaType, refMediaSrc, mediaFileName } from "./sceneMedia";
import { variantIds, type SceneCard, type SceneEdge, type SceneRef } from "./scenes";
import type { Generation } from "../types";

export interface ComfyMediaInput {
  type: "image" | "video";
  url: string;
  name: string;
  source_gen_id?: string | null;
}

export interface PreparedSceneComfyInputs {
  media: ComfyMediaInput[];
  drivenParamValues: Record<string, string | number | boolean>;
  textParamKeys: string[];
  // URL 해소 상태와 무관한 사용자 입력 지문. pending 생성물이 완료되어 URL만 생기는 경우에는 바뀌지 않는다.
  inputFingerprint: string;
}

export function sameComfyParamValues(
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

export function sameComfyMediaInputs(left: ComfyMediaInput[], right: ComfyMediaInput[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        item.type === other.type &&
        item.url === other.url &&
        item.name === other.name &&
        (item.source_gen_id || null) === (other.source_gen_id || null)
      );
    })
  );
}

export function samePreparedSceneComfyInputs(
  left: PreparedSceneComfyInputs,
  right: PreparedSceneComfyInputs,
): boolean {
  return left.inputFingerprint === right.inputFingerprint;
}

function stableParamValues(values: Record<string, string | number | boolean>): [string, string | number | boolean][] {
  return Object.keys(values)
    .sort()
    .map((key) => [key, values[key]]);
}

// target에서 상류로 이어지는 실제 입력 그래프만 걷는다. 출력 URL·런타임 status는 의도적으로 넣지 않는다.
// 이 지문은 엣지/포트 구조, 리스트 순서, 선택한 generation 변형, 레퍼런스 식별자, 연결 텍스트 값,
// 상류 Comfy 실행 번호를 비교하기 위한 것이다.
function inputGraphFingerprint(
  cardId: string,
  cards: SceneCard[],
  edges: SceneEdge[],
  drivenParamValues: Record<string, string | number | boolean>,
  textParamKeys: string[],
): string {
  const byId = new Map(cards.map((card) => [card.id, card] as const));
  const relevantIds = new Set<string>([cardId]);
  const relevantEdges: SceneEdge[] = [];
  const queue = [cardId];
  while (queue.length) {
    const targetId = queue.shift() as string;
    for (const edge of edges) {
      if (edge.to !== targetId) continue;
      relevantEdges.push(edge);
      if (!relevantIds.has(edge.from)) {
        relevantIds.add(edge.from);
        queue.push(edge.from);
      }
    }
    const target = byId.get(targetId);
    if (target?.kind === "input" && target.channel && !relevantIds.has(target.channel)) {
      relevantIds.add(target.channel);
      queue.push(target.channel);
    }
  }
  const cardState = [...relevantIds]
    .sort()
    .map((id) => {
      const card = byId.get(id);
      if (!card) return { id, missing: true };
      if (card.kind === "reference")
        return {
          id,
          kind: card.kind,
          refs: (card.refs || []).map((ref) => ({
            type: ref.type,
            file_path: ref.file_path,
            source_gen_id: ref.source_gen_id || null,
          })),
        };
      if (card.kind === "generation")
        return {
          id,
          kind: card.kind,
          selected_gen_id: card.genId || null,
          variants: variantIds(card),
        };
      if (card.kind === "comfy")
        return {
          id,
          kind: card.kind,
          content: card.comfyCfg?.content || "",
          paramValues: stableParamValues(card.comfyCfg?.paramValues || {}),
          executionId: card.comfyCfg?.runId || null,
        };
      if (card.kind === "text" || card.kind === "output")
        return { id, kind: card.kind, text: card.text || "" };
      if (card.kind === "input") return { id, kind: card.kind, channel: card.channel || null };
      return { id, kind: card.kind };
    });
  // order가 없으면 실행 입력 수집과 같은 y→x 순서를 비교한다. 좌표값 자체가 아니라 순서만 반영한다.
  const edgeState = [...relevantEdges]
    .map((edge, index) => ({ edge, index, source: byId.get(edge.from) }))
    .sort((a, b) => {
      if (a.edge.to !== b.edge.to) return a.edge.to.localeCompare(b.edge.to);
      const ao = a.edge.order;
      const bo = b.edge.order;
      if (ao != null && bo != null && ao !== bo) return ao - bo;
      if (ao != null) return -1;
      if (bo != null) return 1;
      const ay = a.source?.y || 0;
      const by = b.source?.y || 0;
      if (ay !== by) return ay - by;
      const ax = a.source?.x || 0;
      const bx = b.source?.x || 0;
      if (ax !== bx) return ax - bx;
      return a.index - b.index;
    })
    .map(({ edge }) => ({
      from: edge.from,
      to: edge.to,
      role: edge.role || null,
      order: edge.order ?? null,
    }));
  return JSON.stringify({
    edges: edgeState,
    cards: cardState,
    drivenParamValues: stableParamValues(drivenParamValues),
    textParamKeys,
  });
}

// comfy 노드에 '텍스트가 연결돼 있는지' — 내용 유무와 무관하게 연결 존재만 본다(ComfyUI 처럼 연결되면 위젯 비활성).
//  resolveEdgeRole 로 들어오는 엣지 중 텍스트 역할이 하나라도 있으면 true.
export function hasTextConnection(
  cardId: string,
  map: Map<string, SceneCard>,
  es: SceneEdge[],
  refParents: Record<string, string[]>,
): boolean {
  return es.some((e) => e.to === cardId && resolveEdgeRole(e, map, refParents, es) === "text");
}

// comfy 노드로 들어오는 레퍼런스/생성물/상류comfy/리스트를 이미지·영상 입력 슬롯 목록으로 수집(y→x 순).
export function gatherComfyMedia(
  comfyId: string,
  cards: SceneCard[],
  edges: SceneEdge[],
  genData: Record<string, Generation>,
  overlay?: ComfyOutputsById,
): ComfyMediaInput[] {
  const cardsById = new Map(cards.map((c) => [c.id, c] as const));
  const resolved = resolvePortEdges(cardsById, edges);
  const srcs = resolved
    .filter((e) => e.to === comfyId)
    .map((e) => cardsById.get(e.from))
    .filter((c): c is SceneCard => !!c)
    .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
  const out: ComfyMediaInput[] = [];
  const pushRef = (r: SceneRef) => {
    const mt = refMediaType(r);
    if (mt === "audio") return; // 오디오는 image/video 슬롯 대상이 아님 — 제외
    const url = refMediaSrc(r);
    if (!url) return;
    // 레퍼런스가 생성물에서 온 것이면 그 gid 를 계보용으로 전달(source_gen_id).
    out.push({ type: mt, url, name: mediaFileName(r.name || url, mt, out.length + 1), source_gen_id: r.source_gen_id });
  };
  const pushGen = (gc?: SceneCard) => {
    const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
    const a = gid ? genData[gid]?.assets?.[0] : undefined;
    const url = a?.source_url || a?.file_path;
    if (!url) return;
    const type = a?.type === "video" ? "video" : "image";
    out.push({ type, url, name: mediaFileName(url, type, out.length + 1), source_gen_id: gid });
  };
  for (const s of srcs) {
    if (s.kind === "reference") (s.refs || []).forEach(pushRef);
    else if (s.kind === "generation") pushGen(s);
    else if (s.kind === "comfy")
      // 상류 comfy 의 이미지/영상 출력물을 입력으로(comfy→comfy 체인). overlay 가 있으면 이 짝(복사본)의 결과를 읽는다.
      for (const m of comfyOutputMedia(s, overlay))
        out.push({ type: m.kind, url: m.url, name: mediaFileName(m.url, m.kind, out.length + 1) });
    else if (s.kind === "list") {
      const li = collectListInputs(s.id, cardsById, resolved, overlay);
      if (li.kind === "reference")
        for (const cid of li.referenceCardIds) (cardsById.get(cid)?.refs || []).forEach(pushRef);
      else if (li.kind === "generation")
        for (const cid of li.generationCardIds) {
          const gc = cardsById.get(cid);
          // list 안의 comfy 항목은 실행 출력(overlay/결과)을 직접 미디어로 — 라이브러리 저장 전에도 동작.
          if (gc?.kind === "comfy") {
            const media = comfyOutputMedia(gc, overlay);
            if (media.length) {
              for (const m of media)
                out.push({ type: m.kind, url: m.url, name: mediaFileName(m.url, m.kind, out.length + 1) });
              continue;
            }
          }
          pushGen(gc);
        }
    }
  }
  return out;
}

// 연결된 텍스트로 노출된 text 파라미터를 구동 — 텍스트가 연결돼 있으면(빈 값이어도) 모든 text 타입 파라미터를
//  연결 텍스트로 덮는다(연결이 위젯을 대체). 연결 없으면 원래 편집값 유지. 실행 시 라이브로 읽는다.
export function driveTextParams(
  cardId: string,
  baseParams: Record<string, string | number | boolean>,
  params: { key: string; type: string }[] | undefined,
  cards: SceneCard[],
  edges: SceneEdge[],
  refParents: Record<string, string[]>,
  overlay?: ComfyOutputsById,
): Record<string, string | number | boolean> {
  const map = new Map(cards.map((c) => [c.id, c] as const));
  if (!hasTextConnection(cardId, map, edges, refParents)) return baseParams;
  // 연결 텍스트는 '텍스트 입력 노드'의 필드에만 주입(model·resolution 등 설정값 제외). 표시/프롬프트와 동일 판정.
  const keys = comfyTextDriveKeys(params, map.get(cardId)?.comfyCfg?.content);
  if (!keys.size) return baseParams;
  const linked = incomingTextOf(cardId, map, edges, new Set(), overlay); // 빈 문자열 가능
  const out = { ...baseParams };
  for (const k of keys) out[k] = linked;
  return out;
}

// 실제 Comfy API에 영향을 주는 그래프 입력만 정규화한다. 카드 좌표 자체는 제외하되 좌표 변화로
// 미디어 입력 순서가 달라지면 gatherComfyMedia 결과 순서가 바뀌므로 변경으로 판정된다.
export function prepareSceneComfyInputs(
  cardId: string,
  baseParams: Record<string, string | number | boolean>,
  cards: SceneCard[],
  edges: SceneEdge[],
  genData: Record<string, Generation>,
  refParents: Record<string, string[]>,
  overlay?: ComfyOutputsById,
): PreparedSceneComfyInputs {
  const card = cards.find((candidate) => candidate.id === cardId);
  const drivenParamValues = driveTextParams(
    cardId,
    baseParams,
    card?.comfyCfg?.params,
    cards,
    edges,
    refParents,
    overlay,
  );
  const textParamKeys = [...comfyTextDriveKeys(card?.comfyCfg?.params, card?.comfyCfg?.content)];
  const copiedParamValues = { ...drivenParamValues };
  return {
    media: gatherComfyMedia(cardId, cards, edges, genData, overlay),
    drivenParamValues: copiedParamValues,
    textParamKeys,
    inputFingerprint: inputGraphFingerprint(
      cardId,
      cards,
      edges,
      copiedParamValues,
      textParamKeys,
    ),
  };
}
