// 공유 & 리뷰 탭의 '폴더 묶음 보기' 규칙(순수) — 고른 폴더 바로 아래 폴더마다 카드 한 장으로 보일 수 있는 조회인가.
import type { GenQuery } from "../types";

export interface FolderCardsScope {
  projectId: string;
  parent: string;
  workspaceId?: string;
}

// 묶어 보일 수 있는 조회면 그 범위를, 아니면 null(지금처럼 한 장씩 보인다).
//  프로젝트만 골랐으면 맨 위 폴더(에피소드)마다, 폴더를 골랐으면 그 바로 아래(컷)마다 카드 한 장이다.
//  서버가 세는 범위(팀 목록의 가시성 + 팀 공간 하나)와 화면의 조회가 정확히 같을 때만 묶는다. 무엇을 '찾는' 조건
//  (검색·작성자·타입·검토·색·태그…)이 하나라도 켜져 있으면 결과 목록이 맞고, 색·태그·회색 숨김처럼 이 PC 에만 있는
//  조건은 서버가 셀 수 없다. 공간 필터는 팀 공간 하나까지만 서버가 같은 식으로 거른다.
export function folderCardsScope(query: GenQuery, grayOn: boolean): FolderCardsScope | null {
  if (query.tab !== "team" || !query.project_id || query.project_id === "none") return null;
  if (grayOn || query.search || query.creator_uid || query.worker_id || query.share_dir || query.local_only) return null;
  if (query.include_deleted || query.deleted_only || query.color || query.tag) return null;
  if (query.media_type || query.review_filter || query.shared_only || query.comment_only || query.final_only) return null;
  if (query.colors?.length || query.tags?.length || query.auto_tags?.length) return null;
  if (query.workspace_scope || (query.workspace_ids?.length ?? 0) > 1) return null;
  const workspaceId = singleTeamWorkspace(query);
  return { projectId: query.project_id, parent: query.folder_path ?? "", ...(workspaceId ? { workspaceId } : {}) };
}

// 조회가 팀 공간 하나로만 거르고 있으면 그 id — 서버가 폴더 카드를 같은 식으로 거를 수 있는 유일한 공간 조건이다.
export function singleTeamWorkspace(query: GenQuery): string | undefined {
  return !query.workspace_scope && query.workspace_ids?.length === 1 ? query.workspace_ids[0] : undefined;
}

// path 가 base 안에 드는가(같은 폴더 포함) — base "" 는 프로젝트 맨 위라 모두 든다. 글자 그대로 견준다(서버의 폴더 카드와 같은 기준).
export function folderUnder(path: string, base: string): boolean {
  return !base || path === base || path.startsWith(base + "/");
}

// 그 폴더의 부모 경로 — 맨 위 폴더의 부모는 ""(프로젝트의 맨 위 폴더들).
export function parentFolder(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}
