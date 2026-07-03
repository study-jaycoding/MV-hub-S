import type { Creator, Member, Project, ProjectsResponse, Workspace } from "../types";
import { jsonBody, jsonFetch } from "./http";
import { pathPart } from "./url";

export const projectApi = {
  // 프로젝트(작업 묶음) — 공유·이동의 단위
  projects: (tab: "my" | "team" = "my", includeArchived = false) => {
    const p = new URLSearchParams({ tab });
    if (includeArchived) p.set("include_archived", "true");
    return jsonFetch<ProjectsResponse>(`/api/projects?${p.toString()}`);
  },
  myFinalizeRoles: () =>
    jsonFetch<{ project_ids: string[] }>("/api/projects/my-finalize-roles"),
  createProject: (name: string, kind = "team") =>
    jsonFetch<Project>("/api/projects", {
      method: "POST",
      body: jsonBody({ name, kind }),
    }),
  updateProject: (id: string, patch: { name?: string; archived?: boolean }) =>
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
  // 프로젝트의 폴더별 생성물 개수 {folder_path: n} — 사이드바 트리 뱃지·필터 표시용.
  projectFolderCounts: (id: string, tab: "my" | "team" = "my") =>
    jsonFetch<{ counts: Record<string, number> }>(
      `/api/projects/${pathPart(id)}/folder-counts?tab=${tab}`,
    ),
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
  assignProject: (
    generationIds: string[],
    projectId: string | null,
    tab: "my" | "team" = "my",
    folderPath?: string | null, // 담을 때 함께 지정하는 폴더(렌더 루트 상대 경로)
  ) =>
    jsonFetch<{ ok: boolean; updated: number; team_synced?: boolean | null }>(`/api/projects/assign?tab=${tab}`, {
      method: "POST",
      body: jsonBody({
        generation_ids: generationIds,
        project_id: projectId,
        folder_path: folderPath ?? null,
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
  projectMembersAll: () =>
    jsonFetch<Record<string, import("../types").ProjectMember[]>>(
      "/api/projects/members-all",
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
  creators: (tab: "my" | "team" = "my", projectId?: string) => {
    const p = new URLSearchParams({ tab });
    if (projectId) p.set("project_id", projectId);
    return jsonFetch<Creator[]>(`/api/creators?${p.toString()}`);
  },

  // 워크스페이스(팀 공유 UUID 공간) — 목록·선택·해제
  workspaces: () => jsonFetch<Workspace[]>("/api/workspaces"),
  selectWorkspace: (workspace_id: string) =>
    jsonFetch<{ workspaces: Workspace[] }>("/api/workspaces/select", {
      method: "POST",
      body: jsonBody({ workspace_id }),
    }),
  unselectWorkspace: () =>
    jsonFetch<{ workspaces: Workspace[] }>("/api/workspaces/unselect", {
      method: "POST",
      body: jsonBody({}),
    }),
};
