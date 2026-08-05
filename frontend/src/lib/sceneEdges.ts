// SceneBoard 의 '순수 엣지 기하/그래프 계산'을 컴포넌트에서 추출(렌더마다 인라인으로 돌던 것).
//  · DOM/이벤트/상태를 건드리지 않는 순수 함수만 모은다 — 높이 측정(heightsRef) 의존인 heightOf/edgePath/edgeEnds 는 컴포넌트에 남긴다.
//  · 등가성 보존이 목적이라 원본의 반복/큐 순서·판정 로직을 그대로 옮긴다.
import {
  variantIds,
  type SceneCard,
  type SceneCardKind,
  type SceneEdge,
  type SceneEdgeRole,
  type SceneModelCfg,
  type SceneRef,
} from "./scenes";

type IncomingEdgeIndex = ReadonlyMap<string, readonly SceneEdge[]>;

// 같은 그래프를 여러 번 판정할 때 `edges.filter(e => e.to === id)` 전체 순회를 되풀이하지 않도록
// 타깃 카드별 들어오는 엣지를 한 번만 묶는다. 원본 순서를 유지해 order 동률의 기존 결과도 보존한다.
function buildIncomingEdgeIndex(edges: SceneEdge[]): Map<string, SceneEdge[]> {
  const incoming = new Map<string, SceneEdge[]>();
  for (const edge of edges) {
    const found = incoming.get(edge.to);
    if (found) found.push(edge);
    else incoming.set(edge.to, [edge]);
  }
  return incoming;
}

function incomingEdgesOf(
  targetId: string,
  edges: SceneEdge[],
  incomingByTarget?: IncomingEdgeIndex,
): readonly SceneEdge[] {
  return incomingByTarget ? incomingByTarget.get(targetId) ?? [] : edges.filter((e) => e.to === targetId);
}

// 연결 허용 규칙 — to 노드 종류별로 받을 수 있는 소스만. 말이 안 되는 연결(text→view 등)을 막는다.
//  · generation: 모델/텍스트/레퍼런스/생성/리스트 입력 허용(view 제외)
//  · list: 생성/텍스트만(동종 수집)  · view: 생성/리스트만(미디어)  · text/model/reference/view: 입력 없음
//  · output: 출력 포트가 있는 소스 하나에 붙음(view/output/input 제외)  · input: 입력 포트 없음
//  · 소스가 input 이면 그것이 가리키는 '실제 소스'의 종류로 검증한다(무선 연결). 컨텍스트(cardsById/edges) 필요.
export function canConnect(
  from: SceneCard,
  to: SceneCard,
  cardsById?: Map<string, SceneCard>,
  edges?: SceneEdge[],
): boolean {
  if (from.id === to.id) return false;
  if (from.kind === "head" || to.kind === "head") return false; // head 는 포트 없는 주석 노드
  if (from.kind === "output") return false; // output 은 출력 포트가 없다 — 소스가 될 수 없음
  if (from.kind === "render")
    // render 안 생성물을 View 재생 · 생성카드 레퍼런스 · 리스트로 다시 수집(중첩).
    return to.kind === "view" || to.kind === "generation" || to.kind === "list";
  // input 을 소스로 놓으면 실제 소스로 해석해 그 종류로 검증(input 자체는 어디에도 못 풂 → 컨텍스트 없으면 불가)
  if (from.kind === "input") {
    if (!cardsById || !edges) return false;
    const realId = resolveInputSourceId(from.id, cardsById, edges);
    const real = realId ? cardsById.get(realId) : undefined;
    if (!real) return false;
    return canConnect(real, to); // real 은 input 이 아니므로 컨텍스트 불필요
  }
  // 여기 오면 from 은 output/input 이 아니다(위에서 처리) — output 은 출력 포트 있는 소스만(view 제외).
  if (to.kind === "output") return from.kind !== "view";
  if (to.kind === "input") return false;
  switch (to.kind) {
    case "generation":
      return from.kind !== "view";
    case "list":
      // comfy 출력물(이미지·영상=generation 류, 텍스트=text 류)도 리스트 항목이 될 수 있다.
      // 다른 list 도 소스로 받아 중첩 수집(내부 생성물을 펼쳐 사용) — 순환은 collectListInputs 가 차단.
      //  (render→list 는 위 render 분기에서 이미 허용됨.)
      return (
        from.kind === "generation" || from.kind === "text" ||
        from.kind === "reference" || from.kind === "comfy" ||
        from.kind === "list"
      );
    case "view":
      return (
        from.kind === "generation" || from.kind === "list" || from.kind === "text" ||
        from.kind === "comfy" // comfy 출력물(이미지·영상)도 미리보기 가능
      );
    case "render":
      // 렌더(배치)는 생성 카드 + comfy 노드를 모은다 — 실행 시 comfy 먼저, 그 하류 생성 순차 실행.
      return from.kind === "generation" || from.kind === "comfy";
    case "text":
      // 텍스트 노드는 레퍼런스 입력을 받는다(레퍼런스 카드·생성물을 @레퍼런스로). 리스트로 묶은
      // 레퍼런스/생성물도 연결 허용 — 텍스트 노드가 리스트를 펼쳐 @image1/@image2… 로 매핑한다.
      // comfy(프롬프트 생성 등)의 출력도 텍스트로 전달 가능(Phase 2 체인).
      return (
        from.kind === "reference" || from.kind === "generation" || from.kind === "list" ||
        from.kind === "comfy"
      );
    case "comfy":
      // comfy 노드는 레퍼런스/생성물/텍스트/리스트/다른 comfy 를 입력으로 받는다(이미지 수정·후처리·프롬프트 체인).
      // list = 이미지·영상 묶음(순서대로 타입별 슬롯에 자동 주입).
      return (
        from.kind === "reference" || from.kind === "generation" || from.kind === "text" ||
        from.kind === "list" || from.kind === "comfy"
      );
    default:
      return false;
  }
}

// input 노드가 가리키는 '실제 소스 카드 id' 로 해석(무선 연결) — input→output→(output 에 물린 소스).
// 소스가 또 input 이면 계속 따라가되, 사이클/재방문은 unresolved(null)로 끊는다. input 이 아니면 그대로 반환.
function resolveInputSourceIdIndexed(
  cardId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  seen: Set<string>,
  incomingByTarget?: IncomingEdgeIndex,
): string | null {
  const card = cardsById.get(cardId);
  if (!card) return null;
  if (card.kind !== "input") return cardId; // 이미 실제 소스
  if (seen.has(cardId)) return null; // 사이클 차단
  seen.add(cardId);
  const outId = card.channel;
  if (!outId) return null; // 채널 미선택
  const out = cardsById.get(outId);
  if (!out || out.kind !== "output") return null; // 선택한 output 이 사라짐/무효
  // output 에 물린 소스(들) 중 대표 1개: order → y → x 순.
  const ins = incomingEdgesOf(outId, edges, incomingByTarget)
    .map((e) => ({ e, c: cardsById.get(e.from) }))
    .filter((x): x is { e: SceneEdge; c: SceneCard } => !!x.c);
  if (!ins.length) return null; // output 에 아직 소스가 안 붙음
  const primary = sortByOrder(ins)[0].c.id;
  return resolveInputSourceIdIndexed(primary, cardsById, edges, seen, incomingByTarget);
}

export function resolveInputSourceId(
  cardId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  seen: Set<string> = new Set(),
): string | null {
  return resolveInputSourceIdIndexed(cardId, cardsById, edges, seen);
}

