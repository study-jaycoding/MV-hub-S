import type { Generation, WorkspaceContext } from "../src/types";
import type { PreparedSubmission, SubmissionCanvasLink, SubmissionContext } from "../src/shared/contracts/generation";

// 렌더 시험의 기존 전송 spy만 새 factory 경계에 연결한다. runSubmission은 실제 구현이다.
export function preparedFixture(
  send: () => Promise<Generation>, workspace: WorkspaceContext, canvasLink?: SubmissionCanvasLink,
  scope?: Pick<SubmissionContext, "operation" | "isCurrent">,
): PreparedSubmission {
  return { operationId: canvasLink?.attempt_id ?? "render-fixture", context: { workspace, canvasLink, ...scope }, send };
}
