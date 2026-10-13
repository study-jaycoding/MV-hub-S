import { useCallback, useRef, useState } from "react";
import type { Generation } from "../types";
import {
  checkResolveSelection,
  createResolveTimeline,
  createResolveTransfer,
  getResolveConnectionStatus,
  retryResolveTransfer,
  resolveTimelineSummary,
  resolveTransferSummary,
  type ResolveProjectTarget,
  type ResolveTimelineResult,
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
  | { kind: "retry"; projectId: string; transferId: string; target: ResolveProjectTarget }
  // 편집 탭의 타임라인 보내기 — 같은 줄에 선다(Resolve API 를 동시에 부르지 않는다). done 은 끝났을 때(실패는 null) 한 번.
  | { kind: "timeline"; genIds: string[]; target: ResolveProjectTarget; plan: unknown; done: (result: ResolveTimelineResult | null) => void };

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
        if (task.kind === "timeline") {
          flashRef.current(`Resolve 로 타임라인 보내는 중 · ${task.target.project_name}`);
          let result: ResolveTimelineResult | null = null;
          try {
            result = await createResolveTimeline(task.genIds, task.target, task.plan);
            flashRef.current(resolveTimelineSummary(result));
          } finally {
            task.done(result); // 실패(예외)도 알린다 — 단추가 '보내는 중'에 남지 않게. 안내는 아래 onError 가 띄운다
          }
          return;
        }
        flashRef.current(
          task.kind === "transfer"
            ? `Resolve 원본 ${task.genIds.length}개 처리 중 · ${task.target.project_name}`
            : `준비된 원본 다시 가져오는 중 · ${task.target.project_name}`,
        );
        const result = task.kind === "transfer"
          ? await createResolveTransfer(task.genIds, task.target)
          : await retryResolveTransfer(task.projectId, task.transferId);
        flashRef.current(resolveTransferSummary(result));
        const nextRetryable = retryableFromResult(result);
        if (nextRetryable) {
          setRetryable(nextRetryable);
        } else if (task.kind === "retry") {
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

  // 편집 탭의 [타임라인 Resolve 보내기] — 연결 확인은 확인 창이 이미 했다(target = 그때 열려 있던 Resolve 프로젝트. 그사이
  //  바뀌면 받는 쪽이 project_changed 로 멈춘다). 클립 보내기와 같은 줄에 세우고, 끝나면 결과(실패는 null)로 풀린다.
  //  timelineBusy 는 여기(앱)에 둔다 — 편집 탭을 떠났다 돌아와도 단추가 '보내는 중'으로 남아 같은 타임라인을 두 번 줄 세우지 않게.
  const [timelinePending, setTimelinePending] = useState(0);
  const sendTimelineToResolve = useCallback(
    (plan: unknown, gens: Generation[], target: ResolveProjectTarget): Promise<ResolveTimelineResult | null> => {
      const checked = checkResolveSelection(gens);
      if (!checked.ok) {
        flash(checked.message);
        return Promise.resolve(null);
      }
      setTimelinePending((count) => count + 1);
      return new Promise<ResolveTimelineResult | null>((done) => {
        queueRef.current!.enqueue({ kind: "timeline", genIds: checked.genIds, target, plan, done });
      }).finally(() => setTimelinePending((count) => Math.max(0, count - 1)));
    },
    [flash],
  );

  return {
    busy: queueState.total > 0 || connectionChecks > 0,
    pendingCount: queueState.total + connectionChecks,
    retryable,
    retryPreparedTransfer,
    sendToResolve,
    sendTimelineToResolve,
    timelineBusy: timelinePending > 0,
  };
}
