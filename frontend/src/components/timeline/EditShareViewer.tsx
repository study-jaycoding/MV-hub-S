// 편집 탭의 'V0 · 이름' 판(편집 공유 — 다른 편집 보기, Jay 2026-10-23) — 타임라인의 시계를 따라가며 고른 사람의 '보이는 것 한 줄'을 보여 준다.
//  배치는 받은 스냅샷을 조각마다 자리 하나로 편 것(lib/editShare.shareLayout) — 그 사람 타임라인 그대로라 내 컷과 어긋날 수 있다(Jay ③).
//  소리는 내지 않는다. V0 을 못 쓰면(꺼짐·사람 없음·읽기 실패) 안내 화면 — 타임라인으로 바꾸지 않는다(설계 §6).
import { useRef } from "react";
import type { ShareLayout } from "../../lib/editShare";
import type { CutSlot, EditLayout, SlotClip } from "../../lib/editTimeline";
import { useEditFollow } from "../../lib/useEditFollow";
import type { EditSource } from "../../lib/useEditPlayback";
import { EditViewer, type ViewerProps } from "./EditViewer";

const EMPTY: EditLayout = { cuts: [], total: 0, tracks: 1 };
const piece = (slot: CutSlot, local: number): SlotClip | null => {
  const clip = slot.clips[0];
  return clip && local < clip.len ? clip : null;
};

export function EditShareViewer({
  share, sourceOf, now, name, notice, ...viewer
}: Omit<ViewerProps, "shown" | "videoRef" | "label" | "detail" | "muted" | "empty"> & {
  share: ShareLayout | null;
  sourceOf: (clip: SlotClip) => EditSource;
  now: () => number;
  name: string;
  notice: string | null; // V0 을 못 쓸 때의 안내(있으면 그것만 보인다)
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shown = useEditFollow({
    videoRef, layout: share?.layout ?? EMPTY, pick: piece, sourceOf, now, playing: viewer.playing, rate: viewer.rate,
  });
  const box = shown.clip ? share?.layout.cuts.find((slot) => slot.path === shown.clip!.cut) : null;
  return (
    <EditViewer {...viewer} shown={notice ? { ...shown, clip: null, source: null } : shown} videoRef={videoRef} muted
      empty={notice} label={box ? `V0 · ${name} · ${box.name}` : `V0 · ${name}`} detail="" />
  );
}
