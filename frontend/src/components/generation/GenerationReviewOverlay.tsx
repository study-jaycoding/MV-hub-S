import { useState } from "react";
import { useT } from "../../lib/i18n";
import type { ReviewAction } from "../../lib/generationReview";
import { useOverlayDismiss } from "../../lib/useOverlayDismiss";
import { ConfirmQuestion, useOverlayFocus } from "./ConfirmQuestion";

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
  // 검토 메뉴도 카드를 덮고 키를 가져가는 덮개다(위 훅이 Esc 겹) — 초점이 연 단추(S)에 남으면 Tab 이 뒤 카드로만 가서 키보드로는 고를 수
  //  없었다. 확인 단계(ConfirmQuestion)와 같게: 뜨면 덮개에 초점을 두고(첫 항목이 아니라 판 — 바로 누른 Enter 가 아무것도 고르지 않게),
  //  Tab 은 켜진 항목들 안에서 돌고, 걷히면 연 단추로 돌려준다(확인 단계에서 닫혀도 — 그 단계의 연 자리는 사라진 항목이다).
  useOverlayFocus(() => panelRef.current);
  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // 확인 단계에서는 항목이 없다 — 그 단계의 Tab·Space 는 ConfirmQuestion 이 먼저 받는다.
    if (event.key === "Tab") {
      event.preventDefault();
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".review-option:not(:disabled)")];
      const at = options.indexOf(event.target as HTMLButtonElement); // 판에 놓인 초점은 -1 — 앞으로면 첫 항목, 뒤로면 끝 항목
      options[event.shiftKey ? (at <= 0 ? options.length - 1 : at - 1) : (at + 1) % options.length]?.focus();
    }
    // Space 는 초점이 놓인 항목을 누르는 키다 — 뒤 격자까지 올라가면 격자가 기본 동작을 막는다(ConfirmQuestion 과 같은 이유).
    //  판에 놓인 초점(연 직후)에는 누를 항목이 없다 — 격자의 스크롤 막기에 닿지 않으니 여기서 기본 동작(뒤 목록 스크롤)을 막는다.
    else if (event.key === " ") {
      event.stopPropagation();
      if (event.target === event.currentTarget) event.preventDefault();
    }
  };
  const selectedOption = REVIEW_OPTIONS.find((option) => option.state === pending);
  return (
    <div className="sconfirm review-confirm" role="dialog" aria-label={t("이 결과물을 어떻게 할까요?")}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}>
      <div className={`review-panel${selectedOption ? "" : " review-menu"}`} ref={panelRef} tabIndex={-1} style={{ outline: "none" }} onKeyDown={onMenuKey}>
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
