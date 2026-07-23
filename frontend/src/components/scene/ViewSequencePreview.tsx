// View 노드 안 '합쳐진 영상' 미리보기 — 연결된 클립들을 하나의 큰 화면으로 보여주고, 마우스를 올리면
//  순서대로 이어 재생(무음)한다. 생성카드 hover-play 와 같은 방식(평소엔 대표 프레임, 호버 시 재생).
//  · 여러 View 노드가 동시에 재생되면 무거우므로 '호버할 때만' 재생한다.
import { useEffect, useRef, useState } from "react";
import type { TimelineClip } from "./ViewTimeline";

const IMG_DUR_MS = 2000; // 이미지 클립 미리보기 표시 시간

export function ViewSequencePreview({ clips }: { clips: TimelineClip[] }) {
  const [hover, setHover] = useState(false);
  const [idx, setIdx] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hoverRef = useRef(hover);
  hoverRef.current = hover;

  const cur = clips[idx] || clips[0];
  const isVideo = !!cur && (cur.type === "video" || cur.type === "audio");
  const poster = clips[0]?.thumb || null;

  const next = () => setIdx((i) => (i + 1 < clips.length ? i + 1 : 0));

  // 호버 시작=0번부터, 호버 종료=처음으로 리셋.
  useEffect(() => {
    if (!hover) setIdx(0);
  }, [hover]);

  // 이미지 클립은 IMG_DUR_MS 후 다음으로(호버 중일 때만).
  useEffect(() => {
    if (!hover || isVideo || !cur) return;
    const t = window.setTimeout(() => {
      if (hoverRef.current) next();
    }, IMG_DUR_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, isVideo, idx, cur]);

  const onLoaded = () => {
    const v = videoRef.current;
    if (v && hoverRef.current) void v.play().catch(() => {});
  };

  return (
    <div
      className="scene-viewseq"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {hover && cur ? (
        isVideo ? (
          <video
            key={idx}
            ref={videoRef}
            src={cur.url}
            muted
            playsInline
            autoPlay
            onLoadedMetadata={onLoaded}
            onEnded={next}
          />
        ) : (
          <img key={idx} src={cur.url} alt="" draggable={false} />
        )
      ) : poster ? (
        <img src={poster} alt="" draggable={false} />
      ) : (
        <div className="scene-viewseq-ph" />
      )}
      {!hover && clips.length > 1 && (
        <span className="scene-viewseq-badge">▶ {clips.length}개 이어보기</span>
      )}
    </div>
  );
}
