// 선택 노드 정렬(auto-arrange) — 연결 흐름(소스=왼쪽 → 타깃=오른쪽)에 따라 열(column)을 나누고,
// 열 안에서는 현재 세로순서(y)를 보존해 가지런히 배치한다.
//  · 순서를 흐트리지 않음: 가로=연결 깊이, 세로=현재 y 순서.
//  · 위치에 맞게: 선택영역의 좌상단을 앵커로 삼아 대략 제자리에서 정돈된다.
// 순수 함수(부수효과 없음) — 각 노드의 새 좌표만 계산해 반환. 테스트 대상.
export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LayoutLink {
  from: string;
  to: string;
}

export function arrangeNodes(
  nodes: LayoutNode[],
  links: LayoutLink[],
  opts: { colGap?: number; rowGap?: number; grid?: number } = {},
): Record<string, { x: number; y: number }> {
  const colGap = opts.colGap ?? 60; // 열 사이 가로 간격
  const rowGap = opts.rowGap ?? 28; // 같은 열 노드 사이 세로 간격
  const grid = opts.grid ?? 22; // 최종 좌표를 이 격자에 스냅
  const snap = (v: number) => Math.round(v / grid) * grid;
  if (!nodes.length) return {};

  const ids = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 선택 노드끼리의 연결만 사용 — 선택 밖으로 나가는 연결은 정렬에 영향 없음.
  const preds = new Map<string, Set<string>>();
  for (const id of ids) preds.set(id, new Set());
  for (const l of links) {
    if (l.from === l.to) continue;
    if (ids.has(l.from) && ids.has(l.to)) preds.get(l.to)!.add(l.from);
  }
  // 깊이(열) = 소스로부터 가장 긴 경로. 사이클은 방문표시로 방어(back-edge 는 깊이 0 취급).
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const calc = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // 사이클 방어
    visiting.add(id);
    let d = 0;
    for (const p of preds.get(id)!) d = Math.max(d, calc(p) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of ids) calc(id);

  // 열별 그룹핑 후, 열 안 세로 순서는 현재 y(→x→id)로 정렬 = 순서 보존.
  const cols = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id)!;
    if (!cols.has(d)) cols.set(d, []);
    cols.get(d)!.push(id);
  }
  const colKeys = [...cols.keys()].sort((a, b) => a - b);
  for (const k of colKeys)
    cols.get(k)!.sort((a, b) => {
      const A = byId.get(a)!;
      const B = byId.get(b)!;
      return A.y - B.y || A.x - B.x || (a < b ? -1 : 1);
    });

  // 앵커 = 현재 선택의 좌상단(격자 스냅) → 대략 제자리에서 정렬.
  const anchorX = snap(Math.min(...nodes.map((n) => n.x)));
  const anchorY = snap(Math.min(...nodes.map((n) => n.y)));

  const out: Record<string, { x: number; y: number }> = {};
  // ★간격이 들쭉날쭉하지 않게 '누적 좌표'가 아니라 '한 칸 이동량(step)'을 격자에 스냅한다.
  //  예전엔 snap(누적 rowY) 라 카드마다 반올림이 위/아래로 엇갈려 간격이 달라졌다(특히 높이가
  //  격자 배수가 아닌 이미지 카드: 예 h=180 → 간격 198,220 처럼 벌어짐). step 을 스냅하면 anchor·step
  //  이 모두 격자 배수라 좌표가 항상 격자에 맞고, 같은 높이 카드는 간격이 완전히 균일해진다.
  let colX = anchorX; // anchorX 는 이미 격자 스냅됨
  for (const k of colKeys) {
    const col = cols.get(k)!;
    const colW = Math.max(...col.map((id) => byId.get(id)!.w));
    let rowY = anchorY; // anchorY 도 이미 격자 스냅됨
    for (const id of col) {
      const n = byId.get(id)!;
      out[id] = { x: colX, y: rowY }; // colX·rowY 는 격자 배수 step 만 더해져 항상 격자 정렬 상태
      rowY += snap(n.h + rowGap);
    }
    colX += snap(colW + colGap);
  }
  return out;
}
