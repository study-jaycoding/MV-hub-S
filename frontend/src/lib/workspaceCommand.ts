export type WorkspaceCommandOperation = "assign" | "remove";

export interface WorkspaceCommandTarget {
  id: string;
  name: string;
}

export interface WorkspacePickerCommand {
  operation: WorkspaceCommandOperation;
}

/** `##` 전역 모드에서 `#+`/`#-`가 완성됐을 때만 선택 목록을 연다. */
export function parseWorkspacePickerCommand(
  draft: string,
  globalMode: boolean,
): WorkspacePickerCommand | null {
  if (!globalMode) return null;
  if (draft === "#+") return { operation: "assign" };
  if (draft === "#-") return { operation: "remove" };
  return null;
}

function normalizedWorkspaceName(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

/** 표시명이 겹칠 때만 UUID 끝 8자리를 붙여 서로 다른 공간을 구분한다. */
export function workspaceCommandLabels(
  workspaces: readonly WorkspaceCommandTarget[],
): Map<string, string> {
  const counts = new Map<string, number>();
  const suffixCounts = new Map<string, number>();
  for (const workspace of workspaces) {
    const key = normalizedWorkspaceName(workspace.name);
    const suffix = workspace.id.slice(-8);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    suffixCounts.set(`${key}\0${suffix}`, (suffixCounts.get(`${key}\0${suffix}`) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const workspace of workspaces) {
    const key = normalizedWorkspaceName(workspace.name);
    if ((counts.get(key) ?? 0) < 2) {
      labels.set(workspace.id, workspace.name);
      continue;
    }
    const suffix = workspace.id.slice(-8);
    const disambiguator = (suffixCounts.get(`${key}\0${suffix}`) ?? 0) > 1
      ? workspace.id
      : suffix;
    labels.set(workspace.id, `${workspace.name} · ${disambiguator}`);
  }
  return labels;
}