// 수집기(collect*)에 넘길 '해석된 엣지' — from 이 input 이면 실제 소스 id 로 치환, 못 풀면 그 엣지는 뺀다.
// (from,to) 중복은 제거해 같은 소스가 두 번 잡히는 것(모델 2개로 오판 등)을 막는다. order/role 등은 보존.
export function resolvePortEdges(
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): SceneEdge[] {
  const out: SceneEdge[] = [];
  const seenPair = new Set<string>();
  for (const e of edges) {
    const from = cardsById.get(e.from);
    let realFrom = e.from;
    if (from?.kind === "input") {
      const r = resolveInputSourceId(e.from, cardsById, edges);
      if (!r) continue; // 못 푼 input 엣지는 수집에서 제외
      realFrom = r;
    }
    const key = realFrom + ">" + e.to;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    out.push(realFrom === e.from ? e : { ...e, from: realFrom });
  }
  return out;
}

// list 노드로 들어온 입력을 수집·판정(순수). list 는 '동종 수집기' — 생성카드만 들어오면 generation,
// text 만 들어오면 그 텍스트를 order/y 순으로 합친다. 섞이거나 model/ref 가 섞이면 사용 불가로 표시.
export interface ListInputs {
  kind: "empty" | "generation" | "text" | "reference" | "mixed" | "invalid";
  sourceIds: string[]; // 정렬된 입력 소스 카드 id (reference 수집이면 레퍼런스 카드 id 들)
  generationCardIds: string[]; // generation 수집일 때 그 카드들
  text: string; // text 수집일 때 합친 텍스트
}

// 입력 소스 정렬: edge.order 우선 → 소스 y → 소스 x → 기존 순서.
function sortByOrder(items: { e: SceneEdge; c: SceneCard }[]): { e: SceneEdge; c: SceneCard }[] {
  return items
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => {
      const oa = a.e.order;
      const ob = b.e.order;
      if (oa != null && ob != null && oa !== ob) return oa - ob;
      if (oa != null && ob == null) return -1;
      if (oa == null && ob != null) return 1;
      if (a.c.y !== b.c.y) return a.c.y - b.c.y;
      if (a.c.x !== b.c.x) return a.c.x - b.c.x;
      return a.i - b.i;
    });
}

// 생성카드로 들어오는 ref 레인 입력 엣지를 'card.refs 순서'로 정렬하기 위한 순서 인덱스(edgeId → index).
//  · card.refs 는 @image 번호·프롬프트·생성 순서의 단일 권위다. 연결선 fan-in 도 이걸 따라야 프롬프트에서
//    순서를 바꾸면 캔버스 연결선 순서도 같이 바뀐다(직접 연결·리스트 경유 모두). 표시만 맞추고 데이터는 안 건드림.
//  · 매핑: 레퍼런스 소스 → 그 카드가 제공한 ref 의 card.refs 내 최소 인덱스,
//          레퍼런스 리스트 소스 → 리스트 멤버들이 제공한 ref 의 최소 인덱스,
//          생성물(gen-as-ref) 소스 → source_gen_id 가 일치하는 ref 의 최소 인덱스.
//  · 못 매핑하면(comfy 등) 해당 엣지는 맵에 안 넣는다 → 호출부가 Infinity 로 취급해 뒤로, 동률은 소스 y 로 tie-break.
export function refLaneOrderIndex(
  targetGenId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): Map<string, number> {
  const out = new Map<string, number>();
  const target = cardsById.get(targetGenId);
  const refs = target?.refs || [];
  if (!refs.length) return out;
  const keyOf = (r: { file_path?: string; source_gen_id?: string | null }) =>
    (r.file_path || "") + "#" + (r.source_gen_id || "");
  // card.refs 각 항목의 '최초 등장 인덱스'를 key / source_gen_id 로 조회 가능하게 미리 만든다.
  const idxByKey = new Map<string, number>();
  const idxBySrcGen = new Map<string, number>();
  refs.forEach((r, i) => {
    const k = keyOf(r);
    if (!idxByKey.has(k)) idxByKey.set(k, i);
    if (r.source_gen_id && !idxBySrcGen.has(r.source_gen_id)) idxBySrcGen.set(r.source_gen_id, i);
  });
  const minKeyIdx = (rs: SceneRef[] | undefined): number => {
    let min = Infinity;
    for (const r of rs || []) {
      const i = idxByKey.get(keyOf(r));
      if (i != null && i < min) min = i;
    }
    return min;
  };
  for (const e of edges) {
    if (e.to !== targetGenId) continue;
    const src = cardsById.get(e.from);
    if (!src) continue;
    let idx = Infinity;
    if (src.kind === "reference") idx = minKeyIdx(src.refs);
    else if (src.kind === "list") {
      const li = collectListInputs(src.id, cardsById, edges);
      if (li.kind === "reference")
        for (const cid of li.sourceIds) idx = Math.min(idx, minKeyIdx(cardsById.get(cid)?.refs));
    } else if (src.kind === "generation") {
      for (const gid of variantIds(src)) {
        const i = idxBySrcGen.get(gid);
        if (i != null) idx = Math.min(idx, i);
      }
    }
    if (Number.isFinite(idx)) out.set(e.id, idx);
  }
  return out;
}

// comfy 실행 1회의 출력셋(카드 저장분과 같은 모양). 배치 병렬 실행에선 각 실행 결과를 카드에 안 쓰고
// 이 배열로 들고 다니며(overlay), 인덱스별로 짝지어 생성에 주입한다.
export type ComfyOutput = { kind: "image" | "video" | "text"; url?: string; text?: string };
// { comfyCardId: 그 실행의 출력셋 } — 배치 복사본 하나(=한 짝)의 comfy 결과 오버레이.
export type ComfyOutputsById = Record<string, ComfyOutput[]>;
// 배치 병렬·짝 실행의 1묶음 — 카드 1개를 그 comfy 실행 결과(overlay)와 짝지어 1장 생성한다.
//  batchIndex = 몇 번째 복사본인지(0..N-1). SceneBoard 오케스트레이터가 만들어 App.generateCardRuns 로 넘긴다.
export type SceneGenerationRun = { batchIndex: number; cardId: string; comfyOutputsById: ComfyOutputsById };

// 출력셋 → 텍스트/미디어 추출(순수). 카드/오버레이 어느 쪽 출력이든 같은 규칙으로 뽑는다.
export function comfyOutputTextsFrom(outputs: ComfyOutput[]): string[] {
  return outputs.filter((o) => o.kind === "text" && (o.text || "").trim()).map((o) => o.text as string);
}
export function comfyOutputMediaFrom(outputs: ComfyOutput[]): { url: string; kind: "image" | "video" }[] {
  return outputs
    .filter((o) => (o.kind === "image" || o.kind === "video") && o.url)
    .map((o) => ({ url: o.url as string, kind: o.kind as "image" | "video" }));
}

// 이 comfy 카드의 '읽을 출력셋' 결정.
//  · overlay 가 주어지면(배치·짝 실행) overlay[cardId] 만 쓴다 — 없으면 빈 배열(★카드 슬롯 fallback 금지:
//    실패/누락한 복사본이 예전 카드 출력으로 잘못 생성되는 stale 버그를 막는다).
//  · overlay 가 없으면(표시·비배치 경로) 카드 저장분(comfyCfg.outputs)을 쓴다.
function outputsOf(card: SceneCard, overlay?: ComfyOutputsById): ComfyOutput[] {
  if (overlay) return overlay[card.id] || [];
  return card.comfyCfg?.outputs || [];
}

// comfy 노드의 텍스트 출력(kind==="text") — 다른 노드에 텍스트로 전달하는 원천. overlay 우선.
export function comfyOutputTexts(card: SceneCard, overlay?: ComfyOutputsById): string[] {
  return comfyOutputTextsFrom(outputsOf(card, overlay));
}

