// SceneBoard 의 '순수 엣지 기하/그래프 계산'을 컴포넌트에서 추출(렌더마다 인라인으로 돌던 것).
//  · DOM/이벤트/상태를 건드리지 않는 순수 함수만 모은다 — 높이 측정(heightsRef) 의존인 heightOf/edgePath/edgeEnds 는 컴포넌트에 남긴다.
//  · 등가성 보존이 목적이라 원본의 반복/큐 순서·판정 로직을 그대로 옮긴다.
import {
  variantIds,
  type SceneCard,
  type SceneEdge,
  type SceneEdgeRole,
  type SceneModelCfg,
} from "./scenes";

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
  if (from.kind === "render") return to.kind === "view"; // render 는 미리보기(View)에만 연결 — 안의 생성물들을 리스트처럼 넘긴다
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
      return from.kind === "generation" || from.kind === "text" || from.kind === "reference";
    case "view":
      return from.kind === "generation" || from.kind === "list" || from.kind === "text";
    case "render":
      return from.kind === "generation"; // 렌더(배치)는 생성 카드만 모은다
    case "text":
      // 텍스트 노드는 레퍼런스 입력을 받는다(레퍼런스 카드·생성물을 @레퍼런스로). 리스트로 묶은
      // 레퍼런스/생성물도 연결 허용 — 텍스트 노드가 리스트를 펼쳐 @image1/@image2… 로 매핑한다.
      return from.kind === "reference" || from.kind === "generation" || from.kind === "list";
    default:
      return false;
  }
}

// input 노드가 가리키는 '실제 소스 카드 id' 로 해석(무선 연결) — input→output→(output 에 물린 소스).
// 소스가 또 input 이면 계속 따라가되, 사이클/재방문은 unresolved(null)로 끊는다. input 이 아니면 그대로 반환.
export function resolveInputSourceId(
  cardId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
  seen: Set<string> = new Set(),
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
  const ins = edges
    .filter((e) => e.to === outId)
    .map((e) => ({ e, c: cardsById.get(e.from) }))
    .filter((x): x is { e: SceneEdge; c: SceneCard } => !!x.c);
  if (!ins.length) return null; // output 에 아직 소스가 안 붙음
  const primary = sortByOrder(ins)[0].c.id;
  return resolveInputSourceId(primary, cardsById, edges, seen);
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

export function collectListInputs(
  listId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): ListInputs {
  const sources = edges
    .filter((e) => e.to === listId)
    .map((e) => ({ e, c: cardsById.get(e.from) }))
    .filter((x): x is { e: SceneEdge; c: SceneCard } => !!x.c);
  if (!sources.length) return { kind: "empty", sourceIds: [], generationCardIds: [], text: "" };
  const sorted = sortByOrder(sources);
  const sourceIds = sorted.map((s) => s.c.id);
  const kinds = new Set(sorted.map((s) => s.c.kind));
  if ([...kinds].every((k) => k === "generation"))
    return { kind: "generation", sourceIds, generationCardIds: sourceIds, text: "" };
  if ([...kinds].every((k) => k === "text"))
    return { kind: "text", sourceIds, generationCardIds: [], text: sorted.map((s) => s.c.text || "").join("\n") };
  if ([...kinds].every((k) => k === "reference"))
    return { kind: "reference", sourceIds, generationCardIds: [], text: "" };
  // 그 외: gen+text 혼합이면 mixed, 그 외 종류가 섞이면 invalid(리스트는 동종만).
  const hasNonGenText = sorted.some((s) => s.c.kind !== "generation" && s.c.kind !== "text");
  return { kind: hasNonGenText ? "invalid" : "mixed", sourceIds, generationCardIds: [], text: "" };
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
    .filter((x): x is { e: SceneEdge; c: SceneCard } => x.c?.kind === "generation");
  const out: string[] = [];
  for (const s of sortByOrder(items)) if (!out.includes(s.c.id)) out.push(s.c.id);
  return out;
}

// 생성카드에 연결된 텍스트 입력(text 노드 + text-list)을 순서대로 합친다 — 하단 프롬프트 텍스트로 쓸 값.
//  count>0 이면 '텍스트가 연결됨'(파생 우선). count=0 이면 연결 없음(카드 자체 프롬프트 fallback).
export function collectGenText(
  genId: string,
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): { text: string; count: number } {
  const srcs = edges
    .filter((e) => e.to === genId)
    .map((e) => cardsById.get(e.from))
    .filter((c): c is SceneCard => !!c)
    .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
  const blocks: string[] = [];
  for (const s of srcs) {
    if (s.kind === "text") blocks.push(s.text || "");
    else if (s.kind === "list") {
      const li = collectListInputs(s.id, cardsById, edges);
      if (li.kind === "text") blocks.push(li.text);
    }
  }
  return { text: blocks.join("\n"), count: blocks.length };
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
    if (c.kind === "text") {
      if ((c.text || "").trim()) out.push(c.text || "");
    } else if (c.kind === "list") {
      const li = collectListInputs(c.id, cardsById, edges);
      if (li.kind === "text" && li.text.trim()) out.push(li.text);
    }
  }
  return out;
}

// 연결의 역할 판정(순수) — 생성카드 입력 레인·엣지 색의 단일 근거. edge.role 이 명시돼 있으면 그대로,
// 아니면 소스/타깃 kind 로 추론(기존 저장분 하위호환). gen→gen 은 refParents/refs 로 'ref 사용'과 '계보'를 구분.
//  · model 노드 → 'model'(주황)  · text 노드 → 'text'(노랑)  · reference 카드 → 'ref'(파랑)
//  · → list 노드 = 'list'(수집)   · 생성물을 ref 로 사용 → 'ref', 그 외 생성→생성 = 'lineage'
export function resolveEdgeRole(
  edge: SceneEdge,
  cardsById: Map<string, SceneCard>,
  refParents: Record<string, string[]>,
  edges?: SceneEdge[],
): SceneEdgeRole {
  if (edge.role) return edge.role;
  const rawFrom = cardsById.get(edge.from);
  // 소스가 input(무선)이면 실제 소스 종류로 색을 맞춘다 — 못 풀면 그대로(중립 폴백).
  const fromId =
    rawFrom?.kind === "input" && edges
      ? resolveInputSourceId(edge.from, cardsById, edges) ?? edge.from
      : edge.from;
  const from = cardsById.get(fromId);
  const to = cardsById.get(edge.to);
  // 소스 종류를 먼저 본다 — 텍스트→리스트여도 '텍스트'(보라)로. 모델/텍스트/레퍼런스는 소스색 우선.
  if (to?.kind === "text") return "ref"; // 무엇이든 텍스트 노드 입력 = 레퍼런스(파랑)
  if (from?.kind === "model") return "model";
  if (from?.kind === "text") return "text";
  if (from?.kind === "reference") return "ref";
  // 리스트의 출력색은 그 리스트가 모은 종류를 따른다(edges 필요): 텍스트리스트=텍스트(보라), 레퍼런스리스트=레퍼런스(파랑).
  if (from?.kind === "list" && edges) {
    const lk = collectListInputs(from.id, cardsById, edges).kind;
    if (lk === "text") return "text";
    if (lk === "reference") return "ref";
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
