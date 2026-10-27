// @vitest-environment jsdom
// 편집 탭 ⑤ 같은 컷을 컷 사이에 한 번 더(Jay 2026-10-23) — 순수 계산. 계약: docs/status/편집탭_컷끼워넣기_구현_2026-10-23.md
//  (slot-model · slot-ops · slot-playhead). 화면 조작은 editCutRepeatUi.test.tsx.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditArchive, knownDocEquals, parseEditArchive } from "../src/lib/editArchive";
import {
  boundaryAt,
  buildLayout,
  clipKey,
  cutPaths,
  editDocVersion,
  emptyEditDoc,
  fillEmptyCuts,
  folderOf,
  insertClip,
  insertSlot,
  insertTrack,
  isRepeatSlot,
  markRange,
  dropTargetAt,
  moveClipIntoSlot,
  moveClipToSlot,
  moveClipToTrack,
  moveCut,
  parseEditDoc,
  placeClip,
  placeState,
  removeClips,
  resetCutOrder,
  setClipSpeed,
  settlePos,
  shiftClips,
  slotLabels,
  slotOf,
  slotOfFolder,
  slotStays,
  slotTitle,
  validSlotKey,
  type EditClip,
  type EditDoc,
} from "../src/lib/editTimeline";
import { writeEditDoc, writeEditRaw } from "../src/lib/editTimelineStore";

