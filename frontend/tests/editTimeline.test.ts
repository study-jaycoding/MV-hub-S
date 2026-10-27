import { describe, expect, it } from "vitest";
import {
  addMarker,
  addTrack,
  buildLayout,
  clearMarkers,
  clipFull,
  clipKey,
  clipLen,
  cutIsOff,
  cutOf,
  cutPaths,
  DEFAULT_SEC,
  deleteEmptyTracks,
  deleteTrack,
  editPoints,
  emptyEditDoc,
  fillEmptyCuts,
  genSeconds,
  groupByCut,
  insertClip,
  insertTrack,
  isUsableGen,
  linkClip,
  MARKER_COLORS,
  markerAt,
  markerKey,
  markRange,
  marksOf,
  markTime,
  moveClipToTrack,
  moveCut,
  foldersReordered,
  moveTrack,
  nearestPoint,
  orderCuts,
  parseEditDoc,
  patchMarker,
  placeClip,
  placeState,
  posAt,
  removeClips,
  removeMarker,
  resetCutOrder,
  setClipDurs,
  keepClipDurs,
  setClipRange,
  clipHead,
  clipFrames,
  setMark,
  settlePos,
  setTrackColor,
  shiftClips,
  shotsAt,
  shownMarkers,
  snapTrim,
  stepPoint,
  timecode,
  timeOf,
  toggleClipsOff,
  toggleCutOff,
  toggleTrack,
  trackClip,
  trackCount,
  validSeconds,
  visibleClip,
  visibleSegments,
  type EditClip,
  type EditDoc,
  type EditGen,
} from "../src/lib/editTimeline";

const SEQ = "e070";
const clip = (cut: string, gen: string, track: number, extra: Partial<EditClip> = {}): EditClip =>
  ({ cut: `${SEQ}/${cut}`, gen, track, ...extra });
const doc = (clips: EditClip[], extra: Partial<EditDoc> = {}): EditDoc =>
  ({ ...emptyEditDoc(), clips, ...extra });
const key = (cut: string, gen: string) => clipKey({ cut: `${SEQ}/${cut}`, gen });
const tracksOf = (d: EditDoc | null) => Object.fromEntries((d?.clips ?? []).map((c) => [c.gen, c.track]));
const gen = (id: string, folder: string, extra: Partial<EditGen> = {}): EditGen => ({
  id, job_id: `job-${id}`, status: "done", params: { duration: "8" }, folder_path: folder,
  assets: [{ id: `a-${id}`, generation_id: id, type: "video", file_path: `/media/${id}.mp4`,
    thumbnail_path: null, source_url: null, cached: true }],
  ...extra,
});

describe("길이·컷 순서", () => {
  it("유한한 양수만 길이로 인정한다", () => {
    expect(validSeconds(8)).toBe(8);
    expect(validSeconds("4")).toBe(4);
    for (const bad of [0, -1, NaN, Infinity, "", "abc", null, undefined, {}]) expect(validSeconds(bad)).toBeNull();
  });

  it("폴더 경로를 컷(시퀀스의 직계 하위)으로 묶는다", () => {
    expect(cutOf(SEQ, "e070/c0010")).toBe("e070/c0010");
    expect(cutOf(SEQ, "e070\\c0010\\sub")).toBe("e070/c0010");
    expect(cutOf(SEQ, "e070")).toBeNull(); // 시퀀스 바로 아래는 컷이 아니다
    expect(cutOf(SEQ, "e0700/c0010")).toBeNull(); // 접두사만 같은 다른 폴더
    expect(cutOf("", "e070/c0010")).toBeNull();
  });

  it("컷은 이름 자연 정렬 — 디스크에 없던 폴더가 끼어들어도 제자리에 선다", () => {
    const paths = ["e070/c1", "e070/c10", "e070/c3", "e070/C2/deep", "e035/c1", "e070"];
    expect(cutPaths(SEQ, paths, emptyEditDoc())).toEqual(["e070/c1", "e070/C2", "e070/c3", "e070/c10"]);
  });

  it("마지막 공유물이 사라진 컷도 문서에 클립이 있으면 자리가 남는다", () => {
    const d = doc([clip("c0020", "g1", 1)]);
    expect(cutPaths(SEQ, ["e070/c0010", "e070/c0030"], d)).toEqual(["e070/c0010", "e070/c0020", "e070/c0030"]);
  });
});

