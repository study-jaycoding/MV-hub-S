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
  clipSpeed,
  markRange,
  mediaAt,
  shownMarkers,
  visibleSegments,
  type EditDoc,
  type EditLayout,
  type MediaState,
  type SlotClip,
} from "./editTimeline";

export const TIMELINE_EXPORT_FORMAT = "mvhub.edit-timeline";
export const TIMELINE_EXPORT_VERSION = 1;
// 앞을 자른 클립이 있는 계획(Jay 2026-10-14) — 클립에 head(소스의 시작), 소리에 track(그 소리를 내는 영상 클립의 트랙)이 실린다.
//  그런 클립이 하나도 없으면 1 그대로다(전과 한 글자도 다르지 않다). 2 를 모르는 옛 허브는 계획을 거부한다 — 모르는 칸을 버리고
//  0초부터 놓은 타임라인을 '완료'라고 답하지 않게.
export const TIMELINE_EXPORT_VERSION_HEAD = 2;
// 속도를 바꾼 클립이 있는 계획(2026-10-23 Ctrl+R) — 2 의 칸(head·소리 track)은 모두 싣고, 속도 클립에 speed(배율)·src(쓰는 원본 길이 초 =
//  보내는 프레임 수 ÷ 24 × speed — 받는 쪽이 floor(src × 24 ÷ speed + 1e-6) = end − start 를 확인한다), 그 소리에 운반 클립과 같은 speed.
//  3 을 모르는 옛 허브는 계획을 거부한다 — 속도 없이 놓고 '완료'라 답하지 않게.
export const TIMELINE_EXPORT_VERSION_SPEED = 3;

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
  head?: number; // 소스의 시작(24fps 프레임) — version 2·3 에서만, 모든 클립에 싣는다(안 자른 클립·그림은 0)
  speed?: number; // 속도 배율 — version 3 의 속도를 바꾼 영상 클립에만(1 이면 없다)
  src?: number; // 그 클립이 쓰는 원본 길이(초) = (end − start) ÷ 24 × speed — speed 와 같이만
}

export interface TimelineExportAudio {
  gen_id: string;
  start: number;
  end: number;
  // 그 영상 안에서의 시작(초 — 앞을 자른 클립이면 그 시작점을 더한 값). 받는 쪽은 **그 영상 클립이 놓인 프레임에서 센 차이**를
  //  먼저 쓰고(그림과 프레임 단위로 맞게), 이 값은 그 클립을 계획에서 못 찾았을 때의 예비다(services/resolve_timeline.py)
  offset: number;
  // 그 소리를 내는 영상 클립의 트랙 — version 2·3 에서만. 같은 생성물이 두 트랙에 있어도(옛 id 와 새 id 가 같은 것으로 이어진 문서)
  //  받는 쪽이 제 영상 클립의 시작점을 쓰게 한다(Codex 설계 검토)
  track?: number;
  speed?: number; // 운반 영상 클립의 속도 — version 3 에서 그 클립에 속도가 있을 때만(받는 쪽이 같은지 본다)
}

export interface TimelineExportMarker {
  frame: number;
  color: (typeof RESOLVE_MARKER_COLORS)[number];
  name: string;
}

