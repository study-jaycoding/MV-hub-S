// 편집 탭 아래쪽 — 눈금자·컷 줄·영상 트랙(위가 우선)·소리 줄과 재생헤드.
// 재생헤드는 부모가 ref 로 직접 옮긴다(프레임마다 React 렌더 없음). 컷 자리는 폴더 순서로 고정이라
// 클립은 좌우로 못 옮기고, 위아래로 끌어 트랙만 바꾼다.
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { Generation } from "../../types";
import {
  clipKey,
  timecode,
  visibleSegments,
  type EditDoc,
  type EditLayout,
  type MediaState,
  type SlotClip,
} from "../../lib/editTimeline";
import { useT } from "../../lib/i18n";
import { thumbOf } from "../../lib/media";

export const ZOOM_MIN = 2; // px/초
export const ZOOM_MAX = 400;
const LANE_H = 58;
const DRAG_START = 6;
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export interface ClipLink {
  state: MediaState;
  gen: Generation | null;
}

export const EditTimeline = memo(function EditTimeline({
  layout,
  doc,
  links,
  zoom,
  rev,
  selected,
  currentCut,
  scrollRef,
  headRef,
  getNow,
  onSeek,
  onZoom,
  onSelect,
  onClearSelection,
  onMoveClip,
  onToggleTrack,
  onToggleMute,
}: {
  layout: EditLayout;
  doc: EditDoc;
  links: ReadonlyMap<string, ClipLink>;
  zoom: number;
  rev: number; // 끌기를 시작한 뒤 문서가 갈렸으면 그 끌기는 버린다
  selected: ReadonlySet<string>;
  currentCut: string | null;
  scrollRef: RefObject<HTMLDivElement>;
  headRef: RefObject<HTMLDivElement>;
  getNow: () => number;
  onSeek: (time: number) => void;
  onZoom: (zoom: number) => void;
  onSelect: (key: string, additive: boolean) => void;
  onClearSelection: () => void;
  onMoveClip: (key: string, track: number, rev: number) => void;
  onToggleTrack: (list: "tracksOff" | "tracksLocked", track: number) => void;
  onToggleMute: () => void;
}) {
  const t = useT();
  const lanesRef = useRef<HTMLDivElement>(null);
  const live = useRef({ zoom, onZoom, getNow });
  live.current = { zoom, onZoom, getNow };
  // 확대/축소 뒤에도 기준(커서 아래 시각, 없으면 재생헤드)이 화면의 같은 자리에 오게 한다.
  const anchor = useRef<{ time: number; offset: number } | null>(null);
  const zoomed = useRef(zoom);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || zoomed.current === zoom) return;
    const time = anchor.current?.time ?? getNow();
    const offset = anchor.current?.offset ?? time * zoomed.current - scroll.scrollLeft;
    scroll.scrollLeft = Math.max(0, time * zoom - offset);
    zoomed.current = zoom;
    anchor.current = null;
  });

  // 휠은 타임라인 안에서만 가로챈다 — Alt = 확대(커서 기준), Ctrl·Shift = 좌우. (React 의 onWheel 은 취소가 안 된다.)
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const onWheel = (event: WheelEvent) => {
      const delta = event.deltaY || event.deltaX;
      if (!delta) return;
      if (event.altKey) {
        event.preventDefault();
        const { zoom: current, onZoom: setZoom } = live.current;
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current * (delta < 0 ? 1.15 : 1 / 1.15)));
        if (next === current) return;
        const offset = event.clientX - scroll.getBoundingClientRect().left;
        anchor.current = { time: (scroll.scrollLeft + offset) / current, offset };
        setZoom(next);
      } else if (event.ctrlKey || event.shiftKey) {
        event.preventDefault();
        scroll.scrollLeft += delta;
      }
    };
    scroll.addEventListener("wheel", onWheel, { passive: false });
    return () => scroll.removeEventListener("wheel", onWheel);
  }, [scrollRef]);

  const timeAt = (clientX: number) => {
    const rect = lanesRef.current?.getBoundingClientRect();
    return rect ? (clientX - rect.left) / zoom : 0;
  };
  const scrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.type === "pointerdown") {
      if (event.button !== 0) return;
      event.stopPropagation(); // 눈금자를 눌러도 고른 클립은 그대로다
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onSeek(timeAt(event.clientX));
  };

  // 클립 끌기 — 6px 넘게 움직이면 끌기로 보고, 놓은 자리의 트랙으로 옮긴다(찬 자리면 맞바꿈).
  const drag = useRef<{ key: string; track: number; y: number; rev: number; moved: boolean } | null>(null);
  const clipDown = (event: ReactPointerEvent<HTMLElement>, key: string, from: number, locked: boolean) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (locked) return; // 잠긴 트랙의 클립은 고르지도 못한다
    onSelect(key, event.ctrlKey || event.metaKey || event.shiftKey);
    drag.current = { key, track: from, y: event.clientY, rev, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const clipMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.abs(dy) < DRAG_START) return;
    current.moved = true;
    event.currentTarget.style.transform = `translateY(${dy}px)`;
    event.currentTarget.style.zIndex = "4";
  };
  const clipUp = (event: ReactPointerEvent<HTMLElement>, cancel = false) => {
    const current = drag.current;
    drag.current = null;
    event.currentTarget.style.transform = "";
    event.currentTarget.style.zIndex = "";
    if (!current?.moved || cancel) return;
    const lane = document.elementsFromPoint(event.clientX, event.clientY)
      .find((element) => element instanceof HTMLElement && element.dataset.track);
    const track = Number((lane as HTMLElement | undefined)?.dataset.track);
    if (track > 0 && track !== current.track) onMoveClip(current.key, track, current.rev);
  };

  const width = Math.max(layout.total * zoom + 120, 0);
  const step = RULER_STEPS.find((seconds) => seconds * zoom >= 90) ?? RULER_STEPS[RULER_STEPS.length - 1];
  const ticks: number[] = [];
  for (let time = 0; time <= layout.total + step; time += step) ticks.push(time);
  const tracks = Array.from({ length: layout.tracks }, (_, i) => layout.tracks - i); // 위에서부터
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

  const renderClip = (clip: SlotClip, start: number) => {
    const key = clipKey(clip);
    const link = links.get(key);
    const state = link?.state ?? "unknown";
    const locked = doc.tracksLocked.includes(clip.track);
    const off = !!clip.off || doc.tracksOff.includes(clip.track);
    const clipWidth = Math.max(6, clip.len * zoom - 2);
    const thumb = link?.gen ? thumbOf(link.gen, 256) : null;
    const frames = Math.min(16, Math.max(1, Math.round(clipWidth / ((LANE_H - 6) * (16 / 9)))));
    return (
      <div
        key={key}
        className={"ed-clip" + (selected.has(key) ? " ed-sel" : "") + (off ? " ed-off" : "") +
          (state !== "ok" ? ` ed-${state}` : "") + (locked ? " ed-locked" : "")}
        style={{ left: start * zoom + 1, width: clipWidth }}
        title={link?.gen?.prompt?.slice(0, 80) || undefined}
        onPointerDown={(event) => clipDown(event, key, clip.track, locked)}
        onPointerMove={clipMove}
        onPointerUp={(event) => clipUp(event)}
        onPointerCancel={(event) => clipUp(event, true)}
      >
        {state === "ok" && thumb
          ? Array.from({ length: frames }, (_, i) => <i key={i} style={{ backgroundImage: `url("${thumb}")` }} />)
          : <span className="ed-clip-msg">{state === "missing" ? t("미디어 없음") : state === "unknown" ? t("확인 못 함") : ""}</span>}
        <b>{clip.len.toFixed(1)}s</b>
      </div>
    );
  };

  return (
    <div className="ed-tl">
      <div className="ed-heads" onMouseDown={keepFocus}>
        <div className="ed-head ed-h-ruler" />
        <div className="ed-head ed-h-cut"><b>{t("컷")}</b>{t("폴더")}</div>
        {tracks.map((track) => {
          const locked = doc.tracksLocked.includes(track);
          const off = doc.tracksOff.includes(track);
          return (
            <div className="ed-head ed-h-v" key={track}>
              <b>V{track}</b>
              <button type="button" className={"ed-hbtn" + (locked ? " ed-on" : "")} aria-pressed={locked}
                title={locked ? t("잠금 풀기") : t("트랙 잠그기")} aria-label={locked ? t("잠금 풀기") : t("트랙 잠그기")}
                onClick={() => onToggleTrack("tracksLocked", track)}>
                <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true">
                  <rect x="1.5" y="5" width="8" height="6" rx="1.2" />
                  <path d={locked ? "M3.2 5V3.6a2.3 2.3 0 0 1 4.6 0V5" : "M3.2 5V3.6a2.3 2.3 0 0 1 4.4-.9"} fill="none" strokeWidth="1.3" />
                </svg>
              </button>
              <button type="button" className={"ed-hbtn" + (off ? " ed-dim" : "")} aria-pressed={!off}
                title={off ? t("트랙 켜기") : t("트랙 끄기")} aria-label={off ? t("트랙 켜기") : t("트랙 끄기")}
                onClick={() => onToggleTrack("tracksOff", track)}>
                <svg width="14" height="11" viewBox="0 0 14 11" aria-hidden="true">
                  <rect x="1" y="1" width="12" height="9" rx="1.6" fill="none" strokeWidth="1.3" />
                  {!off && <rect x="3.4" y="3.3" width="7.2" height="4.4" rx="0.6" />}
                </svg>
              </button>
            </div>
          );
        })}
        <div className="ed-head ed-h-a">
          <b>A1</b>
          <button type="button" className={"ed-hbtn ed-mute" + (doc.muted ? " ed-on" : "")} aria-pressed={!!doc.muted}
            title={t("소리 끄기 (M)")} aria-label={t("소리 끄기 (M)")} onClick={onToggleMute}>M</button>
        </div>
      </div>
      <div className="ed-scroll" ref={scrollRef}>
        <div className="ed-lanes" ref={lanesRef} style={{ width }} onPointerDown={onClearSelection} onMouseDown={keepFocus}>
          <div className="ed-ruler" onPointerDown={scrub} onPointerMove={scrub}>
            {ticks.map((time) => (
              <div className="ed-tick" key={time} style={{ left: time * zoom }}><span>{timecode(time)}</span></div>
            ))}
          </div>
          <div className="ed-lane ed-l-cut">
            {layout.cuts.map((slot) => (
              <button type="button" key={slot.path} style={{ left: slot.start * zoom, width: slot.len * zoom }}
                className={"ed-cutcell" + (slot.path === currentCut ? " ed-cur" : "") + (slot.clips.length ? "" : " ed-nopick")}
                title={slot.path} onPointerDown={(event) => event.stopPropagation()} onClick={() => onSeek(slot.start)}>
                {slot.name}
              </button>
            ))}
          </div>
          {tracks.map((track) => (
            <div className={"ed-lane ed-l-v" + (doc.tracksOff.includes(track) ? " ed-lane-off" : "")} key={track} data-track={track}>
              {layout.cuts.map((slot) => {
                const clip = slot.clips.find((item) => item.track === track);
                if (clip) return renderClip(clip, slot.start);
                // 고르지 않은 컷은 V1 에 빈 자리로만 보인다.
                return track === 1 && !slot.clips.length ? (
                  <div className="ed-slot" key={slot.path} style={{ left: slot.start * zoom + 1, width: Math.max(6, slot.len * zoom - 2) }}>
                    {slot.len * zoom > 60 ? t("비어 있음") : ""}
                  </div>
                ) : null;
              })}
            </div>
          ))}
          <div className={"ed-lane ed-l-a" + (doc.muted ? " ed-lane-off" : "")}>
            {layout.cuts.flatMap((slot) =>
              visibleSegments(doc, slot)
                .filter((segment) => segment.clip && links.get(clipKey(segment.clip))?.gen?.assets[0]?.type === "video")
                .map((segment) => (
                  <div className="ed-aud" key={`${slot.path}:${segment.from}`}
                    style={{ left: (slot.start + segment.from) * zoom + 1, width: Math.max(4, (segment.to - segment.from) * zoom - 2) }} />
                )))}
          </div>
          {layout.cuts.map((slot) => <div className="ed-cutline" key={slot.path} style={{ left: slot.start * zoom }} />)}
          <div className="ed-cutline" style={{ left: layout.total * zoom }} />
          <div className="ed-phead" ref={headRef} />
        </div>
      </div>
    </div>
  );
});
