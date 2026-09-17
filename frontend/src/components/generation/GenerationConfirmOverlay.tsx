import { useOverlayDismiss } from "../../lib/useOverlayDismiss";
import { useT } from "../../lib/i18n";
import { ConfirmQuestion } from "./ConfirmQuestion";

interface Props {
  mode: "share" | "final";
  shared: boolean;
  isFinal: boolean;
  onYes: () => void;
  onNo: () => void;
}

export function GenerationConfirmOverlay({ mode, shared, isFinal, onYes, onNo }: Props) {
  const t = useT();
  const panelRef = useOverlayDismiss(onNo);
  const question = mode === "final"
    ? isFinal ? "최종 지정을 해제할까요?" : "최종(골드)으로 지정할까요?"
    : shared ? "공유 해제 할까요?" : "공유 하시겠습니까?";
  return (
    <div
      className="sconfirm"
      role="dialog"
      aria-label={t(question)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="confirm-panel" ref={panelRef}>
        <ConfirmQuestion key={question} question={question} onYes={onYes} onNo={onNo} />
      </div>
    </div>
  );
}
