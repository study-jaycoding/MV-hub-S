// 플로팅 입력창 — 네이티브 window.prompt 대체. 화면을 가리지 않는 작은 떠 있는 입력.
import { useEffect, useRef, useState } from "react";

export function FloatingPrompt({
  title,
  initial = "",
  placeholder = "",
  onSubmit,
  onCancel,
}: {
  title: string;
  initial?: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <>
      {/* 바깥 클릭 = 취소(화면을 어둡게 가리지 않는 투명 캐처) */}
      <div className="fp-catcher" onMouseDown={onCancel} />
      <div className="fp-panel" role="dialog">
        <div className="fp-title">{title}</div>
        <input
          ref={ref}
          className="fp-input"
          value={v}
          placeholder={placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit(v);
          }}
        />
        <div className="fp-actions">
          <button className="fp-cancel" onClick={onCancel}>
            취소
          </button>
          <button className="fp-ok" onClick={() => onSubmit(v)}>
            확인
          </button>
        </div>
      </div>
    </>
  );
}
