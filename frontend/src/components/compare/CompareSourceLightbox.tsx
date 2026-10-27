import { useRef } from "react";
import { useModalFocus } from "../../lib/keyGate";

export type CompareSourcePreview = { url: string; type: "image" | "video" | "audio"; name: string };

export function CompareSourceLightbox({
  preview,
  onClose,
}: {
  preview: CompareSourcePreview | null;
  onClose: () => void;
}) {
  // 비교 창 위에 뜨는 창 — 떠 있는 동안은 이것이 맨 위 모달 영역이다(lib/keyGate '모달의 초점'). 비교 창의 **바깥 형제**라 따로 올리지
  //  않으면 여기 놓인 초점(✕·영상 조작부)이 '영역 밖'으로 보여 Tab 이 아래 비교 창으로 끌려갔다(2026-10-11 Codex 리뷰).
  //  Esc 는 비교 창의 겹이 이것부터 닫는다(CompareModal·VideoCompareModal).
  const boxRef = useRef<HTMLDivElement>(null);
  useModalFocus(boxRef, !!preview);
  if (!preview) return null;

  return (
    <div className="cmp-srcbox" onMouseDown={onClose}>
      <div className="cmp-srcbox-inner" ref={boxRef} onMouseDown={(e) => e.stopPropagation()}>
        <button className="cmp-srcbox-x" title="닫기" onClick={onClose}>
          ✕
        </button>
        {preview.type === "video" ? (
          <video src={preview.url} controls autoPlay muted loop playsInline />
        ) : preview.type === "audio" ? (
          <audio src={preview.url} controls preload="metadata" />
        ) : (
          <img src={preview.url} alt={preview.name} />
        )}
        <div className="cmp-srcbox-name">{preview.name}</div>
      </div>
    </div>
  );
}
