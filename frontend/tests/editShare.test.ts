// 편집 공유의 순수 계산(lib/editShare) — 스냅샷(보이는 것 한 줄)·검사·'ASCII 로 감싼 길이'·받은 것을 배치로·빈 꼬리 자리.
//  설계 = docs/status/편집탭_편집공유_설계_2026-10-23.md · 서버의 같은 검사 = backend/app/repo/edit_shares.py.
import { describe, expect, it, vi } from "vitest";
import {
  asciiJsonLength, parseShareSnapshot, SHARE_MAX, sha256Hex, sha256Js, shareLayout, shareSnapshot, TAIL_KEY, withTail, type ShareSnapshot,
} from "../src/lib/editShare";
import { buildLayout, clipKey, emptyEditDoc, mediaAt, posAt, visibleClip, type EditClip, type EditDoc } from "../src/lib/editTimeline";

const doc = (clips: EditClip[], extra: Partial<EditDoc> = {}): EditDoc => ({ ...emptyEditDoc(), v: 3, clips, ...extra });
// 그 사람의 화면: c1 = V1 영상 4초(head 1·speed 1.3) 위 V2 영상 1.5초 · c2 = 그림 5초 · c1 ② = c1 을 한 번 더(같은 영상, speed 0.25) · c3 = 빈 컷
const SHARER = doc([
  { cut: "e035/c1", gen: "a", track: 1, kind: "video", dur: 10, head: 1, trim: 5.2, speed: 1.3 },
  { cut: "e035/c1", gen: "b", job: "job-b", track: 2, kind: "video", dur: 1.5 },
  { cut: "e035/c2", gen: "pic", track: 1, kind: "image", dur: 5 },
  { cut: "e035/c1", slot: "r1", gen: "a", track: 1, kind: "video", dur: 10, trim: 1, speed: 0.25 },
]);
const CUTS = ["e035/c1", "e035/c2", "e035/c1//r1", "e035/c3"];
const LABELS = new Map([["e035/c1", "c1 ①"], ["e035/c1//r1", "c1 ②"]]);
const mine = buildLayout(CUTS, SHARER, undefined, LABELS);

describe("스냅샷 — 보이는 것 한 줄", () => {
  const snap = shareSnapshot(mine, SHARER)!;
  it("컷 순서·이름·폴더·길이 · 조각 = 그 순간 맨 위에 보이는 것 · 빈 컷은 gap", () => {
    expect(snap.total).toBeCloseTo(mine.total, 9);
    expect(snap.cuts.map((cut) => [cut.name, cut.folder])).toEqual([["c1 ①", "e035/c1"], ["c2", "e035/c2"], ["c1 ②", "e035/c1"], ["c3", "e035/c3"]]);
    expect(snap.cuts[0].parts.map((part) => ("gap" in part ? "gap" : part.gen))).toEqual(["b", "a"]); // V2 1.5초 → 그 뒤 V1
    expect(snap.cuts[0].parts[0]).toMatchObject({ gen: "b", job: "job-b", kind: "video", head: 0 });
    expect(snap.cuts[0].parts[1]).toMatchObject({ gen: "a", speed: 1.3 });
    expect(snap.cuts[1].parts[0]).toMatchObject({ gen: "pic", kind: "image", head: 0 });
    expect(snap.cuts[3].parts).toEqual([{ len: 5, gap: true }]);
    expect(shareSnapshot(buildLayout([], SHARER), SHARER)).toBeNull();
  });
  it("받아서 펼친 배치의 원본 시각 = 그 사람 배치의 원본 시각 — 조각 경계 직전·정확히 경계·속도 0.25·1.3", () => {
    const got = shareLayout(parseShareSnapshot(JSON.stringify(snap))!);
    expect(got.layout.total).toBeCloseTo(mine.total, 9);
    const at = (time: number) => {
      const theirs = posAt(mine, time)!;
      const slot = mine.cuts.find((item) => item.path === theirs.cut)!;
      const clip = visibleClip(SHARER, slot, theirs.local);
      const ours = posAt(got.layout, time)!;
      const piece = got.layout.cuts.find((item) => item.path === ours.cut)!.clips[0];
      return [clip ? mediaAt(clip, theirs.local) : null, piece && ours.local < piece.len ? mediaAt(piece, ours.local) : null];
    };
    const c1 = mine.cuts[0];
    const c1b = mine.cuts[2];
    for (const time of [0, 1.5 - 1 / 48, 1.5, 1.5 + 1 / 24, c1.len - 1 / 48, c1.start + c1.len + 1, c1b.start, c1b.start + c1b.len / 2]) {
      const [want, have] = at(time);
      expect(have).not.toBeNull();
      expect(have!).toBeCloseTo(want!, 9);
    }
  });
  it("자리 열쇠는 조각마다 고유하다 — 같은 폴더가 두 번, 같은 영상이 두 조각이어도. 실제 폴더·gen 은 따로 든다", () => {
    const got = shareLayout(snap);
    const keys = got.layout.cuts.map((slot) => slot.path);
    expect(new Set(keys).size).toBe(keys.length);
    const pieces = got.layout.cuts.flatMap((slot) => slot.clips);
    const sameGen = pieces.filter((clip) => clip.gen === "a");
    expect(sameGen.length).toBe(2);
    expect(clipKey(sameGen[0])).not.toBe(clipKey(sameGen[1])); // 알려진 한계 [C2-H]: 열쇠가 달라 경계에서 영상을 다시 싣는다(끊길 수 있다)
    expect([...got.parts.values()].filter((part) => part.gen === "a").map((part) => part.folder)).toEqual(["e035/c1", "e035/c1"]);
    expect(got.boxes.map((box) => [box.name, box.keys.length])).toEqual([["c1 ①", 2], ["c2", 1], ["c1 ②", 1], ["c3", 1]]);
  });
});

