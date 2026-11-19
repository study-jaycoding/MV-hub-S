// @vitest-environment jsdom
// 이미지 레퍼런스 최소 변 검사(Kling 300px·Wan 240px) — 원본 크기만 쓰고, 못 재면 막지 않는다(Codex 검토: 썸네일로 판정 금지).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureImageSize } from "../src/lib/aspectAuto";
import { referenceImageSizeError } from "../src/lib/spotlightSubmit";

// jsdom 은 이미지를 안 불러온다 — URL 로 크기를 정해 두고 Image 를 흉내 낸다. 'broken' 은 로드 실패, 'hang' 은 응답 없음.
const SIZES: Record<string, [number, number]> = { "https://x/ok300.png": [300, 300], "https://x/small299.png": [299, 600], "https://x/ok240.png": [240, 400] };
class FakeImage {
  naturalWidth = 0; naturalHeight = 0; onload: (() => void) | null = null; onerror: (() => void) | null = null;
  set src(url: string) {
    queueMicrotask(() => {
      if (url.includes("hang")) return;
      const size = SIZES[url];
      if (!size) { this.onerror?.(); return; }
      [this.naturalWidth, this.naturalHeight] = size;
      this.onload?.();
    });
  }
}
const ref = (file_path: string, type = "image", name = "그림") => ({ file_path, type, name });

beforeEach(() => { vi.stubGlobal("Image", FakeImage); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("measureImageSize", () => {
  it("원본 크기를 돌려주고, 실패하거나 시간 초과면 null", async () => {
    expect(await measureImageSize("https://x/ok300.png")).toEqual({ width: 300, height: 300 });
    expect(await measureImageSize("https://x/missing.png")).toBeNull();
    expect(await measureImageSize("")).toBeNull();
    const hang = measureImageSize("https://x/hang.png");
    await vi.advanceTimersByTimeAsync(4001);
    expect(await hang).toBeNull();
  });
});

describe("referenceImageSizeError", () => {
  it("Kling 은 한 변이 300 미만이면 이유를, 300 이상이면 null", async () => {
    expect(await referenceImageSizeError("kling4_0", [ref("https://x/ok300.png")])).toBeNull();
    const message = await referenceImageSizeError("kling_4_0_flash", [ref("https://x/small299.png", "image", "작은그림")]);
    expect(message).toContain("300px");
    expect(message).toContain("작은그림");
    expect(message).toContain("299×600");
  });
  it("Wan 은 240 기준 — 240 은 통과", async () => {
    expect(await referenceImageSizeError("wan3_0", [ref("https://x/ok240.png")])).toBeNull();
    expect(await referenceImageSizeError("wan3_0_prime", [ref("https://x/small299.png")])).toBeNull(); // 299×600 → 짧은 변 299 ≥ 240
    expect(await referenceImageSizeError("wan3_0", [ref("https://x/ok240.png"), ref("https://x/ok300.png")])).toBeNull();
  });
  it("한도 표에 없는 모델·이미지가 아닌 참조·크기를 못 재는 이미지는 막지 않는다", async () => {
    expect(await referenceImageSizeError("minimax_h3_max", [ref("https://x/small299.png")])).toBeNull();
    expect(await referenceImageSizeError("kling4_0", [ref("https://x/small299.png", "video")])).toBeNull();
    expect(await referenceImageSizeError("kling4_0", [ref("https://x/missing.png")])).toBeNull(); // 로드 실패 = 판별 불가 = 통과
    expect(await referenceImageSizeError("kling4_0", [])).toBeNull();
  });
});