// comfy 노드의 미디어 출력(image/video) — 다른 노드에 미디어로 전달하는 원천. overlay 우선.
export function comfyOutputMedia(
  card: SceneCard,
  overlay?: ComfyOutputsById,
): { url: string; kind: "image" | "video" }[] {
  return comfyOutputMediaFrom(outputsOf(card, overlay));
}

// 워크플로우가 '선언한' 출력 종류 — 저장(Save/Show) 노드의 class_type 으로 판정한다.
//  · 실행 전에도, 그리고 이전 워크플로우의 stale 런타임 출력에 속지 않고 정확히 판단하기 위함.
//  · SaveImage/SaveVideo/VideoCombine/SaveAnimated… → media, SaveText/ShowText → text.
//  · 파싱 불가/없으면 { media:false, text:false } (호출부가 런타임 출력으로 폴백).
// 워크플로 content(JSON 문자열)에서 여러 호출부가 함께 쓰는 사실을 한 번에 계산한다. class 맵만
// 캐시하던 이전 구현은 comfyGenMeta 가 같은 원문을 다시 JSON.parse 했고, 출력 종류도 렌더마다
// Object.values 를 순회했다. LRU 32개로 원문·파싱 객체의 메모리 상한도 둔다.
interface WorkflowFacts {
  workflow: Record<string, unknown> | null;
  classByNode: Record<string, string>;
  declaredKinds: { media: boolean; text: boolean };
}

const EMPTY_WORKFLOW_FACTS: WorkflowFacts = {
  workflow: null,
  classByNode: {},
  declaredKinds: { media: false, text: false },
};
const WORKFLOW_CACHE_LIMIT = 32;
const _workflowFactsCache = new Map<string, WorkflowFacts>();
const MEDIA_OUTPUT_NODE_RE = /saveimage|savevideo|videocombine|saveanimated|savewebm|savegif/i;
const TEXT_OUTPUT_NODE_RE = /savetext|showtext/i;

function workflowFactsOf(content: string | undefined): WorkflowFacts {
  if (!content) return EMPTY_WORKFLOW_FACTS;
  const cached = _workflowFactsCache.get(content);
  if (cached) {
    // 최근 사용 항목을 뒤로 보내 오래 안 쓴 워크플로부터 제거한다.
    _workflowFactsCache.delete(content);
    _workflowFactsCache.set(content, cached);
    return cached;
  }

  let workflow: Record<string, unknown> | null = null;
  const classByNode: Record<string, string> = {};
  let media = false;
  let text = false;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object") {
      workflow = parsed as Record<string, unknown>;
      for (const [nodeId, node] of Object.entries(workflow)) {
        const classType = (node as { class_type?: unknown } | null)?.class_type;
        if (typeof classType !== "string") continue;
        classByNode[nodeId] = classType;
        if (MEDIA_OUTPUT_NODE_RE.test(classType)) media = true;
        if (TEXT_OUTPUT_NODE_RE.test(classType)) text = true;
      }
    }
  } catch {
    /* malformed content → 빈 사실(필드명/런타임 출력 폴백은 호출부가 처리) */
  }
  const facts = { workflow, classByNode, declaredKinds: { media, text } };
  if (_workflowFactsCache.size >= WORKFLOW_CACHE_LIMIT) {
    const oldest = _workflowFactsCache.keys().next().value as string | undefined;
    if (oldest !== undefined) _workflowFactsCache.delete(oldest);
  }
  _workflowFactsCache.set(content, facts);
  return facts;
}

function classByNodeOf(content: string | undefined): Record<string, string> {
  return workflowFactsOf(content).classByNode;
}

export function comfyDeclaredKinds(content: string | undefined): { media: boolean; text: boolean } {
  return workflowFactsOf(content).declaredKinds;
}

// 연결된 텍스트를 주입할 파라미터 key 집합 — '텍스트 입력 노드'(Text Multiline·CLIPTextEncode 등)의
// 텍스트 필드만 대상. model·resolution·filename_prefix 처럼 문자열이어도 설정값인 파라미터는 제외한다
// (사용자가 직접 조절). 노드 class_type 로 판정하고, content 가 없거나 깨졌으면 필드명으로 폴백한다.
const TEXT_INPUT_NODE_RE = /text|string|prompt|multiline/i;
const TEXT_INPUT_FIELD_RE = /^(text|prompt|positive|negative|string)/i;
type ComfyParam = { key: string; type: string };
const EMPTY_COMFY_PARAMS: ComfyParam[] = [];
const _textDriveKeysCache = new WeakMap<
  readonly ComfyParam[],
  Map<string | undefined, ReadonlySet<string>>
>();
export function comfyTextDriveKeys(
  params: ComfyParam[] | undefined,
  content: string | undefined,
): ReadonlySet<string> {
  // params 배열은 SceneCard 갱신 시 불변 교체된다. 배열 정체성+content 로 캐시해 선택·마퀴 렌더에서
  // 같은 필드 선별을 반복하지 않는다. 반환 Set 은 읽기 전용으로 취급한다.
  const paramList = params || EMPTY_COMFY_PARAMS;
  let byContent = _textDriveKeysCache.get(paramList);
  if (!byContent) {
    byContent = new Map();
    _textDriveKeysCache.set(paramList, byContent);
  }
  const cached = byContent.get(content);
  if (cached) return cached;

  const classByNode = classByNodeOf(content); // content 기준 캐시 재사용(반복 JSON.parse 제거)
  const out = new Set<string>();
  for (const p of paramList) {
    if (p.type !== "text") continue;
    const [nid, field = ""] = p.key.split("|");
    const cls = classByNode[nid];
    // 필드명이 텍스트 계열(text/prompt/positive/negative/string)인 것만 대상. class 를 알면 그 노드가
    // 텍스트 입력 노드인지도 함께 확인한다 — 'SaveText' 처럼 class 는 매칭돼도 filename_prefix 같은 설정
    // 문자열엔 연결 텍스트가 새어들지 않게(필드 검사를 항상 적용). class 를 모르면 필드명만으로 판정(폴백).
    const fieldOk = TEXT_INPUT_FIELD_RE.test(field);
    if (cls ? TEXT_INPUT_NODE_RE.test(cls) && fieldOk : fieldOk) out.add(p.key);
  }
  byContent.set(content, out);
  return out;
}

// Comfy 출력을 생성물로 저장할 때 '생성 정보'에 담을 표준 메타(model·비율·해상도·영상길이)를 뽑는다.
// 워크플로 원문의 노드 입력에서 baked 값을 먼저 읽고, 사용자가 노출·조절한 값(paramValues)으로 덮어쓴다
// (실제 사용값 우선). 여러 노드에 같은 필드가 있으면 마지막 값이 남는다(일반 이미지 워크플로는 1개).
// ★표준 메타 키 → 워크플로 입력 필드명(들). Seedance 등은 평탄 점표기(model.ratio·model.resolution·model.duration)를
//   쓰므로 alias 로 매핑해 잡는다. duration 은 영상 길이(초) → params.duration 으로 저장돼 힉스필드처럼 생성정보에 표시.
const COMFY_META_FIELDS: Record<string, readonly string[]> = {
  model: ["model"],
  aspect_ratio: ["aspect_ratio", "ratio", "model.ratio"],
  resolution: ["resolution", "model.resolution"],
  duration: ["duration", "model.duration"],
};
// 입력 필드명 → 표준 메타 키(노출·조절값 paramValues 매칭용). 없으면 null.
function comfyMetaKeyForField(field: string): string | null {
  for (const [metaKey, aliases] of Object.entries(COMFY_META_FIELDS))
    if (aliases.includes(field)) return metaKey;
  return null;
}
export function comfyGenMeta(
  content: string | undefined,
  params: { key: string; type: string }[] | undefined,
  paramValues: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const workflow = workflowFactsOf(content).workflow;
  if (workflow)
    for (const node of Object.values(workflow)) {
      const inputs = (node as { inputs?: unknown } | null)?.inputs;
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) continue;
      for (const [metaKey, aliases] of Object.entries(COMFY_META_FIELDS))
        for (const alias of aliases) {
          const value = (inputs as Record<string, unknown>)[alias];
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            out[metaKey] = value;
            break; // 이 메타 키는 첫 매칭 alias 로 확정
          }
        }
    }
  for (const p of params || []) {
    const field = p.key.split("|")[1] || "";
    const metaKey = comfyMetaKeyForField(field);
    const v = paramValues?.[p.key];
    if (metaKey && v != null) out[metaKey] = v;
  }
  return out;
}

