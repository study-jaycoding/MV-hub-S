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

/**
 * 브라우저에 저장된 팀 id와 에이전트가 보고한 최신 목록을 합친다.
 *
 * 저장 필터에는 workspace id만 있으므로 새로고침 직후에는 팀 이름이 비어 있을 수 있다.
 * 그 상태로 생성하면 카드에는 id만 남고 표시 이름이 유실된다. 같은 id가 보고 목록에 있을
 * 때만 정식 이름을 채우며, 사용자가 명시적으로 고른 개인/팀 선택은 바꾸지 않는다.
 */
export function reconcileReportedWorkspaceContext(
  current: WorkspaceContext,
  items: Workspace[],
): WorkspaceContext {
  if (current.scope === "team" && current.id) {
    const matched = items.find((item) => item.id?.trim() === current.id);
    return matched ? workspaceContextOf(matched) : current;
  }
  return current.scope === "unknown" ? selectedWorkspaceContext(items) : current;
}

export function isGenerationWorkspaceReady(context: WorkspaceContext): boolean {
  if (context.scope === "personal") return true;
  if (context.scope !== "team") return false;
  return Boolean(context.id?.trim() && context.name?.trim());
}

export function sameWorkspace(a: WorkspaceContext, b: WorkspaceContext): boolean {
  return a.scope === b.scope && a.id === b.id;
}

export function workspaceLabel(context: WorkspaceContext): string {
  if (context.scope === "team") return context.name || "팀 워크스페이스";
  if (context.scope === "personal") return "개인 · 전체 보기";
  return "워크스페이스 확인 중";
}
