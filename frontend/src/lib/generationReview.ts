import type { Generation, GenQuery } from "../types";

export type ReviewFilter = NonNullable<GenQuery["review_filter"]>;
export type ReviewAction = "unshared" | "shared" | "held" | "final";

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