// 한 카드가 '제공하는 텍스트'. 텍스트 노드(연결된 텍스트 입력 + 자기 텍스트), comfy 텍스트 출력,
// 텍스트 리스트를 재귀적으로 합친다(seen 으로 사이클 차단). 그 외 종류는 빈 문자열.
// comfy 의 '입력 프롬프트'(구동 텍스트) — 텍스트 출력이 없어도 리스트/텍스트로 넘길 원천.
//  연결된 상류 텍스트(incomingTextOf) 우선, 없으면 노출된 text 파라미터 값. saveComfyToLibrary 의 promptText 규칙과 일관.
export function comfyInputPromptTextOf(
  cardId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  seen: Set<string> = new Set(),
  overlay?: ComfyOutputsById,
): string {
  const card = cardsById.get(cardId);
  if (!card || card.kind !== "comfy") return "";
  const linked = incomingTextOf(cardId, cardsById, edges, seen, overlay);
  if (linked.trim()) return linked;
  const cfg = card.comfyCfg;
  const keys = [...comfyTextDriveKeys(cfg?.params, cfg?.content)];
  return keys
    .map((k) => String(cfg?.paramValues?.[k] ?? ""))
    .filter((t) => t.trim())
    .join("\n");
}

export function effectiveTextOf(
  cardId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  seen: Set<string> = new Set(),
  overlay?: ComfyOutputsById,
): string {
  const card = cardsById.get(cardId);
  if (!card || seen.has(cardId)) return "";
  seen.add(cardId);
  if (card.kind === "comfy") {
    // 텍스트 출력이 있으면 그것, 없으면 입력 프롬프트(영상 생성 comfy 처럼 텍스트 출력 노드가 없는 경우).
    const outputText = comfyOutputTexts(card, overlay).join("\n");
    return outputText.trim()
      ? outputText
      : comfyInputPromptTextOf(cardId, cardsById, edges, seen, overlay);
  }
  if (card.kind === "list") {
    const li = collectListInputs(cardId, cardsById, edges, overlay, seen);
    return li.kind === "text" ? li.text : "";
  }
  if (card.kind === "text") {
    // 사용자가 채택/편집한 자기 텍스트가 있으면 그것을 쓴다(내가 적은 것 우선).
    if ((card.text || "").trim()) return card.text as string;
    // 아직 자기 텍스트가 없으면 연결된 텍스트 소스(comfy 등)를 그대로 라이브로 사용한다.
    return incomingTextOf(cardId, cardsById, edges, seen, overlay);
  }
  return "";
}

// 텍스트 노드로 '들어오는' 텍스트(자기 텍스트 제외) — 연결된 텍스트 제공 소스들을 순서대로 합친다.
export function incomingTextOf(
  cardId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  seen: Set<string> = new Set(),
  overlay?: ComfyOutputsById,
): string {
  const incoming = edges
    .filter((e) => e.to === cardId)
    .map((e) => ({ e, c: cardsById.get(e.from) }))
    .filter((x): x is { e: SceneEdge; c: SceneCard } => !!x.c);
  return sortByOrder(incoming)
    .map((s) => effectiveTextOf(s.c.id, cardsById, edges, seen, overlay))
    .filter((t) => t.trim())
    .join("\n");
}

// comfy 노드가 리스트에서 어떤 종류로 취급될지 — 미디어(이미지·영상) 출력이면 generation 류,
//  텍스트 전용 출력이면 text 류. 아직 워크플로도 출력도 없어 판정 불가면 null(연결은 되나 내용은 invalid).
//  판정 근거: 저장된 생성물(variantIds) / 워크플로 출력선언(comfyDeclaredKinds) / 실행 결과(comfyOutputMedia·Texts).
type ListComfySourceKind = "generation" | "text";
function comfyListSourceKind(
  card: SceneCard,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  overlay?: ComfyOutputsById,
  seen: Set<string> = new Set(),
): ListComfySourceKind | null {
  if (card.kind !== "comfy") return null;
  const declared = comfyDeclaredKinds(card.comfyCfg?.content);
  // ★미디어 우선 — 이미지/영상 생성 comfy 는 프롬프트가 있어도 generation(미디어 리스트 회귀 방지).
  if (variantIds(card).length > 0 || declared.media || comfyOutputMedia(card, overlay).length > 0)
    return "generation";
  // 미디어가 아니면 텍스트 — 출력 텍스트 또는 입력 프롬프트(텍스트 출력 노드 없는 comfy 도 프롬프트로 인식).
  if (
    declared.text ||
    comfyOutputTexts(card, overlay).length > 0 ||
    comfyInputPromptTextOf(card.id, cardsById, edges, new Set(seen), overlay).trim()
  )
    return "text";
  return null;
}

