import type { Generation, GenQuery, WorkspaceContext } from "../types";

/** 표시 범위일 뿐, 공유 권한이나 생성 요청의 워크스페이스를 바꾸지 않는다. */
export type LibraryWorkspaceFilter = Pick<GenQuery, "workspace_ids" | "workspace_scope">;
export type SharedWorkspaceMode = "auto" | "all";

export function workspaceViewKey(workspace: WorkspaceContext): string {
  return JSON.stringify([workspace.scope, workspace.id]);
}

export function sharedWorkspaceFilter(workspace: WorkspaceContext): LibraryWorkspaceFilter {
  if (workspace.scope === "team" && workspace.id) return { workspace_ids: [workspace.id] };
  if (workspace.scope === "personal") return { workspace_scope: "personal" };
  return {}; // unknown은 호출부의 준비 상태로 조회 자체를 막는다.
}

export function workspaceFilterOf(query: LibraryWorkspaceFilter): LibraryWorkspaceFilter {
  return {
    ...(query.workspace_ids?.length ? { workspace_ids: [...new Set(query.workspace_ids)].sort() } : {}),
    ...(query.workspace_scope ? { workspace_scope: query.workspace_scope } : {}),
  };
}

export function hasWorkspaceFilter(filter: LibraryWorkspaceFilter): boolean {
  return !!(filter.workspace_ids?.length || filter.workspace_scope);
}

export function matchesWorkspaceFilter(generation: Generation, filter: LibraryWorkspaceFilter): boolean {
  if (filter.workspace_scope && generation.workspace_scope !== filter.workspace_scope) return false;
  if (filter.workspace_ids?.length && (generation.workspace_scope !== "team" ||
      !generation.workspace_id || !filter.workspace_ids.includes(generation.workspace_id))) return false;
  return true;
}
