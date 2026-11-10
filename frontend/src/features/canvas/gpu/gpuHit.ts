export interface HitBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface HitRect { l: number; t: number; r: number; b: number }
export interface HitIndex {
  readonly cell: number;
  readonly cells: ReadonlyMap<string, readonly HitBox[]>;
  readonly boxes: readonly HitBox[];
  readonly large: readonly HitBox[];
  readonly order: ReadonlyMap<HitBox, number>;
}

export function buildHitIndex(boxes: HitBox[], cell = 256): HitIndex {
  if (!Number.isFinite(cell) || cell <= 0) throw new RangeError("cell must be positive and finite");
  const cells = new Map<string, HitBox[]>();
  const large: HitBox[] = [];
  for (const box of boxes) {
    if (![box.x, box.y, box.w, box.h, box.z].every(Number.isFinite) || box.w < 0 || box.h < 0)
      throw new RangeError("invalid hit box");
    const left = Math.floor(box.x / cell), top = Math.floor(box.y / cell);
    const right = Math.floor((box.x + box.w) / cell), bottom = Math.floor((box.y + box.h) / cell);
    // 큰 제목 한 장 때문에 빈 격자 칸을 끝없이 할당하지 않도록 별도로 판정한다.
    if (![left, top, right, bottom].every(Number.isSafeInteger) || (right - left + 1) * (bottom - top + 1) > 4096) {
      large.push(box);
      continue;
    }
    for (let x = left; x <= right; x++) {
      for (let y = top; y <= bottom; y++) {
        const key = x + "," + y;
        const entries = cells.get(key);
        if (entries) entries.push(box);
        else cells.set(key, [box]);
      }
    }
  }
  return { cell, cells, boxes: [...boxes], large, order: new Map(boxes.map((box, i) => [box, i])) };
}

export function hitTop(ix: HitIndex, x: number, y: number): HitBox | null {
  let top: HitBox | null = null;
  const test = (box: HitBox) => {
    // 같은 순서이면 나중에 그린 카드가 위에 오도록 원래 입력 순서를 보존한다.
    if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h && (!top || box.z > top.z ||
      (box.z === top.z && ix.order.get(box)! > ix.order.get(top)!))) top = box;
  };
  (ix.cells.get(Math.floor(x / ix.cell) + "," + Math.floor(y / ix.cell)) ?? []).forEach(test);
  ix.large.forEach(test);
  return top;
}

export function queryRect(ix: HitIndex, r: HitRect): HitBox[] {
  if (![r.l, r.t, r.r, r.b].every(Number.isFinite) || r.l > r.r || r.t > r.b) return [];
  const found = new Set<HitBox>();
  const left = Math.floor(r.l / ix.cell), top = Math.floor(r.t / ix.cell);
  const right = Math.floor(r.r / ix.cell), bottom = Math.floor(r.b / ix.cell);
  const add = (box: HitBox) => {
    if (box.x <= r.r && box.x + box.w >= r.l && box.y <= r.b && box.y + box.h >= r.t) found.add(box);
  };
  // 화면 맞춤처럼 빈 칸이 아주 많은 질의는 전체 카드 수까지만 읽는다.
  if (![left, top, right, bottom].every(Number.isSafeInteger) || (right - left + 1) * (bottom - top + 1) > ix.cells.size) ix.boxes.forEach(add);
  else for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++)
    (ix.cells.get(x + "," + y) ?? []).forEach(add);
  ix.large.forEach(add);
  return [...found];
}

export function isOccluded(ix: HitIndex, box: HitBox): boolean {
  return queryRect(ix, { l: box.x, t: box.y, r: box.x + box.w, b: box.y + box.h }).some((other) =>
    other.id !== box.id && other.z > box.z && box.w > 0 && box.h > 0 && other.w > 0 && other.h > 0 &&
    other.x < box.x + box.w && other.x + other.w > box.x &&
    other.y < box.y + box.h && other.y + other.h > box.y,
  );
}
