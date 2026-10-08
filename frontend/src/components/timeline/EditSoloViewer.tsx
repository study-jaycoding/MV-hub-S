// 편집 탭의 '한 트랙만 보기' 판 — 타임라인의 시계를 따라가며 그 트랙의 클립만 보여 준다(useEditFollow).
//  위·아래 줄의 조작(재생·훑기·반복)은 타임라인의 것 그대로다 — 시계가 하나라서.
import { useRef } from "react";
import type { EditLayout, SlotClip } from "../../lib/editTimeline";
import { useEditFollow } from "../../lib/useEditFollow";
import type { EditSource } from "../../lib/useEditPlayback";
import { EditViewer, type ViewerProps } from "./EditViewer";

export function EditSoloViewer({
  track, layout, sourceOf, now, labelOf, detailOf, ...viewer
}: Omit<ViewerProps, "shown" | "videoRef" | "label" | "detail"> & {
  track: number;
  layout: EditLayout;
  sourceOf: (clip: SlotClip) => EditSource;
  now: () => number;
  labelOf: (clip: SlotClip | null) => string;
  detailOf: (clip: SlotClip | null) => string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shown = useEditFollow({ videoRef, layout, track, sourceOf, now, playing: viewer.playing, rate: viewer.rate });
  return <EditViewer {...viewer} shown={shown} videoRef={videoRef} label={labelOf(shown.clip)} detail={detailOf(shown.clip)} />;
}