const S = "e035";
const A = `${S}/C0050`;
const B = `${S}/C0080`;
const C = `${S}/C0110`;
const A2 = `${A}//abc123`; // 반복 자리 — C0050 을 한 번 더
const clip = (cut: string, gen: string, track = 1, more: Partial<EditClip> = {}): EditClip => {
  const at = cut.indexOf("//");
  return { ...(at < 0 ? { cut } : { cut: cut.slice(0, at), slot: cut.slice(at + 2) }), gen, track, kind: "video", dur: 5, ...more };
};
const doc3 = (clips: EditClip[], more: Partial<EditDoc> = {}): EditDoc => ({ ...emptyEditDoc(), v: 3, clips, ...more });
const card = (cut: string, gen: string) => ({ cut, gen, job: `job-${gen}`, kind: "video" as const, dur: 4 });
const order = (doc: EditDoc) => cutPaths(S, [A, B, C], doc);

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("slot-model — 자리 열쇠·검사·판", () => {
  it("자리 열쇠 = 폴더//ID · 폴더는 그대로 · 열쇠 검사는 '//' 정확히 한 번, 폴더만 정규화, ID 는 소문자·숫자, v3 만", () => {
    expect([slotOf(clip(A2, "g")), slotOf(clip(A, "g")), folderOf(A2), folderOf(A), isRepeatSlot(A2), isRepeatSlot(A)])
      .toEqual([A2, A, A, A, true, false]);
    expect(clipKey(clip(A2, "g"))).not.toBe(clipKey(clip(A, "g"))); // 같은 생성물의 두 자리는 다른 클립
    expect([A, A2].map((key) => validSlotKey(key, 3))).toEqual([true, true]);
    expect([validSlotKey(A2, 1), validSlotKey(A2, 2)]).toEqual([false, false]);
    for (const bad of [`${A}//b//c`, `${A}///b`, `${A}//ABC`, `${A}//`, "//abc", `${A}/`, `e035\\C0050//abc`, `${A}//${"a".repeat(17)}`]) {
      expect(validSlotKey(bad, 3)).toBe(false);
    }
  });

  it("실제 폴더 C0050#2·C00502 와 반복 자리가 섞이지 않는다 — 이름순 = 폴더 이름 → 첫 자리 먼저 · 번호는 같은 폴더가 둘 이상일 때만", () => {
    const hash = `${S}/C0050#2`;
    const near = `${S}/C00502`;
    const doc = doc3([clip(A, "a"), clip(A2, "b"), clip(hash, "c"), clip(near, "d")]);
    const all = cutPaths(S, [A, hash, near], doc);
    expect(all).toEqual([A, A2, hash, near]);
    const labels = slotLabels(all);
    expect(all.map((key) => labels.get(key))).toEqual(["C0050 ①", "C0050 ②", "C0050#2", "C00502"]);
    const layout = buildLayout(all, doc, undefined, labels);
    expect(layout.cuts.map((slot) => [slot.path, slot.clips.map((item) => item.gen)])).toEqual([[A, ["a"]], [A2, ["b"]], [hash, ["c"]], [near, ["d"]]]);
    expect(slotTitle(layout.cuts[1])).toBe("e035/C0050 ②"); // 무작위 ID 는 이름에 없다
  });

  it("parseEditDoc — v3 의 slot·자리 열쇠를 받고, v1·v2 의 slot·'//' 와 같은 자리의 겹침은 거부 · 같은 생성물은 두 자리에 있어도 된다", () => {
    const good = doc3([clip(A, "g"), clip(A2, "g", 1, { speed: 2 })], {
      cutOrder: [A, B, A2], cutsOff: [A2], markIn: { cut: A2, local: 1 }, markers: [{ cut: A2, local: 2 }],
    });
    expect(parseEditDoc(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(parseEditDoc({ ...good, v: 2 })).toBeNull();
    expect(parseEditDoc({ v: 2, clips: [], tracksOff: [], tracksLocked: [], cutOrder: [A2] })).toBeNull();
    expect(parseEditDoc({ ...good, clips: [clip(A2, "g"), clip(A2, "h")] })).toBeNull(); // 같은 (자리, 트랙)
    expect(parseEditDoc({ ...good, clips: [clip(A2, "g"), clip(A2, "g", 2)] })).toBeNull(); // 같은 (자리, 생성물)
    expect(parseEditDoc({ ...good, clips: [{ ...clip(A, "g"), slot: "ABC" }] })).toBeNull();
    expect(parseEditDoc({ ...good, clips: [{ ...clip(A, "g"), cut: A2 }] })).toBeNull(); // cut 칸에 자리 열쇠 — 폴더만
    expect(parseEditDoc({ v: 1, clips: [clip(A, "g")], tracksOff: [], tracksLocked: [] })?.v).toBe(1); // 옛 문서는 그대로
  });

  it("판 — 반복 자리·자리 열쇠 참조가 있으면 3, 어떤 명령도 판을 내리지 않는다(v3 에서 속도를 바꿔도 3)", () => {
    expect(editDocVersion({ ...emptyEditDoc(), clips: [clip(A2, "g")] })).toBe(3);
    expect(editDocVersion({ ...emptyEditDoc(), markers: [{ cut: A2, local: 0 }] })).toBe(3);
    expect(editDocVersion({ ...emptyEditDoc(), clips: [clip(A, "g", 1, { speed: 2 })] })).toBe(2);
    const sped = setClipSpeed(doc3([clip(A, "g")]), clipKey(clip(A, "g")), 2)!;
    expect(sped.v).toBe(3);
    expect(setClipSpeed({ ...emptyEditDoc(), clips: [clip(A, "g")] }, clipKey(clip(A, "g")), 2)!.v).toBe(2);
  });

  it("저장본은 한 번 3 이면 계속 3 — 되돌리기로 반복 자리 없는 문서를 저장해도·저장 실패 뒤 다시 저장해도 · 계정 백업 복원(원문)은 글자 그대로", () => {
    const key = "mvhub.editDoc:local:p1:e035";
    writeEditDoc(key, doc3([clip(A, "a"), clip(A2, "b")]));
    const undone: EditDoc = { ...emptyEditDoc(), clips: [clip(A, "a")] }; // 되돌리기로 돌아간 옛 문서(v1)
    writeEditDoc(key, undone);
    expect(JSON.parse(localStorage.getItem(key)!).v).toBe(3);
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("가득 참"); });
    expect(writeEditDoc(key, undone)).toBeNull();
    vi.mocked(Storage.prototype.setItem).mockImplementation(real);
    writeEditDoc(key, undone);
    expect(JSON.parse(localStorage.getItem(key)!).v).toBe(3);
    const backupRaw = JSON.stringify({ v: 1, clips: [clip(A, "old")], tracksOff: [], tracksLocked: [] });
    writeEditRaw(key, backupRaw); // useEditDoc.replaceFromBackup 이 쓰는 길
    expect(localStorage.getItem(key)).toBe(backupRaw);
  });

  it("보관 파일 — v3 왕복(slot·자리 열쇠) · 길이는 자리마다(같은 폴더 두 자리는 따로) · 참조만 남은 반복 자리는 0초 · 같은 생성물의 두 자리 비교", () => {
    const target = { projectId: "p1", seq: S };
    const read = (doc: unknown) => parseEditArchive(JSON.stringify({ ...createEditArchive(emptyEditDoc(), target, false), docRaw: JSON.stringify(doc) }), target);
    const doc = doc3([clip(A, "g"), clip(A2, "g", 1, { speed: 2 })], { cutOrder: [A, B, A2], markers: [{ cut: A2, local: 1 }] });
    const back = read(doc);
    expect(back.ok && back.doc).toEqual(doc);
    const long = (cut: string, gen: string) => clip(cut, gen, 1, { dur: 50_000 });
    expect(read(doc3([long(A, "x"), long(A2, "y")])).ok).toBe(false); // 100,000초 > 하루
    expect(read(doc3([long(A, "x")], { cutOrder: [A2, A], markers: [{ cut: `${A}//dead01`, local: 0 }] })).ok).toBe(true);
    // 길이가 안 적힌 반복 자리의 클립도 배치는 기본 5초 — 하루 한도 경계에서 그 5초가 센다(Codex 독립 리뷰 1차)
    const half = (cut: string, gen: string) => clip(cut, gen, 1, { dur: 43_200 });
    const undated = { ...clip(A2, "u") } as Partial<EditClip>;
    delete undated.dur;
    expect(read(doc3([half(A, "x"), half(B, "y")])).ok).toBe(true);
    expect(read(doc3([half(A, "x"), half(B, "y"), undated as EditClip])).ok).toBe(false);
    // 길이가 안 적힌 클립에 느린 속도 — 기본 5초 ÷ 0.25 = 20초로 센다(첫 자리·반복 자리 모두, Codex 독립 리뷰 2차)
    const slow = { ...undated, speed: 0.25 } as EditClip;
    expect(read(doc3([clip(A, "x", 1, { dur: 86_385 }), slow])).ok).toBe(false); // 86,385 + 20 > 하루
    expect(read(doc3([clip(A, "x", 1, { dur: 86_380 }), slow])).ok).toBe(true); // 86,380 + 20 = 하루
    const slowFirst = { ...slow, slot: undefined, cut: B } as EditClip;
    delete (slowFirst as Partial<EditClip>).slot;
    expect(read(doc3([clip(A, "x", 1, { dur: 86_385 }), slowFirst])).ok).toBe(false);
    // 참조만 남은 반복 자리는 목록의 몇째에 있든 0초(하루 꽉 찬 문서에 죽은 열쇠가 둘째·셋째로 있어도 통과)
    const full = doc3([clip(A, "x", 1, { dur: 86_400 })], { cutOrder: [A, `${A}//dead01`, `${A}//dead02`], cutsOff: [A, `${A}//dead03`] });
    expect(read(full).ok).toBe(true);
    expect(read(doc3([clip(`${S}/other/x`, "g")])).ok).toBe(false); // 그 시퀀스의 직계 컷이 아님
    expect(read({ ...doc, clips: [{ ...clip(A, "g"), slot: "BAD" }] }).ok).toBe(false);
    expect(knownDocEquals(doc, { ...doc, clips: [...doc.clips].reverse() })).toBe(true);
    // v3 에서 속도를 바꾼 작업본을 내보내고 복원해도 v3
    const sped = setClipSpeed(doc, clipKey(clip(A, "g")), 0.5)!;
    const archived = parseEditArchive(JSON.stringify(createEditArchive(sped, target, true)), target);
    expect(archived.ok && archived.doc.v).toBe(3);
  });
});

