// SceneBoard 에서 추출한 순수 파생 계산 — React·ref·DOM·fetch·localStorage 없이 인자만으로 결과를 낸다.
//  domain(순수) 계층: 입력→출력만. 그래서 단위 테스트가 쉽다(ARCHITECTURE.md 참고).
//  · reconcileRefs: 연결로 모은 참조(target)와 기존 참조(existing)를 병합. from_card 규칙으로 유령 참조 방지.
//  · pruneGroups: 삭제된/유령 카드 id 를 그룹 멤버에서 빼고 빈 그룹 제거.
import type { SceneCard, SceneRef, SceneGroup } from "./scenes";

export const GROUP_PADDING = 16;
export const GROUP_HEADER_HEIGHT = 26;
export const GROUP_COLLAPSED_WIDTH = 200;

export interface SceneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneGroupView {
  g: SceneGroup;
  frame: SceneRect;
  bar: SceneRect;
}

type CardSize = (card: SceneCard) => { w: number; h: number };

export function groupRectFromCards(
  cardIds: readonly string[],
  cardsById: ReadonlyMap<string, SceneCard>,
  cardSize: CardSize,
  excludedIds: ReadonlySet<string> = new Set(),
): SceneRect | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (const id of cardIds) {
    if (excludedIds.has(id)) continue;
    const card = cardsById.get(id);
    if (!card) continue;
    const size = cardSize(card);
    count++;
    minX = Math.min(minX, card.x);
    minY = Math.min(minY, card.y);
    maxX = Math.max(maxX, card.x + size.w);
    maxY = Math.max(maxY, card.y + size.h);
  }
  if (!count) return undefined;
  return {
    x: minX - GROUP_PADDING,
    y: minY - GROUP_PADDING - GROUP_HEADER_HEIGHT,
    w: maxX - minX + GROUP_PADDING * 2,
    h: maxY - minY + GROUP_PADDING * 2 + GROUP_HEADER_HEIGHT,
  };
}

export function unionSceneRects(a: SceneRect, b: SceneRect): SceneRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

export function groupFrame(
  group: SceneGroup,
  cardsById: ReadonlyMap<string, SceneCard>,
  cardSize: CardSize,
  excludedIds: ReadonlySet<string> = new Set(),
): SceneRect | null {
  const memberRect = groupRectFromCards(group.cardIds, cardsById, cardSize, excludedIds);
  if (!group.rect) return memberRect ?? null;
  return memberRect ? unionSceneRects(group.rect, memberRect) : group.rect;
}

export function deriveGroupViews(
  groups: readonly SceneGroup[],
  cardsById: ReadonlyMap<string, SceneCard>,
  cardSize: CardSize,
  excludedIds: ReadonlySet<string> = new Set(),
): SceneGroupView[] {
  const views: SceneGroupView[] = [];
  for (const g of groups) {
    const frame = groupFrame(g, cardsById, cardSize, excludedIds);
    if (!frame) continue;
    views.push({
      g,
      frame,
      bar: {
        x: frame.x,
        y: frame.y,
        w: GROUP_COLLAPSED_WIDTH,
        h: GROUP_HEADER_HEIGHT,
      },
    });
  }
  return views;
}

// 기존 refs(프롬프트에서 재정렬됐을 수 있음)의 순서를 보존하며, 새 연결은 뒤에 붙이고 끊긴 건 뺀다.
// ★'직접' 넣은 참조(from_card 없음 — @생성물·드래그 asset 등)는 엣지와 무관하게 보존한다.
//   레퍼런스 카드/리스트가 제공한 참조(from_card:true)는 그 소스가 바뀌면(target 에서 빠지면) 함께 사라진다 —
//   안 그러면 옛 레퍼런스 카드(비디오 등)를 끊고 다른 걸 연결해도 옛 참조가 유령으로 남아 생성에 섞였다.
//   (from_card 는 gatherTarget 이 연결로 모은 참조에만 붙는다. 없으면 사용자가 손으로 넣은 것이라 보존.)
export function reconcileRefs(existing: SceneRef[], target: SceneRef[]): SceneRef[] {
  const key = (r: SceneRef) => r.file_path + "#" + (r.source_gen_id || "");
  const pool = [...target];
  const result: SceneRef[] = [];
  for (const r of existing) {
    const i = pool.findIndex((t) => key(t) === key(r));
    if (i >= 0) {
      const linked = pool.splice(i, 1)[0];
      // ★수동으로 넣은 참조(!from_card)는 연결이 같은 파일을 제공해도 수동 표식을 유지한다 —
      //  안 그러면 연결 해제 때 수동 참조까지 사라진다. from_card 참조만 연결본으로 갱신.
      result.push(r.from_card ? linked : r);
    } else if (!r.from_card) {
      result.push(r); // 연결에서 온 게 아닌 수동 참조(@생성물·드래그 asset)는 보존
    }
    // 그 외(연결이 끊긴 레퍼런스 카드/리스트 참조)는 제거
  }
  result.push(...pool);
  return result;
}

// 삭제된 카드를 그룹 멤버에서 빼고 빈 그룹은 제거. existing=현재 존재하는 카드 id —
//  손상/구버전 씬의 유령 멤버 id 도 함께 정리(rect 만 남은 빈 그룹 잔존 방지).
export function pruneGroups(
  gs: SceneGroup[],
  removed: Set<string>,
  existing: Set<string>,
): SceneGroup[] {
  return gs
    .map((g) => ({ ...g, cardIds: g.cardIds.filter((id) => !removed.has(id) && existing.has(id)) }))
    .filter((g) => g.cardIds.length > 0);
}
