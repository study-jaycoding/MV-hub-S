import { useCallback, useEffect, useRef, useState } from "react";
import type { Generation } from "../types";
import {
  cancelResolveQueueTransfer,
  checkResolveSelection,
  createResolveTransfer,
  getResolveConnectionStatus,
  getResolveQueue,
  resumeResolveQueueTransfer,
  retryResolveTransfer,
  resolveQueueStateLabel,
  resolveTransferAcceptedSummary,
  resolveTransferSummary,
  summarizeResolveQueue,
  type ResolveProjectTarget,
  type ResolveQueueRow,
  type ResolveQueueSummary,
  type ResolveTransferAccepted,
  type ResolveTransferResult,
} from "./resolveTransfer";
import { SerialTaskQueue, type SerialTaskQueueState } from "./serialTaskQueue";

interface UseResolveTransferActionsArgs {
  flash: (message: string) => void;
}

/** 큐를 열어 두는 동안의 폴링 간격. 로컬 파일 스캔이라 짧게 잡지 않는다. */
const QUEUE_POLL_MS = 5000;

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\d+:\s*/, "") || "Resolve 전송에 실패했습니다";
}

type ResolveQueueTask =
  | {
      kind: "transfer";
      genIds: string[];
      target: ResolveProjectTarget;
      /** 같은 클릭의 재요청이 두 번째 전송을 만들지 않게 하는 접수 키. */
      acceptKey: string;
    }
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

function newIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 접수(202)는 완료 결과가 아니므로, 안내 직후 반드시 서버 큐를 다시 읽는다. */
export async function announceAcceptedResolveTransfer(
  accepted: ResolveTransferAccepted,
  flash: (message: string) => void,
  refresh: () => Promise<unknown> | undefined,
): Promise<void> {
  flash(resolveTransferAcceptedSummary(accepted));
  await refresh();
}

export function useResolveTransferActions({ flash }: UseResolveTransferActionsArgs) {
  const [queueState, setQueueState] = useState<SerialTaskQueueState>({
    active: false,
    queued: 0,
    total: 0,
  });
  const [connectionChecks, setConnectionChecks] = useState(0);
  const [retryable, setRetryable] = useState<RetryableResolveTransfer | null>(null);
  const [rows, setRows] = useState<ResolveQueueRow[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  // 이 PC의 로컬 허브에서만 답하는 API 다. 원격(위임) 브라우저에서는 한 번 실패하면
  // 다시 두드리지 않는다 — 5초마다 403 을 만드는 폴링이 되면 안 된다.
  const [queueSupported, setQueueSupported] = useState(true);
  const [queueWorker, setQueueWorker] = useState<{ enabled: boolean; detail: string }>({
    enabled: false,
    detail: "",
  });
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const queueSeqRef = useRef(0);
  const queueEverOkRef = useRef(false);
  const refreshQueueRef = useRef<(() => Promise<ResolveQueueRow[] | null>) | null>(null);
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
          const accepted = await createResolveTransfer(
            task.genIds,
            task.target,
            task.acceptKey,
          );
          await announceAcceptedResolveTransfer(
            accepted,
            flashRef.current,
            () => refreshQueueRef.current?.(),
          );
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
          queueRef.current!.enqueue({
            kind: "transfer",
            genIds: checked.genIds,
            target,
            acceptKey: newIdempotencyKey(),
          });
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

  // ── v3 큐 폴링 ──────────────────────────────────────────────────────────
  // ★seq 가드: 느린 응답이 뒤늦게 도착해 최신 스냅샷을 덮지 않게 한다.
  const refreshQueue = useCallback(async (): Promise<ResolveQueueRow[] | null> => {
    const seq = ++queueSeqRef.current;
    try {
      const snapshot = await getResolveQueue();
      if (seq !== queueSeqRef.current) return null;
      queueEverOkRef.current = true;
      setQueueSupported(true);
      setRows(snapshot.items || []);
      setQueueWorker({
        enabled: !!snapshot.worker_enabled,
        detail: snapshot.worker_detail || "",
      });
      return snapshot.items || [];
    } catch {
      if (seq !== queueSeqRef.current) return null;
      // ★한 번도 성공한 적 없는 실패만 '이 브라우저에서는 못 쓴다'로 본다(로컬 허브가
      // 아닌 위임 접속). 잘 되던 큐가 일시 오류로 사라져 버리면 안 되므로, 그 뒤의
      // 실패는 이번 폴링만 건너뛴다.
      if (!queueEverOkRef.current) setQueueSupported(false);
      return null;
    }
  }, []);
  refreshQueueRef.current = refreshQueue;

  // 첫 마운트에서 한 번만 확인한다. 이 PC의 허브가 아니면 여기서 끝난다.
  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  const summary: ResolveQueueSummary = summarizeResolveQueue(rows);
  // 열어 둔 동안, 또는 진행 중인 전송이 남아 있는 동안만 5초 폴링.
  const shouldPoll = queueSupported && (queueOpen || summary.active > 0);
  // blocked(project_changed 등) 재평가는 /status 호출이 트리거다 — /queue 폴링만으로는
  // 올바른 프로젝트를 다시 열어도 워커 백오프(최대 15분)까지 '차단됨'으로 보인다(실기기 재현).
  const hasBlocked = summary.blocked > 0;
  useEffect(() => {
    if (!shouldPoll) return undefined;
    const timer = window.setInterval(() => {
      if (hasBlocked) void getResolveConnectionStatus().catch(() => {});
      void refreshQueue();
    }, QUEUE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [shouldPoll, hasBlocked, refreshQueue]);

  const cancelQueued = useCallback(
    (row: ResolveQueueRow, force = false) => {
      void cancelResolveQueueTransfer(row.transfer_id, force)
        .then((result) => {
          if (!result.applied && result.cooperative) {
            flashRef.current(
              force
                ? "Resolve 가져오기를 중단했습니다. 잠시 뒤 복구 확인 상태로 바뀝니다."
                : "취소를 접수했습니다. 지금 복사 중인 파일 하나를 끝낸 뒤 멈춥니다.",
            );
          } else {
            flashRef.current(
              `전송을 ${resolveQueueStateLabel(result.state)} 상태로 바꿨습니다.`,
            );
          }
          void refreshQueue();
        })
        .catch((error) => flashRef.current(`전송 취소 실패: ${readableError(error)}`));
    },
    [refreshQueue],
  );

  const resumeQueued = useCallback(
    (row: ResolveQueueRow) => {
      void resumeResolveQueueTransfer(row.transfer_id)
        .then((result) => {
          flashRef.current(
            result.state === "complete"
              ? "다시 검사한 결과 누락된 원본이 없어 완료로 확정했습니다."
              : `${resolveQueueStateLabel(result.state)}(으)로 되돌렸습니다.`,
          );
          void refreshQueue();
        })
        .catch((error) => flashRef.current(`다시 시도 실패: ${readableError(error)}`));
    },
    [refreshQueue],
  );

  return {
    busy: queueState.total > 0 || connectionChecks > 0,
    pendingCount: queueState.total + connectionChecks,
    retryable,
    retryPreparedTransfer,
    sendToResolve,
    queue: {
      rows,
      summary,
      supported: queueSupported,
      open: queueOpen,
      worker: queueWorker,
      setOpen: setQueueOpen,
      refresh: refreshQueue,
      cancel: cancelQueued,
      resume: resumeQueued,
    },
  };
}

export type ResolveQueueController = ReturnType<
  typeof useResolveTransferActions
>["queue"];
