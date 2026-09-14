import type { MediaFilter } from "./mediaTypes";
import type { Filters, GenQuery } from "../types";

export interface GenerationQueryInput {
  filters: Filters;
  typeFilter: MediaFilter;
  colorFilter: Set<string>;
  tagFilter: Set<string>;
  armedAutoTags: Set<string>;
  sharedOnly: boolean;
  commentOnly: boolean;
  finalOnly: boolean;
}

export function buildGenerationQuery({
  filters,
  typeFilter,
  colorFilter,
  tagFilter,
  armedAutoTags,
  sharedOnly,
  commentOnly,
  finalOnly,
}: GenerationQueryInput): GenQuery {
  return {
    tab: filters.tab === "compose" ? "my" : filters.tab,
    worker_id: filters.worker_id,
    share_dir: filters.share_dir,
    local_only: filters.local_only,
    creator_uid: filters.creator_uid,
    // 정렬한 사본을 보낸다 — 고른 순서가 달라도 같은 조회여야 한다(쿼리 키가 JSON 문자열이라
    // [A,B] 와 [B,A] 가 다른 조회로 잡히면 같은 결과를 두 번 받는다).
    workspace_ids: filters.workspace_ids?.length
      ? [...new Set(filters.workspace_ids)].sort()
      : undefined,
    project_id: filters.project_id,
    folder_path: filters.folder_path,
    search: filters.search,
    include_deleted: filters.include_deleted,
    deleted_only: filters.deleted_only,
    media_type: typeFilter === "all" ? undefined : typeFilter,
    colors: [...colorFilter].sort(),
    tags: [...tagFilter].sort(),
    auto_tags: [...armedAutoTags].sort(),
    shared_only: sharedOnly || undefined,
    comment_only: commentOnly || undefined,
    final_only: finalOnly || undefined,
  };
}

export function generationQueryKey(query: GenQuery): string {
  return JSON.stringify(query);
}
