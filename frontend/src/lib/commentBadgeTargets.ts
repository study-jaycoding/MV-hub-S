// 코멘트 배지 폴링의 **판정 로직** — 누구에게 물을지, 무엇이 바뀐 것인지.
//
// 훅 본체(useCommentBadgePoll)에서 떼어낸 이유: 이 저장소에는 React 렌더 시험 도구가 없어
// (testing-library·jsdom 없음) 훅을 그대로는 시험할 수 없다. 판정만 순수 함수로 두면
// 이 저장소의 다른 프론트 시험처럼 vitest 로 못 박을 수 있다.
import type { Generation } from "../types";

export interface CommentCount {
  comment_count: number;
  has_unread: boolean;
}

export interface PanelSeen {
  id: string;
  comment_count: number;
  has_unread: boolean;
}

/** 이번 주기에 물어볼 생성물 id — 공유 카드 + 열린 코멘트 패널. 중복은 없앤다.
 *
 * ★열린 패널을 반드시 넣는다: 알림에서 연 생성물은 현재 목록(`generations`)에 없을 수 있는데,
 *  그때도 새 코멘트를 잡아야 패널이 갱신된다(종전엔 목록만 돌아 이 경우가 빠졌다).
 */
export function commentBadgeTargets(
  generations: Generation[],
  openCommentGenId?: string | null,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const g of generations) {
    if (!g.shared || seen.has(g.id)) continue;
    seen.add(g.id);
    ids.push(g.id);
  }
  if (openCommentGenId && !seen.has(openCommentGenId)) ids.push(openCommentGenId);
  return ids;
}

export interface BadgeDecision {
  /** 목록 카드의 배지 값이 실제로 달라졌나(불필요한 리렌더 방지). */
  anyChange: boolean;
  /** 열린 패널을 새로고침해야 하나(새 코멘트가 온 카드가 있다). */
  notifyPanel: boolean;
  /** 다음 주기의 패널 비교 기준. 패널이 없거나 응답에 없으면 null. */
  nextPanelSeen: PanelSeen | null;
}

/** 받아 온 배지 수를 이전 상태와 비교해 무엇을 해야 하는지 정한다. */
export function decideCommentBadgeUpdate(
  generations: Generation[],
  counts: Record<string, CommentCount | undefined>,
  openCommentGenId: string | null | undefined,
  panelSeen: PanelSeen | null,
): BadgeDecision {
  let anyChange = false;
  let notifyPanel = false;
  for (const g of generations) {
    if (!g.shared) continue;
    const c = counts[g.id];
    if (!c) continue;
    if (c.has_unread !== g.has_unread || c.comment_count !== g.comment_count) anyChange = true;
    // 새 코멘트가 온 카드(미확인 전환 또는 코멘트 수 증가) → 열린 패널을 새로고침.
    if ((c.has_unread && !g.has_unread) || c.comment_count > g.comment_count) notifyPanel = true;
  }

  // 패널 대상은 목록에 없을 수 있으므로 **따로** 비교한다. 기준은 직전 주기의 값이고,
  // 패널이 바뀌면(다른 생성물을 열었다) 기준을 버려 첫 주기에 헛알림이 나지 않게 한다.
  let nextPanelSeen: PanelSeen | null = null;
  if (openCommentGenId) {
    const c = counts[openCommentGenId];
    if (c) {
      const base = panelSeen && panelSeen.id === openCommentGenId ? panelSeen : null;
      if (
        base &&
        (c.comment_count > base.comment_count || (c.has_unread && !base.has_unread))
      ) {
        notifyPanel = true;
      }
      nextPanelSeen = {
        id: openCommentGenId,
        comment_count: c.comment_count,
        has_unread: c.has_unread,
      };
    }
  }
  return { anyChange, notifyPanel, nextPanelSeen };
}