// Jay 2026-10-13 — 타임라인의 폴더 순서를 내가 바꾼다.
describe("내가 정한 컷 순서", () => {
  const p = (...names: string[]) => names.map((name) => `${SEQ}/${name}`);
  const natural = p("c1", "c2", "c3", "c4");

  it("정한 순서대로 서고, 나중에 생긴 폴더는 이름순으로 바로 앞인 컷의 뒤에 선다", () => {
    expect(orderCuts(natural)).toEqual(natural);
    expect(orderCuts(natural, [])).toEqual(natural);
    const saved = p("c3", "c1", "c4");
    expect(orderCuts(natural, saved)).toEqual(p("c3", "c1", "c2", "c4")); // c2 는 c1 의 뒤
    expect(orderCuts(p("c0", "c1", "c3", "c4"), saved)).toEqual(p("c0", "c3", "c1", "c4")); // 앞선 컷이 없으면 맨 앞
    // 같은 자리에 여럿이 끼어도 그들끼리는 이름순 — 같은 입력이면 언제나 같은 순서
    expect(orderCuts(p("c1", "c1a", "c1b", "c3", "c4"), saved)).toEqual(p("c3", "c1", "c1a", "c1b", "c4"));
    // 목록에만 있고 지금 없는 컷은 건너뛴다
    expect(orderCuts(p("c1", "c4"), saved)).toEqual(p("c1", "c4"));
    expect(cutPaths(SEQ, natural, doc([], { cutOrder: saved }))).toEqual(p("c3", "c1", "c2", "c4"));
  });

  it("컷 하나를 다른 컷 앞(또는 맨 뒤)으로 옮긴다 — 이름순과 같아지면 적어 둔 순서를 지운다", () => {
    const moved = moveCut(emptyEditDoc(), natural, natural[2], natural[0])!;
    expect(moved.cutOrder).toEqual(p("c3", "c1", "c2", "c4"));
    expect(moveCut(moved, moved.cutOrder!, natural[0], null)!.cutOrder).toEqual(p("c3", "c2", "c4", "c1"));
    const back = moveCut(moved, moved.cutOrder!, natural[2], null)!; // c3 을 맨 뒤로 — c1 c2 c4 c3
    expect(back.cutOrder).toEqual(p("c1", "c2", "c4", "c3"));
    expect("cutOrder" in moveCut(back, back.cutOrder!, natural[2], natural[3])!).toBe(false); // 이름순으로 돌아왔다
    // 바뀐 것이 없으면 null: 제자리(바로 뒤 컷의 앞·자기 앞) · 맨 뒤 컷을 맨 뒤로 · 없는 컷
    expect(moveCut(emptyEditDoc(), natural, natural[1], natural[2])).toBeNull();
    expect(moveCut(emptyEditDoc(), natural, natural[1], natural[1])).toBeNull();
    expect(moveCut(emptyEditDoc(), natural, natural[3], null)).toBeNull();
    expect(moveCut(emptyEditDoc(), natural, `${SEQ}/c9`, null)).toBeNull();
    expect(moveCut(emptyEditDoc(), natural, natural[0], `${SEQ}/c9`)).toBeNull();
    expect(parseEditDoc(JSON.parse(JSON.stringify(moved)))).toEqual(moved);
    expect(parseEditDoc({ ...emptyEditDoc(), cutOrder: ["e070\\c1"] })).toBeNull();
    expect(parseEditDoc({ ...emptyEditDoc(), cutOrder: "e070/c1" })).toBeNull();
  });

  it("지금 없는 폴더의 자리는 순서를 바꿔도 남는다 — 그 폴더가 돌아오면 제자리에 선다", () => {
    const d = doc([], { cutOrder: p("c3", "c9", "c1", "c2") }); // c9 는 지금 없다
    const now = cutPaths(SEQ, p("c1", "c2", "c3"), d);
    expect(now).toEqual(p("c3", "c1", "c2"));
    const moved = moveCut(d, now, `${SEQ}/c2`, `${SEQ}/c1`)!;
    expect(moved.cutOrder).toEqual(p("c3", "c9", "c2", "c1"));
    expect(cutPaths(SEQ, p("c1", "c2", "c3", "c9"), moved)).toEqual(p("c3", "c9", "c2", "c1"));
    // 순서를 정한 뒤 생긴 폴더(c2b — 목록에 없다)도 옮기는 순간 화면에서 서 있던 자리로 적힌다
    const withNew = cutPaths(SEQ, p("c1", "c2", "c2b", "c3"), moved); // c3 c2 c2b c1
    expect(withNew).toEqual(p("c3", "c2", "c2b", "c1"));
    expect(moveCut(moved, withNew, `${SEQ}/c1`, `${SEQ}/c3`)!.cutOrder).toEqual(p("c1", "c3", "c9", "c2", "c2b"));
  });

  // Codex 코드 리뷰 2026-10-13: 지금 순서에서 제자리인 놓기가, 그 사이의 '지금 없는 폴더'를 넘어간 것으로 적혀 그 폴더의 돌아올
  //  자리를 바꿨다.
  it("지금 순서에서 제자리면 바뀐 것이 없다 — 그 사이에 지금 없는 폴더의 자리가 있어도", () => {
    const d = doc([], { cutOrder: p("c3", "c9", "c1") }); // c9 는 지금 없다 — 화면은 c3 c1
    const now = cutPaths(SEQ, p("c1", "c3"), d);
    expect(now).toEqual(p("c3", "c1"));
    expect(moveCut(d, now, `${SEQ}/c3`, `${SEQ}/c1`)).toBeNull(); // c3 을 바로 뒤 컷 앞에 = 제자리
    expect(moveCut(doc([], { cutOrder: p("c3", "c1", "c9") }), now, `${SEQ}/c1`, null)).toBeNull(); // 맨 뒤 컷을 맨 뒤로(뒤에 없는 폴더의 자리)
    // 진짜 옮기기는 된다 — c1 을 앞으로: c1 c3 (c9). 이름순이 되어 적어 둔 순서가 지워진다
    expect("cutOrder" in moveCut(d, now, `${SEQ}/c1`, `${SEQ}/c3`)!).toBe(false);
    const more = doc([], { cutOrder: p("c3", "c9", "c1", "c2") }); // 화면은 c3 c1 c2
    expect(moveCut(more, p("c3", "c1", "c2"), `${SEQ}/c2`, `${SEQ}/c3`)!.cutOrder).toEqual(p("c2", "c3", "c9", "c1"));
  });

  // 컷 순서가 바뀌거나 사라졌던 폴더가 돌아오면 문서의 인/아웃이 뒤집혀 있을 수 있다. 순서를 바꾸는 순간에 미리 맞바꾸지 않는다
  //  (없는 폴더 가운데 일부만 돌아오면 그때의 예측과 달라진다 — Codex 코드 리뷰 2회째). 그릴 때·찍을 때 같은 눈으로 바로잡는다.
  it("순서를 바꿔 인이 아웃보다 뒤의 컷에 놓이면 — 문서는 그대로 두고, 그리는 구간과 찍기·지우기가 보이는 앞뒤를 따른다", () => {
    const marked = doc([], { markIn: { cut: natural[0], local: 1 }, markOut: { cut: natural[2], local: 2 } });
    const moved = moveCut(marked, natural, natural[2], natural[0])!; // c3 c1 c2 c4 — 인(c1)이 아웃(c3)의 뒤
    expect(moved).toMatchObject({ markIn: marked.markIn, markOut: marked.markOut }); // 문서의 표시는 건드리지 않는다
    const layout = buildLayout(cutPaths(SEQ, natural, moved), moved); // c3 0~5 · c1 5~10 · c2 · c4
    expect(marksOf(layout, moved)).toEqual({ in: 2, out: 6, band: { from: 2, to: 6 } }); // 앞의 것이 인, 뒤의 것이 아웃
    // 인 지우기(Alt+I)는 화면의 인(문서의 markOut — c3 의 2초)을 지운다. 문서는 그때 바로잡힌 모양으로 남는다.
    const cleared = setMark(moved, layout, "markIn", null)!;
    expect([cleared.markIn, cleared.markOut]).toEqual([undefined, { cut: natural[0], local: 1 }]);
    expect(marksOf(layout, cleared)).toEqual({ in: null, out: 6, band: { from: 0, to: 6 } });
    // 아웃을 인 앞에 찍으면 화면의 인이 지워진다(다빈치) — 뒤집힌 문서에서도
    const outFirst = setMark(moved, layout, "markOut", { cut: natural[2], local: 1 })!;
    expect([outFirst.markIn, outFirst.markOut]).toEqual([undefined, { cut: natural[2], local: 1 }]);
    // 이름순으로 되돌리면 원래 앞뒤다
    const reset = resetCutOrder(moved)!;
    expect("cutOrder" in reset).toBe(false);
    expect(marksOf(buildLayout(natural, reset), reset)).toMatchObject({ in: 1, out: 12 });
    expect(resetCutOrder(reset)).toBeNull(); // 정한 순서가 없다
    // 같은 컷 안의 인·아웃은 순서와 무관하다
    const same = doc([], { markIn: { cut: natural[2], local: 1 }, markOut: { cut: natural[2], local: 2 } });
    const sameMoved = moveCut(same, natural, natural[2], natural[0])!;
    expect(marksOf(buildLayout(cutPaths(SEQ, natural, sameMoved), sameMoved), sameMoved)).toMatchObject({ in: 1, out: 2 });
  });

  // Codex 코드 리뷰 2회째의 입력: 정한 순서 c4 (c2) c1 c5, 인 = 없는 c3, 아웃 = c1. c5 를 맨 앞으로 옮긴 뒤 c3 만 돌아온다(c2 는 그대로 없다).
  //  c3 는 '이름순으로 바로 앞인 컷의 뒤'에 서는데, 그 앞 컷(c2)이 없어 c1 의 뒤다 → 인(c3)이 아웃(c1)의 뒤. 그래도 구간은 살아 있다.
  it("없는 폴더 가운데 일부만 돌아와 인/아웃이 뒤집혀도 구간이 사라지지 않는다", () => {
    const d = doc([], { cutOrder: p("c4", "c2", "c1", "c5"), markIn: { cut: `${SEQ}/c3`, local: 0 }, markOut: { cut: `${SEQ}/c1`, local: 1 } });
    const moved = moveCut(d, cutPaths(SEQ, p("c1", "c4", "c5"), d), `${SEQ}/c5`, `${SEQ}/c4`)!;
    const back = cutPaths(SEQ, p("c1", "c3", "c4", "c5"), moved);
    expect(back).toEqual(p("c5", "c4", "c1", "c3"));
    const layout = buildLayout(back, moved); // c5 0~5 · c4 5~10 · c1 10~15 · c3 15~20
    expect(marksOf(layout, moved)).toEqual({ in: 11, out: 15, band: { from: 11, to: 15 } });
    // 한쪽이 아직 안 보이는 동안(c3 가 돌아오기 전)은 구간이 아니다 — 넓히지 않는다
    expect(marksOf(buildLayout(p("c5", "c4", "c1"), moved), moved)).toEqual({ in: null, out: 11, band: null });
  });
});
describe("배치와 보이는 클립", () => {
  const d = doc([clip("c1", "low", 1, { dur: 8 }), clip("c1", "top", 2, { dur: 3 }), clip("c3", "solo", 1)]);
  const layout = buildLayout(["e070/c1", "e070/c2", "e070/c3"], d, (c) => (c.gen === "solo" ? "6" : undefined));

  it("컷 길이 = 그 컷의 가장 긴 클립, 빈 컷과 길이 모르는 클립은 기본 길이", () => {
    expect(layout.cuts.map((cut) => [cut.name, cut.start, cut.len])).toEqual([["c1", 0, 8], ["c2", 8, DEFAULT_SEC], ["c3", 13, 6]]);
    expect(layout.total).toBe(19);
    expect(layout.tracks).toBe(3);
    expect(buildLayout(["e070/c9"], doc([clip("c9", "x", 1, { dur: -2 })])).cuts[0].len).toBe(DEFAULT_SEC);
  });

  it("위 트랙이 우선 보이고, 짧은 위 클립이 끝나면 아래 클립이 같은 시각에서 드러난다", () => {
    const slot = layout.cuts[0];
    expect(visibleClip(d, slot, 0)?.gen).toBe("top");
    expect(visibleClip(d, slot, 2.99)?.gen).toBe("top");
    expect(visibleClip(d, slot, 3)?.gen).toBe("low");
    expect(visibleSegments(d, slot).map((s) => [s.from, s.to, s.clip?.gen])).toEqual([[0, 3, "top"], [3, 8, "low"]]);
    expect(visibleClip(d, layout.cuts[1], 1)).toBeNull(); // 고르지 않은 컷은 비어 있다
  });

  // Jay 2026-10-13 — "v1 이 5초 v2 가 3초면 3초 보여주다가 남은 v1 이 더 보인다. v1 트랙이 꺼져 있다면 그 폴더는 3초만 재생된다."
  it("컷 길이는 켜진 클립만 센다 — 끈 클립·끈 트랙은 안 보이고 길이에도 안 든다. 잠금은 보이기와 무관하다", () => {
    const off = toggleClipsOff(d, [key("c1", "top")])!;
    const slot = buildLayout(["e070/c1"], off).cuts[0];
    expect(visibleClip(off, slot, 0)?.gen).toBe("low");
    expect(slot.len).toBe(8);
    const trackOff = toggleTrack(d, "tracksOff", 1); // 긴 아래 트랙을 껐다 — 위 클립의 3초만 남는다
    const short = buildLayout(["e070/c1"], trackOff).cuts[0];
    expect(short.len).toBe(3);
    expect(visibleSegments(trackOff, short).map((s) => [s.from, s.to, s.clip?.gen])).toEqual([[0, 3, "top"]]);
    expect(short.clips.map((c) => [c.gen, c.len])).toEqual([["low", 8], ["top", 3]]); // 꺼진 클립은 컷보다 길 수 있다
    expect(buildLayout(["e070/c1"], toggleClipsOff(d, [key("c1", "low")])!).cuts[0].len).toBe(3);
    // 넣은 것을 전부 껐으면 빈 컷과 같다(기본 길이)
    const allOff = toggleClipsOff(d, [key("c1", "low"), key("c1", "top")])!;
    expect(buildLayout(["e070/c1"], allOff).cuts[0].len).toBe(DEFAULT_SEC);
    const locked = toggleTrack(d, "tracksLocked", 2);
    expect(visibleClip(locked, layout.cuts[0], 0)?.gen).toBe("top");
  });

  // 뒤만 자르는 걸음(시작점은 그대로 둔다) — 10-13 의 시험들이 쓰던 모양
  const setClipTrim = (d: EditDoc, k: string, seconds: number | null) =>
    setClipRange(d, k, { head: d.clips.find((item) => clipKey(item) === k)?.head ?? 0, trim: seconds });

  // Jay 2026-10-13 — 타임라인 클립 휠 클릭 = 길이 조절(뒤를 자른다). 영상만이고 원본보다 길게는 안 된다.
  it("줄인 길이(trim) — 쓰는 길이는 줄인 값, 원본은 full 에 남는다. 그림은 줄이지 않는다", () => {
    const v = clip("c1", "v", 1, { dur: 5, kind: "video", trim: 3 });
    expect([clipLen(v), clipFull(v)]).toEqual([3, 5]);
    expect(clipLen({ ...v, trim: 9 })).toBe(5); // 원본보다 길게는 안 된다 — 값은 문서에 남고 쓰는 길이만 자른다
    expect(clipLen(clip("c1", "old", 1, { dur: 5, trim: 2 }))).toBe(2); // kind 가 없는 옛 클립은 영상이다
    expect(clipLen(clip("c1", "i", 1, { dur: 5, kind: "image", trim: 2 }))).toBe(5);
    expect(clipLen(clip("c1", "n", 1, { trim: 2 }), "8")).toBe(2); // 길이를 모르면 호출부가 아는 값이 원본
    expect(clipFull(clip("c1", "n", 1), "8")).toBe(8);
    // 위를 3초로 줄이면 3초 뒤에 아래가 드러나고, 아래까지 줄이면 컷이 짧아진다
    const two = doc([clip("c1", "low", 1, { dur: 5, trim: 4 }), clip("c1", "top", 2, { dur: 5, trim: 3 })]);
    const slot = buildLayout(["e070/c1"], two).cuts[0];
    expect(slot.len).toBe(4);
    expect(slot.clips.map((c) => [c.gen, c.len, c.full])).toEqual([["low", 4, 5], ["top", 3, 5]]);
    expect(visibleSegments(two, slot).map((s) => [s.from, s.to, s.clip?.gen])).toEqual([[0, 3, "top"], [3, 4, "low"]]);
  });

  it("길이 줄이기 — 잠긴 트랙·그림·없는 클립은 거부, 같은 값이면 null, null 을 주면 원본 길이로", () => {
    const d2 = doc([clip("c1", "v", 1, { dur: 5, kind: "video" }), clip("c1", "i", 2, { kind: "image" }),
      clip("c2", "k", 3, { dur: 5 })], { tracksLocked: [3] });
    const cut = setClipTrim(d2, key("c1", "v"), 3)!;
    expect(cut.clips[0]).toEqual(clip("c1", "v", 1, { dur: 5, kind: "video", trim: 3 }));
    expect(cut.clips[1]).toBe(d2.clips[1]); // 다른 클립은 그대로
    expect(setClipTrim(cut, key("c1", "v"), 3)).toBeNull();
    expect("trim" in setClipTrim(cut, key("c1", "v"), null)!.clips[0]).toBe(false);
    expect(setClipTrim(d2, key("c1", "v"), null)).toBeNull(); // 줄인 적이 없다
    expect(setClipTrim(d2, key("c1", "v"), 9)!.clips[0].trim).toBe(9); // 원본보다 긴 값도 적는다(쓰는 길이는 clipLen 이 자른다)
    for (const bad of [0, -1, NaN, Infinity]) expect(setClipTrim(d2, key("c1", "v"), bad)).toBeNull();
    expect(setClipTrim(d2, key("c1", "i"), 2)).toBeNull();
    expect(setClipTrim(d2, key("c2", "k"), 2)).toBeNull();
    expect(setClipTrim(d2, "없는 키", 2)).toBeNull();
    expect(parseEditDoc(JSON.parse(JSON.stringify(cut)))).toEqual(cut);
  });

  it("길이 값은 프레임에 맞춘다 — 최소 1프레임, 원본을 넘지 않는 가장 긴 프레임까지", () => {
    expect(snapTrim(3.01, 5)).toBe(72 / 24);
    expect(snapTrim(0, 5)).toBe(1 / 24);
    expect(snapTrim(99, 5)).toBe(5);
    expect(snapTrim(99, 3.02)).toBe(72 / 24); // 원본 3.02초 — 73프레임(3.0417초)으로 올리지 않는다
    expect(snapTrim(1, 0.03)).toBeNull(); // 한 프레임도 안 되는 영상
    expect(snapTrim(NaN, 5)).toBeNull();
    expect(snapTrim(2, NaN)).toBeNull(); // 길이를 아직 모르는 영상(상한이 숫자가 아니다)
  });

  // 실측이 오면 dur 은 고쳐 적히고(되돌리기 대상 아님) trim 은 그대로다 — 쓰는 길이만 그때의 원본에서 다시 잘린다.
  it("줄인 길이는 원본 길이가 바뀌어도 적어 둔 값이 남는다 — 5초 → 3초 → 6초면 쓰는 길이는 4 → 3 → 4", () => {
    const k = key("c1", "v");
    let d2 = setClipTrim(doc([clip("c1", "v", 1, { dur: 5, kind: "video" })]), k, 4)!;
    const len = () => buildLayout(["e070/c1"], d2).cuts[0].clips[0].len;
    expect(len()).toBe(4);
    d2 = setClipDurs(d2, new Map([[k, 3]]))!;
    expect([len(), d2.clips[0].trim]).toEqual([3, 4]);
    d2 = setClipDurs(d2, new Map([[k, 6]]))!;
    expect([len(), d2.clips[0].trim]).toEqual([4, 4]);
    // 옮겨도(트랙) 줄인 길이는 따라간다. 다른 카드로 교체하면 새 클립이라 없다.
    expect(moveClipToTrack(d2, k, 2)!.clips[0]).toMatchObject({ track: 2, trim: 4 });
    expect("trim" in placeClip(d2, { cut: "e070/c1", gen: "new", kind: "video", dur: 5 }, 1)!.clips[0]).toBe(false);
  });

  // Jay 2026-10-14 — 길이 조절에서 앞도 자른다(head). trim 은 그대로 '쓰는 길이'(시작점부터)다.
  it("앞 자르기(head) — 쓰는 길이는 시작점부터 남은 만큼, 유효 시작은 프레임에 맞춰 원본 안으로 자른다", () => {
    const v = clip("c1", "v", 1, { dur: 5, kind: "video", head: 1 });
    expect([clipHead(v), clipLen(v), clipFull(v)]).toEqual([1, 4, 5]);
    expect(clipLen({ ...v, trim: 2 })).toBe(2); // 1초부터 2초
    expect(clipLen({ ...v, trim: 9 })).toBe(4); // 남은 만큼까지만
    const still = clip("c1", "i", 1, { dur: 5, kind: "image", head: 2 });
    expect([clipHead(still), clipLen(still)]).toEqual([0, 5]); // 그림은 자르지 않는다
    // 원본보다 긴 값(실측이 짧아졌다) — 적힌 값은 남고, 쓰는 값은 마지막 프레임의 시작이다(프레임 경계 — 71.48프레임 같은 값이 아니다)
    const long = clip("c1", "v", 1, { dur: 3.02, kind: "video", head: 4 });
    expect(clipFrames(3.02)).toBe(72);
    expect(clipHead(long)).toBe(71 / 24);
    expect(clipLen(long)).toBe(1 / 24); // 남은 1.48프레임 → 1프레임(영상의 쓰는 길이는 프레임으로 내린다, 2026-10-14)
    expect(clipHead(clip("c1", "v", 1, { dur: 5, kind: "video", head: 1.01 }))).toBe(1); // 프레임에 맞춘다
    // 한 프레임도 안 되는 영상은 자를 수 없다
    const tiny = clip("c1", "v", 1, { dur: 0.02, kind: "video", head: 1 });
    expect([clipHead(tiny), clipLen(tiny)]).toEqual([0, 0.02]);
    // 배치에 유효 시작이 실린다(없으면 0). 컷 길이는 켜진 클립의 쓰는 길이 중 가장 긴 것 그대로다
    const slot = buildLayout(["e070/c1"], doc([clip("c1", "low", 1, { dur: 5 }), clip("c1", "top", 2, { dur: 5, head: 2, trim: 1 })])).cuts[0];
    expect(slot.clips.map((c) => [c.gen, c.head, c.len, c.full])).toEqual([["low", 0, 5, 5], ["top", 2, 1, 5]]);
    expect(slot.len).toBe(5);
    // 원본 길이가 바뀌면(실측) 쓰는 값만 다시 잘린다 — 5초 → 1.5초 → 5초면 시작은 2 → 35프레임 → 2
    const k = key("c1", "v");
    let d2 = doc([clip("c1", "v", 1, { dur: 5, kind: "video", head: 2 })]);
    const head = () => buildLayout(["e070/c1"], d2).cuts[0].clips[0].head;
    d2 = setClipDurs(d2, new Map([[k, 1.5]]))!;
    expect([head(), d2.clips[0].head]).toEqual([35 / 24, 2]);
    d2 = setClipDurs(d2, new Map([[k, 5]]))!;
    expect(head()).toBe(2);
  });

  it("구간 정하기(setClipRange) — 앞·뒤를 한 번에 적고, 0·null 은 그 칸을 지운다. 거부는 길이 줄이기와 같다", () => {
    const k = key("c1", "v");
    const d2 = doc([clip("c1", "v", 1, { dur: 5, kind: "video" }), clip("c1", "i", 2, { kind: "image" }),
      clip("c2", "k", 3, { dur: 5 })], { tracksLocked: [3] });
    const both = setClipRange(d2, k, { head: 1, trim: 2 })!;
    expect(both.clips[0]).toEqual(clip("c1", "v", 1, { dur: 5, kind: "video", trim: 2, head: 1 }));
    expect(both.clips[1]).toBe(d2.clips[1]); // 다른 클립은 그대로
    expect(setClipRange(both, k, { head: 1, trim: 2 })).toBeNull(); // 바뀐 것이 없다
    expect(setClipRange(both, k, { head: 0, trim: 2 })!.clips[0]).toEqual(clip("c1", "v", 1, { dur: 5, kind: "video", trim: 2 })); // 앞만 되돌린다
    expect(setClipRange(both, k, { head: 1, trim: null })!.clips[0]).toEqual(clip("c1", "v", 1, { dur: 5, kind: "video", head: 1 })); // 끝은 원본 끝까지
    expect(setClipRange(both, k, { head: 0, trim: null })!.clips[0]).toEqual(clip("c1", "v", 1, { dur: 5, kind: "video" })); // 원본 길이로
    for (const bad of [-1, NaN, Infinity]) expect(setClipRange(d2, k, { head: bad, trim: null })).toBeNull();
    expect(setClipRange(d2, key("c1", "i"), { head: 1, trim: null })).toBeNull(); // 그림
    expect(setClipRange(d2, key("c2", "k"), { head: 1, trim: null })).toBeNull(); // 잠긴 트랙
    expect(parseEditDoc(JSON.parse(JSON.stringify(both)))).toEqual(both);
    // 옮겨도(트랙) 따라가고, 다른 카드로 교체하면 새 클립이라 없다
    const solo = setClipRange(doc([clip("c1", "v", 1, { dur: 5, kind: "video" })]), k, { head: 1, trim: 2 })!;
    expect(moveClipToTrack(solo, k, 2)!.clips[0]).toMatchObject({ track: 2, trim: 2, head: 1 });
    expect("head" in placeClip(solo, { cut: "e070/c1", gen: "new", kind: "video", dur: 5 }, 1)!.clips[0]).toBe(false);
  });

  it("편집점은 컷 경계와 컷 안에서 끝나는 클립의 끝이다", () => {
    const points = editPoints(layout);
    expect(points).toEqual([0, 3, 8, 13, 19]);
    expect(stepPoint(points, 0, 1)).toBe(3);
    expect(stepPoint(points, 3, 1)).toBe(8);
    expect(stepPoint(points, 8, -1)).toBe(3);
    expect(stepPoint(points, 19, 1)).toBe(19);
    expect(stepPoint(points, 0, -1)).toBe(0);
  });

  it("타임코드는 24프레임 기준", () => {
    expect(timecode(0)).toBe("00:00:00:00");
    expect(timecode(20.3)).toBe("00:00:20:07");
    expect(timecode(3661 + 23 / 24)).toBe("01:01:01:23");
    expect(timecode(NaN)).toBe("00:00:00:00");
  });
});

