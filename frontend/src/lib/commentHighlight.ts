// Slack 알림 링크로 열고 온 코멘트를 코멘트 창에서 한 번 강조한다(Jay 2026-11-05 시안 v4 — 3번 깜빡이고 멈춤).
// 열기 처리(useOpenGeneration)가 먼저 요청하고, 코멘트 창은 그 코멘트를 받아 그렸을 때 가져간다 — 창이 아직 안 떴어도 잃지 않게 잠깐 들고 있는다.
export const COMMENT_HIGHLIGHT_EVENT = 'mvhub:comment-highlight';
const KEEP_MS = 10_000;
let sequence = 0;
export interface CommentHighlight { id: string; sequence: number }
let pending: (CommentHighlight & { until: number }) | null = null;

export function requestCommentHighlight(id: string) {
  pending = { id, sequence: ++sequence, until: Date.now() + KEEP_MS };
  window.dispatchEvent(new Event(COMMENT_HIGHLIGHT_EVENT));
}

/** 그린 코멘트 중에 요청한 것이 있으면 한 번만 돌려준다. */
export function takeCommentHighlight(ids: readonly string[]): string | null {
  return takeCommentHighlightRequest(ids)?.id ?? null;
}

export function takeCommentHighlightRequest(ids: readonly string[]): CommentHighlight | null {
  if (!pending || pending.until < Date.now()) { pending = null; return null; }
  if (!ids.includes(pending.id)) return null;
  const { id, sequence } = pending;
  pending = null;
  return { id, sequence };
}
