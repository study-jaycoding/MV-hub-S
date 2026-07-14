import { useRef } from "react";
import { thumbOf } from "../../lib/media";
import type { Generation, PreviewTarget } from "../../types";
import { MediaThumbnail } from "../MediaThumbnail";

export function HistoryNode({
  g,
  isTarget,
  selected,
  grayed,
  seq,
  onSelect,
  onPreview,
  onInfo,
  onConnect,
  onUnlink,
}: {
  g: Generation;
  isTarget?: boolean;
  selected?: boolean;
  grayed?: boolean;
  seq?: number;
  onSelect: (g: Generation, additive: boolean) => void;
  onPreview: (t: PreviewTarget) => void;
  onInfo: (g: Generation, x: number, y: number) => void;
  onConnect?: (g: Generation) => void;
  onUnlink?: (g: Generation) => void;
}) {
  const thumb = thumbOf(g);
  const asset = g.assets[0];
  const clickTimer = useRef<number | null>(null);

  return (
    <div
      className={
        "lin-node" +
        (isTarget ? " target" : "") +
        (selected ? " sel" : "") +
        (grayed ? " grayed" : "")
      }
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onInfo(g, e.clientX, e.clientY);
        }
      }}
      onMouseDown={(e) => e.button === 1 && e.preventDefault()}
    >
      <button
        className="lin-thumb"
        title={`${g.prompt.slice(0, 80)}\n클릭=선택 · Shift+클릭=복수 선택 · 더블클릭=크게 보기 · 미들클릭=정보`}
        onMouseEnter={(e) => {
          const video = e.currentTarget.querySelector("video") as HTMLVideoElement | null;
          if (video) {
            video.muted = true; // React <video muted> 반영 버그 → 재생 직전 무음 강제(썸네일 호버 무음)
            video.play().catch(() => {});
          }
        }}
        onMouseLeave={(e) => {
          const video = e.currentTarget.querySelector("video") as HTMLVideoElement | null;
          if (video) {
            video.pause();
            video.currentTime = 0;
          }
        }}
        onClick={(e) => {
          const additive = e.shiftKey;
          if (clickTimer.current) window.clearTimeout(clickTimer.current);
          clickTimer.current = window.setTimeout(() => {
            clickTimer.current = null;
            onSelect(g, additive);
          }, 220);
        }}
        onDoubleClick={() => {
          if (clickTimer.current) {
            window.clearTimeout(clickTimer.current);
            clickTimer.current = null;
          }
          if (asset) {
            onPreview({
              url: asset.file_path,
              type: asset.type,
              name: g.prompt.slice(0, 50),
              genId: g.id,
            });
          }
        }}
      >
        <MediaThumbnail
          thumb={thumb}
          isVideo={asset?.type === "video"}
          src={asset?.file_path}
          fallback={<span className={"lin-thumb-ph status-" + g.status}>{g.status}</span>}
        />
        {seq != null && <span className="lin-seq">{seq}</span>}
        {asset?.type === "video" && <span className="lin-vid">▶</span>}
        {g.is_final && <span className="lin-final">★</span>}
      </button>
      <span className="lin-cap">{g.prompt.slice(0, 24) || "(제목 없음)"}</span>
      {(onConnect || onUnlink) && (
        <div className="lin-node-actions">
          {onConnect && (
            <button className="lin-act" title="이 카드를 다시 연결" onClick={() => onConnect(g)}>
              ＋ 연결
            </button>
          )}
          {onUnlink && (
            <button className="lin-act lin-act-del" title="이 연결 해제" onClick={() => onUnlink(g)}>
              ✕ 해제
            </button>
          )}
        </div>
      )}
    </div>
  );
}
