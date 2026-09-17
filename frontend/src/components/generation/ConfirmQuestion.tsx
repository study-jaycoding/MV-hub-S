import { useRef } from "react";
import { useT } from "../../lib/i18n";

interface Props {
  question: string;
  onYes: () => void;
  onNo: () => void;
  yesDisabled?: boolean;
}

export function ConfirmQuestion({ question, onYes, onNo, yesDisabled = false }: Props) {
  const t = useT();
  const submittedRef = useRef(false);
  return <>
    <span className="cs-final-q">{t(question)}</span>
    <div className="cs-final-actions">
      <button className="cs-final-yes" disabled={yesDisabled} onClick={() => {
        if (submittedRef.current || yesDisabled) return;
        submittedRef.current = true;
        onYes();
      }}>Yes</button>
      <button className="cs-final-no" onClick={onNo}>No</button>
    </div>
  </>;
}
