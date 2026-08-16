import { loadJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export interface ManageWorkspaceScope {
  workspaceId?: string;
}

/** 메인 라이브러리 필터에서 관리 창이 따라갈 workspace ID만 안전하게 읽는다. */
export function workspaceScopeFromLibraryFilters(value: unknown): ManageWorkspaceScope {
  if (!value || typeof value !== "object") return {};
  const workspaceId = (value as { workspace_id?: unknown }).workspace_id;
  return typeof workspaceId === "string" && workspaceId.trim()
    ? { workspaceId: workspaceId.trim() }
    : {};
}

export function loadManageWorkspaceScope(): ManageWorkspaceScope {
  return workspaceScopeFromLibraryFilters(loadJSON<unknown>(STORAGE_KEYS.libraryFilters));
}
