interface Props {
  mode: "share" | "final";
  shared: boolean;
  isFinal: boolean;
  onYes: () => void;
  onNo: () => void;
}

export function GenerationConfirmOverlay({ mode, shared, isFinal, onYes, onNo }: Props) {
  return (
    <div
      className="sconfirm"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <span className="cs-final-q">
        {mode === "final"
          ? isFinal
            ? "최종 지정을 해제할까요?"
            : "최종(골드)으로 지정할까요?"
          : shared
            ? "공유 해제 할까요?"
            : "공유 하시겠습니까?"}
      </span>
      <div className="cs-final-actions">
        <button className="cs-final-yes" onClick={onYes}>
          Yes
        </button>
        <button className="cs-final-no" onClick={onNo}>
          No
        </button>
      </div>
    </div>
  );
}
