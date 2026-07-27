// 단순 미디어 비교 — 생성정보(프롬프트·파라미터) 없이 이미지·영상 2개+를 나란히 보고, 영상은 동시 재생만 한다.
// (생성카드끼리는 CompareModal 로 전체 비교. 여기는 레퍼런스처럼 생성본이 아닌 미디어가 섞였을 때 '보기' 전용.)
// 영상 동기 로직은 CompareModal 과 동일 — 한 곳에서 재생/정지하면 전부 같이, 길이 다르면 가장 긴 것 끝에 함께 되감기.
import { useEffect, useRef, useState } from "react";
import {
  CompareSourceLightbox,
  type CompareSourcePreview,
} from "./compare/CompareSourceLightbox";

export interface CompareVideo {
  url: string;
  name: string;
  type: "image" | "video";
  fallback?: string; // 이미지 로드 실패 시 대체 URL(검증된 썸네일 등)
  full?: string; // 클릭해 크게 볼 때 쓸 원본(고해상도) URL — 없으면 url 사용
}

export function VideoCompareModal({
  videos,
  onClose,
}: {
  videos: CompareVideo[];
  onClose: () => void;
}) {
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const [zoom, setZoom] = useState<CompareSourcePreview | null>(null); // 클릭해 크게 보기(라이트박스)
  // 이미지 표시 방식 — CompareModal 과 동일 키(cmpFit) 공유: 전체보기(contain, 블랙바) ↔ 꽉 채우기(cover, 크롭).
  const [fitContain, setFitContain] = useState<boolean>(() => {
    try {
      return localStorage.getItem("cmpFit") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("cmpFit", fitContain ? "1" : "0");
    } catch {
      /* 스토리지 차단 환경 — 유지 저장만 건너뛴다 */
    }
  }, [fitContain]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (zoom) setZoom(null); // 라이트박스 먼저 닫기
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, zoom]);

  // 동기 재생 — CompareModal 과 같은 방식(프로그램적 play/pause 는 ignore 로 전파 차단). 영상 요소만 대상.
  useEffect(() => {
    const vids = videoRefs.current.filter((v): v is HTMLVideoElement => !!v);
    if (vids.length === 0) return;
    const ignore = new Set<HTMLVideoElement>();
    const playAll = (except?: HTMLVideoElement) =>
      vids.forEach((v) => {
        if (v !== except && v.paused) {
          ignore.add(v);
          v.play().catch(() => ignore.delete(v));
        }
      });
    const pauseAll = (except?: HTMLVideoElement) =>
      vids.forEach((v) => {
        if (v !== except && !v.paused) {
          ignore.add(v);
          v.pause();
        }
      });
    let restarting = false;
    const onPlay = (e: Event) => {
      const t = e.target as HTMLVideoElement;
      if (ignore.has(t)) {
        ignore.delete(t);
        return;
      }
      playAll(t);
    };
    const onPause = (e: Event) => {
      const t = e.target as HTMLVideoElement;
      if (ignore.has(t)) {
        ignore.delete(t);
        return;
      }
      if (t.ended) return; // 끝나서 멈춘 건 전파 안 함(짧은 영상은 대기)
      pauseAll(t);
    };
    const onEnded = (e: Event) => {
      if (restarting) return;
      const t = e.target as HTMLVideoElement;
      const maxDur = Math.max(...vids.map((v) => v.duration || 0));
      if ((t.duration || 0) >= maxDur - 0.05 || vids.every((v) => v.ended)) {
        restarting = true;
        vids.forEach((v) => (v.currentTime = 0));
        playAll();
        setTimeout(() => (restarting = false), 120);
      }
    };
    vids.forEach((v) => {
      v.addEventListener("play", onPlay);
      v.addEventListener("pause", onPause);
      v.addEventListener("ended", onEnded);
    });
    playAll(); // 열리면 동시 자동재생(muted 라 정책 통과)
    return () =>
      vids.forEach((v) => {
        v.removeEventListener("play", onPlay);
        v.removeEventListener("pause", onPause);
        v.removeEventListener("ended", onEnded);
      });
  }, [videos]);

  return (
    <>
      <div className="cmp-backdrop" onMouseDown={onClose} />
      <div className="cmp-modal" role="dialog" aria-label="미디어 비교">
        <header className="admin-head">
          <span className="admin-title">⊞ 미디어 비교 ({videos.length})</span>
          <div className="cmp-toggles">
            <button
              className={"fit-toggle" + (fitContain ? " on" : "")}
              onClick={() => setFitContain((v) => !v)}
              title={
                fitContain
                  ? "전체 보기(블랙바) — 클릭 시 꽉 채우기"
                  : "꽉 채우기(크롭) — 클릭 시 전체 보기"
              }
            >
              {fitContain ? "▢" : "▣"}
            </button>
            <button className="assets-x" onClick={onClose} title="닫기">
              ✕
            </button>
          </div>
        </header>
        <div className="cmp-body">
          <div
            className={"cmp-cols" + (fitContain ? " fit-contain" : "")}
            style={{ gridTemplateColumns: `repeat(${videos.length}, minmax(220px, 1fr))` }}
          >
            {videos.map((v, i) => (
              <div className="cmp-col" key={i}>
                <div className="cmp-thumb">
                  {v.type === "video" ? (
                    <video
                      ref={(el) => {
                        videoRefs.current[i] = el;
                      }}
                      src={v.url}
                      controls
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    <img
                      src={v.url}
                      alt={v.name}
                      style={{ cursor: "zoom-in" }}
                      title="클릭해 크게 보기"
                      onClick={() =>
                        setZoom({ url: v.full || v.url, type: "image", name: v.name })
                      }
                      onError={(e) => {
                        // 고해상도 URL 로드 실패 → 검증된 대체(썸네일)로 한 번 교체(무한 루프 방지).
                        const img = e.currentTarget;
                        if (v.fallback && img.src !== v.fallback) img.src = v.fallback;
                      }}
                    />
                  )}
                </div>
                <div className="cmp-model">{v.name}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <CompareSourceLightbox preview={zoom} onClose={() => setZoom(null)} />
    </>
  );
}