describe("위치는 컷 경로로 든다", () => {
  const d = doc([clip("c1", "a", 1, { dur: 4 }), clip("c3", "b", 1, { dur: 6 })]);
  const before = buildLayout(["e070/c1", "e070/c3"], d);

  it("시각↔위치 변환, 전체 끝은 마지막 컷의 끝", () => {
    expect(posAt(before, 5)).toEqual({ cut: "e070/c3", local: 1 });
    expect(posAt(before, 4)).toEqual({ cut: "e070/c3", local: 0 }); // 컷 구간은 [start, end)
    expect(posAt(before, 99)).toEqual({ cut: "e070/c3", local: 6 });
    expect(timeOf(before, { cut: "e070/c3", local: 2 })).toBe(6);
    expect(posAt(buildLayout([], d), 3)).toBeNull();
  });

  it("앞에 컷이 끼어들어도 보던 컷을 계속 가리킨다", () => {
    const pos = { cut: "e070/c3", local: 2 };
    const after = buildLayout(["e070/c1", "e070/c2", "e070/c3"], d);
    expect(settlePos(after, pos)).toEqual({ pos, moved: false });
    expect(timeOf(after, pos)).toBe(4 + DEFAULT_SEC + 2);
  });

  it("보던 컷이 사라지면 이름 순서로 그다음 컷 처음(없으면 끝)으로 옮기고 멈춘다", () => {
    expect(settlePos(before, { cut: "e070/c2", local: 1 })).toEqual({ pos: { cut: "e070/c3", local: 0 }, moved: true });
    expect(settlePos(before, { cut: "e070/c9", local: 1 })).toEqual({ pos: { cut: "e070/c3", local: 6 }, moved: true });
  });

  it("보던 컷이 빠지면 '내가 정한 순서'에서 그다음 컷으로 간다 — 숨긴 컷도, 사라진 폴더도", () => {
    const shown = buildLayout(["e070/c3", "e070/c1"], d); // 정한 순서 c3 · (c2 숨김) · c1
    const order = ["e070/c3", "e070/c2", "e070/c1"];
    expect(settlePos(shown, { cut: "e070/c2", local: 1 }, order, order)).toEqual({ pos: { cut: "e070/c1", local: 0 }, moved: true });
    // 폴더가 사라져 순서에도 없는 컷 — 정한 순서에 적혀 있으면 그 자리에서 본다
    const saved = ["e070/c3", "e070/c9", "e070/c1"];
    expect(settlePos(shown, { cut: "e070/c9", local: 1 }, ["e070/c3", "e070/c1"], saved))
      .toEqual({ pos: { cut: "e070/c1", local: 0 }, moved: true });
    // 적혀 있지 않으면 새 컷이 서는 규칙(이름순으로 바로 앞인 컷의 뒤 — c0 은 맨 앞이라 그다음은 c3)
    expect(settlePos(shown, { cut: "e070/c0", local: 1 }, ["e070/c3", "e070/c1"], saved))
      .toEqual({ pos: { cut: "e070/c3", local: 0 }, moved: true });
    // 순서의 맨 뒤였으면 전체 끝
    expect(settlePos(shown, { cut: "e070/c2", local: 1 }, ["e070/c3", "e070/c1", "e070/c2"]))
      .toEqual({ pos: { cut: "e070/c1", local: 4 }, moved: true });
  });

  it("보던 컷이 짧아지면 컷 끝 직전으로 제한하고 멈춘다", () => {
    const settled = settlePos(before, { cut: "e070/c1", local: 7 });
    expect(settled.moved).toBe(true);
    expect(settled.pos?.cut).toBe("e070/c1");
    expect(settled.pos!.local).toBeLessThan(4);
    expect(settled.pos!.local).toBeGreaterThan(3.9);
  });
});