function collectListInputsIndexed(
  listId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  overlay?: ComfyOutputsById,
  seen: Set<string> = new Set(), // 텍스트 상류 추적 시 순환 차단(effectiveTextOf 체인과 공유)
  incomingByTarget?: IncomingEdgeIndex,
): ListInputs {
  const sources = incomingEdgesOf(listId, edges, incomingByTarget)
    .map((e) => ({ e, c: cardsById.get(e.from) }))
    .filter((x): x is { e: SceneEdge; c: SceneCard } => !!x.c);
  if (!sources.length) return { kind: "empty", sourceIds: [], generationCardIds: [], text: "" };
  const sorted = sortByOrder(sources);
  const sourceIds = sorted.map((s) => s.c.id); // 직접 소스(행표시·reorder용) — 중첩이어도 그대로.

  // 중첩 수집 순환 차단 — 하위 list 로 내려갈 때 이 listId 를 경로에 넣는다(자기참조·A→B→A 방지).
  //  effectiveTextOf(list) 가 이미 listId 를 seen 에 넣고 올 수 있어, 여기선 하위로 내려갈 때만 검사한다.
  const pathSeen = new Set(seen);
  pathSeen.add(listId);

  // comfy 는 출력 종류에 따라 generation·text 로 분류(카드당 1회 판정 캐시).
  const comfyKinds = new Map<string, ListComfySourceKind | null>();
  const listComfyKindOf = (c: SceneCard) => {
    if (c.kind !== "comfy") return null;
    if (!comfyKinds.has(c.id))
      comfyKinds.set(c.id, comfyListSourceKind(c, cardsById, edges, overlay, new Set(pathSeen)));
    return comfyKinds.get(c.id) ?? null;
  };
  // 중첩 list 는 1회만 재귀 판정(캐시). 순환이면 null.
  const nestedLists = new Map<string, ListInputs | null>();
  const nestedListInputsOf = (c: SceneCard): ListInputs | null => {
    if (c.kind !== "list") return null;
    if (pathSeen.has(c.id)) return null; // list 사이클/자기참조
    if (!nestedLists.has(c.id))
      nestedLists.set(
        c.id,
        collectListInputsIndexed(c.id, cardsById, edges, overlay, new Set(pathSeen), incomingByTarget),
      );
    return nestedLists.get(c.id) ?? null;
  };

  type SourceKind = "generation" | "text" | "reference" | "other";
  const sourceKindOf = (c: SceneCard): SourceKind => {
    if (c.kind === "generation" || c.kind === "render") return "generation";
    if (c.kind === "text") return "text";
    if (c.kind === "reference") return "reference";
    const comfyKind = listComfyKindOf(c);
    if (comfyKind) return comfyKind;
    if (c.kind === "list") {
      const li = nestedListInputsOf(c);
      // 중첩 reference 는 이번엔 미지원(sourceIds 기반 reference 소비처와 충돌) → other 로 둬 invalid 처리.
      if (li?.kind === "generation" || li?.kind === "text") return li.kind;
      return "other";
    }
    return "other";
  };
  const classified = sorted.map((s) => ({ ...s, sourceKind: sourceKindOf(s.c) }));

  // generation kind: 중첩 list/render 를 그 안 생성물 id 로 펼친다(순서보존·중복제거).
  const generationIdsFrom = (c: SceneCard): string[] => {
    if (c.kind === "generation") return [c.id];
    if (listComfyKindOf(c) === "generation") return [c.id]; // comfy 는 id 로(소비처가 특수처리)
    if (c.kind === "render") return collectRenderGenCardIds(c.id, cardsById, edges);
    if (c.kind === "list") {
      const li = nestedListInputsOf(c);
      return li?.kind === "generation" ? li.generationCardIds : [];
    }
    return [];
  };

  if (classified.every((s) => s.sourceKind === "generation")) {
    const generationCardIds: string[] = [];
    const seenGen = new Set<string>();
    for (const s of classified)
      for (const id of generationIdsFrom(s.c))
        if (!seenGen.has(id)) {
          seenGen.add(id);
          generationCardIds.push(id);
        }
    return { kind: "generation", sourceIds, generationCardIds, text: "" };
  }
  if (classified.every((s) => s.sourceKind === "text"))
    return {
      kind: "text",
      sourceIds,
      generationCardIds: [],
      // 텍스트 소스는 상류(comfy 등)까지 따라 읽는다. 중첩 list 는 그 리스트의 합친 텍스트를 쓴다.
      text: classified
        .map((s) =>
          s.c.kind === "list"
            ? nestedListInputsOf(s.c)?.text ?? ""
            : effectiveTextOf(s.c.id, cardsById, edges, new Set(pathSeen), overlay),
        )
        .join("\n"),
    };
  if (classified.every((s) => s.sourceKind === "reference"))
    return { kind: "reference", sourceIds, generationCardIds: [], text: "" };
  // 그 외: gen+text 혼합이면 mixed, reference·미판정 comfy·중첩미지원 등이 섞이면 invalid(리스트는 동종만).
  const hasNonGenText = classified.some(
    (s) => s.sourceKind !== "generation" && s.sourceKind !== "text",
  );
  return { kind: hasNonGenText ? "invalid" : "mixed", sourceIds, generationCardIds: [], text: "" };
}

export function collectListInputs(
  listId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  overlay?: ComfyOutputsById,
  seen: Set<string> = new Set(),
): ListInputs {
  return collectListInputsIndexed(listId, cardsById, edges, overlay, seen);
}

// View 노드가 표시할 생성 카드 id 목록(순서 보존, 중복 제거). generation 직접 연결 + generation-list 를
// 통해 들어온 것까지 펼친다. text/model/ref 나 text-list 는 무시(View 는 미디어 전용).
export function collectViewGenCardIds(
  viewId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): string[] {
  const srcs = edges
    .filter((e) => e.to === viewId)
    .map((e) => cardsById.get(e.from))
    .filter((c): c is SceneCard => !!c)
    .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
  const out: string[] = [];
  const push = (id: string) => {
    if (!out.includes(id)) out.push(id);
  };
  for (const c of srcs) {
    // comfy 직접 연결은 여기서 넣지 않는다 — 소비처(buildViewClips)가 comfyOutputMedia 로 따로 담아 중복 방지.
    //  단 list 경유 comfy 는 아래 generationCardIds 로 들어온다(그건 comfySrcs 가 안 잡으므로 중복 아님).
    if (c.kind === "generation") push(c.id);
    else if (c.kind === "list") {
      const li = collectListInputs(c.id, cardsById, edges);
      if (li.kind === "generation") li.generationCardIds.forEach(push);
    } else if (c.kind === "render") {
      // 렌더 노드도 리스트처럼 그 안의 생성 카드들을 펼쳐 넘긴다.
      collectRenderGenCardIds(c.id, cardsById, edges).forEach(push);
    }
  }
  return out;
}

// 렌더(배치) 노드에 연결된 생성 카드 id들(edge.order→y→x 순, 중복 제거). 생성 카드만 — 리스트/텍스트 등은 무시.
// 소스가 input(무선)이면 호출부에서 resolvePortEdges 로 실제 소스로 해석된 엣지를 넘겨준다.
// order 우선이라 렌더 노드 안에서 드래그로 순서 변경(reorderList)한 결과가 표시에 반영된다.
export function collectRenderGenCardIds(
  renderId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): string[] {
  const items = edges
    .filter((e) => e.to === renderId)
    .map((e) => ({ e, c: cardsById.get(e.from) }))
    // 생성 카드 + Comfy 노드(출력을 생성물로 저장해 genIds 를 가진 것) — 둘 다 렌더에 '생성물'로 쌓인다.
    .filter(
      (x): x is { e: SceneEdge; c: SceneCard } =>
        x.c?.kind === "generation" ||
        (x.c?.kind === "comfy" && !!(x.c.genIds?.length || x.c.genId)),
    );
  const out: string[] = [];
  for (const s of sortByOrder(items)) if (!out.includes(s.c.id)) out.push(s.c.id);
  return out;
}

// ── 실행 오케스트레이션 계획(순수) ──────────────────────────────────────────
// 생성/렌더를 실행할 때, 상류 comfy 노드를 먼저 실행해야 한다(연결 순서). 실행 대상(comfy + 생성)을
// 모으고 의존관계로 위상정렬한 계획을 만든다. comfy 가 먼저, 같은 단계면 y→x(위→아래·왼→오).

export type SceneExecKind = "comfy" | "generation";
export interface SceneExecStep {
  id: string;
  kind: SceneExecKind;
  dependsOn: string[]; // 이 노드가 의존하는 상류 comfy id들(직접 의존)
}
export interface SceneExecutionPlan {
  steps: SceneExecStep[]; // 위상정렬된 실행 순서
  comfyIds: string[]; // 실행할 comfy id(순서)
  generationIds: string[]; // 생성할 생성카드 id(순서)
  skippedByCycle: string[]; // 사이클로 실행 불가한 노드
}

// 실행 계획의 의미만 비교한다. 카드 위치에 따른 동순위 실행 순서가 바뀌어도 같은 계획으로 보고,
// 실제 대상·종류·Comfy 의존관계·사이클 제외 대상이 달라졌을 때만 이전 실행을 폐기한다.
export function sameSceneExecutionPlan(
  left: SceneExecutionPlan,
  right: SceneExecutionPlan,
): boolean {
  const sorted = (items: readonly string[]) => [...items].sort();
  const stepSignatures = (plan: SceneExecutionPlan) =>
    plan.steps
      .map((step) => `${step.id}\u0000${step.kind}\u0000${sorted(step.dependsOn).join("\u0001")}`)
      .sort();
  const sameStrings = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((item, index) => item === b[index]);

  return (
    sameStrings(sorted(left.comfyIds), sorted(right.comfyIds)) &&
    sameStrings(sorted(left.generationIds), sorted(right.generationIds)) &&
    sameStrings(sorted(left.skippedByCycle), sorted(right.skippedByCycle)) &&
    sameStrings(stepSignatures(left), stepSignatures(right))
  );
}

