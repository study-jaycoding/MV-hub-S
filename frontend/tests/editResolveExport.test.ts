// 편집 탭 → Resolve 타임라인 계획(순수) — 지금 화면의 배치가 프레임 단위 계획으로 그대로 옮겨지는가.
import { describe, expect, it } from "vitest";
import { buildLayout, clipKey, emptyEditDoc, type EditClip, type EditDoc } from "../src/lib/editTimeline";
import {
  buildTimelineExport,
  RESOLVE_MARKER_COLORS,
  timelineExportName,
  type ExportLink,
} from "../src/lib/editResolveExport";
import type { Generation } from "../src/types";

const SEQ = "e035";
const cut = (name: string) => `${SEQ}/${name}`;
const gen = (id: string, type: "video" | "image" = "video", more: Partial<Generation> = {}): Generation => ({
  id, job_id: `job-${id}`, status: "done", project_id: "p1", folder_path: cut("C0010"),
  assets: [{ type, file_path: `/media/${id}.${type === "video" ? "mp4" : "png"}`, thumbnail_path: null }],
  params: {}, ...more,
} as unknown as Generation);
const clip = (cutName: string, id: string, track: number, dur: number, more: Partial<EditClip> = {}): EditClip => ({
  cut: cut(cutName), gen: id, track, dur, ...more,
});
// 문서의 클립마다 같은 id 의 생성물을 이어 준다(빼고 싶은 id 는 missing 으로).
function linksOf(doc: EditDoc, kinds: Record<string, "video" | "image"> = {}, missing: string[] = []) {
  const map = new Map<string, ExportLink>();
  for (const item of doc.clips) {
    const lost = missing.includes(item.gen);
    map.set(clipKey(item), lost ? { state: "missing", gen: null } : { state: "ok", gen: gen(item.gen, kinds[item.gen] ?? "video") });
  }
  return map;
}
const build = (doc: EditDoc, cuts: string[], links = linksOf(doc)) =>
  buildTimelineExport({ layout: buildLayout(cuts.map(cut), doc), doc, links, name: "뻘뻘뻘_e035" });

