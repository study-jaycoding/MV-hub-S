import { useCallback, useRef, useState } from "react";
import type { Generation } from "../types";
import { HttpError } from "./http";
import {
  checkResolveSelection,
  createResolveTimeline,
  createResolveTransfer,
  getResolveConnectionStatus,
  retryResolveTransfer,
  resolveTimelineNeedsCheck,
  resolveTimelineSummary,
  resolveTransferNeedsCheck,
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

// 닫을 때까지 남는 안내 한 줄(components/app/ResolveNotices) — 보내기 결과 가운데 확인이 필요한 것
export interface ResolveNotice {
  id: number;
  text: string;
}
export const RESOLVE_NOTICE_LIMIT = 3; // 넘으면 오래된 것부터 빠진다(Jay 2026-10-14)

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
  // 보내기의 **결과**를 알린다. 확인이 필요한 것(keep — 부분 성공·실패·결과 불명)은 알림에 더해 닫을 때까지 남긴다(Jay 2026-10-14):
  //  알림은 한 칸이고 2.5초라, 줄 서 있던 다음 작업의 '처리 중' 글이 앞의 결과를 덮었다 — 못 보고 다시 보내면 타임라인이 한 벌 더
  //  생긴다(Codex 배포 전 검토 E4). 정상 결과와 진행 글(처리 중·대기열·연결 확인)은 전처럼 알림에만 뜬다.
  const [notices, setNotices] = useState<ResolveNotice[]>([]);
  const noticeSerial = useRef(0);
  const report = useRef((text: string, keep: boolean) => {
    flashRef.current(text);
    if (!keep) return;
    const id = ++noticeSerial.current;
    setNotices((list) => [...list, { id, text }].slice(-RESOLVE_NOTICE_LIMIT));
  }).current;
  const dismissNotice = useCallback((id: number) => setNotices((list) => list.filter((item) => item.id !== id)), []);
  const queueRef = useRef<SerialTaskQueue<ResolveQueueTask> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new SerialTaskQueue(
      async (task) => {
        if (task.kind === "timeline") {
          flashRef.current(`Resolve 로 타임라인 보내는 중 · ${task.target.project_name}`);
          let result: ResolveTimelineResult | null = null;
          try {
            result = await createResolveTimeline(task.genIds, task.target, task.plan);
            report(resolveTimelineSummary(result), resolveTimelineNeedsCheck(result));
          } catch (error) {
            // 4xx = 서버가 시작하기 전에 거절했다(만든 것이 없다 — 서버는 Resolve 를 바꾼 뒤로는 4xx 를 내지 않는다:
            //  routers/resolve_integration 의 create_resolve_timeline). 그 밖(끊김·5xx)은 서버가 끝까지 돌았을 수 있다 — 요청이
            //  끊겨도 서버는 작업을 버리지 않는다(run_non_abandon). 만들어졌는지 모르는 채 '실패'라고만 하면 다시 눌러 둘이 된다.
            const refused = error instanceof HttpError && error.status >= 400 && error.status < 500;
            report(
              `타임라인 보내기 실패: ${readableError(error)}`
              + (refused ? "" : " — 만들어졌을 수 있습니다. 다시 보내기 전에 Resolve 를 확인하세요"),
              true,
            );
          } finally {
            task.done(result); // 실패해도 알린다 — 단추가 '보내는 중'에 남지 않게
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
        report(resolveTransferSummary(result), resolveTransferNeedsCheck(result));
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
        report(`Resolve 전송 실패: ${readableError(error)}`, true);
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
    notices,
    dismissNotice,
    pendingCount: queueState.total + connectionChecks,
    retryable,
    retryPreparedTransfer,
    sendToResolve,
    sendTimelineToResolve,
    timelineBusy: timelinePending > 0,
  };
}
