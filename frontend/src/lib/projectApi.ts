import type {
  Creator,
  FolderReviewCounts,
  Member,
  Project,
  ProjectsResponse,
  Workspace,
  WorkspaceContext,
  WorkspaceMemberCandidate,
  WorkspaceOption,
} from "../types";
import { HttpError, jsonBody, jsonFetch } from "./http";
import { hasWorkspaceFilter, workspaceFilterOf, type LibraryWorkspaceFilter } from "./libraryWorkspaceScope";
import { pathPart } from "./url";

export interface TeamFreshItem {
  id: string;
  project_id: string | null;
  folder_path: string | null;
  shared_at: string | null;
  ack_key?: string | null;
  creator_uid?: string | null; // 미지원(필드 부재)과 작성자 미상(null)을 구분한다.
}

interface FolderCountsResponse {
  counts: Record<string, number>;
  review_counts?: Record<string, FolderReviewCounts>;
  creator_filter_uid?: string;
}

interface FolderCountsBatchResponse {
  counts: Record<string, Record<string, number>>;
  review_counts?: Record<string, Record<string, FolderReviewCounts>>;
  creator_filter_uid?: string;
  project_counts?: Record<string, number>;
  unassigned_count?: number;
}

function requireCreatorCountScope(result: { creator_filter_uid?: string }, creatorUid?: string) {
  if (creatorUid && result?.creator_filter_uid !== creatorUid) {
    throw new HttpError(409, "생성자별 개수 표시에는 앱과 공유 서버 업데이트가 필요합니다.");
  }
}

interface TeamFreshCursor {
  shared_at: string;
  id: string;
}

interface TeamFreshPage {
  items: TeamFreshItem[];
  next_cursor?: TeamFreshCursor | null;
}

function teamFreshPage(since: string, cursor: TeamFreshCursor | null = null): Promise<TeamFreshPage> {
  const p = new URLSearchParams({ since, limit: "500" });
  if (cursor) {
    p.set("cursor_shared_at", cursor.shared_at);
    p.set("cursor_id", cursor.id);
  }
  return jsonFetch<TeamFreshPage>(`/api/projects/team-fresh?${p.toString()}`);
}

async function readAllTeamFresh(since: string): Promise<TeamFreshItem[]> {
  const out: TeamFreshItem[] = [];
  const itemIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: TeamFreshCursor | null = null;
  for (;;) {
    const page = await teamFreshPage(since, cursor);
    for (const item of page.items || []) {
      if (!itemIds.has(item.id)) {
        itemIds.add(item.id);
        out.push(item);
      }
    }
    const next = page.next_cursor;
    if (!next) break; // 구서버 응답도 여기서 1페이지 호환 종료
    const key = `${next.shared_at}\u0000${next.id}`;
    if (cursors.has(key)) throw new Error("team-fresh 페이지 커서가 반복되었습니다");
    cursors.add(key);
    cursor = next;
  }
  return out;
}

// 같은 기준선·계정/서버/공간 문맥으로 도는 조회가 이미 있으면 **합류**한다(단일비행).
// ★왜(2026-09-12 실측): 이 목록은 기준선 이후 60일치 공유 **전체**이고 500건씩 **순차** 왕복이다
//  (실측 413건 = 85.7KB 한 페이지). 호출부는 갱신마다 요청 번호를 올려 옛 실행을 무효로 만들었는데,
//  팀 탭의 15초 폴이 그 갱신을 계속 일으킨다 — 전체 조회가 15초보다 길면 **매번 완독 전에 폐기**돼
//  배지가 영영 갱신되지 않는다. 합류하면 왕복이 한 벌로 줄고 완독이 보장된다.
//  늦은 결과를 화면에 반영할지 말지는 호출부의 판단으로 그대로 남긴다.
let teamFreshInflight: { key: string; promise: Promise<TeamFreshItem[]> } | null = null;

export function fetchAllTeamFresh(since: string, contextKey = ""): Promise<TeamFreshItem[]> {
  const key = JSON.stringify([since, contextKey]);
  if (teamFreshInflight && teamFreshInflight.key === key) return teamFreshInflight.promise;
  const promise = readAllTeamFresh(since).finally(() => {
    if (teamFreshInflight?.promise === promise) teamFreshInflight = null;
  });
  teamFreshInflight = { key, promise };
  return promise;
}

