// SceneBoard 의 '순수 엣지 기하/그래프 계산'을 컴포넌트에서 추출(렌더마다 인라인으로 돌던 것).
//  · DOM/이벤트/상태를 건드리지 않는 순수 함수만 모은다 — 높이 측정(heightsRef) 의존인 heightOf/edgePath/edgeEnds 는 컴포넌트에 남긴다.
//  · 등가성 보존이 목적이라 원본의 반복/큐 순서·판정 로직을 그대로 옮긴다.
import { variantIds, type SceneCard, type SceneEdge, type SceneEdgeRole } from "./scenes";

// 연결 허용 규칙 — to 노드 종류별로 받을 수 있는 소스만. 말이 안 되는 연결(text→view 등)을 막는다.
//  · generation: 모델/텍스트/레퍼런스/생성/리스트 입력 허용(view 제외)
//  · list: 생성/텍스트만(동종 수집)  · view: 생성/리스트만(미디어)  · text/model/reference/view: 입력 없음
export function canConnect(from: SceneCard, to: SceneCard): boolean {
  if (from.id === to.id) return false;
  switch (to.kind) {
    case "generation":
      return from.kind !== "view";
    case "list":
      return from.kind === "generation" || from.kind === "text";
    case "view":
      return from.kind === "generation" || from.kind === "list";
    default:
      return false;
  }
}

// list 노드로 들어온 입력을 수집·판정(순수). list 는 '동종 수집기' — 생성카드만 들어오면 generation,
// text 만 들어오면 그 텍스트를 order/y 순으로 합친다. 섞이거나 model/ref 가 섞이면 사용 불가로 표시.
export interface ListInputs {
  kind: "empty" | "generation" | "text" | "mixed" | "invalid";
  sourceIds: string[]; // 정렬된 입력 소스 카드 id
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
  // 그 외: gen+text 혼합이면 mixed, model/reference 등이 섞이면 invalid.
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
): SceneEdgeRole {
  if (edge.role) return edge.role;
  const from = cardsById.get(edge.from);
  const to = cardsById.get(edge.to);
  if (to?.kind === "list") return "list";
  if (from?.kind === "model") return "model";
  if (from?.kind === "text") return "text";
  if (from?.kind === "reference") return "ref";
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
