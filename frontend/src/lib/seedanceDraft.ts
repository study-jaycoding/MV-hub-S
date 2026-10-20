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
