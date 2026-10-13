// 공유 & 리뷰 탭의 '폴더 묶음 보기' 규칙(순수) — 고른 폴더 바로 아래 폴더마다 카드 한 장으로 보일 수 있는 조회인가.
import type { GenQuery } from "../types";

export interface FolderCardsScope {
  projectId: string;
  parent: string;
  workspaceId?: string;
}

// 묶어 보일 **자리**면 그 범위를, 아니면 null(한 장씩 보인다) — 공유 탭에서 프로젝트(또는 그 폴더)를 골랐고 휴지통이 아닐 때.
//  프로젝트만 골랐으면 맨 위 폴더(에피소드)마다, 폴더를 골랐으면 그 바로 아래(컷)마다 카드 한 장이다.
//  무엇을 '찾는' 조건(아래 hasFindFilters)이 켜져 있어도 자리는 자리다 — 그때는 서버 카드 대신 걸러진 목록을 화면이 직접 묶는다
//  (lib/folderCardsLocal · Jay 2026-10-13 저녁: 묶인 상태에서 태그·작성자·종류를 눌러도 묶음이 풀리지 않게).
//  공간 조건만은 자리의 일부다: 서버가 폴더 카드를 같은 식으로 거를 수 있는 것은 팀 공간 하나까지다.
export function folderCardsPlace(query: GenQuery): FolderCardsScope | null {
  if (query.tab !== "team" || !query.project_id || query.project_id === "none") return null;
  if (query.include_deleted || query.deleted_only) return null;
  if (query.workspace_scope || (query.workspace_ids?.length ?? 0) > 1) return null;
  const workspaceId = singleTeamWorkspace(query);
  return { projectId: query.project_id, parent: query.folder_path ?? "", ...(workspaceId ? { workspaceId } : {}) };
}

// 무엇을 '찾는' 조건이 켜져 있는가(검색·작성자·종류·검토·색·태그·회색 숨김…) — 켜져 있으면 서버 카드(그 폴더의 **전부**를 센다)는 화면의
//  조회와 범위가 다르다. 색·태그·회색 숨김은 이 PC 에만 있어 서버가 셀 수도 없다.
export function hasFindFilters(query: GenQuery, grayOn: boolean): boolean {
  return !!(
    grayOn || query.search || query.creator_uid || query.worker_id || query.share_dir || query.local_only
    || query.color || query.tag || query.media_type || query.review_filter || query.shared_only || query.comment_only || query.final_only
    || query.colors?.length || query.tags?.length || query.auto_tags?.length
  );
}

// 서버 카드만으로 묶을 수 있는 조회면 그 범위 — 자리이고 찾는 조건이 없을 때(서버가 세는 범위와 화면의 조회가 정확히 같다).
export function folderCardsScope(query: GenQuery, grayOn: boolean): FolderCardsScope | null {
  return hasFindFilters(query, grayOn) ? null : folderCardsPlace(query);
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
