// 코멘트 그림 획 목록 v1 — 프런트 정규화·해시가 서버(backend/app/services/comment_strokes.py)와 같은 바이트인가.
//  기준값은 서버 코드로 뽑았다(같은 입력 → canonical·content_hash). 설계 docs/status/크게보기_코멘트그림_설계_2026-11-05.md §10 C4.
import { describe, expect, it, vi } from "vitest";
import { canonical, drawingHash, quantize, quantizeTime, sha256Plain, StrokesTooLarge, toStrokesV1, type DrawItem } from "../src/components/edit/drawing/strokes";

const ITEMS: DrawItem[] = [
  { kind: "pen", erase: false, color: "#ef4444", size: 7.25, points: [{ x: 10.04, y: 20.05 }, { x: 40.26, y: 30 }] },
  { kind: "shape", shape: "arrow", color: "#bef264", size: 12, from: { x: 0, y: 0 }, to: { x: 1919.96, y: 1080 } },
  { kind: "text", text: '조개 "작게" \\ 끝', color: "#ffffff", size: 40.05, at: { x: 1.5, y: 2.25 } },
];
// 서버 cs.canonical(cs.normalize_strokes(…, 1920, 1080)) 의 출력
const SERVER_CANONICAL =
  '{"items":[{"color":"#ef4444","erase":false,"kind":"pen","points":[{"x":10,"y":20.1},{"x":40.3,"y":30}],"size":7.3},' +
  '{"color":"#bef264","from":{"x":0,"y":0},"kind":"shape","shape":"arrow","size":12,"to":{"x":1920,"y":1080}},' +
  '{"at":{"x":1.5,"y":2.3},"color":"#ffffff","kind":"text","size":40.1,"text":"조개 \\"작게\\" \\\\ 끝"}],"v":1}';

describe("획 목록 v1", () => {
  it("0.5 는 올리고 정수는 정수로 — 파이썬 쪽과 같다", () => {
    expect(quantize(0.05)).toBe(0.1);
    expect(quantize(0.25)).toBe(0.3);
    expect(quantize(2)).toBe(2);
    expect(JSON.stringify(quantize(2.0))).toBe("2");
    expect(quantizeTime(1.5)).toBe(1.5);
  });

  it("정규화 결과가 서버와 같은 글자이고 해시도 같다", async () => {
    const doc = toStrokesV1(ITEMS, { w: 1920, h: 1080 }, 1920, 1080);
    expect(canonical(doc)).toBe(SERVER_CANONICAL);
    expect(await drawingHash({ strokes: doc, kind: "image", width: 1920, height: 1080, timeSec: null, idx: 0, thumb: null }))
      .toBe("8cd90c8ee38750dba9465d0c7881571492146f305480fc07d5d78a3e933de0e7");
    const thumb = new Uint8Array([0xff, 0xd8, 0x61, 0x62, 0x63]);
    expect(await drawingHash({ strokes: doc, kind: "video", width: 1920, height: 1080, timeSec: 1.2345, idx: 2, thumb }))
      .toBe("51ba400076cd10fe291ebc8066dcae9057e7a0dc1f3183ae310abeaed2557a86");
  });

  it("안전하지 않은 주소(crypto.subtle 없음)에서도 같은 해시 — 직접 계산한 SHA-256 이 표준값·subtle 과 같다", async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(sha256Plain(enc(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Plain(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const size of [55, 56, 63, 64, 65, 1000, 70000]) { // 덧붙임 경계(55·56·64)와 여러 덩이
      const data = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 0xff);
      const subtle = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
      expect(sha256Plain(data), `size ${size}`).toBe(Array.from(subtle, (b) => b.toString(16).padStart(2, "0")).join(""));
    }
    const doc = toStrokesV1(ITEMS, { w: 1920, h: 1080 }, 1920, 1080);
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) }); // subtle 이 없는 브라우저
    try {
      expect(await drawingHash({ strokes: doc, kind: "image", width: 1920, height: 1080, timeSec: null, idx: 0, thumb: null }))
        .toBe("8cd90c8ee38750dba9465d0c7881571492146f305480fc07d5d78a3e933de0e7");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("줄인 캔버스의 획을 원본 좌표계로 옮기고 범위 밖 점은 가장자리로", () => {
    const doc = toStrokesV1(
      [{ kind: "pen", erase: true, color: "#ffffff", size: 10, points: [{ x: -5, y: 50 }, { x: 120, y: 30.04 }] }],
      { w: 100, h: 50 }, 400, 200,
    );
    expect(doc.items[0]).toEqual({ kind: "pen", erase: true, color: "#ffffff", size: 40, points: [{ x: 0, y: 200 }, { x: 400, y: 120.2 }] });
  });

  it("굵기는 서버 상한(max(180, 긴 변/4))을 넘지 않게 내림한다", () => {
    const doc = toStrokesV1([{ kind: "shape", shape: "rect", color: "#ef4444", size: 120, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }],
      { w: 100, h: 100 }, 4937, 4937); // 긴 변/4 = 1234.25 — 120 × 49.37 = 5924.4 를 1234.2 로
    expect((doc.items[0] as { size: number }).size).toBe(1234.2);
  });

  it("빈 그림·너무 긴 획은 보내기 전에 막는다", () => {
    expect(() => toStrokesV1([], { w: 10, h: 10 }, 10, 10)).toThrow(StrokesTooLarge);
    const long = Array.from({ length: 5001 }, (_, i) => ({ x: i % 10, y: 1 }));
    expect(() => toStrokesV1([{ kind: "pen", erase: false, color: "#ef4444", size: 4, points: long }], { w: 10, h: 10 }, 10, 10))
      .toThrow(StrokesTooLarge);
  });
});
