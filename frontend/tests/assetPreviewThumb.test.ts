// @vitest-environment jsdom
// 어셋 크게 보기의 자리 표시(2026-11-10 Jay "어셋에서 크게 보기를 할때 딜레이") — 원본이 오는 동안 셀이 이미 받은 썸네일을 깐다.
// 계약: 셀과 같은 폭·같은 버전의 썸네일 주소(캐시 히트) · 오디오는 없음 · 폭을 안 주면 종전 그대로(thumb 없음).
import { afterEach, expect, it } from "vitest";
import { assetCellThumbPx, assetPreviewTarget } from "../src/components/assets/assetsViewModel";
import { assetFileUrl, assetThumbUrl } from "../src/lib/assetUrls";
import type { AssetNode } from "../src/types";

const node = (path: string, type: AssetNode["type"], version?: string): AssetNode => ({ name: path.split("/").pop()!, path, type, version });
const files = [node("shots/a.png", "image", "v-a"), node("shots/b.mp4", "video", "v-b"), node("shots/c.wav", "audio"), node("shots/d.jpg", "image")];
const setDpr = (value: number) => Object.defineProperty(window, "devicePixelRatio", { configurable: true, value });
afterEach(() => setDpr(1));

it("셀 썸네일 폭 — 표시폭×DPR 이 256 이하면 256, 넘으면 512, Masonry 는 512 (AssetCell 과 같은 함수)", () => {
  setDpr(1);
  expect(assetCellThumbPx(1, false, false)).toBe(256); // 180
  expect(assetCellThumbPx(1.5, false, false)).toBe(512); // 270
  expect(assetCellThumbPx(1.2, true, false)).toBe(256); // 목록 240
  expect(assetCellThumbPx(1.3, true, false)).toBe(512); // 목록 260
  expect(assetCellThumbPx(0.5, false, true)).toBe(512); // Masonry
  setDpr(2);
  expect(assetCellThumbPx(1, false, false)).toBe(512); // 180 × 2
});

it("폭을 주면 그림·영상에 셀과 같은 썸네일 주소를 넣고 오디오는 넣지 않는다", () => {
  const target = assetPreviewTarget("P", files, files[0], 256)!;
  expect(target.url).toBe(assetFileUrl("P", "shots/a.png"));
  expect(target.thumb).toBe(assetThumbUrl("P", "shots/a.png", 256, "v-a"));
  expect(target.thumb).not.toBe(assetThumbUrl("P", "shots/a.png", 512, "v-a")); // 폭이 다르면 캐시를 못 탄다
  expect(target.items!.map((item) => item.thumb)).toEqual([
    assetThumbUrl("P", "shots/a.png", 256, "v-a"),
    assetThumbUrl("P", "shots/b.mp4", 256, "v-b"), // 영상은 표지(ffmpeg 첫 프레임)
    undefined, // 오디오
    assetThumbUrl("P", "shots/d.jpg", 256), // 버전이 없으면 셀과 같은 고정 버스터 주소
  ]);
  expect(target.index).toBe(0);
  const audio = assetPreviewTarget("P", files, files[2], 512)!;
  expect(audio.thumb).toBeUndefined();
  expect(audio.index).toBe(2);
});

it("폭을 안 주면 종전 그대로 — thumb 이 없다", () => {
  const target = assetPreviewTarget("P", files, files[1])!;
  expect("thumb" in target).toBe(false);
  expect(target.items!.some((item) => "thumb" in item)).toBe(false);
});
