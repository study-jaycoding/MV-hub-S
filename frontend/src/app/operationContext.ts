import { APP_EVENTS } from "../lib/appEvents";
import { getAccountNamespace } from "../lib/accountScope";
import { getApiPause, getAuthToken } from "../lib/http";
import { STORAGE_KEYS } from "../lib/storageKeys";
import type { WorkspaceContext } from "../types";
import type { OperationContext, SubmissionContext } from "../shared/contracts/generation";
import { clearGenerationReadModels } from "../features/library/api";

let epoch = 0;
let scope = { key: "", serverOrigin: "", authority: "local" as "local" | "team", ready: true };
let credentials = "";

// 비밀 토큰은 모듈 안의 비교에만 쓰며 작업 DTO·로그로 넘기지 않는다.
function synchronizeCredentials(): void {
  const next = JSON.stringify([getAccountNamespace(), getAuthToken(), getApiPause()]);
  if (next !== credentials) { credentials = next; invalidateOperationContext(); }
}

export function invalidateOperationContext(): void { epoch++; clearGenerationReadModels(); }

export function configureOperationContext(next: {
  key: string; serverOrigin: string; authority: "local" | "team"; ready: boolean;
}): void {
  if (JSON.stringify(next) !== JSON.stringify(scope)) { scope = { ...next }; invalidateOperationContext(); }
  synchronizeCredentials();
}

export function watchOperationContext(): () => void {
  const invalidate = () => invalidateOperationContext();
  const storage = (event: StorageEvent) => {
    if (event.key === null || [STORAGE_KEYS.authToken, STORAGE_KEYS.activeAccount, STORAGE_KEYS.hubLogoutAt].some(key => key === event.key)) invalidate();
  };
  window.addEventListener(APP_EVENTS.accountUpdated, synchronizeCredentials);
  window.addEventListener(APP_EVENTS.authRequired, invalidate);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(APP_EVENTS.accountUpdated, synchronizeCredentials);
    window.removeEventListener(APP_EVENTS.authRequired, invalidate);
    window.removeEventListener("storage", storage);
    invalidate();
  };
}

export function captureOperationContext(workspace: WorkspaceContext): OperationContext {
  synchronizeCredentials();
  return Object.freeze({ accountNamespace: getAccountNamespace(), serverOrigin: scope.serverOrigin,
    authority: scope.authority, workspaceId: workspace.id, sessionEpoch: epoch });
}

export function isOperationContextCurrent(context: OperationContext): boolean {
  synchronizeCredentials();
  return scope.ready && !getApiPause() && context.sessionEpoch === epoch
    && context.accountNamespace === getAccountNamespace() && context.serverOrigin === scope.serverOrigin
    && context.authority === scope.authority;
}

export class OperationContextChangedError extends Error {
  readonly status = 409; // 전송 전 확정 중단: 기존 surelyNotRun 분류를 재사용한다.
  readonly notStarted = true; // 409 는 이 표식이 있어야 '안 보냄'이다(surelyNotRun).
  constructor() { super("계정 또는 서버가 바뀌어 제출을 중단했습니다. 원래 요청을 확인한 뒤 다시 실행하세요."); }
}

export function captureSubmissionScope(workspace: WorkspaceContext): Pick<SubmissionContext, "operation" | "isCurrent"> {
  const operation = captureOperationContext(workspace);
  return Object.freeze({ operation, isCurrent: () => isOperationContextCurrent(operation) });
}

export function assertOperationContextCurrent(context: OperationContext): void {
  if (!isOperationContextCurrent(context)) throw new OperationContextChangedError();
}