describe("문서 편집", () => {
  it("넣기 — 그 컷의 맨 위보다 위, 꺼졌거나 잠긴 트랙은 건너뛴다", () => {
    let d = doc([clip("c1", "a", 1), clip("c2", "b", 3)], { tracksOff: [2], tracksLocked: [3] });
    expect(insertTrack(d, "e070/c1")).toBe(4); // 2 는 꺼짐, 3 은 잠김
    expect(insertTrack(d, "e070/c9")).toBe(1);
    d = insertClip(d, { cut: "e070/c1", gen: "new", job: "j", kind: "video", dur: 8 })!;
    expect(d.clips[2]).toEqual({ cut: "e070/c1", gen: "new", track: 4, kind: "video", dur: 8, job: "j" });
    expect(insertClip(d, { cut: "e070/c1", gen: "new", kind: "video", dur: 8 })).toBeNull(); // 같은 컷에 한 번만
  });

  it("넣는 순간 길이가 반드시 적힌다(잘못된 값이면 기본 길이)", () => {
    const d = insertClip(emptyEditDoc(), { cut: "e070/c1", gen: "g", kind: "image", dur: NaN })!;
    expect(d.clips[0].dur).toBe(DEFAULT_SEC);
  });

  it("잠긴 트랙의 클립은 빼기·끄기·옮기기 모두 거부한다", () => {
    const d = doc([clip("c1", "a", 1), clip("c1", "b", 2)], { tracksLocked: [2] });
    expect(removeClips(d, [key("c1", "b")])).toBeNull();
    expect(toggleClipsOff(d, [key("c1", "b")])).toBeNull();
    expect(shiftClips(d, [key("c1", "b")], 1)).toBeNull();
    expect(shiftClips(d, [key("c1", "a")], 1)).toBeNull(); // 도착 트랙이 잠김
    expect(moveClipToTrack(d, key("c1", "a"), 2)).toBeNull();
    expect(removeClips(d, [key("c1", "a")])?.clips.map((c) => c.gen)).toEqual(["b"]);
  });

  it("위/아래로 옮기기 — 찬 자리는 맞바꾸고, 여러 개는 전부 될 때만 한 번에", () => {
    const d = doc([clip("c1", "a", 1), clip("c1", "b", 2), clip("c1", "x", 3), clip("c2", "y", 1)]);
    expect(tracksOf(shiftClips(d, [key("c1", "a")], 1))).toEqual({ a: 2, b: 1, x: 3, y: 1 });
    expect(tracksOf(shiftClips(d, [key("c1", "a"), key("c1", "b")], 1))).toEqual({ a: 2, b: 3, x: 1, y: 1 });
    expect(tracksOf(shiftClips(d, [key("c1", "x")], 1))).toEqual({ a: 1, b: 2, x: 4, y: 1 }); // 새 트랙
    expect(shiftClips(d, [key("c1", "b"), key("c2", "y")], -1)).toBeNull(); // y 가 1 아래로 못 간다 → 전체 거부
    expect(shiftClips(d, ["없는 키"], 1)).toBeNull();
  });

  it("끌어서 옮기기 — 지정한 트랙으로, 찬 자리면 맞바꿈", () => {
    const d = doc([clip("c1", "a", 1), clip("c1", "b", 3), clip("c2", "c", 3)]);
    expect(tracksOf(moveClipToTrack(d, key("c1", "a"), 3))).toEqual({ a: 3, b: 1, c: 3 });
    expect(tracksOf(moveClipToTrack(d, key("c1", "a"), 2))).toEqual({ a: 2, b: 3, c: 3 });
    expect(moveClipToTrack(d, key("c1", "a"), 1)).toBeNull();
    expect(moveClipToTrack(d, key("c1", "a"), 0)).toBeNull();
  });

  // 뷰어의 '한 트랙만 보기'(Jay 2026-10-08) — 위 트랙에 가려져 있어도, 꺼 둔 클립·트랙이어도 그 트랙의 것을 본다.
  it("한 트랙만 보기 — 그 순간 그 트랙에 있는 클립(끔은 따지지 않는다). 끝났거나 없으면 null", () => {
    const d = doc([clip("c1", "a", 1, { dur: 8, off: true }), clip("c1", "b", 2, { dur: 3 })], { tracksOff: [1] });
    const slot = buildLayout(["e070/c1"], d).cuts[0];
    expect(visibleClip(d, slot, 1)?.gen).toBe("b"); // 타임라인에서는 위 트랙이 보인다
    expect(trackClip(slot, 1, 1)?.gen).toBe("a");
    expect(trackClip(slot, 2, 1)?.gen).toBe("b");
    expect(trackClip(slot, 2, 3)).toBeNull(); // 3초에서 끝났다
    expect(trackClip(slot, 3, 0)).toBeNull();
  });

  // 카드의 트랙 메뉴(Jay 2026-10-08) — 찬 트랙을 고르면 교체, 빈 트랙이면 그 자리에 들어간다.
  it("트랙을 골라 넣기 — 찬 트랙은 교체, 빈 트랙은 그 자리에, 이미 넣은 것은 옮긴다", () => {
    const d = doc([clip("c1", "a", 1, { off: true, dur: 3 }), clip("c1", "b", 2), clip("c2", "y", 1)]);
    const fresh = { cut: "e070/c1", gen: "new", job: "j", kind: "video" as const, dur: 8 };
    const replaced = placeClip(d, fresh, 1)!; // V1 의 a 를 빼고 들어간다 — 다른 컷의 V1(y)은 그대로
    expect(tracksOf(replaced)).toEqual({ b: 2, y: 1, new: 1 });
    expect(replaced.clips.find((c) => c.gen === "new")).toEqual({ cut: "e070/c1", gen: "new", track: 1, kind: "video", dur: 8, job: "j" });
    expect(tracksOf(placeClip(d, fresh, 3))).toEqual({ a: 1, b: 2, y: 1, new: 3 }); // 빈 트랙 — 쌓인다
    expect(placeClip(d, { ...fresh, dur: NaN }, 3)!.clips[3].dur).toBe(DEFAULT_SEC);

    // 이미 이 컷에 넣은 것 — 새로 넣지 않고 옮긴다(꺼짐·길이는 그대로). 찬 자리는 교체하고 떠난 트랙은 빈다.
    const moved = placeClip(d, { cut: "e070/c1", gen: "a", kind: "video", dur: 99 }, 2)!;
    expect(moved.clips).toEqual([clip("c2", "y", 1), clip("c1", "a", 2, { off: true, dur: 3 })]);
    expect(placeClip(d, { cut: "e070/c1", gen: "a", kind: "video", dur: 99 }, 1)).toBeNull(); // 이미 그 트랙
    expect(parseEditDoc(JSON.parse(JSON.stringify(replaced)))).toEqual(replaced); // (컷, 트랙)·(컷, 생성물)은 하나뿐
    expect(parseEditDoc(JSON.parse(JSON.stringify(moved)))).toEqual(moved);
  });

  it("트랙을 골라 넣기 — 도착 트랙이나 떠나는 트랙이 잠겨 있으면 거부한다", () => {
    const d = doc([clip("c1", "a", 1), clip("c1", "b", 2)], { tracksLocked: [2] });
    const fresh = { cut: "e070/c1", gen: "new", kind: "image" as const, dur: 5 };
    expect(placeClip(d, fresh, 2)).toBeNull(); // 잠긴 트랙의 클립은 교체하지 않는다
    expect(placeClip(d, { ...fresh, gen: "b" }, 3)).toBeNull(); // 잠긴 트랙에서 떠나지 못한다
    expect(placeClip(d, fresh, 0)).toBeNull();
    expect(tracksOf(placeClip(d, fresh, 1))).toEqual({ b: 2, new: 1 });
  });

  it("놓을 자리의 판정 — 휠 클릭 메뉴의 줄과 끌어 넣기가 같이 쓴다(placeClip 의 거부와 어긋나지 않는다)", () => {
    const d = doc([clip("c1", "a", 1), clip("c1", "b", 2)], { tracksLocked: [2] });
    const [a, b] = d.clips;
    expect([1, 2, 3].map((track) => placeState(d, "e070/c1", null, track))).toEqual(["taken", "locked", "empty"]);
    expect([1, 2, 3].map((track) => placeState(d, "e070/c1", a, track))).toEqual(["here", "locked", "empty"]);
    expect([1, 2, 3].map((track) => placeState(d, "e070/c1", b, track))).toEqual(["locked", "here", "locked"]); // 잠긴 트랙에서 못 떠난다
    expect(placeState(d, "e070/c2", null, 1)).toBe("empty"); // 다른 컷의 같은 트랙
    for (const [own, id] of [[null, "new"], [a, "a"], [b, "b"]] as const) {
      for (const track of [1, 2, 3]) {
        const placed = placeClip(d, { cut: "e070/c1", gen: id, kind: "video", dur: 5 }, track);
        expect([id, track, placed === null]).toEqual([id, track, ["here", "locked"].includes(placeState(d, "e070/c1", own, track))]);
      }
    }
  });

  it("끄기는 하나라도 켜져 있으면 모두 끄고, 모두 꺼져 있으면 모두 켠다", () => {
    const d = doc([clip("c1", "a", 1, { off: true }), clip("c1", "b", 2)]);
    const allOff = toggleClipsOff(d, [key("c1", "a"), key("c1", "b")])!;
    expect(allOff.clips.map((c) => !!c.off)).toEqual([true, true]);
    expect(toggleClipsOff(allOff, [key("c1", "a"), key("c1", "b")])!.clips.map((c) => "off" in c)).toEqual([false, false]);
  });

  it("확정 길이 기록은 바뀐 것이 없으면 null", () => {
    const d = doc([clip("c1", "a", 1, { dur: 8 })]);
    expect(setClipDurs(d, new Map([[key("c1", "a"), 8]]))).toBeNull();
    expect(setClipDurs(d, new Map([[key("c1", "a"), NaN]]))).toBeNull();
    expect(setClipDurs(d, new Map([[key("c1", "a"), 8.04]]))!.clips[0].dur).toBe(8.04);
  });

  // 2026-10-14 — 그림 트랙으로 잰 길이의 표(durExact). 길이가 같아도 표가 달라지면 바뀐 것이다. 저장했다 읽어도·되돌리기에도 남는다.
  it("그림 트랙으로 잰 표(durExact) — 달고 떼기 · 저장·읽기 · 되돌리기는 지금 것을 따른다", () => {
    const k = key("c1", "a");
    const d = doc([clip("c1", "a", 1, { dur: 97 / 24 })]);
    const sure = setClipDurs(d, new Map([[k, 97 / 24]]), new Set([k]))!; // 같은 길이 — 표만 단다
    expect(sure.clips[0]).toMatchObject({ dur: 97 / 24, durExact: true });
    expect(setClipDurs(sure, new Map([[k, 97 / 24]]), new Set([k]))).toBeNull();
    expect("durExact" in setClipDurs(sure, new Map([[k, 98 / 24]]))!.clips[0]).toBe(false); // 표 없이 고치면 뗀다
    expect(parseEditDoc(JSON.parse(JSON.stringify(sure)))).toEqual(sure);
    expect(parseEditDoc({ ...sure, clips: [{ ...sure.clips[0], durExact: "yes" }] })).toBeNull();
    expect(keepClipDurs(d, sure)).toEqual(sure); // 옛 문서를 되살려도 길이·표는 지금 것
  });
});