describe("buildTimelineExport", () => {
  it("컷 순서대로 프레임 자리를 잡는다 — 절대 시각을 한 번씩 반올림하고, 빈 컷은 5초 자리로 남는다", () => {
    // 길이 4.1초 셋: 컷마다 반올림해 더하면 98+98+98 = 294, 절대 시각으로는 round(12.3*24) = 295
    const doc: EditDoc = { ...emptyEditDoc(), clips: [clip("C0010", "a", 1, 4.1), clip("C0020", "b", 1, 4.1), clip("C0040", "c", 1, 4.1)] };
    const out = build(doc, ["C0010", "C0020", "C0030", "C0040"]); // C0030 은 빈 컷
    expect(out.plan.clips.map((item) => [item.gen_id, item.track, item.start, item.end])).toEqual([
      ["a", 1, 0, 98], ["b", 1, 98, 197], ["c", 1, 317, 415], // 빈 컷 5초 = 197 → 317
    ]);
    expect(out.plan).toMatchObject({ format: "mvhub.edit-timeline", version: 1, name: "뻘뻘뻘_e035", fps: 24, video_tracks: 3, total: 415 });
    expect(out.gens.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect([out.unresolved, out.perTrack, out.disabled]).toEqual([0, [3, 0, 0], 0]);
    expect([out.end, out.tailEmpty]).toEqual([415, 0]); // 마지막 컷에 클립이 있다 — 끝이 전체 길이와 같다
  });

  // Resolve 의 타임라인은 마지막 클립에서 끝난다(실측) — 끝의 빈 컷은 남지 않는다. 확인 창이 그 길이를 약속하지 않게 따로 센다.
  it("끝의 빈 컷은 따로 센다 — 타임라인의 끝은 마지막 클립의 끝이다", () => {
    const doc: EditDoc = { ...emptyEditDoc(), clips: [clip("C0010", "a", 1, 5), clip("C0010", "b", 2, 3)] };
    const out = build(doc, ["C0010", "C0020", "C0030"]); // 뒤의 두 컷이 비었다(5초씩)
    expect([out.plan.total, out.end, out.tailEmpty]).toEqual([360, 120, 240]);
  });

  it("쌓은 클립 — 위 트랙도 컷의 처음에서 시작하고, 꺼진 클립·꺼진 트랙·잠금은 그대로 싣는다", () => {
    const doc: EditDoc = {
      ...emptyEditDoc(),
      clips: [clip("C0010", "low", 1, 6), clip("C0010", "top", 2, 4), clip("C0020", "off", 1, 5, { off: true }), clip("C0020", "v3", 3, 5)],
      tracksOff: [3, 9], tracksLocked: [2], tracks: 3,
    };
    const out = build(doc, ["C0010", "C0020"]);
    expect(out.plan.clips).toEqual([
      { gen_id: "low", track: 1, start: 0, end: 144, enabled: true, kind: "video" },
      { gen_id: "top", track: 2, start: 0, end: 96, enabled: true, kind: "video" },
      { gen_id: "off", track: 1, start: 144, end: 264, enabled: false, kind: "video" },
      { gen_id: "v3", track: 3, start: 144, end: 264, enabled: true, kind: "video" },
    ]);
    expect([out.plan.tracks_off, out.plan.tracks_locked, out.plan.video_tracks]).toEqual([[3], [2], 3]); // 없는 트랙 번호(9)는 뺀다
    expect([out.perTrack, out.disabled]).toEqual([[2, 1, 1], 1]);
  });

  // Jay 2026-10-13 — 컷 길이는 켜진 클립만 센다 · 클립 길이를 줄일 수 있다(뒤를 자른다).
  it("꺼진 긴 클립은 컷의 끝에서 자르고, 줄인 클립은 줄인 길이로 싣는다 — 다음 컷과 겹치지 않는다", () => {
    const doc: EditDoc = {
      ...emptyEditDoc(),
      clips: [
        clip("C0010", "long-off", 1, 8, { off: true }), clip("C0010", "top", 2, 3), // 컷 = 3초(꺼진 8초는 세지 않는다)
        // 위(V2)를 2초로, 아래(V1)를 4초로 줄였다 — 2초 뒤 아래가 드러나 4초에 컷이 끝난다
        clip("C0020", "under", 1, 5, { trim: 4 }), clip("C0020", "cut", 2, 5, { kind: "video", trim: 2 }),
        clip("C0030", "next", 1, 5),
      ],
    };
    const out = build(doc, ["C0010", "C0020", "C0030"]);
    expect(out.plan.clips.map((item) => [item.gen_id, item.track, item.start, item.end, item.enabled])).toEqual([
      ["long-off", 1, 0, 72, false], ["top", 2, 0, 72, true],
      ["under", 1, 72, 168, true], ["cut", 2, 72, 120, true],
      ["next", 1, 168, 288, true],
    ]);
    // 같은 트랙에서 겹치는 것이 없다(받는 쪽은 겹친 계획을 거부한다)
    for (const a of out.plan.clips) for (const b of out.plan.clips) {
      if (a !== b && a.track === b.track) expect(a.end <= b.start || b.end <= a.start).toBe(true);
    }
    // 소리 = 보이는 것: 줄인 위 클립의 2초, 이어서 아래 클립의 2초부터(소스의 그 시각)
    expect(out.plan.audio.map((item) => [item.gen_id, item.start, item.end, item.offset])).toEqual([
      ["top", 0, 72, 0], ["cut", 72, 120, 0], ["under", 120, 168, 2], ["next", 168, 288, 0],
    ]);
    expect(out.plan.total).toBe(288);
  });

  it("소리는 그 순간 보이는 영상 하나의 것 — 위 클립이 끝나면 아래 클립의 소리가 그 자리(소스의 그 시각)부터", () => {
    const doc: EditDoc = {
      ...emptyEditDoc(),
      clips: [
        clip("C0010", "low", 1, 6), clip("C0010", "top", 2, 4), // 0~4초 top, 4~6초 low(소스 4초부터)
        clip("C0020", "still", 1, 5), // 이미지 — 소리 없음
        clip("C0030", "muted-top", 2, 5, { off: true }), clip("C0030", "under", 1, 5), // 꺼진 위 클립 → 아래 것의 소리
        clip("C0040", "hidden", 3, 5), // 꺼진 트랙 — 보이는 것이 없다
      ],
      tracksOff: [3],
    };
    const out = build(doc, ["C0010", "C0020", "C0030", "C0040"], linksOf(doc, { still: "image" }));
    expect(out.plan.audio).toEqual([
      { gen_id: "top", start: 0, end: 96, offset: 0 },
      { gen_id: "low", start: 96, end: 144, offset: 4 },
      { gen_id: "under", start: 264, end: 384, offset: 0 },
    ]);
    expect(out.plan.clips.find((item) => item.gen_id === "still")).toMatchObject({ kind: "image", start: 144, end: 264 });
    expect(build({ ...doc, muted: true }, ["C0010"]).plan.muted).toBe(true); // 소리 끔은 계획에 싣는다(받는 쪽이 A1 을 끈다)
  });

  it("공유 목록에서 못 찾은 클립은 세어 알린다 — 계획에는 넣지 않는다(부르는 쪽이 보내기를 막는다)", () => {
    const doc: EditDoc = { ...emptyEditDoc(), clips: [clip("C0010", "a", 1, 5), clip("C0020", "lost", 1, 5), clip("C0030", "c", 1, 5)] };
    const out = build(doc, ["C0010", "C0020", "C0030"], linksOf(doc, {}, ["lost"]));
    expect(out.unresolved).toBe(1);
    expect(out.plan.clips.map((item) => [item.gen_id, item.start])).toEqual([["a", 0], ["c", 240]]); // 자리는 그대로
    expect(out.gens.map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("job 으로 이은 클립은 실제 id 로 싣는다 — 같은 생성물이 여러 컷에 있어도 보낼 것은 한 번", () => {
    const doc: EditDoc = { ...emptyEditDoc(), clips: [clip("C0010", "old-id", 1, 5), clip("C0020", "same", 1, 5), clip("C0030", "same", 2, 5)] };
    const links = new Map<string, ExportLink>([
      [clipKey(doc.clips[0]), { state: "ok", gen: gen("real-id") }],
      [clipKey(doc.clips[1]), { state: "ok", gen: gen("same") }],
      [clipKey(doc.clips[2]), { state: "ok", gen: gen("same") }],
    ]);
    const out = build(doc, ["C0010", "C0020", "C0030"], links);
    expect(out.plan.clips.map((item) => item.gen_id)).toEqual(["real-id", "same", "same"]);
    expect(out.gens.map((item) => item.id)).toEqual(["real-id", "same"]);
  });

  it("북마크는 프레임과 다빈치 색 이름으로, 인/아웃은 구간으로 — 같은 프레임의 두 번째 북마크는 뺀다", () => {
    const doc: EditDoc = {
      ...emptyEditDoc(),
      clips: [clip("C0010", "a", 1, 5), clip("C0020", "b", 1, 5)],
      markers: [
        { cut: cut("C0010"), local: 0.5, name: "첫 표시" }, // 기본색
        { cut: cut("C0020"), local: 1, color: "#e12401", name: "빨강" },
        { cut: cut("C0010"), local: 5, color: "#00ad2f" }, // 컷 경계 — 앞 컷의 끝
        { cut: cut("C0020"), local: 0, color: "#f5ebe1" }, // 같은 프레임(뒤 컷의 처음) → 뺀다
        { cut: cut("C0099"), local: 1 }, // 배치에 없는 컷 — 화면에도 없다
      ],
      markIn: { cut: cut("C0010"), local: 2 },
      markOut: { cut: cut("C0020"), local: 3 },
    };
    const out = build(doc, ["C0010", "C0020"]);
    expect(out.plan.markers).toEqual([
      { frame: 12, color: "Blue", name: "첫 표시" },
      { frame: 120, color: "Green", name: "" },
      { frame: 144, color: "Red", name: "빨강" },
    ]);
    expect(out.markersDropped).toBe(1);
    expect(out.plan.mark).toEqual({ in: 48, out: 192 });
    // 한쪽만 찍으면 처음(또는 끝)까지 — 편집 탭의 구간과 같다
    expect(build({ ...doc, markIn: undefined }, ["C0010", "C0020"]).plan.mark).toEqual({ in: 0, out: 192 });
    expect(build({ ...doc, markIn: undefined, markOut: undefined }, ["C0010", "C0020"]).plan.mark).toBeNull();
  });

  it("색 이름은 편집 탭의 16색과 같은 순서다", () => {
    expect(RESOLVE_MARKER_COLORS).toHaveLength(16);
    expect([RESOLVE_MARKER_COLORS[0], RESOLVE_MARKER_COLORS[4], RESOLVE_MARKER_COLORS[15]]).toEqual(["Blue", "Red", "Cream"]);
  });
});

describe("timelineExportName", () => {
  it("프로젝트_시퀀스 잎 이름 — 파일 이름에 못 쓰는 글자는 뺀다", () => {
    expect(timelineExportName("뻘뻘뻘", "e035")).toBe("뻘뻘뻘_e035");
    expect(timelineExportName("A/B:C", "ep/e020")).toBe("A B C_e020");
    expect(timelineExportName("", "")).toBe("MVHub");
  });
});
