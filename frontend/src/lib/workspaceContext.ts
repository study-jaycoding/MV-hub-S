import type { Workspace, WorkspaceContext } from "../types";
import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export const UNKNOWN_WORKSPACE: WorkspaceContext = {
  scope: "unknown",
  id: null,
  name: null,
};

/**
 * 선택 워크스페이스(크레딧 컨텍스트) 영속화.
 *
 * 예전에는 라이브러리 필터(workspace_id)가 이 역할을 겸했지만, 워크스페이스 전환이
 * 생성물 가시성을 바꾸지 않게 분리되면서 별도 키로 저장한다. 관리/에셋 창도 이 키를 따라간다.
 */
export function loadStoredWorkspaceContext(): WorkspaceContext | null {
  const value = loadJSON<Partial<WorkspaceContext>>(STORAGE_KEYS.workspaceContext);
  if (!value || typeof value !== "object") return null;
  if (value.scope === "team" && typeof value.id === "string" && value.id.trim()) {
    return { scope: "team", id: value.id, name: typeof value.name === "string" ? value.name : null };
  }
  if (value.scope === "personal") return { scope: "personal", id: null, name: null };
  return null;
}

export function saveStoredWorkspaceContext(context: WorkspaceContext): void {
  saveJSON(STORAGE_KEYS.workspaceContext, context);
}

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

/**
 * 목록에서 '지금 활성인 워크스페이스' 한 건을 고른다.
 *
 * 기준은 앱에서 고른 컨텍스트다 — 팀이면 그 id, 개인이면 이름 없는 항목. 아직 확정 전(unknown)
 * 일 때만 CLI 가 선택 중인 항목으로 폴백한다. 계정 메뉴 게이지와 하단 상태줄이 같은 값을 쓰도록
 * 이 규칙을 한 곳에 둔다.
 */
export function activeWorkspaceOf<T extends Workspace>(
  items: T[],
  context: WorkspaceContext,
): T | undefined {
  if (context.scope === "team") return items.find((item) => item.id === context.id);
  if (context.scope === "personal") return items.find((item) => !item.name);
  return items.find((item) => item.is_selected) || items.find((item) => !item.name);
}

export function workspaceLabel(context: WorkspaceContext): string {
  if (context.scope === "team") return context.name || "팀 워크스페이스";
  if (context.scope === "personal") return "개인 · 전체 보기";
  return "워크스페이스 확인 중";
}