describe("저장된 문서 읽기", () => {
  const good = { v: 1, clips: [{ cut: "e070/c1", gen: "g", job: "j", track: 2, off: true, dur: 8, kind: "video" }],
    tracksOff: [1, 1], tracksLocked: [], muted: true };

  it("정상 문서는 알려진 칸만 남겨 돌려준다", () => {
    expect(parseEditDoc({ ...good, extra: 1 })).toEqual({
      v: 1, clips: [{ cut: "e070/c1", gen: "g", track: 2, job: "j", off: true, dur: 8, kind: "video" }],
      tracksOff: [1], tracksLocked: [], muted: true,
    });
    expect(parseEditDoc({ v: 1, clips: [] })).toEqual(emptyEditDoc());
  });

  it("버전·모양·불변식이 어긋나면 null(빈 문서로 바꾸지 않는다)", () => {
    const c = good.clips[0];
    const bad: unknown[] = [
      null, "x", { v: 4, clips: [] }, { v: 1 }, { v: 1, clips: [null] }, // v 3 = 반복 자리(2026-10-23) — 모르는 판은 4
      { v: 1, clips: [{ ...c, track: 0 }] }, { v: 1, clips: [{ ...c, track: 1.5 }] },
      { v: 1, clips: [{ ...c, cut: "" }] }, { v: 1, clips: [{ ...c, cut: "e070\\c1" }] },
      { v: 1, clips: [{ ...c, dur: 0 }] }, { v: 1, clips: [{ ...c, dur: "8" }] },
      { v: 1, clips: [{ ...c, kind: "audio" }] }, { v: 1, clips: [], tracksOff: [0] },
      { v: 1, clips: [{ ...c, head: 0 }] }, { v: 1, clips: [{ ...c, head: -1 }] }, { v: 1, clips: [{ ...c, head: "1" }] },
      { v: 1, clips: [c, { ...c, gen: "other" }] }, // 같은 (컷, 트랙)
      { v: 1, clips: [c, { ...c, track: 3 }] }, // 같은 (컷, 생성물)
      { v: 1, clips: [], muted: "yes" },
    ];
    for (const value of bad) expect(parseEditDoc(value)).toBeNull();
  });
});

