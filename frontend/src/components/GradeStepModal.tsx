// 등급 S 다중선택 확인 — 브라우저 confirm 대신 인앱 중앙 모달.
import { describeGradeStep, type GradeStepResult } from "../lib/gradeStep";
import { useEscapeClose } from "../lib/useEscapeClose";

export function GradeStepModal({
  pending,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: GradeStepResult;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEscapeClose(busy ? () => {} : onCancel); // 적용 중엔 ESC/바깥클릭으로 못 닫음(작업 도는데 모달만 닫힘 방지)
  const { title, body } = describeGradeStep(pending);
  return (
    <>
      <div className="gradestep-catcher" onMouseDown={busy ? undefined : onCancel} />
      <div className="gradestep-modal" role="dialog" aria-modal="true">
        <div className="gradestep-title">{title}</div>
        <div className="gradestep-body">{body}</div>
        <div className="gradestep-actions">
          <button className="gradestep-btn cancel" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button className="gradestep-btn confirm" onClick={onConfirm} disabled={busy}>
            {busy ? "적용 중…" : "확인"}
          </button>
        </div>
      </div>
    </>
  );
}
