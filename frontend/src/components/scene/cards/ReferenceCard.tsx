// 레퍼런스 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
//  genData 는 이벤트 시점 참조라 조회 함수(getGen)로 받는다(ref 역참조 없이 최신값).
import type React from "react";
import type { SceneCard } from "../../../lib/scenes";
import type { Generation, InfoTarget, PreviewTarget } from "../../../types";
import { refMediaSrc, refMediaType, refThumbSrc, refTypeLabel } from "../../../lib/sceneMedia";
import { MediaThumbnail } from "../../MediaThumbnail";

export function ReferenceCard({
  card,
  fill,
  getGen,
  onInfo,
  onPreview,
  onOutPortDown,
}: {
  card: SceneCard;
  fill: boolean;
  getGen: (id: string) => Generation | undefined;
  onInfo?: (target: InfoTarget) => void;
  onPreview?: (t: PreviewTarget) => void;
  onOutPortDown: (e: React.MouseEvent, cardId: string) => void;
}) {
  return (
    <>
      {/* 내부 래퍼만 클리핑(둥근 모서리) — 포트는 이 밖이라 잡기 영역이 안 잘린다 */}
      <div className="scene-card-inner">
        <div className="scene-card-hd">{refTypeLabel(card.refs)}</div>
        <div
          className={
            "scene-card-body" +
            ((card.refs?.length ?? 0) <= 1 ? " single" : "") +
            (fill ? "" : " fit-contain")
          }
        >
          {(card.refs || []).map((r, i) => {
            const isVid = refMediaType(r) === "video";
            return (
              <div
                className="scene-refthumb"
                key={i}
                title={(r.name || `레퍼런스 ${i + 1}`) + " · 더블클릭=큰 화면 · 미들클릭=정보"}
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault(); // 휠클릭 자동스크롤 방지(정보는 auxclick 에서)
                }}
                onAuxClick={(e) => {
                  // 미들클릭 = 정보. asset 토큰(어셋/임포트/캡처) → 어셋창과 동일한 파일 정보 팝업,
                  //  생성물에서 온 레퍼런스(source_gen_id) → 생성 정보 팝업.
                  if (e.button !== 1) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const fp = r.file_path || "";
                  if (fp.startsWith("asset:")) {
                    const [proj, path] = fp.slice(6).split("|");
                    if (proj && path) {
                      const mt = refMediaType(r);
                      onInfo?.({
                        kind: "file",
                        project: proj,
                        node: {
                          name: r.name || path.split("/").pop() || path,
                          type: mt === "video" ? "video" : mt === "audio" ? "audio" : "image",
                          path,
                        },
                        x: e.clientX,
                        y: e.clientY,
                      });
                      return;
                    }
                  }
                  const g = r.source_gen_id ? getGen(r.source_gen_id) : undefined;
                  if (g) onInfo?.({ kind: "generation", gen: g, x: e.clientX, y: e.clientY });
                }}
                onMouseEnter={
                  isVid
                    ? (e) => {
                        const v = e.currentTarget.querySelector("video");
                        if (v) {
                          v.muted = true; // React <video muted> 반영 버그 → 재생 직전 무음 강제
                          v.play().catch(() => {});
                        }
                      }
                    : undefined
                }
                onMouseLeave={
                  isVid
                    ? (e) => {
                        const v = e.currentTarget.querySelector("video");
                        if (v) {
                          v.pause();
                          v.currentTime = 0;
                        }
                      }
                    : undefined
                }
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  const url = refMediaSrc(r);
                  if (url) onPreview?.({ url, type: refMediaType(r), name: r.name || "레퍼런스" });
                }}
              >
                <MediaThumbnail
                  thumb={refThumbSrc(r)}
                  isVideo={isVid}
                  src={refMediaSrc(r)}
                  fallback={<span className="scene-refthumb-ph" />}
                  retrySrcOnThumbError
                />
                {isVid ? (
                  <span className="scene-refthumb-vid vid">▶</span>
                ) : refMediaType(r) === "audio" ? (
                  <span className="scene-refthumb-vid aud">♪</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <span
        className="scene-port out"
        onMouseDown={(e) => onOutPortDown(e, card.id)}
        title="드래그해 생성 카드에 연결"
      />
    </>
  );
}
