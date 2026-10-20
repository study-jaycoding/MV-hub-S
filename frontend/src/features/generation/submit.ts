import { surelyNotRun } from "../../lib/http";
import { isGenerationWorkspaceReady } from "../../lib/workspaceContext";
import type { PreparedSubmission, SubmissionDestination, SubmissionResult } from "../../shared/contracts/generation";

export async function runSubmission(
  prepared: PreparedSubmission,
  destination?: SubmissionDestination,
): Promise<SubmissionResult> {
  if (prepared.context.isCurrent && !prepared.context.isCurrent()) {
    return { outcome: { kind: "prepare_failed", reasonCode: "context_changed" } };
  }
  if (!isGenerationWorkspaceReady(prepared.context.workspace)) {
    return { outcome: { kind: "prepare_failed", reasonCode: "workspace_unready" } };
  }
  if (prepared.context.canvasLink && !destination) {
    return { outcome: { kind: "prepare_failed", reasonCode: "destination_required" } };
  }
  if (destination) {
    try {
      if (!await destination.confirm(prepared)) {
        return { outcome: { kind: "prepare_failed", reasonCode: "destination_unconfirmed" } };
      }
    } catch (error) {
      return { outcome: { kind: "prepare_failed", reasonCode: "destination_confirmation_failed" }, error };
    }
  }
  let generation;
  try {
    if (prepared.context.isCurrent && !prepared.context.isCurrent()) {
      return { outcome: { kind: "prepare_failed", reasonCode: "context_changed" } };
    }
    generation = await prepared.send();
  } catch (error) {
    return {
      outcome: surelyNotRun(error)
        ? { kind: "rejected", reasonCode: "request_rejected" }
        : { kind: "acceptance_unknown", operationId: prepared.operationId },
      error,
    };
  }
  if (!generation || typeof generation.id !== "string" || !generation.id.trim()) {
    return { outcome: { kind: "acceptance_unknown", operationId: prepared.operationId },
      error: new Error("생성 응답의 식별자를 확인하지 못했습니다. 기존 요청을 확인하세요.") };
  }
  const response = generation as typeof generation & { requestId?: unknown; request_id?: unknown };
  const requestId = typeof response.request_id === "string" ? response.request_id
    : typeof response.requestId === "string" ? response.requestId : undefined;
  const accepted = { operationId: prepared.operationId, generationId: generation.id,
    ...(requestId ? { requestId } : {}) };
  try {
    if (destination && prepared.context.isCurrent && !prepared.context.isCurrent()) {
      return { outcome: { kind: "accepted_local_pending", ...accepted }, generation };
    }
    await destination?.apply(generation, prepared);
  } catch (error) {
    return { outcome: { kind: "accepted_local_pending", ...accepted }, generation, error };
  }
  return { outcome: { kind: "accepted", ...accepted }, generation };
}