describe("컷(폴더) 비활성", () => {
  const C1 = `${SEQ}/c1`;
  it("문서에 적은 켬·끔이 기본값보다 앞서고, 안 적었으면 기본값을 따른다", () => {
    expect(cutIsOff(doc([]), C1, false)).toBe(false);
    expect(cutIsOff(doc([]), C1, true)).toBe(true); // 빈 폴더
    expect(cutIsOff(doc([], { cutsOn: [C1] }), C1, true)).toBe(false);
    expect(cutIsOff(doc([], { cutsOff: [C1] }), C1, false)).toBe(true);
  });

  it("뒤집을 때 기본값과 다를 때만 적는다 — 기본값과 같아지면 적어 둔 것을 지운다", () => {
    const off = toggleCutOff(doc([clip("c1", "g", 1)], { muted: true }), C1, false); // 켜져 있던 폴더를 끈다
    expect(off).toMatchObject({ cutsOff: [C1], muted: true });
    expect(off.clips).toHaveLength(1); // 넣은 클립은 그대로 남는다
    expect(toggleCutOff(off, C1, false).cutsOff).toBeUndefined(); // 다시 켜면 흔적이 없다

    const on = toggleCutOff(doc([]), C1, true); // 빈 폴더를 켠다
    expect(on.cutsOn).toEqual([C1]);
    expect(toggleCutOff(on, C1, true).cutsOn).toBeUndefined();

    // 끈 뒤에 그 폴더가 비게 됐다(기본값도 비활성) — 켜려면 '켬'으로 옮겨 적는다
    expect(toggleCutOff(doc([], { cutsOff: [C1] }), C1, true)).toMatchObject({ cutsOn: [C1] });
    expect(toggleCutOff(doc([], { cutsOff: [C1] }), C1, true).cutsOff).toBeUndefined();
  });

  it("저장된 문서에서 읽는다 — 빈 목록은 남기지 않고, 모양이 틀리면 문서 전체를 거부한다", () => {
    expect(parseEditDoc({ v: 1, clips: [], cutsOn: [C1, C1], cutsOff: [`${SEQ}/c2`], hideOff: true }))
      .toEqual({ ...emptyEditDoc(), cutsOn: [C1], cutsOff: [`${SEQ}/c2`], hideOff: true });
    expect(parseEditDoc({ v: 1, clips: [], cutsOn: [], hideOff: false })).toEqual(emptyEditDoc());
    for (const bad of [{ cutsOn: [C1], cutsOff: [C1] }, { cutsOff: ["/abs"] }, { cutsOn: [1] }, { cutsOff: "x" }, { hideOff: 1 }]) {
      expect(parseEditDoc({ v: 1, clips: [], ...bad })).toBeNull();
    }
  });
});

describe("공유 목록과 잇기", () => {
  it("쓸 수 있는 것 = 완료 + 영상/이미지", () => {
    expect(isUsableGen(gen("a", "e070/c1"))).toBe(true);
    expect(isUsableGen(gen("a", "e070/c1", { status: "running" }))).toBe(false);
    expect(isUsableGen(gen("a", "e070/c1", { assets: [] }))).toBe(false);
    const audio = gen("a", "e070/c1");
    (audio.assets[0] as { type: string }).type = "audio";
    expect(isUsableGen(audio)).toBe(false);
  });

  it("목록을 끝까지 못 받았으면 '없음'이 아니라 '확인 못 함'", () => {
    const c = clip("c1", "gone", 1, { job: "job-gone" });
    const list = [gen("other", "e070/c1")];
    expect(linkClip(c, list, false).state).toBe("unknown");
    expect(linkClip(c, undefined, false).state).toBe("unknown");
    expect(linkClip(c, list, true).state).toBe("missing");
    expect(linkClip(clip("c1", "other", 1), list, false).state).toBe("ok"); // 받은 쪽에 있으면 그대로 쓴다
  });

  it("job_id 로 다시 잇는 것은 그 컷에서 하나만 맞을 때뿐", () => {
    const c = clip("c1", "old-id", 1, { job: "J" });
    const one = [gen("new-id", "e070/c1", { job_id: "J" })];
    expect(linkClip(c, one, true)).toEqual({ state: "ok", gen: one[0] });
    expect(linkClip(c, [...one, gen("dup", "e070/c1", { job_id: "J" })], true).state).toBe("missing");
    expect(linkClip({ ...c, job: null }, one, true).state).toBe("missing");
  });

  it("컷으로 묶을 때 시퀀스 바로 아래·다른 폴더는 뺀다", () => {
    const grouped = groupByCut(SEQ, [gen("a", "e070/c1"), gen("b", "e070/c1/v2"), gen("c", "e070"), gen("d", "e035/c1")]);
    expect([...grouped.keys()]).toEqual(["e070/c1"]);
    expect(grouped.get("e070/c1")!.map((g) => g.id)).toEqual(["a", "b"]);
  });

  it("넣는 순간 길이 — 영상은 실측 → params → 기본, 이미지는 기본", () => {
    expect(genSeconds(gen("a", "x"), 7.5)).toBe(7.5);
    expect(genSeconds(gen("a", "x"))).toBe(8);
    expect(genSeconds(gen("a", "x", { params: null }))).toBe(DEFAULT_SEC);
    const image = gen("a", "x");
    image.assets[0].type = "image";
    expect(genSeconds(image, 9)).toBe(DEFAULT_SEC);
  });
});

