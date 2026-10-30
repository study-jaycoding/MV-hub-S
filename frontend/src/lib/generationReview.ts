import type { Generation, GenQuery } from "../types";

export type ReviewFilter = NonNullable<GenQuery["review_filter"]>;
export type ReviewAction = "unshared" | "shared" | "held" | "final";

// 조작 진입점의 표시 규칙. 읽기 전용 공유/최종 배지의 표시 여부와는 별개다.
export function canShowShareAction(generation: Generation, mayFinalize: boolean): boolean {
  return !!(generation.is_mine || generation.is_final || generation.is_held || (generation.shared && mayFinalize));
}

export function reviewState(generation: Generation): ReviewAction {
  return generation.is_final ? "final" : generation.is_held ? "held" : generation.shared ? "shared" : "unshared";
}

// 워크스페이스·캔버스 S 선택 창(Jay 2026-10-30) — 공유 탭 창과 달리 보류가 없고 위 = 올리기 · 아래 = 해제.
export function workspaceReviewOptions(generation: Generation): ReviewAction[] {
  return generation.shared && !generation.is_final ? ["final", "unshared"] : ["shared", "unshared"];
}

// 창을 여는 조건 = 바꿀 수 있는 카드. 남의 비공유·권한 없는 최종(읽기 전용 표식)은 무반응이다.
export function canOpenWorkspaceReview(generation: Generation, mayFinalize: boolean): boolean {
  return generation.is_final ? mayFinalize : !!generation.is_mine || (generation.shared && mayFinalize);
}

// 위 조건을 지나 창이 열린 카드에서는 공유·해제가 늘 가능하다. 최종만 권한을 따로 본다.
export const workspaceReviewAllowed = (mayFinalize: boolean): Record<ReviewAction, boolean> =>
  ({ unshared: true, shared: true, held: false, final: mayFinalize });

export interface WorkspaceReviewHandlers {
  onPublish: (generation: Generation) => void;
  onUnpublish: (generation: Generation) => void;
  onFinalize: (generation: Generation) => void;
  onUnfinalize: (generation: Generation) => void;
  onReview?: (generation: Generation, action: ReviewAction) => void;
}

// 쓰던 공유·최종 처리로 보낸다. 최종 → 해제만 공유 탭과 같은 전환이다 — 최종 풀기와 공유 해제를 나누어 부르면 중간 상태가 남는다.
export function applyWorkspaceReview(generation: Generation, action: ReviewAction, handlers: WorkspaceReviewHandlers) {
  if (action === "final") handlers.onFinalize(generation);
  else if (action === "shared") (generation.is_final ? handlers.onUnfinalize : handlers.onPublish)(generation);
  else if (generation.is_final) handlers.onReview?.(generation, "unshared");
  else handlers.onUnpublish(generation);
}

export function matchesReviewFilter(generation: Generation, filter: ReviewFilter): boolean {
  return generation.shared && !generation.is_final &&
    (filter === "held" ? !!generation.is_held : !generation.is_held);
}

export function reviewTargets(
  generations: Generation[],
  action: ReviewAction,
  canFinalize: (generation: Generation) => boolean,
): Generation[] {
  return generations.filter((generation) => {
    if (!generation.shared || generation.deleted || generation.status !== "done" || reviewState(generation) === action) return false;
    if (action === "unshared" && !generation.is_final) return generation.is_mine || canFinalize(generation);
    return canFinalize(generation);
  });
}
