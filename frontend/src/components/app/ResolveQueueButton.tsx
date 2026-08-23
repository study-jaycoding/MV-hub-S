import { useState } from "react";
import type { ResolveQueueController } from "../../lib/useResolveTransferActions";
import {
  resolveQueueActions,
  resolveQueueDetail,
  resolveQueueStateLabel,
  type ResolveQueueRow,
} from "../../lib/resolveTransfer";

/**
 * Resolve 전송 대기열 배지 + 목록.
 *
 * 전송 버튼 바로 옆에 (N) 배지를 놓아 "보낸 게 어디까지 갔는지"를 그 자리에서 본다.
 * 사용자가 손봐야 진행되는 건(보류·중단·복구·실패)이 있으면 배지를 경고색으로 띄운다 —
 * 자동 재실행을 하지 않는 설계라 사용자가 모르면 큐가 그대로 멈춰 있기 때문이다.
 */
export function ResolveQueueButton({ queue }: { queue: ResolveQueueController }) {
  const { summary, rows, open, setOpen } = queue;
  if (!queue.supported) return null;
  if (!summary.active && !open) return null;

  const label = summary.attention
    ? `⚠ Resolve 큐 (${summary.active})`
    : `◇ Resolve 큐 (${summary.active})`;
  return (
    <span className="rq-wrap">
      <button
        className={summary.attention ? "sb-resolve rq-toggle rq-alert" : "sb-resolve rq-toggle"}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void queue.refresh();
        }}
        title={
          summary.attention
            ? `확인이 필요한 전송 ${summary.attention}건이 있습니다`
            : `대기 ${summary.waiting} · 진행 ${summary.running}`
        }
      >
        {label}
      </button>
      {open && (
        <div className="rq-pop" role="dialog" aria-label="Resolve 전송 대기열">
          <div className="rq-head">
            <span>
              대기 {summary.waiting} · 진행 {summary.running} · 보류 {summary.blocked} · 실패
              {" "}
              {summary.failed}
            </span>
            <button className="rq-close" onClick={() => setOpen(false)} title="닫기">
              ✕
            </button>
          </div>
          {!queue.worker.enabled && queue.worker.detail && (
            <p className="rq-worker">{queue.worker.detail}</p>
          )}
          {!rows.length && <p className="rq-empty">대기 중인 Resolve 전송이 없습니다.</p>}
          {rows.map((row) => (
            <ResolveQueueLine key={row.transfer_id} row={row} queue={queue} />
          ))}
        </div>
      )}
    </span>
  );
}

function ResolveQueueLine({
  row,
  queue,
}: {
  row: ResolveQueueRow;
  queue: ResolveQueueController;
}) {
  // 강제 중단은 Resolve 조작을 도중에 끊는다 — 한 번 더 확인받는다(§D 2차 확인).
  const [confirmForce, setConfirmForce] = useState(false);
  const actions = resolveQueueActions(row);
  return (
    <div className={`rq-row rq-${row.state}`}>
      <div className="rq-row-head">
        <span className="rq-state">{resolveQueueStateLabel(row.state)}</span>
        <span className="rq-name">
          {row.project_name || "이름 없는 프로젝트"} · {row.total}개
        </span>
      </div>
      <p className="rq-detail">{resolveQueueDetail(row)}</p>
      <div className="rq-actions">
        {actions.canResume && (
          <button onClick={() => queue.resume(row)}>{actions.resumeLabel}</button>
        )}
        {actions.canCancel && !actions.needsForce && (
          <button onClick={() => queue.cancel(row, false)}>취소</button>
        )}
        {actions.canCancel && actions.needsForce && !confirmForce && (
          <button onClick={() => setConfirmForce(true)}>강제 중단…</button>
        )}
        {actions.canCancel && actions.needsForce && confirmForce && (
          <>
            <span className="rq-warn">
              Resolve 조작을 도중에 끊습니다. Bin 확인이 필요해집니다.
            </span>
            <button
              className="rq-danger"
              onClick={() => {
                setConfirmForce(false);
                queue.cancel(row, true);
              }}
            >
              그래도 중단
            </button>
            <button onClick={() => setConfirmForce(false)}>취소</button>
          </>
        )}
      </div>
    </div>
  );
}
