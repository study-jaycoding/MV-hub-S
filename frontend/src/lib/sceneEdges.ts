// SceneBoard 의 '순수 엣지 기하/그래프 계산'을 컴포넌트에서 추출(렌더마다 인라인으로 돌던 것).
//  · DOM/이벤트/상태를 건드리지 않는 순수 함수만 모은다 — 높이 측정(heightsRef) 의존인 heightOf/edgePath/edgeEnds 는 컴포넌트에 남긴다.
//  · 등가성 보존이 목적이라 원본의 반복/큐 순서·판정 로직을 그대로 옮긴다.
import { variantIds, type SceneCard, type SceneEdge } from "./scenes";

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
