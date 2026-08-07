export type WorkspaceCommandOperation = "assign" | "remove";

export interface WorkspaceCommand {
  operation: WorkspaceCommandOperation;
  workspaceName: string;
}

export interface InvalidWorkspaceCommand {
  error: string;
}

/** `##` 전역 모드에서만 +이름/-이름을 워크스페이스 명령으로 해석한다. */
export function parseWorkspaceCommand(
  draft: string,
  globalMode: boolean,
): WorkspaceCommand | InvalidWorkspaceCommand | null {
  if (!globalMode) return null;
  const value = draft.trim();
  const prefix = value.charAt(0);
  if (prefix !== "+" && prefix !== "-") return null;
  const workspaceName = value.slice(1).trim().normalize("NFC");
  if (!workspaceName) return { error: "워크스페이스 이름을 입력하세요" };
  return {
    operation: prefix === "+" ? "assign" : "remove",
    workspaceName,
  };
}