// comfy 의존 추적 시 '통과' 노드 — 이들을 지나 상류 comfy 를 찾는다(text/list 로 comfy 출력이 전달됨).
const _PASSTHROUGH: SceneCardKind[] = ["text", "list"];

// nodeId 의 '가장 가까운 상류 comfy' 집합 — 통과 노드는 지나 재귀, comfy 를 만나면 멈춘다.
// (레퍼런스·모델·생성 등은 comfy 실행 의존이 아니므로 통과하지 않는다 — comfy 입력은 실행 시점에 gather.)
function nearestUpstreamComfy(
  nodeId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  seen: Set<string> = new Set(),
): Set<string> {
  const result = new Set<string>();
  for (const e of edges.filter((x) => x.to === nodeId)) {
    const src = cardsById.get(e.from);
    if (!src) continue;
    if (src.kind === "comfy") result.add(src.id);
    else if (_PASSTHROUGH.includes(src.kind) && !seen.has(src.id)) {
      seen.add(src.id);
      for (const c of nearestUpstreamComfy(src.id, cardsById, edges, seen)) result.add(c);
    }
  }
  return result;
}

export function buildExecutionPlan(
  targetGenIds: string[],
  directComfyIds: string[],
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): SceneExecutionPlan {
  const kindOf = new Map<string, SceneExecKind>();
  for (const id of targetGenIds) if (cardsById.get(id)?.kind === "generation") kindOf.set(id, "generation");
  for (const id of directComfyIds) if (cardsById.get(id)?.kind === "comfy") kindOf.set(id, "comfy");

  // 상류 comfy 를 transitively 모으고 각 노드의 직접 의존을 기록.
  const deps = new Map<string, Set<string>>();
  const stack = [...kindOf.keys()];
  const visited = new Set<string>();
  while (stack.length) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const upc = nearestUpstreamComfy(id, cardsById, edges);
    deps.set(id, upc);
    for (const c of upc) {
      if (!kindOf.has(c)) kindOf.set(c, "comfy");
      if (!visited.has(c)) stack.push(c);
    }
  }

  // Kahn 위상정렬 — comfy 먼저, 같은 단계면 y→x.
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of kindOf.keys()) {
    indeg.set(id, 0);
    dependents.set(id, []);
  }
  for (const [id, ds] of deps)
    for (const d of ds)
      if (kindOf.has(d)) {
        indeg.set(id, (indeg.get(id) || 0) + 1);
        dependents.get(d)?.push(id);
      }
  // 생성카드끼리 tie 는 호출부가 준 순서(렌더 행의 edge.order 반영)를 우선 보존, 그 다음 y→x.
  const genOrder = new Map(targetGenIds.map((id, i) => [id, i] as const));
  const cmp = (a: string, b: string): number => {
    const ka = kindOf.get(a);
    const kb = kindOf.get(b);
    if (ka !== kb) return ka === "comfy" ? -1 : 1; // comfy 먼저
    if (ka === "generation") {
      const oa = genOrder.get(a);
      const ob = genOrder.get(b);
      if (oa != null && ob != null && oa !== ob) return oa - ob;
    }
    const ca = cardsById.get(a);
    const cb = cardsById.get(b);
    if (!ca || !cb) return 0;
    return ca.y !== cb.y ? ca.y - cb.y : ca.x - cb.x;
  };
  const ready = [...kindOf.keys()].filter((id) => (indeg.get(id) || 0) === 0).sort(cmp);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift() as string;
    order.push(id);
    for (const dep of dependents.get(id) || []) {
      indeg.set(dep, (indeg.get(dep) || 0) - 1);
      if ((indeg.get(dep) || 0) === 0) ready.push(dep);
    }
    ready.sort(cmp);
  }
  const inOrder = new Set(order);
  const skippedByCycle = [...kindOf.keys()].filter((id) => !inOrder.has(id));
  const steps: SceneExecStep[] = order.map((id) => ({
    id,
    kind: kindOf.get(id) as SceneExecKind,
    dependsOn: [...(deps.get(id) || [])].filter((d) => kindOf.has(d)),
  }));
  return {
    steps,
    comfyIds: order.filter((id) => kindOf.get(id) === "comfy"),
    generationIds: order.filter((id) => kindOf.get(id) === "generation"),
    skippedByCycle,
  };
}

// 단일 생성카드 실행 계획 — 그 카드 + 상류 comfy.
export function buildGenerationExecutionPlan(
  genId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): SceneExecutionPlan {
  return buildExecutionPlan(
    [genId],
    [],
    cardsById,
    resolvePortEdges(cardsById, edges),
  );
}

// 렌더 노드 실행 계획 — 현재 체크된 생성카드 + 직접 연결된 comfy + 그 상류 comfy 전부.
// 고수준 경계에서 무선 Input/Output 해석과 unchecked 적용까지 책임져 호출부마다 규칙이 갈리지 않게 한다.
export function buildRenderExecutionPlan(
  renderId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): SceneExecutionPlan {
  const render = cardsById.get(renderId);
  if (render?.kind !== "render") return buildExecutionPlan([], [], cardsById, []);
  const resolved = resolvePortEdges(cardsById, edges);
  const unchecked = new Set(render.unchecked || []);
  const genIds = collectRenderGenCardIds(renderId, cardsById, resolved).filter(
    (id) => !unchecked.has(id),
  );
  const directComfy = resolved
    .filter((e) => e.to === renderId)
    .map((e) => cardsById.get(e.from))
    .filter((c): c is SceneCard => c?.kind === "comfy" && !unchecked.has(c.id))
    .map((c) => c.id);
  return buildExecutionPlan(genIds, directComfy, cardsById, resolved);
}

export function isGenerationExecutionPlanCurrent(
  snapshot: SceneExecutionPlan,
  genId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): boolean {
  return sameSceneExecutionPlan(
    snapshot,
    buildGenerationExecutionPlan(genId, cardsById, edges),
  );
}

export function isRenderExecutionPlanCurrent(
  snapshot: SceneExecutionPlan,
  renderId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): boolean {
  return sameSceneExecutionPlan(
    snapshot,
    buildRenderExecutionPlan(renderId, cardsById, edges),
  );
}

// 생성카드에 연결된 텍스트 입력(text 노드 + text-list)을 순서대로 합친다 — 하단 프롬프트 텍스트로 쓸 값.
//  count>0 이면 '텍스트가 연결됨'(파생 우선). count=0 이면 연결 없음(카드 자체 프롬프트 fallback).
export function collectGenText(
  genId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  overlay?: ComfyOutputsById,
): { text: string; count: number } {
  const srcs = edges
    .filter((e) => e.to === genId)
    .map((e) => cardsById.get(e.from))
    .filter((c): c is SceneCard => !!c)
    .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
  // 텍스트를 제공하는 소스(텍스트 노드·comfy 텍스트 출력·텍스트 리스트)를 순서대로 합친다.
  // effectiveTextOf 가 텍스트 노드의 연결된 텍스트 입력(comfy→텍스트 체인)까지 펼쳐 준다.
  const blocks: string[] = [];
  for (const s of srcs) {
    const t = effectiveTextOf(s.id, cardsById, edges, new Set(), overlay);
    if (t.trim()) blocks.push(t);
  }
  return { text: blocks.join("\n"), count: blocks.length };
}

