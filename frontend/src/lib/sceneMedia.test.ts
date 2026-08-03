import { describe, it, expect, vi } from "vitest";

// refMediaSrc 의 asset: 토큰 경로만 api 에 의존 — URL 빌더를 결정적으로 목킹.
vi.mock("../api", () => ({
  api: { assetFileUrl: (proj: string, path: string) => `/A/${proj}/${path}` },
}));

import { refMediaSrc, refMediaType, mediaFileName } from "./sceneMedia";
import type { SceneRef } from "./scenes";

const ref = (p: string, type = "image"): SceneRef => ({ file_path: p, type });

describe("refMediaType", () => {
  it("video/audio 는 그대로, 그 외는 image 로 정규화", () => {
    expect(refMediaType(ref("x", "video"))).toBe("video");
    expect(refMediaType(ref("x", "audio"))).toBe("audio");
    expect(refMediaType(ref("x", "image"))).toBe("image");
    expect(refMediaType(ref("x", "weird"))).toBe("image");
  });
});

describe("mediaFileName", () => {
  it("URL 확장자를 뽑고 typeN 이름을 만든다", () => {
    expect(mediaFileName("https://c/x.PNG", "image", 1)).toBe("image1.png");
    expect(mediaFileName("a/b/c.webp?v=2", "image", 3)).toBe("image3.webp");
  });
  it("확장자 없으면 타입 기본값(png/mp4)", () => {
    expect(mediaFileName("noext", "image", 2)).toBe("image2.png");
    expect(mediaFileName("noext", "video", 1)).toBe("video1.mp4");
  });
});

describe("refMediaSrc", () => {
  it("asset:proj|path 토큰은 api 빌더 URL 로", () => {
    expect(refMediaSrc(ref("asset:proj|dir/x.png"))).toBe("/A/proj/dir/x.png");
  });
  it("원격 URL 등은 그대로", () => {
    expect(refMediaSrc(ref("https://cdn/x.png"))).toBe("https://cdn/x.png");
  });
  it("빈 경로·불완전 토큰은 undefined", () => {
    expect(refMediaSrc(ref(""))).toBeUndefined();
    expect(refMediaSrc(ref("asset:proj"))).toBeUndefined(); // path 없음
  });
});
