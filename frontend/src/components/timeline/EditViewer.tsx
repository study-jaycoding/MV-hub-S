// 편집 탭의 뷰어 — 재생헤드 자리에서 보이는 클립 하나(위 트랙 우선)와 재생 단추.
// `<video>` 는 늘 하나만 두고 재생 훅(useEditPlayback)이 주소를 갈아 끼운다. 타임코드는 훅의 paint 가 ref 로 고친다.
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import { useT } from "../../lib/i18n";
import type { EditView } from "../../lib/useEditPlayback";

export function EditViewer({
  view,
  videoRef,
  timecodeRef,
  total,
  label,
  detail,
  muted,
  empty,
  dual,
  onToggleDual,
  onToggle,
  onStepFrames,
  onStepEdit,
}: {
  view: EditView;
  videoRef: RefObject<HTMLVideoElement>;
  timecodeRef: RefObject<HTMLSpanElement>;
  total: string; // 전체 길이 타임코드
  label: string; // 'e070 / c0050 · V3'
  detail: string; // '만든 사람 · 모델 · 5.0s'
  muted: boolean;
  empty: string | null; // 타임라인이 없을 때의 안내(있으면 화면 가운데에 그것만)
  dual: boolean; // 듀얼 뷰어 — 왼쪽에 소스 뷰어가 같이 떠 있다
  onToggleDual: () => void;
  onToggle: () => void;
  onStepFrames: (frames: number) => void;
  onStepEdit: (dir: 1 | -1) => void;
}) {
  const t = useT();
  const source = view.source;
  const isVideo = !!view.clip && source?.state === "ok" && source.type === "video" && !view.failed;
  const still = view.clip && source?.state === "ok" && !isVideo ? (source.type === "image" ? source.url : source.thumb) : null;
  const notice = empty
    ?? (!view.clip ? null
      : source?.state === "missing" ? t("미디어 없음 — 공유 목록에 없는 생성물입니다.")
        : source?.state === "unknown" ? t("확인 못 함 — 공유 목록을 아직 받지 못했습니다.")
          : view.failed ? t("이 영상을 재생하지 못했습니다.") : null);
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault();
  const speed = Math.abs(view.rate) > 1 || view.rate < 0 ? `${view.rate < 0 ? "◀ " : ""}${Math.abs(view.rate)}x` : "";

  return (
    <section className="ed-view">
      <div className="ed-stage">
        {/* 영상 요소는 떼지 않는다 — 떼면 재생 훅이 걸어 둔 이벤트와 주소가 함께 사라진다. */}
        <video ref={videoRef} className="ed-media" muted={muted} playsInline preload="auto" hidden={!isVideo}
          poster={isVideo && source?.thumb ? source.thumb : undefined} />
        {still && <img className="ed-media" src={still} alt="" draggable={false} />}
        {notice && <div className="ed-notice" role="status">{notice}</div>}
        {!empty && label && <span className="ed-chip ed-chip-l">{label}</span>}
        {!empty && detail && <span className="ed-chip ed-chip-r">{detail}</span>}
      </div>
      <div className="ed-trans" onMouseDown={keepFocus}>
        <span className="ed-keys">
          <kbd>Space</kbd> {t("재생")} <kbd>J</kbd><kbd>K</kbd><kbd>L</kbd> <kbd>←</kbd><kbd>→</kbd> {t("한 프레임")}{" "}
          <kbd>↑</kbd><kbd>↓</kbd> {t("앞·뒤 편집점")}
        </span>
        <button type="button" className="ed-tbtn" title={t("앞 편집점 (↑)")} aria-label={t("앞 편집점 (↑)")} onClick={() => onStepEdit(-1)}>
          <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="1" y="1" width="2" height="12" /><path d="M15 1v12L5 7z" /></svg>
        </button>
        <button type="button" className="ed-tbtn" title={t("한 프레임 뒤로 (←)")} aria-label={t("한 프레임 뒤로 (←)")} onClick={() => onStepFrames(-1)}>
          <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M11 1v12L1 7z" /></svg>
        </button>
        <button type="button" className="ed-tbtn ed-play" title={t("재생/정지 (Space)")} aria-label={t("재생/정지 (Space)")} onClick={onToggle}>
          {view.playing ? (
            <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><rect x="1.5" y="1" width="3.2" height="12" /><rect x="7.3" y="1" width="3.2" height="12" /></svg>
          ) : (
            <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M2 1v12l9-6z" /></svg>
          )}
        </button>
        <button type="button" className="ed-tbtn" title={t("한 프레임 앞으로 (→)")} aria-label={t("한 프레임 앞으로 (→)")} onClick={() => onStepFrames(1)}>
          <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M1 1v12l10-6z" /></svg>
        </button>
        <button type="button" className="ed-tbtn" title={t("뒤 편집점 (↓)")} aria-label={t("뒤 편집점 (↓)")} onClick={() => onStepEdit(1)}>
          <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="13" y="1" width="2" height="12" /><path d="M1 1v12l10-6z" /></svg>
        </button>
        <span className="ed-tcr">
          {speed && <b>{speed}</b>}
          <span ref={timecodeRef}>00:00:00:00</span><span className="ed-tcr-total"> / {total}</span>
          {/* 싱글/듀얼 뷰어(다빈치의 Single Viewer Mode) — 듀얼이면 왼쪽에 미디어 풀에서 고른 생성물(소스)이 나란히 보인다 */}
          <button type="button" className={"ed-tbtn ed-dual" + (dual ? " ed-on" : "")} aria-pressed={dual} onClick={onToggleDual}
            title={dual ? t("싱글 뷰어로 — 타임라인만 봅니다") : t("듀얼 뷰어로 — 고른 생성물(소스)과 타임라인을 나란히 봅니다")}
            aria-label={dual ? t("싱글 뷰어로 — 타임라인만 봅니다") : t("듀얼 뷰어로 — 고른 생성물(소스)과 타임라인을 나란히 봅니다")}>
            <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
              {dual ? <><rect x="0.5" y="0.5" width="7.5" height="11" /><rect x="10" y="0.5" width="7.5" height="11" /></>
                : <rect x="0.5" y="0.5" width="17" height="11" />}
            </svg>
          </button>
        </span>
      </div>
    </section>
  );
}
