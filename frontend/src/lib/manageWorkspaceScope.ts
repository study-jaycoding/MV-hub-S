import { loadJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export interface ManageWorkspaceScope {
  workspaceId?: string;
}

/** 저장된 워크스페이스 컨텍스트에서 관리/에셋 창이 따라갈 팀 workspace ID만 안전하게 읽는다. */
export function workspaceScopeFromContext(value: unknown): ManageWorkspaceScope {
  if (!value || typeof value !== "object") return {};
  const scope = (value as { scope?: unknown }).scope;
  const id = (value as { id?: unknown }).id;
  return scope === "team" && typeof id === "string" && id.trim()
    ? { workspaceId: id.trim() }
    : {};
}

export function loadManageWorkspaceScope(): ManageWorkspaceScope {
  return workspaceScopeFromContext(loadJSON<unknown>(STORAGE_KEYS.workspaceContext));
}