describe("slot-ops — 끼워 넣기·옮기기·넣기·맞바꾸기", () => {
  it("insertSlot — before 앞에 새 자리를 만들고 그 트랙에 넣는다 · 잠긴 트랙·쓰인 ID·잘못된 before·폴더가 아닌 카드는 거부(문서 그대로)", () => {
    const base: EditDoc = { ...emptyEditDoc(), clips: [clip(A, "a"), clip(B, "b"), clip(C, "c")] };
    const all = order(base);
    const next = insertSlot(base, all, card(A, "n"), C, 2, "zz9")!;
    expect(next.v).toBe(3);
    expect(next.clips.at(-1)).toEqual({ cut: A, slot: "zz9", gen: "n", job: "job-n", track: 2, kind: "video", dur: 4 });
    expect(order(next)).toEqual([A, B, `${A}//zz9`, C]);
    expect(insertSlot(base, all, card(A, "n"), null, 1, "zz9") && order(insertSlot(base, all, card(A, "n"), null, 1, "zz9")!)).toEqual([A, B, C, `${A}//zz9`]);
    expect(insertSlot({ ...base, tracksLocked: [2] }, all, card(A, "n"), C, 2, "zz9")).toBeNull();
    expect(insertSlot(base, all, card(A, "n"), `${S}/nope`, 1, "zz9")).toBeNull();
    expect(insertSlot(base, all, card(A2, "n"), C, 1, "zz9")).toBeNull();
    expect(insertSlot(base, all, card(`${S}/nope`, "n"), C, 1, "zz9")).toBeNull();
    for (const used of [
      { clips: [...base.clips, clip(`${B}//zz9`, "q")] }, { cutOrder: [`${C}//zz9`] }, { cutsOn: [`${C}//zz9`] }, { cutsOff: [`${C}//zz9`] },
      { markIn: { cut: `${C}//zz9`, local: 0 } }, { markOut: { cut: `${C}//zz9`, local: 0 } }, { markers: [{ cut: `${C}//zz9`, local: 0 }] },
    ]) {
      const taken = { ...base, v: 3 as const, ...used };
      expect(insertSlot(taken, order(taken), card(A, "n"), C, 1, "zz9")).toBeNull();
    }
    expect(insertSlot(base, all, card(A, "n"), C, 1, "BAD")).toBeNull();
  });

  it("moveClipToSlot ② — 반복 자리의 유일한 클립은 자리째(ID·북마크·D 가 따라감) · 트랙만 바뀌어도 성공 · 둘 다 그대로면 null · ID 는 안 본다", () => {
    const base = doc3([clip(A, "a"), clip(B, "b"), clip(A2, "r"), clip(C, "c")], { cutOrder: [A, B, A2, C], markers: [{ cut: A2, local: 1 }], cutsOff: [A2] });
    const all = order(base);
    expect(all).toEqual([A, B, A2, C]);
    const key = clipKey(clip(A2, "r"));
    const moved = moveClipToSlot(base, all, key, null, 1, "BAD-IGNORED")!;
    expect(order(moved)).toEqual([A, B, C, A2]);
    expect([moved.markers, moved.cutsOff, moved.clips.find((item) => item.gen === "r")?.slot]).toEqual([[{ cut: A2, local: 1 }], [A2], "abc123"]);
    const retracked = moveClipToSlot(base, all, key, C, 3, "x")!; // 제자리 + 트랙만
    expect([order(retracked), retracked.clips.find((item) => item.gen === "r")?.track]).toEqual([[A, B, A2, C], 3]);
    expect(moveClipToSlot(base, all, key, C, 1, "x")).toBeNull();
    expect(moveClipToSlot(base, all, key, A2, 1, "x")).toBeNull();
  });

  it("moveClipToSlot ③ — 그 밖은 복사해 slot 만 새 ID(속도·자르기·꺼짐·길이 보존) · 첫 자리는 빈 채 남음 · 잠금·잘못된 before·쓰인 ID 는 거부", () => {
    const rich = clip(A, "a", 1, { head: 1, trim: 2, speed: 0.5, off: true, dur: 9, durExact: true, job: "j" });
    const base = doc3([rich, clip(B, "b"), clip(C, "c")]);
    const all = order(base);
    const next = moveClipToSlot(base, all, clipKey(rich), C, 2, "nw1")!;
    expect(next.clips.find((item) => item.gen === "a")).toEqual({ ...rich, slot: "nw1", track: 2 });
    // A 는 빈 첫 자리 — 그 폴더에 반복 자리가 있으니 자리 목록에서 숨는다(2026-10-26, Jay "비어있는 부분을 없앨수도 없네")
    expect(order(next)).toEqual([B, `${A}//nw1`, C]);
    expect(next.cutOrder).toContain(A); // 순서 기록은 남는다
    expect(moveClipToSlot({ ...base, tracksLocked: [1] }, all, clipKey(rich), C, 2, "nw1")).toBeNull();
    expect(moveClipToSlot({ ...base, tracksLocked: [2] }, all, clipKey(rich), C, 2, "nw1")).toBeNull();
    expect(moveClipToSlot(base, all, clipKey(rich), `${S}/nope`, 2, "nw1")).toBeNull();
    expect(moveClipToSlot({ ...base, cutOrder: [`${B}//nw1`] }, all, clipKey(rich), C, 2, "nw1")).toBeNull();
    // 다른 클립이 남는 반복 자리에서 빼 옮기면 새 자리 — 원래 자리는 남는다
    const two = doc3([clip(A, "a"), clip(A2, "r"), clip(A2, "s", 2), clip(B, "b")]);
    const split = moveClipToSlot(two, order(two), clipKey(clip(A2, "s", 2)), null, 1, "nw2")!;
    expect(order(split)).toEqual([A, A2, B, C, `${A}//nw2`]);
  });

  it("트랙 맞바꾸기·넣기는 같은 자리의 클립하고만 — 다른 반복 자리의 클립은 그대로", () => {
    const other = `${A}//zzz`;
    const base = doc3([clip(A2, "x", 1), clip(A2, "y", 2), clip(other, "p", 1), clip(other, "q", 2)]);
    const swapped = moveClipToTrack(base, clipKey(clip(A2, "x")), 2)!;
    expect(swapped.clips.map((item) => [slotOf(item), item.gen, item.track])).toEqual([[A2, "x", 2], [A2, "y", 1], [other, "p", 1], [other, "q", 2]]);
    const shifted = shiftClips(base, [clipKey(clip(A2, "x"))], 1)!;
    expect(shifted.clips.map((item) => item.track)).toEqual([2, 1, 1, 2]);
    const placed = placeClip(base, card(other, "z"), 1)!; // 다른 자리의 V1 을 교체 — A2 의 V1 은 남는다
    expect(placed.clips.map((item) => `${slotOf(item)}:${item.gen}:${item.track}`).sort())
      .toEqual([`${A2}:x:1`, `${A2}:y:2`, `${other}:q:2`, `${other}:z:1`].sort());
    expect([insertTrack(base, A2), insertTrack(base, A), placeState(base, other, null, 1), placeState(base, A, null, 1)]).toEqual([3, 1, "taken", "empty"]);
  });

  it("넣기 함수 — 사라진 반복 자리(클립 없음)로는 안 넣고, 빈 첫 자리(폴더)는 된다", () => {
    const base = doc3([clip(A2, "r")]);
    const dead = `${A}//gone1`;
    expect([insertClip(base, card(dead, "n")), placeClip(base, card(dead, "n"), 1)]).toEqual([null, null]);
    expect(fillEmptyCuts(base, [card(dead, "n")])).toBeNull();
    expect(insertClip(base, card(A, "n"))!.clips.at(-1)).toMatchObject({ cut: A, gen: "n", track: 1 });
    expect(fillEmptyCuts(base, [card(A, "n")])!.clips.at(-1)).toMatchObject({ cut: A, gen: "n" }); // 반복 자리의 클립이 첫 자리를 채운 것으로 치지 않는다
    expect(placeClip(base, card(A2, "n"), 2)!.clips.at(-1)).toEqual({ cut: A, slot: "abc123", gen: "n", job: "job-n", track: 2, kind: "video", dur: 4 });
  });

  it("죽은 자리 정리 — 빼기는 순서를 안 건드리고, 다음 순서 쓰기(moveCut·resetCutOrder)가 순서·D·북마크에서 뺀다 · 인/아웃은 남아 구간이 꺼진다", () => {
    const base = doc3([clip(A, "a"), clip(B, "b"), clip(A2, "r"), clip(C, "c")], {
      cutOrder: [A, B, A2, C], cutsOff: [A2], markers: [{ cut: A2, local: 1 }, { cut: B, local: 1 }], markIn: { cut: A2, local: 0 }, markOut: { cut: C, local: 2 },
    });
    const removed = removeClips(base, [clipKey(clip(A2, "r"))])!;
    expect(removed.cutOrder).toEqual([A, B, A2, C]);
    expect(markRange(buildLayout(order(removed), removed), removed)).toBeNull(); // 인이 사라진 자리에 — 구간 꺼짐
    const reordered = moveCut(removed, order(removed), C, B)!;
    expect([reordered.cutOrder, reordered.cutsOff, reordered.markers, reordered.markIn]).toEqual([[A, C, B], undefined, [{ cut: B, local: 1 }], { cut: A2, local: 0 }]);
    expect(resetCutOrder(removed)).toMatchObject({ markers: [{ cut: B, local: 1 }] });
    // 이름순으로 되돌리면 반복 자리는 자기 폴더의 첫 자리 바로 뒤
    const live = resetCutOrder(base)!;
    expect([live.cutOrder, order(live)]).toEqual([undefined, [A, A2, B, C]]);
  });

  it("boundaryAt — 가장 가까운 경계, 반폭 = min(12px, 양옆 컷 폭의 25%) · 맨 앞·맨 뒤 · 축소(2px/초)에서도 몸통이 남는다", () => {
    const doc: EditDoc = { ...emptyEditDoc(), clips: [clip(A, "a"), clip(B, "b", 1, { dur: 10 })] };
    const layout = buildLayout([A, B], doc); // A 0~5초 · B 5~15초
    expect([boundaryAt(layout, 100, 20), boundaryAt(layout, 111, 20), boundaryAt(layout, 113, 20)]).toEqual([{ before: B }, { before: B }, null]);
    expect([boundaryAt(layout, 4, 20), boundaryAt(layout, 300, 20), boundaryAt(layout, 290, 20), boundaryAt(layout, 287, 20)])
      .toEqual([{ before: A }, { before: null }, { before: null }, null]);
    // 2px/초 — A 는 10px: 반폭 2.5px
    expect([boundaryAt(layout, 12, 2), boundaryAt(layout, 7, 2), boundaryAt(layout, 5, 2), boundaryAt(layout, 29, 2)])
      .toEqual([{ before: B }, null, null, { before: null }]);
  });

  it("dropTargetAt — 경계 띠 · 같은 폴더의 자리 몸통(자기 자리 포함) = 그 자리 · 다른 폴더 몸통·맨 뒤 밖 = 가장 가까운 경계(같은 거리면 앞)", () => {
    const doc: EditDoc = doc3([clip(A, "a"), clip(B, "b"), clip(A2, "r"), clip(C, "c")], { cutOrder: [A, B, A2, C] });
    const layout = buildLayout([A, B, A2, C], doc); // 20px/초 — A 0~100 · B 100~200 · A② 200~300 · C 300~400
    const edge = (before: string | null) => ({ kind: "edge", before });
    const slot = (path: string) => ({ kind: "slot", path });
    expect([dropTargetAt(layout, 50, 20, A), dropTargetAt(layout, 95, 20, A), dropTargetAt(layout, 250, 20, A)])
      .toEqual([slot(A), edge(B), slot(A2)]); // 자기 칸 · 띠 · 같은 폴더의 다른 자리(원래 자리에 다시 쌓기)
    expect([dropTargetAt(layout, 150, 20, A), dropTargetAt(layout, 151, 20, A), dropTargetAt(layout, 999, 20, A)])
      .toEqual([edge(B), edge(A2), edge(null)]); // 다른 폴더의 가운데(같은 거리 — 앞) · 넘으면 뒤 · 맨 뒤 밖
    expect([dropTargetAt(layout, 50, 20, A2), dropTargetAt(layout, 150, 20, B), dropTargetAt(layout, 350, 20, B), dropTargetAt(layout, 360, 20, B)])
      .toEqual([slot(A), slot(B), edge(C), edge(null)]); // C 의 가운데는 같은 거리 — 앞
    expect(dropTargetAt(buildLayout([], emptyEditDoc()), 10, 20, A)).toBeNull();
  });

  it("slotStays — 전체 순서(숨긴 자리 포함)로 제자리를 본다", () => {
    const all = [A, A2, B, C];
    expect([slotStays(all, A2, B), slotStays(all, A2, A2), slotStays(all, A2, C), slotStays([A, B], A2, B), slotStays(all, C, null)])
      .toEqual([true, true, false, false, true]);
  });
});