describe("검사·크기 — 서버와 같다", () => {
  const ok: ShareSnapshot = { v: 1, total: 5, cuts: [{ name: "C1", folder: "e/C1", len: 5, parts: [{ len: 2, gen: "g", kind: "video", head: 1, speed: 1.5 }, { len: 3, gap: true }] }] };
  it.each([
    ["판", { ...ok, v: 2 }], ["끝 없음", { ...ok, total: Infinity }], ["합 불일치", { ...ok, total: 6 }], ["빈 컷 목록", { ...ok, cuts: [] }],
    ["속도", { ...ok, cuts: [{ ...ok.cuts[0], parts: [{ len: 5, gen: "g", kind: "video", head: 0, speed: 5 }] }] }],
    ["음수 head", { ...ok, cuts: [{ ...ok.cuts[0], parts: [{ len: 5, gen: "g", kind: "video", head: -1 }] }] }],
    ["종류", { ...ok, cuts: [{ ...ok.cuts[0], parts: [{ len: 5, gen: "g", kind: "audio", head: 0 }] }] }],
    ["이름 길이", { ...ok, cuts: [{ ...ok.cuts[0], name: "x".repeat(201) }] }],
  ])("%s 이 틀리면 읽지 않는다", (_name, bad) => {
    expect(parseShareSnapshot(JSON.stringify(bad))).toBeNull();
  });
  it("서버(Python)와 같은 단위·같은 판정 — 이름은 코드 포인트로 세고, v 는 숫자 1 만, gap: false 는 영상 조각", () => {
    const named = (name: string) => JSON.stringify({ ...ok, cuts: [{ ...ok.cuts[0], name }] });
    expect(parseShareSnapshot(named("😀".repeat(200)))).not.toBeNull(); // UTF-16 으로는 400 이지만 Python len 은 200
    expect(parseShareSnapshot(named("😀".repeat(201)))).toBeNull();
    expect(parseShareSnapshot(JSON.stringify({ ...ok, v: true }))).toBeNull();
    const media = { v: 1, total: 2, cuts: [{ name: "C1", folder: "e/C1", len: 2, parts: [{ len: 2, gap: false, gen: "g", kind: "video", head: 1 }] }] };
    const got = shareLayout(parseShareSnapshot(JSON.stringify(media))!);
    expect(got.layout.cuts[0].clips.map((clip) => clip.gen)).toEqual(["g"]);
    expect(got.parts.get("0:0")).toEqual({ folder: "e/C1", gen: "g" });
  });
  it("맞으면 읽고, JSON 이 아니면 null", () => {
    expect(parseShareSnapshot(JSON.stringify(ok))).toEqual(ok);
    expect(parseShareSnapshot("not json")).toBeNull();
  });
  it("'ASCII 로 감싼 길이' = Python len(json.dumps(x)) — 코드 포인트로 센다", () => {
    // Python: len(json.dumps(s)) — 'a' 3 · '"' 4 · '\\n' 4 · '\\x01' 8 · '\\x7f' 8 · '가' 8 · '😀' 14
    expect(["a", "\"", "\n", "\u0001", "\u007f", "가", "😀", ""].map(asciiJsonLength)).toEqual([3, 4, 4, 8, 8, 8, 14, 2]);
    const pad = "x".repeat(SHARE_MAX - asciiJsonLength(JSON.stringify({ ...ok, pad: "" })));
    const fits = JSON.stringify({ ...ok, pad });
    expect(asciiJsonLength(fits)).toBe(SHARE_MAX);
    expect(parseShareSnapshot(fits)).not.toBeNull();
    expect(parseShareSnapshot(JSON.stringify({ ...ok, pad: pad + "x" }))).toBeNull();
    expect(parseShareSnapshot(JSON.stringify({ ...ok, pad: pad.slice(6) + "가" + "x" }))).toBeNull(); // 한글 1자 = 6
  });
  it("보낸 글자의 SHA-256(UTF-8) — 서버 data_hash 와 같은 값", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); // 표준 시험 값
  });
  it("보안 문맥이 아니어도(http LAN — crypto.subtle 없음) 같은 SHA-256 — 표준 값 · 블록 경계 · 한글·보조 평면 · 큰 글자", async () => {
    const vectors: [string, string][] = [
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
    ];
    const encode = (text: string) => new TextEncoder().encode(text);
    for (const [text, want] of vectors) expect(sha256Js(encode(text))).toBe(want);
    const samples = [55, 56, 63, 64, 65, 119, 120, 1000].map((n) => "가😀a\"\\".repeat(n).slice(0, n)).concat(["x".repeat(300 * 1024)]);
    for (const text of samples) expect(sha256Js(encode(text))).toBe(await sha256Hex(text)); // 브라우저 crypto.subtle 과 같은 값
    // 블록 경계는 '바이트' 길이로 — 위 표본은 글자 수로 잘라 UTF-8 바이트가 그 길이가 아니다(Codex 독립 리뷰 5차 P2). ASCII 한 글자 = 1바이트, 비교값은 crypto.subtle 에서 바로
    for (const n of [55, 56, 63, 64, 65, 119, 120]) {
      const bytes = encode("a".repeat(n));
      expect(bytes.length).toBe(n);
      const want = [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      expect([n, sha256Js(bytes)]).toEqual([n, want]);
    }
    vi.stubGlobal("crypto", {});
    try {
      expect(await sha256Hex("abc")).toBe(vectors[1][1]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("빈 꼬리 자리 — 재생용 배치", () => {
  it("V0 이 더 길면 클립 없는 꼬리(실제 자리 열쇠와 안 겹침)를 붙이고, 짧거나 같으면 그대로 · 내 편집이 비면 꼬리만", () => {
    const long = withTail(mine, mine.total + 7);
    expect(long.cuts.at(-1)).toMatchObject({ path: TAIL_KEY, start: mine.total, clips: [] });
    expect(long.cuts.at(-1)!.len).toBeCloseTo(7, 9);
    expect(long.total).toBeCloseTo(mine.total + 7, 9);
    expect(long.cuts.slice(0, -1)).toEqual(mine.cuts);
    expect(withTail(mine, mine.total)).toBe(mine);
    expect(withTail(mine, 1)).toBe(mine);
    expect(withTail(buildLayout([], SHARER), 3).cuts).toEqual([{ path: TAIL_KEY, name: "", start: 0, len: 3, clips: [] }]);
    expect(TAIL_KEY.startsWith("//")).toBe(true); // 폴더 부분이 비어 validSlotKey 가 거부하는 꼴
  });
});
