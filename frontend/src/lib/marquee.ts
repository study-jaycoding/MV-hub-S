// 마퀴(러버밴드) 선택 공용 — 생성 그리드(.gen-cell)·에셋 그리드(.asset-cell)가 동일하게 쓰던
// '사각형 계산 + 셀 AABB 교차 수집' 로직. 차이는 셀 셀렉터와 key(문자열 id / 숫자 idx)뿐이라 매개변수화.
// (구성보드 HistoryBoard 는 zoom 보정이 있어 별도 — 이 util 미사용.)

export type MarqueeRect = { l: number; t: number; w: number; h: number };

// 시작점~현재 커서로 마퀴 사각형(그리드 기준·스크롤 보정)과 뷰포트 경계(교차 판정용)를 계산.
export function computeMarquee(
  grid: HTMLElement,
  start: { x: number; y: number },
  e: { clientX: number; clientY: number },
): { rect: MarqueeRect; b: { x0: number; y0: number; x1: number; y1: number } } {
  const gr = grid.getBoundingClientRect();
  const x0 = Math.min(start.x, e.clientX),
    y0 = Math.min(start.y, e.clientY);
  const x1 = Math.max(start.x, e.clientX),
    y1 = Math.max(start.y, e.clientY);
  return {
    rect: { l: x0 - gr.left + grid.scrollLeft, t: y0 - gr.top + grid.scrollTop, w: x1 - x0, h: y1 - y0 },
    b: { x0, y0, x1, y1 },
  };
}

// 마퀴 경계와 교차하는 셀들의 key 를 base 선택에 더해 반환. keyOf 가 셀 엘리먼트의 식별자를 뽑는다
// (null/undefined 면 제외). 결과는 호출측이 setSelected/onSelectedChange 로 적용.
export function marqueeHits<K>(
  grid: HTMLElement,
  cellSelector: string,
  b: { x0: number; y0: number; x1: number; y1: number },
  base: Iterable<K>,
  keyOf: (el: HTMLElement) => K | null | undefined,
): Set<K> {
  const hit = new Set<K>(base);
  grid.querySelectorAll(cellSelector).forEach((node) => {
    const el = node as HTMLElement;
    const r = el.getBoundingClientRect();
    if (r.right >= b.x0 && r.left <= b.x1 && r.bottom >= b.y0 && r.top <= b.y1) {
      const k = keyOf(el);
      if (k != null) hit.add(k);
    }
  });
  return hit;
}
