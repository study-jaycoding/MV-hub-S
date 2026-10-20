import type { Generation, WorkspaceContext } from "../../types";
import type { GenerationCreateBody, PreparedSubmission, RegenerateBody, SubmissionCanvasLink, SubmissionContext } from "../../shared/contracts/generation";
import { ApiPausedError, jsonBody, jsonFetch } from "../../lib/http";
import { normalizeGenerationPromptCompatibility } from "../../lib/generationPrompt";
import { isGenerationWorkspaceReady } from "../../lib/workspaceContext";
import { getAccountNamespace } from "../../lib/accountScope";
import { EXPECT_ACCOUNT_HEADER, hubHasFeature, REQUEST_RETRY_FEATURE } from "../../lib/hubFeatures";

function newGenerationRequestKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}


function prepare(
  kind: "create" | "regenerate",
  body: GenerationCreateBody | RegenerateBody,
  workspace: WorkspaceContext,
  canvasLink?: SubmissionCanvasLink,
  sourceId?: string,
  idempotencyKey?: string,
  scope?: Pick<SubmissionContext, "operation" | "isCurrent">,
): PreparedSubmission {
  const requestKey = canvasLink ? undefined : idempotencyKey || newGenerationRequestKey();
  const context = Object.freeze({
    workspace: Object.freeze({ ...workspace }),
    ...(canvasLink ? { canvasLink: Object.freeze({ ...canvasLink }) } : {}),
    ...scope,
  });
  const requestBody = jsonBody({
    kind, workspace: context.workspace,
    ...(kind === "create" ? { create: body } : { source_gen_id: sourceId, regenerate: body }),
    canvas_link: context.canvasLink,
    ...(requestKey ? { idempotency_key: requestKey } : {}),
  });
  // send is a detached closure: every retry uses this operation's same identity.
  return Object.freeze({
    operationId: context.canvasLink?.attempt_id ?? requestKey!,
    context,
    send: (): Promise<Generation> => {
      if (context.isCurrent && !context.isCurrent()) {
        return Promise.reject(new ApiPausedError("계정 또는 서버가 바뀌어 제출을 중단했습니다. 원래 요청을 확인하세요."));
      }
      if (!isGenerationWorkspaceReady(context.workspace)) {
        return Promise.reject(new Error(kind === "create"
          ? "워크스페이스 id와 이름이 모두 확인된 뒤 생성할 수 있습니다"
          : "워크스페이스 id와 이름이 모두 확인된 뒤 재생성할 수 있습니다"));
      }
      const retry = hubHasFeature(REQUEST_RETRY_FEATURE);
      return jsonFetch<Generation>("/api/gen-requests", {
        method: "POST",
        body: requestBody,
        ...(retry ? { headers: { [EXPECT_ACCOUNT_HEADER]: context.operation?.accountNamespace ?? getAccountNamespace() } } : {}),
      }, undefined, { retryNoResponse: retry, beforeAttempt: () => {
        if (context.isCurrent && !context.isCurrent()) throw new ApiPausedError("계정 또는 서버가 바뀌어 제출을 중단했습니다. 원래 요청을 확인하세요.");
      } }).then(normalizeGenerationPromptCompatibility);
    },
  });
}

export function prepareCreateSubmission(
  body: GenerationCreateBody,
  workspace: WorkspaceContext,
  canvasLink?: SubmissionCanvasLink,
  scope?: Pick<SubmissionContext, "operation" | "isCurrent">,
): PreparedSubmission {
  return prepare("create", body, workspace, canvasLink, undefined, undefined, scope);
}

export function prepareRegenerateSubmission(
  id: string,
  body: RegenerateBody,
  workspace: WorkspaceContext,
  canvasLink?: SubmissionCanvasLink,
  scope?: Pick<SubmissionContext, "operation" | "isCurrent">,
): PreparedSubmission {
  return prepare("regenerate", body, workspace, canvasLink, id, undefined, scope);
}

export function createGeneration(
  body: GenerationCreateBody,
  workspace: WorkspaceContext = { scope: "unknown", id: null, name: null },
  canvasLink?: SubmissionCanvasLink,
  idempotencyKey?: string,
  scope?: Pick<SubmissionContext, "operation" | "isCurrent">,
): Promise<Generation> {
  return prepare("create", body, workspace, canvasLink, undefined, idempotencyKey, scope).send();
}

export function regenerateGeneration(
  id: string,
  body: RegenerateBody,
  workspace: WorkspaceContext = { scope: "unknown", id: null, name: null },
  canvasLink?: SubmissionCanvasLink,
  idempotencyKey?: string,
  scope?: Pick<SubmissionContext, "operation" | "isCurrent">,
): Promise<Generation> {
  return prepare("regenerate", body, workspace, canvasLink, id, idempotencyKey, scope).send();
}

export { runSubmission } from "./submit";
