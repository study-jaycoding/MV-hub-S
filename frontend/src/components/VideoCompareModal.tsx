// 단순 미디어 비교 — 생성정보(프롬프트·파라미터) 없이 이미지·영상 2개+를 나란히 본다.
// (생성카드끼리는 CompareModal 로 전체 비교. 여기는 레퍼런스처럼 생성본이 아닌 미디어가 섞였을 때 '보기' 전용.)
// 영상 동기 로직은 CompareModal 과 공용 — 재생·정지·수동 탐색을 함께, 길이 다르면 가장 긴 것 끝에 되감기.
import { useEffect, useRef, useState } from "react";
import { bindSynchronizedVideos } from "../lib/synchronizedVideos";
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
      // 모달이 키를 소유 — 폼 컨트롤 밖의 키는 배경(캔버스 Delete 등)으로 새지 않게 막는다.
      //  capture 단계라 먼저 등록된 SceneBoard bubble 리스너보다 앞서 stopPropagation 이 걸린다.
      const t = e.target as HTMLElement | null;
      const formEl = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (!formEl) e.stopPropagation();
      if (e.key !== "Escape") return;
      if (zoom) setZoom(null); // 라이트박스 먼저 닫기
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, zoom]);

  // 동기 재생·탐색 — CompareModal 과 같은 공용 바인더. 영상 요소만 대상.
  useEffect(() => {
    const vids = videoRefs.current.filter((v): v is HTMLVideoElement => !!v);
    if (vids.length === 0) return;
    return bindSynchronizedVideos(vids);
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
                        // 고해상도 URL 로드 실패 → 검증된 대체(썸네일)로 '한 번만' 교체. img.src 는 절대 URL 로
                        //  정규화되고 v.fallback 은 상대 /api 라 문자열 비교가 항상 달라, fallback 도 404 면
                        //  무한 재요청이 났다 → dataset 플래그로 1회 적용 보장.
                        const img = e.currentTarget;
                        if (v.fallback && !img.dataset.fellback) {
                          img.dataset.fellback = "1";
                          img.src = v.fallback;
                        }
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
