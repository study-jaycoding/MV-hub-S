// 편집 탭 → DaVinci Resolve 타임라인 보내기의 순수 계산 — 지금 화면의 배치(layout)를 '타임라인 계획'으로 옮긴다.
// React·fetch·localStorage 를 쓰지 않는다(eslint 순수 파일 목록). 계약은 docs/EDIT_TAB.md '타임라인 Resolve 보내기'.
//
//  · 계획은 **프레임**으로 적는다(타임라인 처음 = 0, 끝은 미포함). 초 → 프레임은 **절대 시각을 한 번씩** 반올림한다 — 컷마다 반올림한
//    길이를 더하면 뒤로 갈수록 어긋난다(Codex 설계 검토 10-09).
//  · 넣는 것은 **그 순간의 layout** 이다(문서가 아니다): 숨긴 컷은 빠지고, 숨기지 않은 비활성 컷은 편집 탭에서 재생되므로 들어간다.
//    꺼진 클립·꺼진 트랙도 그대로 넣고 꺼 둔다(Resolve 에서 켜 볼 수 있게 — '그대로').
//  · 소리는 편집 탭에서 **들리는 것만**: 그 순간 보이는 영상 하나의 소리(visibleSegments) → A1 한 줄(Jay 2026-10-13).
//  · 생성물 id 는 공유 목록이 이어 준 **실제 id** 다(job 으로 이은 클립 — 문서에 적힌 옛 id 가 아니다). 못 이은 클립이 하나라도 있으면
//    보내지 않는다(빼고 보내면 '그대로'가 아니다 — unresolved).
import type { Generation } from "../types";
import {
  EDIT_FPS,
  MARKER_COLORS,
  clipKey,
  markRange,
  shownMarkers,
  visibleSegments,
  type EditDoc,
  type EditLayout,
  type MediaState,
} from "./editTimeline";

export const TIMELINE_EXPORT_FORMAT = "mvhub.edit-timeline";
export const TIMELINE_EXPORT_VERSION = 1;

// Resolve 의 마커 색 이름 — MARKER_COLORS 와 같은 순서(편집 탭의 16색이 다빈치의 것이다).
export const RESOLVE_MARKER_COLORS = [
  "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia",
  "Rose", "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream",
] as const;

export interface TimelineExportClip {
  gen_id: string;
  track: number; // 1 부터(V1)
  start: number; // 타임라인 프레임(처음 = 0)
  end: number; // 끝 미포함
  enabled: boolean;
  kind: "video" | "image";
}

export interface TimelineExportAudio {
  gen_id: string;
  start: number;
  end: number;
  offset: number; // 그 영상 안에서의 시작(초) — 소스 프레임은 받는 쪽이 그 클립의 fps 로 센다
}

export interface TimelineExportMarker {
  frame: number;
  color: (typeof RESOLVE_MARKER_COLORS)[number];
  name: string;
}

export interface TimelineExportPlan {
  format: typeof TIMELINE_EXPORT_FORMAT;
  version: typeof TIMELINE_EXPORT_VERSION;
  name: string;
  fps: number;
  video_tracks: number;
  tracks_off: number[];
  tracks_locked: number[];
  muted: boolean;
  clips: TimelineExportClip[];
  audio: TimelineExportAudio[];
  markers: TimelineExportMarker[];
  mark: { in: number; out: number } | null; // out 은 끝 미포함
  total: number;
}

export interface TimelineExport {
  plan: TimelineExportPlan;
  gens: Generation[]; // 파일을 준비할 생성물(겹치지 않게, 타임라인 순서)
  unresolved: number; // 공유 목록에서 찾지 못한 클립 수 — 0 이 아니면 보내지 않는다
  perTrack: number[]; // perTrack[n - 1] = Vn 의 클립 수
  disabled: number; // 꺼진 채 들어가는 클립 수
  markersDropped: number; // 같은 프레임에 겹쳐 뺀 북마크 수(Resolve 는 프레임마다 하나)
}

export interface ExportLink {
  state: MediaState;
  gen: Generation | null;
}

const frame = (seconds: number) => Math.round(seconds * EDIT_FPS);