// 트랙 머리 우클릭 메뉴(Jay 2026-10-08) — 다빈치의 Add Track · Move Track Up/Down · Delete Track · Delete Empty Tracks · 색.
describe("트랙 더하기·빼기·옮기기", () => {
  const base = doc(
    [clip("c1", "a", 1), clip("c1", "b", 2), clip("c2", "x", 2), clip("c2", "y", 3)],
    { tracksOff: [2], tracksLocked: [3], trackColors: { 2: "#e5484d" } },
  );

  it("이 위에 추가하면 그 위의 트랙이 한 줄씩 올라가고 끔·잠금·색이 따라간다", () => {
    const next = addTrack(base, 1)!;
    expect(tracksOf(next)).toEqual({ a: 1, b: 3, x: 3, y: 4 });
    expect(next).toMatchObject({ tracks: 4, tracksOff: [3], tracksLocked: [4], trackColors: { 3: "#e5484d" } });
    expect(buildLayout([], next).tracks).toBe(4);
    expect(addTrack(base, 3)).toMatchObject({ tracks: 4, tracksLocked: [3] }); // 맨 위에 추가 — 아무것도 안 밀린다
    expect(tracksOf(addTrack(base, 3))).toEqual(tracksOf(base));
    expect(addTrack(base, 4)).toBeNull(); // 없는 트랙
    expect(trackCount(emptyEditDoc())).toBe(3); // 적어 둔 줄 수가 없으면 기본 3줄
    expect(trackCount(doc([clip("c1", "a", 5)], { tracks: 2 }))).toBe(5); // 클립이 있는 트랙보다 적게는 안 그린다
  });

  it("위/아래로 옮기면 옆 트랙과 통째로 자리를 바꾼다 — 잠긴 트랙이 걸리면 거부", () => {
    const next = moveTrack(base, 1, 1)!;
    expect(tracksOf(next)).toEqual({ a: 2, b: 1, x: 1, y: 3 });
    expect(next).toMatchObject({ tracksOff: [1], trackColors: { 1: "#e5484d" } });
    expect(next.tracks).toBe(3); // 줄 수는 그대로
    const top = moveTrack(doc([clip("c1", "a", 4)], { trackColors: { 3: "#46a758" } }), 4, -1)!; // 맨 위 줄의 클립을 내린다
    expect(trackCount(top)).toBe(4); // 빈 줄이 된 맨 위 줄이 사라지지 않는다
    expect(top.trackColors).toEqual({ 4: "#46a758" });
    expect(moveTrack(base, 2, 1)).toBeNull(); // V3 가 잠겨 있다
    expect(moveTrack(base, 3, -1)).toBeNull();
    expect(moveTrack(base, 1, -1)).toBeNull(); // 맨 아래
    expect(moveTrack({ ...base, tracksLocked: [] }, 3, 1)).toBeNull(); // 맨 위
  });

  it("트랙을 지우면 그 트랙의 클립도 빠지고 위가 내려온다 — 잠긴 트랙·마지막 한 줄은 거부", () => {
    const next = deleteTrack(base, 2)!;
    expect(tracksOf(next)).toEqual({ a: 1, y: 2 });
    expect(next).toMatchObject({ tracks: 2, tracksOff: [], tracksLocked: [2] });
    expect(next.trackColors).toBeUndefined();
    expect(deleteTrack(base, 3)).toBeNull(); // 잠김
    expect(deleteTrack(doc([], { tracks: 1 }), 1)).toBeNull(); // 한 줄은 남긴다
    expect(parseEditDoc(JSON.parse(JSON.stringify(next)))).toEqual(next); // 저장했다 읽어도 같다
  });

  it("빈 트랙 모두 삭제 — 클립이 있는 트랙만 남기고 번호를 당긴다. 잠긴 트랙은 비어 있어도 남긴다", () => {
    const sparse = doc([clip("c1", "a", 2), clip("c1", "b", 5)], { tracksOff: [5], tracksLocked: [3], trackColors: { 5: "#46a758" } });
    const next = deleteEmptyTracks(sparse)!;
    expect(tracksOf(next)).toEqual({ a: 1, b: 3 }); // 빈 V1·V4 가 빠진다 — 잠긴 빈 V3 은 V2 로 남는다(트랙 삭제가 잠긴 트랙을 거부하는 것과 같다)
    expect(next).toMatchObject({ tracks: 3, tracksOff: [3], tracksLocked: [2], trackColors: { 3: "#46a758" } });
    expect(deleteEmptyTracks(next)).toBeNull(); // 더 지울 것이 없다(남은 빈 줄은 잠긴 것뿐)
    expect(deleteEmptyTracks(emptyEditDoc())).toMatchObject({ tracks: 1 }); // 클립이 없어도 한 줄은 남는다
    expect(deleteEmptyTracks(doc([], { tracksLocked: [2] }))).toMatchObject({ tracks: 1, tracksLocked: [1] }); // 잠긴 빈 줄이 그 한 줄이다
    expect(deleteEmptyTracks(doc([clip("c1", "a", 1)], { tracks: 2, tracksLocked: [2, 9] }))).toBeNull(); // 없는 번호(9)의 잠금은 세지 않는다
  });

  it("트랙 색을 정하고 없앤다 — 저장된 값은 #rrggbb 만 받는다", () => {
    const next = setTrackColor(base, 1, "#3b9eff")!;
    expect(next.trackColors).toEqual({ 1: "#3b9eff", 2: "#e5484d" });
    expect(setTrackColor(next, 1, "#3b9eff")).toBeNull();
    expect(setTrackColor(doc([], { trackColors: { 1: "#3b9eff" } }), 1, null)!.trackColors).toBeUndefined();
    expect(parseEditDoc(JSON.parse(JSON.stringify(next)))!.trackColors).toEqual(next.trackColors);
    expect(parseEditDoc({ ...emptyEditDoc(), trackColors: { 1: "red" } })).toBeNull();
    expect(parseEditDoc({ ...emptyEditDoc(), tracks: 0 })).toBeNull();
  });
});

// 마크 인/아웃·북마크(Jay 2026-10-08) — 자리는 재생헤드와 같은 좌표((컷, 컷 안 시각)).
describe("마크 인/아웃·북마크", () => {
  const cuts3 = [`${SEQ}/c1`, `${SEQ}/c2`, `${SEQ}/c3`];
  const d = doc([clip("c1", "a", 1, { dur: 8 }), clip("c3", "p", 1, { dur: 4 })]);
  const layout = buildLayout(cuts3, d); // c1 0~8 · c2(빈 컷) 8~13 · c3 13~17
  const at = (time: number) => posAt(layout, time)!;

  it("인/아웃은 (컷, 컷 안 시각)으로 적는다 — 순서가 뒤집히면 반대쪽을 지운다", () => {
    let next = setMark(d, layout, "markIn", at(2))!;
    next = setMark(next, layout, "markOut", at(10))!;
    expect(next).toMatchObject({ markIn: { cut: "e070/c1", local: 2 }, markOut: { cut: "e070/c2", local: 2 } });
    expect(markRange(layout, next)).toEqual({ from: 2, to: 10 });
    expect(marksOf(layout, next)).toEqual({ in: 2, out: 10, band: { from: 2, to: 10 } });
    expect(setMark(next, layout, "markOut", at(10))).toBeNull(); // 같은 자리
    const flipped = setMark(next, layout, "markIn", at(12))!; // 인을 아웃 뒤에 — 아웃을 지운다
    expect(flipped.markOut).toBeUndefined();
    expect(markRange(layout, flipped)).toEqual({ from: 12, to: 17 }); // 한쪽만 있으면 끝까지
    expect(setMark(next, layout, "markOut", at(1))!.markIn).toBeUndefined(); // 아웃을 인 앞에 — 인을 지운다
    expect(markRange(layout, setMark(d, layout, "markOut", at(5))!)).toEqual({ from: 0, to: 5 });
    const cleared = setMark(setMark(next, layout, "markIn", null)!, layout, "markOut", null)!;
    expect(cleared.markIn ?? cleared.markOut).toBeUndefined();
    expect(setMark(d, layout, "markIn", null)).toBeNull();
    expect(markRange(layout, d)).toBeNull();
    // 두 프레임보다 짧으면 구간으로 치지 않는다(표시는 따로 남는다 — 띠·반복만 없다)
    const tiny = (frames: number) => markRange(layout, setMark(setMark(d, layout, "markIn", at(2))!, layout, "markOut", at(2 + frames / 24))!);
    expect(tiny(1)).toBeNull();
    expect(tiny(2)).toEqual({ from: 2, to: 2 + 2 / 24 });
  });

  it("그 컷이 숨겨지거나 그 자리보다 짧아지면 문서에는 남고 화면에서만 빠진다", () => {
    const marked: EditDoc = { ...d, markIn: at(2), markOut: at(10) };
    const hidden = buildLayout([cuts3[0], cuts3[2]], marked); // c2 를 숨겼다 — c1 0~8 · c3 8~12
    expect(markTime(hidden, marked.markOut)).toBeNull();
    // 찍어 둔 표시가 안 보이면 구간이 아니다 — 안 보이는 쪽을 전체 끝으로 치면 구간 반복이 말없이 끝까지 넓어진다
    expect(marksOf(hidden, marked)).toEqual({ in: 2, out: null, band: null });
    expect(markRange(layout, marked)).toEqual({ from: 2, to: 10 }); // 다시 보이면 구간도 돌아온다
    const short = buildLayout(cuts3, doc([clip("c1", "a", 1, { dur: 1 }), clip("c3", "p", 1, { dur: 4 })]));
    expect(markTime(short, marked.markIn)).toBeNull(); // 끝으로 자르지 않는다
    expect(markTime(short, marked.markOut)).toBe(3); // 앞 컷이 짧아진 만큼 당겨진다 — 그 컷 안의 자리는 그대로
    // 안 보이는 쪽은 순서를 따지지 않는다 — 다시 보이게 되면 그대로 쓰인다
    expect(setMark(marked, hidden, "markIn", posAt(hidden, 11)!)!.markOut).toEqual(marked.markOut);
    expect(parseEditDoc(JSON.parse(JSON.stringify(marked)))).toMatchObject({ markIn: marked.markIn, markOut: marked.markOut });
    expect(parseEditDoc({ ...emptyEditDoc(), markIn: { cut: "e070/c1", local: -1 } })).toBeNull();
  });

  it("북마크는 (컷, 프레임)에 하나 — 고치고 지울 때는 원래 열쇠로 찾는다", () => {
    let next = addMarker(d, at(2))!;
    next = addMarker(next, at(9))!;
    expect(addMarker(next, { cut: "e070/c1", local: 2.01 })).toBeNull(); // 같은 프레임
    const [first, second] = shownMarkers(layout, next);
    expect([first.time, second.time]).toEqual([2, 9]);
    expect(first.key).toBe(markerKey(at(2)));
    next = patchMarker(next, first.key, { name: " 여기부터 ", color: "#e5484d" })!;
    expect(next.markers![0]).toEqual({ cut: "e070/c1", local: 2, color: "#e5484d", name: "여기부터" });
    expect(patchMarker(next, first.key, { name: "여기부터" })).toBeNull(); // 바뀐 것이 없다
    expect(patchMarker(next, "없는 열쇠", { name: "x" })).toBeNull();
    expect(patchMarker(next, first.key, { name: "" })!.markers![0].name).toBeUndefined();
    expect(parseEditDoc(JSON.parse(JSON.stringify(next)))!.markers).toEqual(next.markers);
    expect(parseEditDoc({ ...emptyEditDoc(), markers: [at(2), at(2)] })).toBeNull(); // 겹친 열쇠
    next = removeMarker(next, second.key)!;
    expect(shownMarkers(layout, next).map((item) => item.time)).toEqual([2]);
    expect(removeMarker(next, second.key)).toBeNull();
    expect(removeMarker(next, first.key)!.markers).toBeUndefined();
    // 새 북마크의 색(다빈치의 마커 색 16가지) · 모두 지우기
    expect(MARKER_COLORS).toHaveLength(16);
    expect(addMarker(d, at(3), MARKER_COLORS[4].color)!.markers![0]).toEqual({ cut: "e070/c1", local: 3, color: "#e12401" });
    expect(addMarker(d, at(3), "red")!.markers![0].color).toBeUndefined(); // #rrggbb 가 아니면 색 없이
    expect(clearMarkers(next)!.markers).toBeUndefined();
    expect(clearMarkers(d)).toBeNull();
  });

  it("재생헤드 자리의 북마크 — 같은 프레임이면 찾고, 컷 경계에서는 앞 컷 끝에 찍은 것도 찾는다", () => {
    const end = { cut: "e070/c1", local: 8 }; // 앞 컷의 끝(다음 컷의 처음과 같은 시각인데 열쇠가 다르다)
    const marked: EditDoc = { ...d, markers: [{ cut: "e070/c1", local: 1.022 }, end] };
    const shown = shownMarkers(layout, marked);
    expect(markerAt(layout, shown, 1.061)?.marker.local).toBe(1.022); // 반 프레임보다 멀어도 같은 프레임(열쇠)이다
    expect(markerAt(layout, shown, 1.1)).toBeNull();
    expect(markerAt(layout, shown, 8)?.marker).toEqual(end);
    expect(markerAt(layout, shown, 8.5)).toBeNull();
    const shorter = buildLayout([cuts3[0]], doc([clip("c1", "a", 1, { dur: 4 })]));
    expect(shownMarkers(shorter, marked).map((item) => item.time)).toEqual([1.022]); // 길이 밖의 것은 숨는다(문서에는 남는다)
  });
});

