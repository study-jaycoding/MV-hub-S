// 캔버스 'c' 자동 연결 계획(순수) — SceneBoard.autoConnectSelection 에서 추출(2026-09-09).
//  선택한 카드들 사이에 '말이 되는' 연결을 자동으로 고른다. DOM·상태를 건드리지 않고 (from, to) 쌍만 돌려준다.
//
//  순서(코덱스 1~3차 리뷰 반영):
//   ① 텍스트를 뺀 카드끼리 층 규칙(예전 그대로) — 소스(0) → 생성(1) → 수집기 list/render(2) → view(3) → output(4).
//      한 소스는 가장 가까운 층에만. 양방향 가능한 모호한 쌍만 화면 위치로 방향. 텍스트 리스트는 생성의 프롬프트 쪽이라 리스트 → 생성.
//      리스트를 '혼합/잘못된 입력'으로 만드는 연결은 만들지 않는다(리스트의 실제 판정기 collectListInputs 로 미리 셈).
//   ② 그 계획(기존 연결 + 새 연결)으로 각 리스트가 실제로 무엇을 모으게 되는지 판정한 뒤 텍스트의 방향을 고정한다
//      (Jay 2026-09-09: 화면 위치와 무관). 텍스트 → 생성 · 레퍼런스 → 텍스트 · 레퍼런스/빈 리스트 → 텍스트 · 텍스트 → 텍스트 리스트.
//      생성물·혼합 리스트와 텍스트는 잇지 않는다(텍스트→생성→리스트→텍스트 순환, comfy 혼합 입력 방지). 리스트를 거치는 사슬
//      (레퍼런스→리스트→텍스트, 텍스트→텍스트리스트→생성)이 생기면 직접 연결은 생략한다. 남는 대상(view 등)은 가장 가까운 층에만.
import { canConnect, collectListInputs, resolvePortEdges, type ListInputs } from "./sceneEdges";
import type { SceneCard, SceneEdge } from "./scenes";

// comfyAsGeneration: 렌더가 선택에 있으면 comfy 를 생성 카드와 같은 1층으로 — 렌더는 New·comfy 를 함께 모아 배치 실행하는
//  수집기라 둘 다 렌더 입력으로 가야 한다(Jay 2026-09-09). 아니면 comfy 는 0층(가장 가까운 New 의 레퍼런스로, 예전 그대로).
function layerOf(card: SceneCard, comfyAsGeneration = false): number {
  return card.kind === "generation" || (card.kind === "comfy" && comfyAsGeneration)
    ? 1
    : card.kind === "list" || card.kind === "render"
      ? 2
      : card.kind === "view"
        ? 3
        : card.kind === "output"
          ? 4
          : 0;
}

type ListKind = ListInputs["kind"];

