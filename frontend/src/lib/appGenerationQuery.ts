import { workspaceFilterOf } from "./libraryWorkspaceScope";
import type { MediaFilter } from "./mediaTypes";
import type { Filters, GenQuery } from "../types";

export interface GenerationQueryInput {
  filters: Filters;
  typeFilter: MediaFilter;
  colorFilter: Set<string>;
  tagFilter: Set<string>;
  armedAutoTags: Set<string>;
  sharedOnly: boolean;
  reviewFilter?: GenQuery["review_filter"];
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
  reviewFilter = "shared",
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
    review_filter: sharedOnly ? reviewFilter : undefined,
    comment_only: commentOnly || undefined,
    final_only: finalOnly || undefined,
  };
}

// 목록 탭의 '폴더 보기' 창(카드의 폴더 이름표로 연 것)이 떠 있는 동안의 목록 조회 — 그 폴더(하위 포함)에 무엇이 있는지 본다.
// 따르는 조건을 **하나씩 적는다**: 탭·공간 범위, 그리고 창 툴바에 보여서 창에서 바꿀 수 있는 조건(타입·색·태그·공유/검토·
// 코멘트·최종)뿐. 창에서 안 보이는 조건(검색·작성자·자동 태그·휴지통 등)까지 따라오면 폴더에 있는 것이 말없이 빠진다.
// 프로젝트가 없는 폴더는 project_id="none" — 생략하면 다른 프로젝트의 같은 이름 폴더가 섞인다.
export function folderPeekQuery(query: GenQuery, folder: { projectId: string | null; path: string }): GenQuery {
  return {
    tab: query.tab,
    ...workspaceFilterOf(query),
    project_id: folder.projectId ?? "none",
    folder_path: folder.path,
    media_type: query.media_type,
    colors: query.colors,
    tags: query.tags,
    review_filter: query.review_filter,
    comment_only: query.comment_only,
    final_only: query.final_only,
  };
}

export function generationQueryKey(query: GenQuery): string {
  return JSON.stringify(query);
}