// 빈 곳 채우기(Jay 2026-10-08) — 클립이 하나도 없는 컷에만, 컷마다 하나씩.
// 다이나믹 재생 모드(Jay 2026-10-26 — 다빈치의 Dynamic Trim Mode, 보기만 · 10-08 의 계산을 되살림)
describe("다이나믹 재생 모드 — 편집점의 앞 | 뒤", () => {
  // c1 0~8(위 top 3초 · 아래 low 8초) · c2(빈 컷) 8~13 · c3 13~19
  const d = doc([clip("c1", "low", 1, { dur: 8 }), clip("c1", "top", 2, { dur: 3 }), clip("c3", "solo", 1, { dur: 6 })]);
  const layout = buildLayout(["e070/c1", "e070/c2", "e070/c3"], d);
  const points = editPoints(layout);
  const seen = (point: number, from = d) =>
    shotsAt(layout, from, points, point).map((shot) => shot && (shot.clip?.gen ?? "빈 화면"));

  it("보는 편집점 = 재생헤드에서 가장 가까운 것(처음·끝 포함)", () => {
    expect(points).toEqual([0, 3, 8, 13, 19]);
    expect([0, 1.4, 1.6, 5.4, 5.6, 12, 18.9, 99].map((time) => nearestPoint(points, time))).toEqual([0, 0, 3, 3, 8, 13, 19, 19]);
    expect(nearestPoint([], 4)).toBe(0);
  });

  it("편집점의 바로 앞과 바로 뒤에 보이는 것 — 처음에는 앞이, 끝에는 뒤가 없다", () => {
    expect(seen(0)).toEqual([null, "top"]);
    expect(seen(3)).toEqual(["top", "low"]); // 컷 안 — 위 클립이 끝나 아래가 드러난다
    expect(seen(8)).toEqual(["low", "빈 화면"]);
    expect(seen(13)).toEqual(["빈 화면", "solo"]);
    expect(seen(19)).toEqual(["solo", null]);
    expect(seen(0, { ...d, tracksOff: [2] })).toEqual([null, "low"]); // 끈 트랙은 타임라인 뷰어처럼 건너뛴다
    expect(seen(5)).toEqual([null, null]); // 편집점이 아닌 시각
    const [before, after] = shotsAt(layout, d, points, 3);
    expect(before!.local).toBeCloseTo(3 - 0.25 / 24); // 끝나는 클립의 마지막 프레임 안쪽
    expect(after!.local).toBeCloseTo(3 + 0.25 / 24); // 아래 클립은 0초가 아니라 보던 시각
    expect(shotsAt(layout, d, points, 13)[1]!.local).toBeLessThan(1 / 24); // 컷 경계 — 뒤 컷의 첫 프레임
  });

  it("아주 짧게 비치는 클립을 건너뛰지 않는다 — 표본 시각은 이웃 편집점과의 한가운데를 넘지 않는다", () => {
    // 0.005초 조각은 그림 클립으로 만든다 — 영상의 쓰는 길이는 프레임으로 내려 이런 조각이 생기지 않는다(2026-10-14)
    const thin = doc([clip("c1", "v1", 1, { dur: 8 }), clip("c1", "v2", 2, { dur: 5.005, kind: "image" }), clip("c1", "v3", 3, { dur: 5 })]);
    const thinLayout = buildLayout(["e070/c1"], thin);
    const thinPoints = editPoints(thinLayout); // 0 · 5 · 5.005 · 8
    const gens = (point: number) => shotsAt(thinLayout, thin, thinPoints, point).map((shot) => shot!.clip!.gen);
    expect(gens(5)).toEqual(["v3", "v2"]); // 1/4 프레임 뒤면 v1 이지만, 그 사이 0.005초는 v2 다
    expect(gens(5.005)).toEqual(["v2", "v1"]);
  });
});

// 막대의 순서 알약(Jay 2026-10-26 — "폴더순으로 되는건데 내순서라고 적혀있어서 헷갈린다") — '내 순서 ↺' 는 폴더끼리의 순서를 바꿨을 때만
describe("폴더끼리의 순서", () => {
  it("반복 자리를 컷 사이에 끼운 것만으로는 바꾼 것이 아니다 — 각 폴더가 처음 나오는 순서로 본다", () => {
    expect(foldersReordered(["e070/c1", "e070/c2", "e070/c1//abc123", "e070/c3"])).toBe(false);
    expect(foldersReordered(["e070/c1//abc123", "e070/c2", "e070/c1", "e070/c3"])).toBe(false); // 첫 자리가 숨어 반복 자리가 먼저여도
    expect(foldersReordered(["e070/c2", "e070/c1//abc123", "e070/c1", "e070/c3"])).toBe(true);
    expect(foldersReordered(["e070/c9", "e070/c10"])).toBe(false); // 이름순은 숫자를 숫자로 본다
    expect(foldersReordered([])).toBe(false);
  });
});

describe("빈 곳 채우기", () => {
  const pick = (cut: string, gen: string) => ({ cut: `${SEQ}/${cut}`, gen, job: `job-${gen}`, kind: "image" as const, dur: 5 });

  it("빈 컷에만 넣는다 — 넣는 자리는 넣기와 같고(안 잠긴 가장 낮은 트랙), 넣은 것이 없으면 null", () => {
    const base = doc([clip("c1", "a", 2)], { tracksLocked: [1] });
    const filled = fillEmptyCuts(base, [pick("c1", "z"), pick("c2", "x"), pick("c3", "y")])!;
    expect(tracksOf(filled)).toEqual({ a: 2, x: 2, y: 2 }); // c1 은 이미 클립이 있다 · V1 은 잠겨 있어 V2 로
    expect(filled.clips.find((item) => item.gen === "x")).toEqual({ cut: "e070/c2", gen: "x", track: 2, kind: "image", dur: 5, job: "job-x" });
    expect(base.clips).toHaveLength(1); // 원본은 그대로
    expect(fillEmptyCuts(filled, [pick("c2", "x2"), pick("c3", "y2")])).toBeNull(); // 더 채울 곳이 없다
    expect(fillEmptyCuts(base, [])).toBeNull();
    expect(tracksOf(fillEmptyCuts(doc([]), [pick("c2", "x"), pick("c2", "x2")]))).toEqual({ x: 1 }); // 한 컷에 하나만
  });
});