export const projectApi = {
  // 프로젝트(작업 묶음) — 공유·이동의 단위
  projects: (tab: "my" | "team" = "my", includeArchived = false, workspaceId?: string) => {
    const p = new URLSearchParams({ tab });
    if (includeArchived) p.set("include_archived", "true");
    if (workspaceId) p.set("workspace_id", workspaceId);
    return jsonFetch<ProjectsResponse>(`/api/projects?${p.toString()}`);
  },
  workspaceOptions: () =>
    jsonFetch<{ workspaces: WorkspaceOption[] }>("/api/projects/workspace-options"),
  workspaceMembers: (workspaceId: string) =>
    jsonFetch<{ members: WorkspaceMemberCandidate[] }>(
      `/api/projects/workspace-options/${pathPart(workspaceId)}/members`,
    ),
  myFinalizeRoles: () =>
    jsonFetch<{ project_ids: string[] }>("/api/projects/my-finalize-roles"),
  createProject: (
    name: string,
    kind = "team",
    workspace: WorkspaceContext = { scope: "unknown", id: null, name: null },
  ) =>
    jsonFetch<Project>("/api/projects", {
      method: "POST",
      body: jsonBody({ name, kind, workspace }),
    }),
  updateProject: (
    id: string,
    patch: {
      name?: string;
      archived?: boolean;
      render_root_path?: string | null;
      workspace?: WorkspaceContext;
    },
  ) =>
    jsonFetch<Project>(`/api/projects/${pathPart(id)}`, {
      method: "PATCH",
      body: jsonBody(patch),
    }),
  deleteProject: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/projects/${pathPart(id)}`, { method: "DELETE" }),
  reorderProjects: (ids: string[]) =>
    jsonFetch<{ ok: boolean }>("/api/projects/reorder", {
      method: "POST",
      body: jsonBody({ project_ids: ids }),
    }),
  projectFolderLinks: () =>
    jsonFetch<{ links: Record<string, import("../types").ProjectFolderLink> }>(
      "/api/manage/project-folders",
    ),
  projectFolder: (id: string) =>
    jsonFetch<import("../types").ProjectFolderState>(
      `/api/manage/project-folders/${pathPart(id)}`,
    ),
  openProjectFolder: (projectId: string, folderPath: string) =>
    jsonFetch<{ ok: boolean }>("/api/manage/project-folders/reveal", {
      method: "POST",
      body: jsonBody({ project_id: projectId, folder_path: folderPath }),
    }),
  // 프로젝트의 폴더별 생성물 개수 {folder_path: n} — 사이드바 트리 뱃지·필터 표시용.
  projectFolderCounts: async (id: string, tab: "my" | "team" = "my", creatorUid?: string) => {
    const params = new URLSearchParams({ tab });
    if (creatorUid) params.set("creator_uid", creatorUid);
    const result = await jsonFetch<FolderCountsResponse>(
      `/api/projects/${pathPart(id)}/folder-counts?${params.toString()}`,
    );
    requireCreatorCountScope(result, creatorUid);
    return result;
  },
  projectFolderCountsBatch: async (ids: string[], tab: "my" | "team" = "my", creatorUid?: string) => {
    const result = await jsonFetch<FolderCountsBatchResponse>(
      "/api/projects/folder-counts/batch",
      {
        method: "POST",
        body: jsonBody({ project_ids: ids, tab, ...(creatorUid ? { creator_uid: creatorUid } : {}) }),
      },
    );
    requireCreatorCountScope(result, creatorUid);
    if (creatorUid && (!Number.isSafeInteger(result.unassigned_count) || result.unassigned_count! < 0
      || ids.some(id => !Object.prototype.hasOwnProperty.call(result.project_counts ?? {}, id)
        || !Number.isSafeInteger(result.project_counts![id]) || result.project_counts![id] < 0
        || !Object.prototype.hasOwnProperty.call(result.counts ?? {}, id)
        || !result.counts[id] || typeof result.counts[id] !== "object" || Array.isArray(result.counts[id])
        || Object.values(result.counts[id]).some(n => !Number.isSafeInteger(n) || n < 0)
        || Object.values(result.counts[id]).reduce((sum, n) => sum + n, 0) > result.project_counts![id]))) {
      throw new HttpError(502, "생성자별 개수 응답이 올바르지 않습니다.");
    }
    return result;
  },
  // 기준선 이후 공유된 항목 목록 — 사이드바 +N(신규 라임 배지). 클라가 확인(클릭)분을 제외하고 센다.
  // 구버전 서버는 이 라우트가 없어 404 → 호출부가 빈 목록 폴백(배지만 숨김).
  teamFreshAll: fetchAllTeamFresh,
  setProjectFolder: (
    id: string,
    body: { root_path?: string; selected_path?: string },
  ) =>
    jsonFetch<import("../types").ProjectFolderState>(
      `/api/manage/project-folders/${pathPart(id)}`,
      {
        method: "PUT",
        body: jsonBody(body),
      },
    ),
  setProjectFolderSelection: (id: string, selectedPath: string) =>
    jsonFetch<import("../types").ProjectFolderLink>(
      `/api/manage/project-folders/${pathPart(id)}/selection`,
      {
        method: "PATCH",
        body: jsonBody({ selected_path: selectedPath }),
      },
    ),
  assignProject: (
    generationIds: string[],
    projectId: string | null,
    tab: "my" | "team" = "my",
    folderPath?: string | null, // 담을 때 함께 지정하는 폴더(렌더 루트 상대 경로)
    resumeWork = false, // 사용자 명시적 작업 재개에서만 opt-in
  ) =>
    jsonFetch<{ ok: boolean; updated: number; team_synced?: boolean | null }>(`/api/projects/assign?tab=${tab}`, {
      method: "POST",
      body: jsonBody({
        generation_ids: generationIds,
        project_id: projectId,
        folder_path: folderPath ?? null,
        ...(resumeWork ? { resume_work: true } : {}),
      }),
    }),

  // 멤버·전역역할(복수) — 관리자 창
  members: () => jsonFetch<Member[]>("/api/members"),
  setMemberGlobalRoles: (uid: string, global_roles: string[]) =>
    jsonFetch<Member[]>(`/api/members/${pathPart(uid)}/global-roles`, {
      method: "PATCH",
      body: jsonBody({ global_roles }),
    }),

  // 프로젝트 멤버·역할
  projectMembers: (pid: string) =>
    jsonFetch<import("../types").ProjectMember[]>(
      `/api/projects/${pathPart(pid)}/members`,
    ),
  // 전 프로젝트 멤버를 {pid: [...]} 한 번에 — 관리 창 prefetch(요청 N→1)
  allProjectMembers: () =>
    jsonFetch<Record<string, import("../types").ProjectMember[]>>(
      "/api/projects/members-all",
    ),
  // 현재 사용자가 읽을 수 있는 프로젝트의 멤버만 {pid: [...]} 한 번에 조회.
  visibleProjectMembers: () =>
    jsonFetch<Record<string, import("../types").ProjectMember[]>>(
      "/api/projects/members-visible",
    ),
  setProjectRoles: (pid: string, creator_uid: string, project_roles: string[]) =>
    jsonFetch<import("../types").ProjectMember[]>(
      `/api/projects/${pathPart(pid)}/members`,
      { method: "PATCH", body: jsonBody({ creator_uid, project_roles }) },
    ),
  removeProjectMember: (pid: string, uid: string) =>
    jsonFetch<import("../types").ProjectMember[]>(
      `/api/projects/${pathPart(pid)}/members/${pathPart(uid)}`,
      { method: "DELETE" },
    ),

  // 생성자(팀 워크스페이스 작성자) — 목록
  creators: async (tab: "my" | "team" = "my", projectId?: string, workspaceFilter?: LibraryWorkspaceFilter, folderPath?: string) => {
    const p = new URLSearchParams({ tab });
    if (projectId) p.set("project_id", projectId);
    const scope = workspaceFilterOf(workspaceFilter ?? {});
    if (tab === "my") {
      p.set("facet_scope", "library");
      if (folderPath) p.set("folder_path", folderPath);
    }
    for (const id of scope.workspace_ids ?? []) p.append("workspace_ids", id);
    if (scope.workspace_scope) p.set("workspace_scope", scope.workspace_scope);
    const result = await jsonFetch<Creator[] | { items: Creator[]; workspace_filter_applied?: boolean; creator_scope_applied?: boolean }>(
      `/api/creators?${p.toString()}`,
    );
    if (tab === "my") {
      if (!result || Array.isArray(result) || result.creator_scope_applied !== true || !Array.isArray(result.items)) {
        throw new HttpError(409, "작업 공간 생성자 표시에는 로컬 앱 업데이트가 필요합니다.");
      }
      return result.items;
    }
    if (!hasWorkspaceFilter(scope)) return result as Creator[];
    // 구서버가 모르는 조건을 무시하고 전체 건수를 보내도 현재 공간의 집계로 표시하지 않는다.
    if (!result || Array.isArray(result) || result.workspace_filter_applied !== true || !Array.isArray(result.items)) {
      throw new HttpError(409, "워크스페이스별 생성자 표시에는 공유 서버 업데이트가 필요합니다.");
    }
    return result.items;
  },

  // 워크스페이스(팀 공유 UUID 공간) — **읽기만** 한다.
  //  선택은 앱이 소유한다(로컬 저장 + 창 간 storage). 허브에 선택을 보내던 POST 두 개는
  //  2026-09-11 에 폐기(410)했다 — 허브가 CLI 전역을 바꾸면 에이전트와 그 상태를 나눠 쓰게 돼
  //  '확인 뒤 제출 전' 에 끼어드는 과금 경합이 생긴다. 래퍼도 같이 지운다(다시 쓰는 실수 방지).
  workspaces: () => jsonFetch<Workspace[]>("/api/workspaces"),
};