export interface TimelineExportPlan {
  format: typeof TIMELINE_EXPORT_FORMAT;
  version: typeof TIMELINE_EXPORT_VERSION | typeof TIMELINE_EXPORT_VERSION_HEAD | typeof TIMELINE_EXPORT_VERSION_SPEED;
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
  zeroCuts: number; // 한 프레임도 안 되는 컷 수 — 0 이 아니면 보내지 않는다(그 컷의 클립이 다음 컷과 겹친다)
  perTrack: number[]; // perTrack[n - 1] = Vn 의 클립 수
  disabled: number; // 꺼진 채 들어가는 클립 수
  markersDropped: number; // 같은 프레임에 겹쳐 뺀 북마크 수(Resolve 는 프레임마다 하나)
  end: number; // 마지막 클립의 끝(프레임) — Resolve 의 타임라인은 여기서 끝난다
  tailEmpty: number; // 그 뒤에 남는 빈 컷의 길이(프레임, plan.total − end) — Resolve 에 남지 않는다(실측: 끝의 빈 구간은 보존되지 않는다)
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
  let zeroCuts = 0;
  // 소스의 시작(프레임) — 그림에는 없다. 생성물의 실제 종류로 본다(kind 가 안 적힌 옛 클립은 문서만으로는 영상으로 보인다).
  //  **실제로 보내는 클립** 가운데 앞을 자른 것이 있을 때만 2 판이다(문서에 head 가 적혀 있어도 못 이은 클립·그림은 세지 않는다).
  const headOf = (clip: SlotClip, gen: Generation) => (gen.assets?.[0]?.type === "image" ? 0 : frame(clip.head));
  // 보내는 클립의 속도 — 그림은 1(문서의 kind 가 안 적힌 옛 클립도 생성물로 본다)
  const speedOf = (clip: SlotClip, gen: Generation) => (gen.assets?.[0]?.type === "image" ? 1 : clipSpeed(clip));
  const sent = (test: (clip: SlotClip, gen: Generation) => boolean) => layout.cuts.some((slot) => slot.clips.some((clip) => {
    const gen = links.get(clipKey(clip))?.gen ?? null;
    return !!gen && test(clip, gen);
  }));
  // 속도 클립이 하나라도 있으면 3 판(2 의 칸도 모두 싣는다), 앞을 자른 것만 있으면 2 판
  const sped = sent((clip, gen) => speedOf(clip, gen) !== 1);
  const headed = sped || sent((clip, gen) => headOf(clip, gen) > 0);

  for (const slot of layout.cuts) {
    const start = frame(slot.start);
    const stop = frame(slot.start + slot.len); // 컷의 끝(미포함) — 클립은 이 밖으로 나가지 않는다
    // 한 프레임도 안 되는 컷(켜진 클립이 반 프레임 미만 — 깨진 영상의 실측 길이 등). 클립은 최소 한 프레임이라 다음 컷의 같은 트랙과
    //  겹친다 → 보내지 않는다(zeroCuts. 컷 길이가 켜진 클립만 세게 되면서 생긴 길 — Codex 코드 리뷰 2026-10-13).
    if (stop <= start) zeroCuts += 1;
    for (const clip of slot.clips) {
      const gen = links.get(clipKey(clip))?.gen ?? null;
      if (!gen) {
        unresolved += 1;
        continue;
      }
      // 꺼진 클립은 컷보다 길 수 있다(컷 길이는 켜진 클립만 센다 — buildLayout) → 컷의 끝에서 자른다. 안 자르면 다음 컷의 같은
      //  트랙 클립과 겹쳐 받는 쪽이 계획을 거부한다. 줄인 길이(trim)는 clip.len 에 이미 들어 있다.
      const end = Math.max(start + 1, Math.min(stop, frame(slot.start + Math.min(clip.len, slot.len))));
      // 속도 클립이 쓰는 원본 = 보내는 프레임 수 × 속도 — 컷의 끝에서 잘린 꺼 둔 클립은 그 끝까지만이다
      const speed = speedOf(clip, gen);
      gens.set(gen.id, gen);
      clips.push({
        gen_id: gen.id,
        track: clip.track,
        start,
        end,
        enabled: !clip.off,
        kind: gen.assets?.[0]?.type === "image" ? "image" : "video",
        ...(headed ? { head: headOf(clip, gen) } : {}),
        ...(speed !== 1 ? { speed, src: ((end - start) / EDIT_FPS) * speed } : {}),
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
      if (to > from) {
        // 그 영상 안의 시각 = 시작점 + 컷 안 시각 × 속도(mediaAt — 속도가 있으면 소리도 그 빠르기로 원본을 지난다)
        const speed = clipSpeed(segment.clip!);
        audio.push({
          gen_id: gen.id, start: from, end: to, offset: mediaAt(segment.clip!, segment.from),
          ...(headed ? { track: segment.clip!.track } : {}),
          ...(speed !== 1 ? { speed } : {}),
        });
      }
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
  const total = frame(layout.total);
  const end = clips.reduce((latest, clip) => Math.max(latest, clip.end), 0);

  return {
    plan: {
      format: TIMELINE_EXPORT_FORMAT,
      version: sped ? TIMELINE_EXPORT_VERSION_SPEED : headed ? TIMELINE_EXPORT_VERSION_HEAD : TIMELINE_EXPORT_VERSION,
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
      total,
    },
    gens: [...gens.values()],
    unresolved,
    zeroCuts,
    perTrack,
    disabled,
    markersDropped,
    end,
    tailEmpty: Math.max(0, total - end),
  };
}
