export type WorkspaceCommandOperation = "assign" | "remove";

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
