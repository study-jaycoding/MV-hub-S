export type CompareSourcePreview = { url: string; type: "image" | "video" | "audio"; name: string };

export function CompareSourceLightbox({
  preview,
  onClose,
}: {
  preview: CompareSourcePreview | null;
  onClose: () => void;
}) {
  if (!preview) return null;

  return (
    <div className="cmp-srcbox" onMouseDown={onClose}>
      <div className="cmp-srcbox-inner" onMouseDown={(e) => e.stopPropagation()}>
        <button className="cmp-srcbox-x" title="닫기" onClick={onClose}>
          ✕
        </button>
        {preview.type === "video" ? (
          <video src={preview.url} controls autoPlay muted loop playsInline />
        ) : preview.type === "audio" ? (
          <audio src={preview.url} controls autoPlay />
        ) : (
          <img src={preview.url} alt={preview.name} />
        )}
        <div className="cmp-srcbox-name">{preview.name}</div>
      </div>
    </div>
  );
}