function resolveColor(hex: string | undefined): (typeof RESOLVE_MARKER_COLORS)[number] {
  const at = hex ? MARKER_COLORS.findIndex((item) => item.color.toLowerCase() === hex.toLowerCase()) : 0;
  return RESOLVE_MARKER_COLORS[at < 0 ? 0 : at];
}

// 타임라인 이름 — Resolve 가 받지 않거나 헷갈리는 글자를 뺀다. 같은 이름이 있으면 받는 쪽이 _2, _3 … 을 붙인다.
export function timelineExportName(projectName: string, sequence: string): string {
  const leaf = sequence.slice(sequence.lastIndexOf("/") + 1);
  const clean = (text: string) => text.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  return [clean(projectName), clean(leaf)].filter(Boolean).join("_").slice(0, 80) || "MVHub";
}

export function buildTimelineExport(args: {
  layout: EditLayout;
  doc: EditDoc;
  links: ReadonlyMap<string, ExportLink>;
  name: string;
}): TimelineExport {
  const { layout, doc, links, name } = args;
  const clips: TimelineExportClip[] = [];
  const audio: TimelineExportAudio[] = [];
  const gens = new Map<string, Generation>();
  const perTrack = Array.from({ length: layout.tracks }, () => 0);
  let unresolved = 0;
  let disabled = 0;

  for (const slot of layout.cuts) {
    const start = frame(slot.start);
    for (const clip of slot.clips) {
      const gen = links.get(clipKey(clip))?.gen ?? null;
      if (!gen) {
        unresolved += 1;
        continue;
      }
      const end = Math.max(start + 1, frame(slot.start + clip.len));
      gens.set(gen.id, gen);
      clips.push({
        gen_id: gen.id,
        track: clip.track,
        start,
        end,
        enabled: !clip.off,
        kind: gen.assets?.[0]?.type === "image" ? "image" : "video",
      });
      if (clip.track >= 1 && clip.track <= perTrack.length) perTrack[clip.track - 1] += 1;
      if (clip.off) disabled += 1;
    }
    // 들리는 것 = 그 순간 보이는 영상(꺼진 클립·꺼진 트랙은 visibleSegments 가 이미 뺐다). 이미지에는 소리가 없다.
    for (const segment of visibleSegments(doc, slot)) {
      const gen = segment.clip ? links.get(clipKey(segment.clip))?.gen ?? null : null;
      if (!gen || gen.assets?.[0]?.type !== "video") continue;
      const from = frame(slot.start + segment.from);
      const to = frame(slot.start + segment.to);
      if (to > from) audio.push({ gen_id: gen.id, start: from, end: to, offset: segment.from });
    }
  }

  // 북마크 — 프레임마다 하나(먼저 온 것). 컷 경계에서는 앞 컷의 끝과 뒤 컷의 처음이 같은 프레임이 된다.
  const markers: TimelineExportMarker[] = [];
  const taken = new Set<number>();
  let markersDropped = 0;
  for (const shown of shownMarkers(layout, doc)) {
    const at = frame(shown.time);
    if (taken.has(at)) {
      markersDropped += 1;
      continue;
    }
    taken.add(at);
    markers.push({ frame: at, color: resolveColor(shown.marker.color), name: shown.marker.name ?? "" });
  }

  const range = markRange(layout, doc);
  const mark = range && frame(range.to) > frame(range.from) ? { in: frame(range.from), out: frame(range.to) } : null;

  return {
    plan: {
      format: TIMELINE_EXPORT_FORMAT,
      version: TIMELINE_EXPORT_VERSION,
      name,
      fps: EDIT_FPS,
      video_tracks: layout.tracks,
      tracks_off: [...doc.tracksOff].filter((track) => track >= 1 && track <= layout.tracks).sort((a, b) => a - b),
      tracks_locked: [...doc.tracksLocked].filter((track) => track >= 1 && track <= layout.tracks).sort((a, b) => a - b),
      muted: !!doc.muted,
      clips,
      audio,
      markers,
      mark,
      total: frame(layout.total),
    },
    gens: [...gens.values()],
    unresolved,
    perTrack,
    disabled,
    markersDropped,
  };
}
