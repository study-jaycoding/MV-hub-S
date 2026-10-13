// 편집 탭 — 클립 길이 조절 창(Jay 2026-10-13: 타임라인의 클립을 휠 클릭). 뒤를 자른다 — 줄인 뒤의 구간에는 아래 트랙이 보인다.
//  · 값은 프레임(24fps) 단위다. 조절할 때마다 바로 문서에 적는다(부르는 쪽이 창을 한 번 연 동안을 되돌리기 한 단계로 묶는다).
//  · 창의 작은 화면이 그 길이에서 **마지막으로 보이는 프레임**을 보여 준다 — 타임라인의 재생헤드는 건드리지 않는다(그 클립이 위
//    트랙에 가려져 있거나 꺼져 있어도 볼 수 있다).
//  · ←/→ = 1프레임, Shift+←/→ = 10프레임. 끝까지 늘리면 '원본 길이로'와 같다(줄임을 지운다).
//  껍데기(자리·바깥 누르기·Esc·뒤 화면의 키 막기)는 EditMenu 의 것이다.
import { useEffect, useRef } from "react";
import { EDIT_FPS } from "../../lib/editTimeline";
import { useT } from "../../lib/i18n";
import { EditMenu } from "./EditTrackMenu";

const WIDTH = 268;

export function EditTrimPop({
  x,
  y,
  title,
  full,
  value,
  trimmed,
  src,
  onChange,
  onClose,
}: {
  x: number;
  y: number;
  title: string; // 'C0110 · V2'
  full: number; // 원본 길이(초)
  value: number; // 지금 쓰는 길이(초)
  trimmed: boolean; // 줄여 둔 클립인가 — '원본 길이로'가 켜진다
  src: string | null; // 그 영상(작은 화면) — 없으면 화면 없이 숫자만
  onChange: (seconds: number | null) => void; // null = 원본 길이로
  onClose: () => void;
}) {
  const t = useT();
  const top = Math.max(1, Math.floor(full * EDIT_FPS + 1e-6)); // 원본을 넘지 않는 가장 긴 프레임 수(snapTrim 과 같은 내림)
  const frames = Math.min(top, Math.max(1, Math.round(value * EDIT_FPS)));
  const set = (next: number) => {
    const to = Math.min(top, Math.max(1, Math.round(next)));
    if (to >= top) {
      if (trimmed) onChange(null);
    } else if (to !== frames || !trimmed) onChange(to / EDIT_FPS);
  };

  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const seek = () => {
      element.currentTime = (frames - 1) / EDIT_FPS; // 그 길이에서 마지막으로 보이는 프레임
    };
    if (element.readyState >= 1) seek();
    else element.addEventListener("loadedmetadata", seek, { once: true });
    return () => element.removeEventListener("loadedmetadata", seek);
  }, [frames, src]);

  const step = (delta: number, label: string) => (
    <button type="button" disabled={delta < 0 ? frames <= 1 : frames >= top} onClick={() => set(frames + delta)}>{label}</button>
  );
  return (
    <EditMenu x={x} y={y} width={WIDTH} height={src ? 300 : 152} label={t("길이 조절")} className="ed-trim" onClose={onClose}>
      <div
        className="ed-trim-body"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault(); // 슬라이더가 스스로 한 칸 더 움직이지 않게
          set(frames + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1));
        }}
      >
        <div className="ed-tmenu-head">{t("길이 조절")} — {title}</div>
        {src && <video ref={video} className="ed-trim-view" src={src} muted playsInline preload="auto" />}
        <input type="range" className="ed-trim-range" autoFocus min={1} max={top} step={1} value={frames}
          aria-label={t("클립 길이(프레임)")} aria-valuetext={`${(frames / EDIT_FPS).toFixed(2)}${t("초")}`}
          onChange={(event) => set(Number(event.target.value))} />
        <div className="ed-trim-row">
          {step(-10, "−10f")}
          {step(-1, "−1f")}
          <b>{(frames / EDIT_FPS).toFixed(2)}{t("초")}</b>
          {step(1, "+1f")}
          {step(10, "+10f")}
        </div>
        <div className="ed-trim-note">
          {t("원본 {full}초 · 지금 {frames}프레임").replace("{full}", full.toFixed(2)).replace("{frames}", String(frames))}
        </div>
        <div className="ed-trim-foot">
          <button type="button" disabled={!trimmed} onClick={() => onChange(null)}>{t("원본 길이로")}</button>
          <button type="button" onClick={onClose}>{t("닫기")}</button>
        </div>
      </div>
    </EditMenu>
  );
}
