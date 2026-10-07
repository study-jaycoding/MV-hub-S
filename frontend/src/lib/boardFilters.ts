// 캔버스의 툴바 필터·폴더 선택 판정 — 한 기준을 두 곳이 쓴다.
//  · 캔버스 노드(HistoryBoardNode): 안 맞으면 흐리게.
//  · '생성 결과' 창(SceneBoard): 필터에 안 맞으면 걸러 내고, 고른 폴더 밖이면 흐리게.
import { matchesReviewFilter, type ReviewFilter } from "./generationReview";
import type { MediaFilter } from "./mediaTypes";
import type { Generation } from "../types";

export interface BoardFilters {
  typeFilter: MediaFilter;
  colorFilter?: Set<string>;
  tagFilter?: Set<string>;
  sharedOnly: boolean;
  reviewFilter?: ReviewFilter;
  commentOnly: boolean;
  finalOnly: boolean;
}

export function matchesBoardFilters(generation: Generation, filters: BoardFilters): boolean {
  const { typeFilter, colorFilter, tagFilter, sharedOnly, reviewFilter = "shared", commentOnly, finalOnly } = filters;
  if (typeFilter !== "all" && generation.assets[0]?.type !== typeFilter) return false;
  if (colorFilter && colorFilter.size > 0 && !(generation.color && colorFilter.has(generation.color))) return false;
  if (tagFilter && tagFilter.size > 0 && !generation.tags.some((tag) => tagFilter.has(tag))) return false;
  if (sharedOnly && !matchesReviewFilter(generation, reviewFilter)) return false;
  if (commentOnly && generation.comment_count === 0) return false;
  if (finalOnly && !generation.is_final) return false;
  return true;
}

export type BoardFolderSelection = { projectId: string; path: string } | null | undefined;

// 사이드바에서 고른 폴더(하위 포함) 안인가. path==="" 는 프로젝트 루트 선택 — 프로젝트만 맞으면 된다. 고른 폴더가 없으면 모두 '안'.
export function inBoardFolder(generation: Generation, folderSel: BoardFolderSelection): boolean {
  if (!folderSel) return true;
  return (
    generation.project_id === folderSel.projectId &&
    (folderSel.path === "" ||
      generation.folder_path === folderSel.path ||
      (generation.folder_path?.startsWith(folderSel.path + "/") ?? false))
  );
}
