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
    project_id: filters.project_id,
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