describe("slot-playhead — 사라진 자리 뒤의 재생헤드", () => {
  const layoutOf = (paths: string[]) => buildLayout(paths, { ...emptyEditDoc(), clips: paths.map((path, i) => clip(path, `g${i}`)) });
  it("직전 순서(previous)에서 그 뒤의 첫 보이는 자리 · 숨긴 자리는 지금 순서 · 다음이 없으면 전체 끝 · previous 가 없으면 전 규칙", () => {
    const D = `${S}/C0200`;
    const E = `${S}/C0300`;
    // 같은 창의 마지막 클립 빼기
    expect(settlePos(layoutOf([A, B, C]), { cut: A2, local: 1 }, [A, B, C], undefined, [A, B, A2, C]).pos).toEqual({ cut: C, local: 0 });
    // 다른 창이 삭제 뒤 순서 정리(E 를 D 앞으로)까지 한 최종 문서만 받았다
    expect(settlePos(layoutOf([A, B, C, E, D]), { cut: A2, local: 1 }, [A, B, C, E, D], [A, B, C, E, D], [A, B, A2, C, D, E]).pos)
      .toEqual({ cut: C, local: 0 });
    // 순서를 A A② B C 로 바꾸고 A② 를 숨긴 문서 — 지금 순서의 다음(B)
    expect(settlePos(layoutOf([A, B, C]), { cut: A2, local: 1 }, [A, A2, B, C], [A, A2, B, C], [A, B, A2, C]).pos).toEqual({ cut: B, local: 0 });
    // 마지막 자리 만들기를 되돌림 — 다음이 없으면 전체 끝
    const last = layoutOf([A, B]);
    expect(settlePos(last, { cut: A2, local: 1 }, [A, B], undefined, [A, B, A2]).pos).toEqual({ cut: B, local: last.cuts[1].len });
    // 기억한 순서가 없으면(시퀀스를 막 바꿈) 전 규칙 — 이름순 보정으로 A 뒤
    expect(settlePos(layoutOf([A, B, C]), { cut: A2, local: 1 }, [A, B, C]).pos).toEqual({ cut: B, local: 0 });
  });
});

