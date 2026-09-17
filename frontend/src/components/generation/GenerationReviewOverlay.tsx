import { useState } from "react";
import { useT } from "../../lib/i18n";
import type { ReviewAction } from "../../lib/generationReview";
import { useOverlayDismiss } from "../../lib/useOverlayDismiss";
import { ConfirmQuestion } from "./ConfirmQuestion";

interface Props {
  state: ReviewAction;
  count?: number;
  allowed: Record<ReviewAction, boolean>;
  onAction: (action: ReviewAction) => void;
  onCancel: () => void;
}

const REVIEW_OPTIONS: { state: ReviewAction; label: string; icon: string; question: string }[] = [
  { state: "unshared", label: "해제", icon: "−", question: "공유 해제 할까요?" },
  { state: "shared", label: "공유", icon: "S", question: "공유로 복귀할까요?" },
  { state: "held", label: "보류", icon: "S", question: "보류할까요?" },
  { state: "final", label: "최종", icon: "★", question: "최종(골드)으로 지정할까요?" },
];

export function GenerationReviewOverlay({ state, count = 1, allowed, onAction, onCancel }: Props) {
  const t = useT();
  const [pending, setPending] = useState<ReviewAction | null>(null);
  const panelRef = useOverlayDismiss(onCancel);
  const selectedOption = REVIEW_OPTIONS.find((option) => option.state === pending);
  return (
    <div className="sconfirm review-confirm" role="dialog" aria-label={t("이 결과물을 어떻게 할까요?")}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}>
      <div className={`review-panel${selectedOption ? "" : " review-menu"}`} ref={panelRef}>
        {count > 1 && <span className="review-selection-count">{t("선택 {count}개에 적용").replace("{count}", String(count))}</span>}
        {selectedOption ? <ConfirmQuestion key={selectedOption.state} question={selectedOption.question}
          yesDisabled={!allowed[selectedOption.state]} onYes={() => onAction(selectedOption.state)} onNo={onCancel} />
          : <div className="review-options">
          {REVIEW_OPTIONS.filter((option) => option.state !== state).map((option) => (
            <button key={option.state} className={`review-option review-${option.state}`}
              disabled={!allowed[option.state]} onClick={() => setPending(option.state)}>
              <span className="review-option-name"><span className="review-option-icon" aria-hidden>{option.icon}</span>
                <span className="review-option-label">{t(option.label)}</span></span>
            </button>
          ))}
        </div>}
      </div>
    </div>
  );
}
