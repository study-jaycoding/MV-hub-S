import { useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import type { ReviewAction } from "../../lib/generationReview";
import { useOverlayDismiss } from "../../lib/useOverlayDismiss";
import { ConfirmQuestion, useOverlayFocus } from "./ConfirmQuestion";
import { onReviewMenuKey, REVIEW_OPTIONS, ReviewIcon } from "./reviewOptions";

interface Props {
  state: ReviewAction;
  count?: number;
  allowed: Record<ReviewAction, boolean>;
  onAction: (action: ReviewAction) => void;
  onCancel: () => void;
}

// 공유 탭에서 여러 장을 고른 채 누른 S — 카드를 덮는 창 + Yes/No. 한 장은 ReviewPicker(S 옆 · 바로 적용)다. 여러 장은 잘못 누르면 한꺼번에 바뀌어 한 번 더 묻는다.
export function GenerationReviewOverlay({ state, count = 1, allowed, onAction, onCancel }: Props) {
  const t = useT();
  const [pending, setPending] = useState<ReviewAction | null>(null);
  const panelRef = useOverlayDismiss(onCancel);
  // 검토 메뉴도 카드를 덮고 키를 가져가는 덮개다(위 훅이 Esc 겹) — 초점이 연 단추(S)에 남으면 Tab 이 뒤 카드로만 가서 키보드로는 고를 수
  //  없었다. 확인 단계(ConfirmQuestion)와 같게: 뜨면 덮개에 초점을 두고(첫 항목이 아니라 판 — 바로 누른 Enter 가 아무것도 고르지 않게),
  //  Tab 은 켜진 항목들 안에서 돌고, 걷히면 연 단추로 돌려준다(확인 단계에서 닫혀도 — 그 단계의 연 자리는 사라진 항목이다).
  useOverlayFocus(() => panelRef.current);
  // 즉시 열린 메뉴로 S 더블클릭의 두 번째 포인터 클릭이 넘어가지 않게 한다. 키보드 활성(detail=0)은 지연하지 않는다.
  const openedAt = useRef(performance.now());
  const onFirstClickCapture = (event: React.MouseEvent) => {
    if (event.detail !== 0 && performance.now() - openedAt.current < 220) event.stopPropagation();
  };
  const selectedOption = REVIEW_OPTIONS.find((option) => option.state === pending);
  return (
    <div className="sconfirm review-confirm" role="dialog" aria-label={t("이 결과물을 어떻게 할까요?")}
      onClickCapture={onFirstClickCapture}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}>
      <div className={`review-panel${selectedOption ? "" : " review-menu"}`} ref={panelRef} tabIndex={-1} style={{ outline: "none" }}
        onKeyDown={(event) => onReviewMenuKey(event, ".review-option")}>
        {count > 1 && <span className="review-selection-count">{t("선택 {count}개에 적용").replace("{count}", String(count))}</span>}
        {selectedOption ? <ConfirmQuestion key={selectedOption.state} question={selectedOption.question}
          yesDisabled={!allowed[selectedOption.state]} onYes={() => onAction(selectedOption.state)} onNo={onCancel} />
          : <div className="review-options">
          {REVIEW_OPTIONS.filter((option) => option.state !== state).map((option) => (
            <button key={option.state} className={`review-option review-${option.state}`}
              disabled={!allowed[option.state]} onClick={() => setPending(option.state)}>
              <span className="review-option-name"><span className="review-option-icon" aria-hidden><ReviewIcon state={option.state} /></span>
                <span className="review-option-label">{t(option.label)}</span></span>
            </button>
          ))}
        </div>}
      </div>
    </div>
  );
}
