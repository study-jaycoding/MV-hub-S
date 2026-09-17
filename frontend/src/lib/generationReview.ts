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
