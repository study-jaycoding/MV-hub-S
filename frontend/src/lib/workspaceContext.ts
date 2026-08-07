import type { Workspace, WorkspaceContext } from "../types";

export const UNKNOWN_WORKSPACE: WorkspaceContext = {
  scope: "unknown",
  id: null,
  name: null,
};

export function workspaceContextOf(item: Workspace | null | undefined): WorkspaceContext {
  if (!item) return UNKNOWN_WORKSPACE;
  const name = item.name?.trim() || null;
  if (!name) return { scope: "personal", id: null, name: null };
  const id = item.id?.trim() || null;
  return id ? { scope: "team", id, name } : UNKNOWN_WORKSPACE;
}

export function selectedWorkspaceContext(items: Workspace[]): WorkspaceContext {
  const selected = items.find((item) => item.is_selected);
  if (selected) return workspaceContextOf(selected);
  return workspaceContextOf(items.find((item) => !item.name));
}

export function sameWorkspace(a: WorkspaceContext, b: WorkspaceContext): boolean {
  return a.scope === b.scope && a.id === b.id;
}

export function workspaceLabel(context: WorkspaceContext): string {
  if (context.scope === "team") return context.name || "팀 워크스페이스";
  if (context.scope === "personal") return "개인 · 전체 보기";
  return "워크스페이스 확인 중";
}
