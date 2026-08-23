import { useCallback, useRef, useState } from "react";
import type { Generation } from "../types";
import {
  checkResolveSelection,
  createResolveTransfer,
  getResolveConnectionStatus,
  retryResolveTransfer,
  resolveTransferAcceptedSummary,
  resolveTransferSummary,
  type ResolveProjectTarget,
  type ResolveTransferResult,
} from "./resolveTransfer";
import { SerialTaskQueue, type SerialTaskQueueState } from "./serialTaskQueue";

interface UseResolveTransferActionsArgs {
  flash: (message: string) => void;
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\d+:\s*/, "") || "Resolve 전송에 실패했습니다";
}

type ResolveQueueTask =
  | { kind: "transfer"; genIds: string[]; target: ResolveProjectTarget }
  | { kind: "retry"; projectId: string; transferId: string; target: ResolveProjectTarget };

export interface RetryableResolveTransfer {
  projectId: string;
  transferId: string;
  target: ResolveProjectTarget;
}

function retryableFromResult(result: ResolveTransferResult): RetryableResolveTransfer | null {
  const prepared = result.downloaded + result.skipped;
  if (!prepared || result.resolve_import.status === "complete") return null;
  const target = result.resolve_target;
  if (!target?.project_id && !target?.project_name) return null;
  return {
    projectId: result.project_id,
    transferId: result.transfer_id,
    target,
  };
}

function sameResolveProject(left: ResolveProjectTarget, right: ResolveProjectTarget): boolean {
  if (left.project_id && right.project_id) return left.project_id === right.project_id;
  return !!left.project_name && left.project_name === right.project_name;
}

export function useResolveTransferActions({ flash }: UseResolveTransferActionsArgs) {
  const [queueState, setQueueState] = useState<SerialTaskQueueState>({
    active: false,
    queued: 0,
    total: 0,
  });
  const [connectionChecks, setConnectionChecks] = useState(0);
  const [retryable, setRetryable] = useState<RetryableResolveTransfer | null>(null);
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const queueRef = useRef<SerialTaskQueue<ResolveQueueTask> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new SerialTaskQueue(
      async (task) => {
        flashRef.current(
          task.kind === "transfer"
            ? `Resolve 원본 ${task.genIds.length}개 처리 중 · ${task.target.project_name}`
            : `준비된 원본 다시 가져오는 중 · ${task.target.project_name}`,
        );
        if (task.kind === "transfer") {
          // 접수만 하는 202 응답이다. 준비·가져오기 결과는 큐에서 확인한다.
          const accepted = await createResolveTransfer(task.genIds, task.target);
          flashRef.current(resolveTransferAcceptedSummary(accepted));
          return;
        }
        const result = await retryResolveTransfer(task.projectId, task.transferId);
        flashRef.current(resolveTransferSummary(result));
        const nextRetryable = retryableFromResult(result);
        if (nextRetryable) {
          setRetryable(nextRetryable);
        } else {
          setRetryable((current) =>
            current?.transferId === task.transferId ? null : current,
          );
        }
      },
      setQueueState,
      (error) => {
        flashRef.current(`Resolve 전송 실패: ${readableError(error)}`);
      },
    );
  }

  const sendToResolve = useCallback(
    (selected: Generation[]) => {
      const checked = checkResolveSelection(selected);
      if (!checked.ok) {
        flash(checked.message);
        return;
      }

      setConnectionChecks((count) => count + 1);
      flash("DaVinci Resolve 연결과 현재 프로젝트를 확인하는 중…");
      void getResolveConnectionStatus()
        .then((status) => {
          if (status.status !== "ready") {
            flash(status.message || "DaVinci Resolve에 연결할 수 없습니다.");
            return;
          }
          const target = {
            project_id: status.project_id,
            project_name: status.project_name,
          };
          const ahead = queueRef.current!.snapshot().total;
          flash(
            ahead
              ? `Resolve 원본 ${checked.genIds.length}개를 대기열에 추가했습니다 · ${status.project_name} · 앞 작업 ${ahead}건`
              : `Resolve 원본 ${checked.genIds.length}개 전송 시작 · ${status.project_name}`,
          );
          queueRef.current!.enqueue({ kind: "transfer", genIds: checked.genIds, target });
        })
        .catch((error) => {
          flash(`Resolve 연결 확인 실패: ${readableError(error)}`);
        })
        .finally(() => setConnectionChecks((count) => Math.max(0, count - 1)));
    },
    [flash],
  );

  const retryPreparedTransfer = useCallback(() => {
    if (!retryable) return;
    setConnectionChecks((count) => count + 1);
    flash(`DaVinci Resolve 연결 확인 중 · 예정 프로젝트 ${retryable.target.project_name}`);
    void getResolveConnectionStatus()
      .then((status) => {
        if (status.status !== "ready") {
          flash(status.message || "DaVinci Resolve에 연결할 수 없습니다.");
          return;
        }
        const current = { project_id: status.project_id, project_name: status.project_name };
        if (!sameResolveProject(retryable.target, current)) {
          flash(
            `다른 Resolve 프로젝트가 열려 있습니다 · 예정 ${retryable.target.project_name} · 현재 ${status.project_name}`,
          );
          return;
        }
        const ahead = queueRef.current!.snapshot().total;
        flash(
          ahead
            ? `준비된 원본 다시 가져오기를 대기열에 추가했습니다 · 앞 작업 ${ahead}건`
            : `준비된 원본을 ${status.project_name}(으)로 다시 가져옵니다…`,
        );
        queueRef.current!.enqueue({
          kind: "retry",
          projectId: retryable.projectId,
          transferId: retryable.transferId,
          target: retryable.target,
        });
      })
      .catch((error) => {
        flash(`Resolve 연결 확인 실패: ${readableError(error)}`);
      })
      .finally(() => setConnectionChecks((count) => Math.max(0, count - 1)));
  }, [flash, retryable]);

  return {
    busy: queueState.total > 0 || connectionChecks > 0,
    pendingCount: queueState.total + connectionChecks,
    retryable,
    retryPreparedTransfer,
    sendToResolve,
  };
}
