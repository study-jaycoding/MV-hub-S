import { describe, expect, it } from "vitest";
import {
  buildLayout,
  clipKey,
  cutIsOff,
  cutOf,
  cutPaths,
  DEFAULT_SEC,
  editPoints,
  emptyEditDoc,
  genSeconds,
  groupByCut,
  insertClip,
  insertTrack,
  isUsableGen,
  linkClip,
  moveClipToTrack,
  parseEditDoc,
  placeClip,
  posAt,
  removeClips,
  setClipDurs,
  settlePos,
  shiftClips,
  stepPoint,
  timecode,
  timeOf,
  toggleClipsOff,
  toggleCutOff,
  toggleTrack,
  trackClip,
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

  it("끈 클립·끈 트랙은 안 보이지만 컷 길이는 그대로다. 잠금은 보이기와 무관하다", () => {
    const off = toggleClipsOff(d, [key("c1", "top")])!;
    const slot = buildLayout(["e070/c1"], off).cuts[0];
    expect(visibleClip(off, slot, 0)?.gen).toBe("low");
    const trackOff = toggleTrack(d, "tracksOff", 1);
    expect(visibleClip(trackOff, buildLayout(["e070/c1"], trackOff).cuts[0], 5)).toBeNull();
    expect(buildLayout(["e070/c1"], toggleClipsOff(d, [key("c1", "low")])!).cuts[0].len).toBe(8);
    const locked = toggleTrack(d, "tracksLocked", 2);
    expect(visibleClip(locked, layout.cuts[0], 0)?.gen).toBe("top");
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

  // 카드 우클릭 메뉴(Jay 2026-10-08) — 찬 트랙을 고르면 교체, 빈 트랙이면 그 자리에 들어간다.
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
      null, "x", { v: 2, clips: [] }, { v: 1 }, { v: 1, clips: [null] },
      { v: 1, clips: [{ ...c, track: 0 }] }, { v: 1, clips: [{ ...c, track: 1.5 }] },
      { v: 1, clips: [{ ...c, cut: "" }] }, { v: 1, clips: [{ ...c, cut: "e070\\c1" }] },
      { v: 1, clips: [{ ...c, dur: 0 }] }, { v: 1, clips: [{ ...c, dur: "8" }] },
      { v: 1, clips: [{ ...c, kind: "audio" }] }, { v: 1, clips: [], tracksOff: [0] },
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