// 생성카드에 연결된 comfy 노드의 '미디어 출력(image/video)'을 레퍼런스로 파생 수집한다(순수·transient).
//  · card.refs 처럼 persist 하지 않는다 — comfy 재실행 때 URL 이 바뀌므로 생성 직전에 최신 comfyCfg.outputs 에서
//    그때그때 읽는다(stale URL 자동 해소). collectGenText 와 같은 파생-시점 철학.
//  · comfy 직접 연결 + list 경유(comfy 를 담은 generation-list)를 모두 처리. comfy 미디어를 입력 ref 로.
//  · 텍스트 출력은 collectGenText 가 프롬프트로 가져가므로 여기선 미디어만. 한 comfy 가 둘 다 내면 프롬프트+ref 로 동시 사용.
export function collectGenRefs(
  genId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  overlay?: ComfyOutputsById,
): Pick<SceneRef, "file_path" | "type" | "name" | "thumb" | "source_gen_id">[] {
  const srcs = edges
    .filter((e) => e.to === genId)
    .map((e) => ({ e, c: cardsById.get(e.from) }))
    .filter(
      (x): x is { e: SceneEdge; c: SceneCard } =>
        x.c?.kind === "comfy" || x.c?.kind === "list",
    );
  const out: Pick<SceneRef, "file_path" | "type" | "name" | "thumb" | "source_gen_id">[] = [];
  const seen = new Set<string>();
  const pushComfyMedia = (c: SceneCard) => {
    // 워크플로우가 '텍스트 전용'을 선언하면 미디어 ref 로 붙이지 않는다(stale 미디어 오누출 방지).
    const dk = comfyDeclaredKinds(c.comfyCfg?.content);
    if (dk.text && !dk.media) return;
    for (const m of comfyOutputMedia(c, overlay)) {
      const key = `${c.id}|${m.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        file_path: m.url,
        type: m.kind,
        name: c.comfyCfg?.name || "Comfy",
        thumb: m.kind === "image" ? m.url : null,
        source_gen_id: null,
      });
    }
  };
  for (const s of sortByOrder(srcs)) {
    if (s.c.kind === "comfy") {
      pushComfyMedia(s.c);
    } else {
      // list 경유 — generation-list 안의 comfy 항목만 미디어로 편다(순수 generation 카드는 다른 경로).
      const li = collectListInputs(s.c.id, cardsById, edges, overlay);
      if (li.kind !== "generation") continue;
      for (const cid of li.generationCardIds) {
        const c = cardsById.get(cid);
        if (c?.kind !== "comfy") continue;
        // 평상시에는 저장된 comfy를 gatherTarget의 SceneRef가 담당한다. 배치 실행 overlay가 있으면
        // 이전 저장 ref가 아니라 이번 복사본 결과를 써야 하므로 저장 이력이 있어도 overlay를 펼친다.
        if (variantIds(c).length > 0 && !overlay) continue;
        pushComfyMedia(c);
      }
    }
  }
  return out;
}

// 생성카드에 연결된 모델 노드의 설정 — 정확히 1개일 때만 유효(복수면 침묵 선택 위험 → null).
export function collectGenModel(
  genId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): SceneModelCfg | null {
  const models = edges
    .filter((e) => e.to === genId)
    .map((e) => cardsById.get(e.from))
    .filter((c): c is SceneCard => c?.kind === "model");
  if (models.length !== 1) return null;
  return models[0].modelCfg ?? null;
}

// View 노드가 표시할 텍스트 블록들(순서 보존) — text 노드 직접 연결 + text-list 를 통해 들어온 것.
// 미디어(생성물)와 별개로 수집한다. View 는 생성물이 있으면 재생, 텍스트가 있으면 텍스트를 보여준다.
export function collectViewTexts(
  viewId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): string[] {
  const srcs = edges
    .filter((e) => e.to === viewId)
    .map((e) => cardsById.get(e.from))
    .filter((c): c is SceneCard => !!c)
    .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
  const out: string[] = [];
  for (const c of srcs) {
    // 텍스트 노드·comfy 텍스트 출력·텍스트 리스트 모두 표시(comfy→텍스트 체인 포함).
    const t = effectiveTextOf(c.id, cardsById, edges);
    if (t.trim()) out.push(t);
  }
  return out;
}

// 연결의 역할 판정(순수) — 생성카드 입력 레인·엣지 색의 단일 근거. edge.role 이 명시돼 있으면 그대로,
// 아니면 소스/타깃 kind 로 추론(기존 저장분 하위호환). gen→gen 은 refParents/refs 로 'ref 사용'과 '계보'를 구분.
//  · model 노드 → 'model'(주황)  · text 노드 → 'text'(노랑)  · reference 카드 → 'ref'(파랑)
//  · → list 노드 = 'list'(수집)   · 생성물을 ref 로 사용 → 'ref', 그 외 생성→생성 = 'lineage'
interface EdgeRoleResolutionContext {
  incomingByTarget: IncomingEdgeIndex;
  inputSourceById: Map<string, string | null>;
  listInputsById: Map<string, ListInputs>;
}

function resolveRoleInputSourceId(
  cardId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  context: EdgeRoleResolutionContext,
): string | null {
  if (context.inputSourceById.has(cardId)) return context.inputSourceById.get(cardId) ?? null;
  const resolved = resolveInputSourceIdIndexed(
    cardId,
    cardsById,
    edges,
    new Set(),
    context.incomingByTarget,
  );
  context.inputSourceById.set(cardId, resolved);
  return resolved;
}

function collectRoleListInputs(
  listId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  context: EdgeRoleResolutionContext,
): ListInputs {
  const cached = context.listInputsById.get(listId);
  if (cached) return cached;
  const collected = collectListInputsIndexed(
    listId,
    cardsById,
    edges,
    undefined,
    new Set(),
    context.incomingByTarget,
  );
  context.listInputsById.set(listId, collected);
  return collected;
}

function resolveEdgeRoleWithContext(
  edge: SceneEdge,
  cardsById: Map<string, SceneCard>,
  refParents: Record<string, string[]>,
  edges?: SceneEdge[],
  context?: EdgeRoleResolutionContext,
): SceneEdgeRole {
  if (edge.role) return edge.role;
  const rawFrom = cardsById.get(edge.from);
  // 소스가 input(무선)이면 실제 소스 종류로 색을 맞춘다 — 못 풀면 그대로(중립 폴백).
  const fromId =
    rawFrom?.kind === "input" && edges
      ? (context
          ? resolveRoleInputSourceId(edge.from, cardsById, edges, context)
          : resolveInputSourceId(edge.from, cardsById, edges)) ?? edge.from
      : edge.from;
  const from = cardsById.get(fromId);
  const to = cardsById.get(edge.to);
  // 소스 종류를 먼저 본다 — 텍스트→리스트여도 '텍스트'(보라)로. 모델/텍스트/레퍼런스는 소스색 우선.
  // 텍스트 노드 입력: 텍스트를 주는 소스(comfy 텍스트·텍스트 노드·텍스트 리스트)면 텍스트색(보라),
  // 레퍼런스(레퍼런스 카드·생성물·레퍼런스 리스트)면 파랑.
  if (to?.kind === "text") {
    if (from?.kind === "comfy" || from?.kind === "text") return "text";
    if (from?.kind === "list" && edges)
      return (context
        ? collectRoleListInputs(from.id, cardsById, edges, context)
        : collectListInputs(from.id, cardsById, edges)
      ).kind === "text"
        ? "text"
        : "ref";
    return "ref"; // reference·generation → 레퍼런스(파랑)
  }
  if (from?.kind === "model") return "model";
  if (from?.kind === "text") return "text";
  if (from?.kind === "comfy") {
    // 출력을 '내 작업' 생성물로 저장한 comfy(genIds 보유)는 생성물색(lineage) — 생성카드처럼 취급·렌더.
    if (from.genIds?.length || from.genId) return "lineage";
    // ★워크플로우가 '선언한' 출력으로 색 결정 — 실행 전에도 정확하고, 이전 워크플로우의 stale 런타임 출력에
    //  속지 않는다. 미디어 출력이 있으면 ref(파랑), 텍스트 전용이면 text(보라). 둘 다면 ref 우선(텍스트는
    //  프롬프트에서 확인). 선언을 못 읽으면 런타임 출력으로 폴백.
    const dk = comfyDeclaredKinds(from.comfyCfg?.content);
    if (dk.media || dk.text) return dk.media ? "ref" : "text";
    return comfyOutputMedia(from).length > 0 ? "ref" : "text";
  }
  if (from?.kind === "reference") return "ref";
  // render(완료 렌더물) → 생성/컨피 카드 = 레퍼런스(파랑). render 는 미디어만 담으므로 그 외 대상은 폴백.
  if (from?.kind === "render" && (to?.kind === "generation" || to?.kind === "comfy")) return "ref";
  // 리스트의 출력색은 그 리스트가 모은 종류를 따른다(edges 필요): 텍스트리스트=텍스트(보라), 레퍼런스리스트=레퍼런스(파랑).
  if (from?.kind === "list" && edges) {
    const lk = (context
      ? collectRoleListInputs(from.id, cardsById, edges, context)
      : collectListInputs(from.id, cardsById, edges)
    ).kind;
    if (lk === "text") return "text";
    if (lk === "reference") return "ref";
    // 생성물(미디어)을 모은 리스트가 생성/컨피 카드로 들어가면 레퍼런스(파랑). 리스트→리스트 수집(아래 "list")은 그대로 둔다.
    if ((lk === "generation" || lk === "mixed") && (to?.kind === "generation" || to?.kind === "comfy"))
      return "ref";
  }
  if (to?.kind === "list") return "list"; // 생성물 → 리스트 수집
  if (from?.kind === "generation" && to) {
    const srcGens = variantIds(from);
    const byRefs = (to.refs || []).some((r) => r.source_gen_id && srcGens.includes(r.source_gen_id));
    const byHistory = variantIds(to).some((b) => (refParents[b] || []).some((p) => srcGens.includes(p)));
    return byRefs || byHistory ? "ref" : "lineage";
  }
  return "lineage";
}

export function resolveEdgeRole(
  edge: SceneEdge,
  cardsById: Map<string, SceneCard>,
  refParents: Record<string, string[]>,
  edges?: SceneEdge[],
): SceneEdgeRole {
  return resolveEdgeRoleWithContext(edge, cardsById, refParents, edges);
}

// 화면 렌더용 일괄 판정. 들어오는 엣지 인덱스와 input/list 해석 결과를 그래프 전체에서 공유해,
// 카드 이동 중 엣지마다 같은 전체 그래프를 되풀이해 읽는 비용을 없앤다.
export function resolveEdgeRoles(
  edges: SceneEdge[],
  cardsById: Map<string, SceneCard>,
  refParents: Record<string, string[]>,
): Map<string, SceneEdgeRole> {
  const context: EdgeRoleResolutionContext = {
    incomingByTarget: buildIncomingEdgeIndex(edges),
    inputSourceById: new Map(),
    listInputsById: new Map(),
  };
  const roles = new Map<string, SceneEdgeRole>();
  for (const edge of edges)
    roles.set(edge.id, resolveEdgeRoleWithContext(edge, cardsById, refParents, edges, context));
  return roles;
}

// 베지어 연결선 path(d) — 양 끝점 좌표만으로. 중간 제어점은 x 중앙.
export function edgePathXY(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

// 한 포트에 연결이 여러 개면 세로로 펼쳐(fan-out) 끝점이 겹치지 않게 — 선마다 오프셋. 연결 1개면 0(정중앙).
export function fanOffset(list: SceneEdge[] | undefined, id: string, fan: number): number {
  if (!list || list.length < 2) return 0;
  const i = list.findIndex((x) => x.id === id);
  return (i - (list.length - 1) / 2) * fan;
}

// 숨긴(회색) 카드를 건너뛰어 보이는 '앞 카드 → 뒤 카드'로 회색 점선 우회선을 만든다(중간에 숨김이 있다는 표시).
// ★반복 순서 보존: cards 순서로 출발, edges 순서로 인접, FIFO queue.shift() — bridgeEdges 결과 순서가 여기에 달려 있다.
export function computeBridgeEdges(
  cards: SceneCard[],
  edges: SceneEdge[],
  hiddenIds: Set<string>,
): { id: string; from: string; to: string }[] {
  const bridgeEdges: { id: string; from: string; to: string }[] = [];
  if (!hiddenIds.size) return bridgeEdges;
  const outAdj = new Map<string, string[]>();
  for (const e of edges) {
    const arr = outAdj.get(e.from);
    if (arr) arr.push(e.to);
    else outAdj.set(e.from, [e.to]);
  }
  const made = new Set<string>();
  for (const v of cards) {
    if (hiddenIds.has(v.id)) continue; // 보이는 노드에서만 출발
    const visited = new Set<string>();
    const queue: { id: string; viaHidden: boolean }[] = (outAdj.get(v.id) || []).map((id) => ({
      id,
      viaHidden: false,
    }));
    while (queue.length) {
      const { id, viaHidden } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (hiddenIds.has(id)) {
        for (const t of outAdj.get(id) || []) queue.push({ id: t, viaHidden: true });
      } else if (viaHidden && id !== v.id) {
        // 숨김을 1개 이상 지나 도달한 '다른' 보이는 노드 = 우회선 대상(사이클로 자기 자신 복귀는 제외)
        const key = v.id + ">" + id;
        if (!made.has(key)) {
          made.add(key);
          bridgeEdges.push({ id: "bridge:" + key, from: v.id, to: id });
        }
      }
    }
  }
  return bridgeEdges;
}

// 연결 종류 판정 — 카드 종류가 아니라 실제 데이터 기준. 전체 edges 대상(없는 카드만 skip).
//  · refCardEdgeIds: 레퍼런스 카드 → 생성(파란 점선)
//  · genRefEdgeIds : 생성물을 레퍼런스로 사용 → 초록 점선. (1) 씬 로컬 refs 의 source_gen_id, 또는
//    (2) 백엔드 history(refParents)로 소스를 레퍼런스 부모로 실제 사용. 그 외 생성→생성은 계보(초록 실선).
export function classifyEdges(
  edges: SceneEdge[],
  cardsById: Map<string, SceneCard>,
  refParents: Record<string, string[]>,
): { refCardEdgeIds: Set<string>; genRefEdgeIds: Set<string> } {
  const refCardEdgeIds = new Set<string>();
  const genRefEdgeIds = new Set<string>();
  for (const e of edges) {
    const from = cardsById.get(e.from);
    const to = cardsById.get(e.to);
    if (!from || !to) continue;
    if (from.kind === "reference") {
      refCardEdgeIds.add(e.id);
      continue;
    }
    const srcGens = variantIds(from);
    if (!srcGens.length) continue;
    const byRefs = (to.refs || []).some((r) => r.source_gen_id && srcGens.includes(r.source_gen_id));
    const byHistory = variantIds(to).some((b) => (refParents[b] || []).some((p) => srcGens.includes(p)));
    if (byRefs || byHistory) genRefEdgeIds.add(e.id);
  }
  return { refCardEdgeIds, genRefEdgeIds };
}
