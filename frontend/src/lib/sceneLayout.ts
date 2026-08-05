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
  if (!nodes.length) return {};
  const nonNegative = (value: number | undefined, fallback: number) =>
    Number.isFinite(value) && value! >= 0 ? value! : fallback;
  const positive = (value: number | undefined, fallback: number) =>
    Number.isFinite(value) && value! > 0 ? value! : fallback;
  const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
  const colGap = nonNegative(opts.colGap, 60); // 열 사이 가로 간격
  const rowGap = nonNegative(opts.rowGap, 28); // 같은 열 노드 사이 세로 간격
  const grid = positive(opts.grid, 22); // 최종 좌표를 이 격자에 스냅
  const snap = (v: number) => {
    const snapped = Math.round(finite(v) / grid) * grid;
    return finite(snapped);
  };
  // 직접 편집된 localStorage·외부 도구가 NaN/Infinity/0 크기를 넣어도 정렬 결과가 전파되지 않게
  // 계산용 입력만 안전화한다. 원본 노드 객체는 바꾸지 않는다.
  const safeNodes = nodes.map((node) => ({
    ...node,
    x: finite(node.x),
    y: finite(node.y),
    w: positive(node.w, 1),
    h: positive(node.h, 1),
  }));

  const ids = new Set(safeNodes.map((n) => n.id));
  const byId = new Map(safeNodes.map((n) => [n.id, n]));
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

  // 열별 그룹핑(가로 = 연결 깊이).
  const cols = new Map<number, string[]>();
  for (const id of ids) {
    const d = depth.get(id)!;
    if (!cols.has(d)) cols.set(d, []);
    cols.get(d)!.push(id);
  }
  const colKeys = [...cols.keys()].sort((a, b) => a - b);

  // 앵커 = 현재 선택의 좌상단(격자 스냅) → 대략 제자리에서 정렬.
  const anchorX = snap(Math.min(...safeNodes.map((n) => n.x)));
  const anchorY = snap(Math.min(...safeNodes.map((n) => n.y)));

  const out: Record<string, { x: number; y: number }> = {};
  // ★열 안을 '행(row)'으로 묶는다: 세로로 겹치는(=가로로 나란한) 카드는 같은 행에 두어 윗변을 맞추고
  //  왼→오른쪽으로 편다. 세로로 떨어져 있으면 다음 행 → 예전처럼 세로로 쌓인다(연결 흐름과 호환).
  //  간격은 '누적 좌표'가 아니라 '한 칸 이동량(step)'을 격자에 스냅해 균일하게 만든다(anchor·step 이
  //  모두 격자 배수라 좌표도 항상 격자에 맞고, 같은 크기 카드는 간격이 완전히 균일해진다).
  let colX = anchorX;
  for (const k of colKeys) {
    // 세로(y→x) 순으로 훑으며, 앞 행과 세로로 겹치면 같은 행에 붙인다.
    const sorted = [...cols.get(k)!].sort((a, b) => {
      const A = byId.get(a)!, B = byId.get(b)!;
      return A.y - B.y || A.x - B.x || (a < b ? -1 : 1);
    });
    const rows: string[][] = [];
    let rowBottom = -Infinity;
    for (const id of sorted) {
      const n = byId.get(id)!;
      if (rows.length && n.y < rowBottom) {
        rows[rows.length - 1].push(id); // 앞 행과 세로로 겹침 → 같은 행(가로 나란)
        rowBottom = Math.max(rowBottom, n.y + n.h);
      } else {
        rows.push([id]); // 세로로 떨어짐 → 새 행
        rowBottom = n.y + n.h;
      }
    }
    let rowY = anchorY;
    let colRight = colX;
    for (const row of rows) {
      row.sort((a, b) => byId.get(a)!.x - byId.get(b)!.x || (a < b ? -1 : 1));
      let cellX = colX;
      let rowH = 0;
      for (const id of row) {
        const n = byId.get(id)!;
        out[id] = { x: cellX, y: rowY }; // 같은 행 = 같은 y(윗변 정렬), 왼→오른쪽 배치
        rowH = Math.max(rowH, n.h);
        colRight = Math.max(colRight, finite(cellX + n.w, cellX));
        cellX = snap(cellX + snap(n.w + colGap)); // step 스냅 → 좌표가 항상 격자 정렬
      }
      rowY = snap(rowY + snap(rowH + rowGap)); // 행 높이는 그 행 최고 카드 기준
    }
    colX = snap(colRight + colGap); // 다음 열 = 이 열의 오른쪽 끝 + 간격
  }
  return out;
}