export function planAutoConnections(
  selectedCards: SceneCard[],
  cardsById: Map<string, SceneCard>,
  edges: SceneEdge[],
): Array<[string, string]> {
  if (selectedCards.length < 2) return [];

  // 생성 카드만 골랐으면 왼쪽→오른쪽으로 사슬(계보).
  if (selectedCards.every((card) => card.kind === "generation")) {
    const sorted = [...selectedCards].sort((left, right) => left.x - right.x);
    const pairs: Array<[string, string]> = [];
    for (let index = 0; index < sorted.length - 1; index++)
      pairs.push([sorted[index].id, sorted[index + 1].id]);
    return pairs;
  }

  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  const add = (from: SceneCard, to: SceneCard) => {
    const key = from.id + ">" + to.id;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push([from.id, to.id]);
  };
  const has = (from: SceneCard, to: SceneCard) => seen.has(from.id + ">" + to.id);
  const ok = (from: SceneCard, to: SceneCard) => canConnect(from, to, cardsById, edges);

  // 리스트가 '지금 + 계획된 연결(+ 추가 후보)'으로 무엇을 모으게 되는지 — 실제 판정기로 센다(무선 input 도 해석).
  const plannedInto = (list: SceneCard): SceneEdge[] =>
    pairs
      .filter(([, to]) => to === list.id)
      .map(([from, to]) => ({ id: "plan:" + from + ">" + to, from, to }));
  const kindWith = (list: SceneCard, extra: SceneEdge[]): ListKind => {
    const all = [...edges, ...plannedInto(list), ...extra];
    return collectListInputs(list.id, cardsById, resolvePortEdges(cardsById, all)).kind;
  };
  const currentKindOf = (list: SceneCard): ListKind =>
    collectListInputs(list.id, cardsById, resolvePortEdges(cardsById, edges)).kind;
  const breaksList = (from: SceneCard, list: SceneCard): boolean => {
    // 이 연결을 더하면 리스트가 혼합/잘못된 입력이 되는가(이미 그 상태면 더 나빠지지 않으니 허용).
    const after = kindWith(list, [{ id: "plan:" + from.id + ">" + list.id, from: from.id, to: list.id }]);
    if (after !== "mixed" && after !== "invalid") return false;
    return kindWith(list, []) !== after;
  };

  const texts = selectedCards.filter((card) => card.kind === "text");
  const others = selectedCards.filter((card) => card.kind !== "text");
  const lists = others.filter((card) => card.kind === "list");
  const hasRender = others.some((card) => card.kind === "render");
  const layer = (card: SceneCard) => layerOf(card, hasRender);

  // ① 텍스트를 뺀 카드끼리 층 규칙.
  for (const source of others) {
    const candidates = others.filter((target) => layer(target) > layer(source) && ok(source, target));
    if (!candidates.length) continue;
    const minimumLayer = Math.min(...candidates.map(layer));
    for (const target of candidates) {
      if (layer(target) !== minimumLayer) continue;
      let from = source;
      let to = target;
      if (source.kind === "generation" && target.kind === "list" && currentKindOf(target) === "text") {
        // 텍스트 리스트는 생성의 프롬프트 쪽 — 위치와 무관하게 리스트 → 생성.
        from = target;
        to = source;
      } else if (ok(target, source) && target.x < source.x) {
        from = target;
        to = source;
      }
      if (to.kind === "list" && breaksList(from, to)) {
        // 이 방향은 리스트를 혼합/잘못된 입력으로 만든다 — 반대 방향이 유효하면(레퍼런스 리스트 → 생성) 그쪽으로, 아니면 잇지 않는다.
        if (ok(to, from) && !(from.kind === "list" && breaksList(to, from))) add(to, from);
        continue;
      }
      add(from, to);
    }
  }

  // ② 이 계획으로 각 리스트가 무엇을 모으게 되는지(확정) → 텍스트 방향.
  const plannedKind = new Map(lists.map((list) => [list.id, kindWith(list, [])] as const));

  for (const text of texts) {
    const handled = new Set<string>();
    // 리스트부터 — 생성·레퍼런스의 '리스트를 거치는 사슬' 판정이 이 결과를 본다.
    for (const list of lists) {
      const kind = plannedKind.get(list.id);
      if (kind === "text") add(text, list);
      else if ((kind === "reference" || kind === "empty") && ok(list, text)) add(list, text);
      // 생성물·혼합·무효 리스트: 텍스트와 잇지 않는다.
      handled.add(list.id);
    }
    for (const other of others) {
      if (handled.has(other.id)) continue;
      if (other.kind === "generation") {
        // 텍스트 → 텍스트 리스트 → 생성 사슬이 있으면 직접 연결 생략(프롬프트 중복 방지).
        const viaTextList = lists.some((list) => has(text, list) && has(list, other));
        if (!viaTextList && ok(text, other)) add(text, other);
        handled.add(other.id);
      } else if (other.kind === "reference") {
        // 레퍼런스 → 리스트 → 텍스트 사슬이 있으면 직접 연결 생략.
        const viaList = lists.some((list) => has(other, list) && has(list, text));
        if (!viaList && ok(other, text)) add(other, text);
        handled.add(other.id);
      }
    }
    // 나머지(view·output 등)는 가장 가까운 층에만 — 생성이 있으면 생성까지(위에서 처리)라 더 잇지 않는다.
    const candidates = others.filter((target) => layer(target) > 0 && ok(text, target));
    if (!candidates.length) continue;
    const minimumLayer = Math.min(...candidates.map(layer));
    for (const target of candidates)
      if (layer(target) === minimumLayer && !handled.has(target.id)) add(text, target);
  }
  return pairs;
}
