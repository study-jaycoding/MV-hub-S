import { generationErrorMatches } from "./generationIssue";
type DraftGeneration = {
  model?: string | null;
  status?: string;
  params?: Record<string, unknown> | null;
  job_id?: string | null;
  is_mine?: boolean;
  deleted?: boolean;
};

export function isDraftGeneration(generation: DraftGeneration): boolean {
  return generation.model === "seedance_2_5"
    && generation.status === "done"
    && generation.params?.draft === true
    && !generation.params.draft_job_id;
}

export function canFinishDraft(generation: DraftGeneration): boolean {
  return isDraftGeneration(generation)
    && !!generation.job_id?.trim()
    && generation.is_mine === true
    && !generation.deleted;
}

/** 옵션 복원·일반 생성은 원격 Draft 작업을 다시 완성하지 않는다. */
export function normalizeSeedanceDraftParams(
  model: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...params };
  delete result.draft_job_id;
  if (model === "seedance_2_5" && result.resolution === "480p") result.draft = true;
  else delete result.draft;
  return result;
}


export type DraftResolution = "1080p" | "4k";
export const DRAFT_ACTIVE_PHASES = new Set([
  "preparing", "pending", "claimed", "submitting", "running", "tracking", "verifying", "blocked", "recovery_required",
]);

export function draftRequestKey(parentId: string, jobId: string, resolution: DraftResolution): string {
  return JSON.stringify([parentId, jobId, resolution]);
}

export function isDraftExpiredError(error?: string | null): boolean {
  return generationErrorMatches(error, /^Seedance 2\.5 draft has expired(?:$|[\s.!?;:—])/);
}

type DraftChild = DraftGeneration & { id: string; error?: string | null; execution_phase?: string | null; deleted_at?: string | null };
export function isExpiredDraftChild(child: DraftChild): boolean {
  return child.model === "seedance_2_5" && !!child.params?.draft_job_id
    && child.status !== "done" && child.status !== "canceled" && child.status !== "nsfw"
    && (!child.execution_phase || ["failed", "blocked", "recovery_required"].includes(child.execution_phase))
    && (child.status === "failed" || ["failed", "blocked", "recovery_required"].includes(child.execution_phase || ""))
    && isDraftExpiredError(child.error);
}

export function summarizeDraftChildren(jobId: string, children: DraftChild[]) {
  const done = { "1080p": 0, "4k": 0 };
  const pending = { "1080p": false, "4k": false };
  let expired = false;
  const seen = new Set<string>();
  for (const child of children) {
    if (seen.has(child.id) || child.deleted || child.deleted_at || child.model !== "seedance_2_5"
      || child.params?.draft_job_id !== jobId) continue;
    seen.add(child.id);
    const resolution = child.params.resolution ?? "1080p";
    if (resolution !== "1080p" && resolution !== "4k") continue;
    const active = child.execution_phase ? DRAFT_ACTIVE_PHASES.has(child.execution_phase)
      : child.status === "pending" || child.status === "running";
    if (active) pending[resolution] = true;
    if (child.status === "done" && !active) done[resolution]++;
    expired ||= isExpiredDraftChild(child);
  }
  return { done, pending, expired };
}
