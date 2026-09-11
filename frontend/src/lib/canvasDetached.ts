// 카드에서 나왔다가 떨어진 생성물 판정 — 순수 규칙(DOM·네트워크 없음).
//
// 서버는 '지금 붙어 있는지'를 모른다. 카드 소속표는 더하기 전용이라 카드나 씬을 지워도 행이
// removed_at=NULL 로 남는다(sceneCardLinks 계약). 그래서 서버는 '있었던 자리'만 전부 주고,
// 지금 어디에 붙어 있나는 로컬 씬 목록을 가진 이쪽이 판정한다.
//
// ★판정의 한계를 이름으로 못 박는다(코덱스 P1): 이건 "어디에도 안 붙었다"가 아니라
//  **"이 브라우저의 캔버스에서 못 찾았다"**이다. 브라우저·설치경로마다 프로필이 갈려 다른
//  프로필의 씬은 여기 없다. 그래서 붙이기는 기존 소속을 지우지 않는 '추가'여야 하고,
//  스키마도 한 생성물의 복수 카드 소속을 허용한다.
// ★로컬을 못 읽었으면 판정 자체를 하지 않는다 — 읽기 실패를 '전부 떨어짐'으로 바꾸면
//  사용자에게 멀쩡한 생성물이 전부 미아로 보인다.
import type { Scene } from "./scenes";
import { variantIds } from "./scenes";

/** 서버가 주는 지난 소속 한 줄 — (생성물, 씬, 카드)뿐인 가벼운 메타데이터. */
export interface CardHistoryLink {
  generation_id: string;
  scene_id: string;
  card_id: string;
}

/** 이어 읽기 기준 — 마지막으로 본 **줄** 전체의 키.
 *  한 생성물이 여러 카드에 있었으면 (ts, id) 가 같은 줄이 여럿이라, 소속까지 넣어야
 *  쪽 경계에 걸친 나머지 소속이 누락되지 않는다(코덱스 재리뷰 P1). */
export interface CardHistoryCursor {
  ts: number;
  id: string;
  scene: string;
  card: string;
}

/** 로컬 캔버스 요약 — 판정에 필요한 것만 추린다. */
export interface LocalCanvasState {
  readable: boolean; // 씬 목록을 실제로 읽었나(false 면 판정 금지)
  attached: Set<string>; // 지금 어느 카드엔가 붙어 있는 생성물 id
  liveCards: Set<string>; // 살아 있는 "씬|카드" 조합
  sceneNames: Map<string, string>; // 살아 있는 씬 id → 이름
}

/** 가까운 순 — 숫자가 작을수록 이 카드에 가깝다. 정렬과 꼬리표가 같은 값을 쓴다. */
export type DetachedOrigin =
  | "this-card" // 바로 이 카드에 있었다
  | "this-scene-card-gone" // 같은 캔버스인데 그 카드가 지금 없다
  | "this-scene-other-card" // 같은 캔버스의 살아 있는 다른 카드
  | "other-scene"; // 다른 캔버스

const ORIGIN_RANK: Record<DetachedOrigin, number> = {
  "this-card": 0,
  "this-scene-card-gone": 1,
  "this-scene-other-card": 2,
  "other-scene": 3,
};

export interface DetachedCandidate {
  generationId: string;
  sceneId: string;
  cardId: string;
  origin: DetachedOrigin;
  label: string;
}

export interface DetachedResult {
  /** unreadable = 로컬을 못 읽어 판정 불가. 이때 items 는 비고, 화면은 안내만 띄운다. */
  status: "ok" | "unreadable";
  items: DetachedCandidate[];
}

export const cardKey = (sceneId: string, cardId: string): string => `${sceneId}|${cardId}`;

/** 씬 목록 → 판정 재료. readable=false 면 목록 내용과 무관하게 판정하지 않는다. */
export function readLocalCanvasState(
  scenes: Scene[] | null,
  readable: boolean,
): LocalCanvasState {
  const attached = new Set<string>();
  const liveCards = new Set<string>();
  const sceneNames = new Map<string, string>();
  if (!readable || !scenes) {
    return { readable: false, attached, liveCards, sceneNames };
  }
  for (const scene of scenes) {
    sceneNames.set(scene.id, scene.name);
    for (const card of scene.cards || []) {
      liveCards.add(cardKey(scene.id, card.id));
      for (const genId of variantIds(card)) {
        if (genId) attached.add(genId);
      }
    }
  }
  return { readable: true, attached, liveCards, sceneNames };
}

function classify(
  link: CardHistoryLink,
  local: LocalCanvasState,
  target: { sceneId: string; cardId: string },
): DetachedOrigin {
  // ★'이 카드'는 씬+카드 둘 다 같아야 한다 — 카드 id 만 비교하면 다른 캔버스의 동명 카드가 섞인다.
  if (link.scene_id === target.sceneId) {
    if (link.card_id === target.cardId) return "this-card";
    return local.liveCards.has(cardKey(link.scene_id, link.card_id))
      ? "this-scene-other-card"
      : "this-scene-card-gone";
  }
  return "other-scene";
}

/** 꼬리표 — '어디서 나왔나'가 아니라 '어디에 있었나'로 적는다.
 *  수동으로 담았던 것과 그 카드에서 생성된 것을 서버 기록만으로는 가를 수 없기 때문이다
 *  (수동 담기도 manual_ attempt 를 남긴다 — 코덱스 P1). 둘 다 참인 문장으로 쓴다. */
export function detachedLabel(
  origin: DetachedOrigin,
  link: CardHistoryLink,
  local: LocalCanvasState,
): string {
  if (origin === "this-card") return "이 카드에 있었음";
  if (origin === "this-scene-card-gone") return "이 캔버스 · 지워진 카드";
  if (origin === "this-scene-other-card") return "이 캔버스 · 다른 카드";
  const name = local.sceneNames.get(link.scene_id);
  return name ? `다른 캔버스 · ${name}` : "다른 캔버스 · 지워짐";
}

/**
 * 지난 소속 목록에서 '지금 이 브라우저의 캔버스에 안 붙어 있는' 것만 골라 가까운 순으로 준다.
 *
 * links 는 서버가 최신순으로 준 순서를 그대로 유지한다(정렬은 안정 정렬이라 같은 순위 안에서
 * 최신이 위). 한 생성물이 여러 카드에 있었으면 가장 가까운 자리 하나로 접는다.
 */
export function detachedCandidates(
  links: CardHistoryLink[],
  local: LocalCanvasState,
  target: { sceneId: string; cardId: string },
): DetachedResult {
  if (!local.readable) return { status: "unreadable", items: [] };
  const best = new Map<string, DetachedCandidate>();
  const order: string[] = [];
  for (const link of links) {
    const genId = link.generation_id;
    if (!genId || !link.scene_id || !link.card_id) continue;
    if (local.attached.has(genId)) continue; // 지금 어딘가에 붙어 있다 — 미아가 아니다
    const origin = classify(link, local, target);
    const previous = best.get(genId);
    if (previous && ORIGIN_RANK[previous.origin] <= ORIGIN_RANK[origin]) continue;
    if (!previous) order.push(genId);
    best.set(genId, {
      generationId: genId,
      sceneId: link.scene_id,
      cardId: link.card_id,
      origin,
      label: detachedLabel(origin, link, local),
    });
  }
  const items = order.map((genId) => best.get(genId)!);
  items.sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin]);
  return { status: "ok", items };
}