// ⑤ 후속(Jay 2026-10-26): "다른 트랙에 생기게 했던 클립을 다시 원래 클립으로 … 클립위에 쌓을수 있어야한다" · "비어있는 부분을 없앨수도 없네".
//  계약: docs/status/편집탭_끼워넣기_원래자리_2026-10-26.md (move-into-slot · drop-target · hide-empty-first)
describe("⑤ 후속 — 빈 첫 자리 숨기기", () => {
  it("첫 자리가 비고 그 폴더에 살아 있는 반복 자리가 있으면 자리 목록에서 빠진다 — 번호는 보이는 자리로 · 반복 자리가 다 없어지면 돌아온다", () => {
    const A3 = `${A}//def456`;
    const doc = doc3([clip(A2, "r"), clip(A3, "s", 2), clip(B, "b")], {
      cutOrder: [A2, A3, B, A], cutsOff: [A], markers: [{ cut: A, local: 1 }], // 첫 자리의 D·북마크 기록은 그대로 남는다
    });
    const all = order(doc);
    expect(all).toEqual([A2, A3, B, C]);
    expect(all.map((key) => slotLabels(all).get(key))).toEqual(["C0050 ①", "C0050 ②", "C0080", "C0110"]);
    expect([doc.cutsOff, doc.markers]).toEqual([[A], [{ cut: A, local: 1 }]]);
    // 꺼 둔 반복 클립도 살아 있다(클립이 있다) — 숨김은 그대로
    expect(order({ ...doc, clips: doc.clips.map((item) => ({ ...item, off: true })) })).toEqual([A2, A3, B, C]);
    // 반복 자리를 다 빼면 첫 자리가 순서 기록의 자리로 돌아온다(빈 '비어 있음' — 기록 [A②, A③, B, A] 의 B 뒤. 기록에 없는 C 는 이름순으로 B 바로 뒤)
    const back = removeClips(doc, [clipKey(clip(A2, "r")), clipKey(clip(A3, "s", 2))])!;
    expect(order(back)).toEqual([B, C, A]);
    // 숨은 동안 이름순으로 되돌린 뒤 지워도 돌아온다(이름순 자리)
    const reset = resetCutOrder(doc)!;
    expect(order(removeClips(reset, [clipKey(clip(A2, "r")), clipKey(clip(A3, "s", 2))])!)).toEqual([A, B, C]);
    // 첫 자리에 클립이 있으면 숨지 않는다
    expect(order({ ...doc, clips: [...doc.clips, clip(A, "a")] })).toEqual([A2, A3, B, C, A]);
  });

  it("slotOfFolder — 배치의 폴더 열쇠, 없으면 그 폴더의 첫 보이는 자리, 없으면 null", () => {
    const doc = doc3([clip(A2, "r"), clip(B, "b")], { cutOrder: [B, A2] });
    const layout = buildLayout(order(doc), doc);
    expect([slotOfFolder(layout, A), slotOfFolder(layout, B), slotOfFolder(layout, `${S}/C9999`)]).toEqual([A2, B, null]);
  });

  it("첫 자리가 숨은 동안에도 그 폴더 카드로 새 자리를 끼워 넣는다 · 보관 파일 왕복", () => {
    const doc = doc3([clip(A2, "r"), clip(B, "b")]);
    const all = order(doc);
    expect(all).not.toContain(A);
    const next = insertSlot(doc, all, card(A, "n"), null, 1, "zz9")!;
    expect(order(next)).toEqual([A2, B, C, `${A}//zz9`]);
    const target = { projectId: "p1", seq: S };
    const archived = parseEditArchive(JSON.stringify(createEditArchive(next, target, true)), target);
    expect(archived.ok && order(archived.doc)).toEqual(order(next));
  });
});

