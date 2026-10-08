// 컷 정보의 집계와 모아보기 재생기의 계산 — 순수 함수.
import { describe, expect, it } from "vitest";
import type { FolderCard, Generation } from "../src/types";
import { durationSec, inFolder, summarizeCut, workerLabel } from "../src/lib/cutSummary";
import { fmtReelTime, reelClips, reelLocate, reelStarts, REEL_IMAGE_SEC } from "../src/lib/cutReel";

const gen = (id: string, extra: Partial<Generation> = {}): Generation => ({
  id, folder_path: "e035/C0290", created_at: "2026-10-03 10:00:00", model: "seedance-2.5", params: { duration: "5" },
  assets: [{ type: "video", file_path: `/m/${id}.mp4`, thumbnail_path: null }], creator_name: "리버", is_mine: false,
  ...extra,
} as unknown as Generation);

describe("컷 정보 집계", () => {
  it("작업자·크레딧·생성일·길이·모델·검토를 센다 — 모르는 크레딧은 미상으로", () => {
    const gens = [
      gen("a"), // 리버 · 5초 · 실제 1.5
      gen("b", { created_at: "2026-10-02 23:56:00", creator_name: null, is_mine: true, is_held: true }), // 나 · 보류 · 크레딧 미상
      gen("c", { created_at: "2026-10-07 18:15:00", creator_name: "오지짱", model: "kling", params: { duration: 7 }, is_final: true }),
      gen("d", { assets: [{ type: "image", file_path: "/m/d.png", thumbnail_path: null }], params: {}, model: null }), // 이미지 · 길이 없음
    ];
    const metrics = new Map([["a", { real_credits: 1.5 }], ["b", null], ["c", { real_credits: 2.1 }], ["d", { real_credits: null }]]);
    const s = summarizeCut(gens, metrics);
    expect([s.total, s.videos, s.images]).toEqual([4, 3, 1]);
    expect(s.workers).toEqual([{ name: "리버", count: 2 }, { name: "나", count: 1 }, { name: "오지짱", count: 1 }]);
    expect(s.credits).toEqual({ real: 3.6, known: 2, unknown: 2 });
    expect([s.first, s.last]).toEqual(["2026-10-02 23:56:00", "2026-10-07 18:15:00"]);
    expect(s.seconds).toBe(17); // 5 + 5 + 7 — 이미지(d)는 길이가 없다
    expect(s.models).toEqual(["seedance-2.5", "kling"]);
    expect(s.review).toEqual({ final: 1, held: 1, shared: 2 });
  });

  it("빈 목록·길이 읽기·작업자 이름", () => {
    const s = summarizeCut([], new Map());
    expect([s.total, s.first, s.last, s.seconds, s.workers]).toEqual([0, null, null, 0, []]);
    expect(durationSec(gen("x", { params: { duration: "4.5" } }))).toBe(4.5);
    expect(durationSec(gen("x", { params: { duration: "abc" } }))).toBe(0);
    expect(durationSec(gen("x", { params: null }))).toBe(0);
    expect(workerLabel(gen("x", { creator_name: null, is_mine: false }))).toBe("팀원");
  });

  it("그 폴더(와 하위)만 — 대소문자가 다른 폴더는 뺀다(서버 LIKE 가 섞어 준다)", () => {
    const gens = [
      gen("in"), gen("sub", { folder_path: "e035/C0290/takeB" }),
      gen("case", { folder_path: "E035/C0290" }), gen("sibling", { folder_path: "e035/C02900" }),
    ];
    expect(inFolder(gens, "e035/C0290").map((g) => g.id)).toEqual(["in", "sub"]);
  });
});

describe("모아보기 재생기 계산", () => {
  it("시작 시각·위치 찾기·타임코드", () => {
    expect(reelStarts([3, 5, 5])).toEqual([0, 3, 8]);
    expect(reelLocate([3, 5, 5], 4.2)).toEqual({ index: 1, offset: expect.closeTo(1.2, 6) });
    expect(reelLocate([3, 5, 5], 0)).toEqual({ index: 0, offset: 0 });
    expect(reelLocate([3, 5, 5], 3)).toEqual({ index: 1, offset: 0 }); // 경계는 다음 클립의 시작
    expect(reelLocate([3, 5, 5], 99)).toEqual({ index: 2, offset: 5 }); // 끝을 넘으면 마지막의 끝
    expect(reelLocate([], 1)).toEqual({ index: 0, offset: 0 });
    expect([fmtReelTime(4.2), fmtReelTime(29), fmtReelTime(65.04), fmtReelTime(-1), fmtReelTime(NaN)])
      .toEqual(["0:04.2", "0:29.0", "1:05.0", "0:00.0", "0:00.0"]);
  });

  it("컷 카드 → 클립: 파일 없는 표지는 뺀다·이미지는 3초", () => {
    const card = (name: string, type: "image" | "video", rep = false, file = `/m/${name}`): FolderCard => ({
      path: `e035/${name}`, name, count: 1, rep,
      cover: gen(name, { assets: file ? [{ type, file_path: file, thumbnail_path: null }] : [] }),
    });
    const clips = reelClips([card("C0050", "image"), card("C0080", "video", true), card("C0110", "video", false, "")]);
    expect(clips.map((c) => [c.name, c.type, c.rep, c.worker])).toEqual([["C0050", "image", false, "리버"], ["C0080", "video", true, "리버"]]);
    expect(REEL_IMAGE_SEC).toBe(3);
  });
});