describe("⑤ 후속 — moveClipIntoSlot(같은 폴더의 다른 자리로 옮기기·쌓기)", () => {
  const rich = (cut: string, gen: string, track: number) => clip(cut, gen, track, { head: 1, trim: 2, speed: 0.5, off: true, dur: 9, durExact: true, job: "j" });
  it("반복 자리 → 첫 자리의 빈 트랙 = 쌓기(slot 칸 없음 · 속도·자르기 보존) · 떠난 반복 자리는 사라지고 재생헤드는 그 다음", () => {
    const base = doc3([clip(A, "a", 1), rich(A2, "r", 2), clip(B, "b")], { cutOrder: [A, B, A2, C] });
    const next = moveClipIntoSlot(base, clipKey(rich(A2, "r", 2)), A, 2)!;
    const moved = next.clips.find((item) => item.gen === "r")!;
    expect(moved).toEqual({ ...rich(A, "r", 2) });
    expect("slot" in moved).toBe(false);
    expect(parseEditDoc(JSON.parse(JSON.stringify(next)))).toEqual(next);
    expect(order(next)).toEqual([A, B, C]);
    const layout = buildLayout(order(next), next);
    expect(settlePos(layout, { cut: A2, local: 1 }, order(next), next.cutOrder, [A, B, A2, C]).pos).toEqual({ cut: C, local: 0 });
  });

  it("첫 자리 → 반복 자리 · 반복 ↔ 반복 · 같은 트랙 번호여도 옮김 · 찬 칸이면 맞바꿈(상대가 첫 자리로 가면 slot 없음)", () => {
    const A3 = `${A}//def456`;
    const base = doc3([clip(A, "a", 1), clip(A2, "r", 1), clip(A3, "s", 1)]);
    const toRepeat = moveClipIntoSlot(base, clipKey(clip(A, "a")), A2, 2)!;
    expect(toRepeat.clips.find((item) => item.gen === "a")).toEqual(clip(A2, "a", 2));
    const swap = moveClipIntoSlot(base, clipKey(clip(A3, "s")), A, 1)!; // 같은 트랙 번호 · 찬 칸 → 맞바꿈
    expect(swap.clips.map((item) => [slotOf(item), item.gen, item.track]))
      .toEqual([[A3, "a", 1], [A2, "r", 1], [A, "s", 1]]);
    expect("slot" in swap.clips.find((item) => item.gen === "s")!).toBe(false);
    expect(parseEditDoc(JSON.parse(JSON.stringify(swap)))).toEqual(swap);
    const between = moveClipIntoSlot(base, clipKey(clip(A2, "r")), A3, 3)!;
    expect(between.clips.find((item) => item.gen === "r")).toEqual(clip(A3, "r", 3));
  });

  it("거부(null) — 같은 생성물(도착 칸의 상대가 그것이어도, 자르기·속도가 달라도) · 맞바꿀 상대의 생성물이 떠난 자리에 있음 · 잠금 · 자기 자리 · 다른 폴더 · 사라진 자리 · 트랙 숫자", () => {
    const base = doc3([clip(A, "g", 1), rich(A2, "g", 2), clip(A2, "x", 1), clip(B, "b")]);
    expect(moveClipIntoSlot(base, clipKey(clip(A, "g")), A2, 2)).toBeNull(); // 도착 칸의 상대가 같은 생성물(속도·자르기 다름)
    expect(moveClipIntoSlot(base, clipKey(clip(A, "g")), A2, 3)).toBeNull(); // 도착 자리에 같은 생성물
    const partner = doc3([clip(A, "a", 1), clip(A, "x", 2), clip(A2, "x", 1)]);
    expect(moveClipIntoSlot(partner, clipKey(clip(A, "a")), A2, 1)).toBeNull(); // 맞바꿀 x 가 떠난 자리(A)에 이미 있음
    const plain = doc3([clip(A, "a", 1), clip(A2, "r", 1), clip(B, "b")]);
    const key = clipKey(clip(A, "a"));
    for (const [target, track, more] of [
      [A2, 2, { tracksLocked: [1] }], [A2, 2, { tracksLocked: [2] }], [A, 2, {}], [B, 2, {}], [`${A}//gone99`, 2, {}],
      [A2, 0, {}], [A2, 1.5, {}], [A2, Number.MAX_SAFE_INTEGER + 1, {}],
    ] as const) {
      expect(moveClipIntoSlot({ ...plain, ...more }, key, target, track)).toBeNull();
    }
    expect(moveClipIntoSlot(plain, "없는 열쇠", A2, 2)).toBeNull();
  });

  it("Resolve 계획 — 빈 첫 자리가 빠지면 뒤의 시작 프레임이 당겨진다(계획 형식 그대로)", () => {
    const doc = doc3([clip(A2, "r"), clip(B, "b")], { cutOrder: [A, A2, B] });
    const layout = buildLayout(order(doc), doc); // A(빈 첫 자리 5초)가 빠져 A② 가 0초에서
    expect(layout.cuts.map((slot) => [slot.path, slot.start])).toEqual([[A2, 0], [B, 5], [C, 10]]);
  });
});
