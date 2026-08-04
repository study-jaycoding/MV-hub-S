// buildSpotlightCreateBody 특성화 — 생성 요청 body 의 마지막 관문(크레딧 낭비 직결).
import { describe, it, expect } from "vitest";
import {
  buildSpotlightCreateBody,
  normalizeSpotlightBatch,
} from "../src/lib/spotlightSubmit";
import type { ChipRef } from "../src/lib/promptEditor";

const img = (over: Partial<ChipRef> = {}): ChipRef => ({
  file_path: "asset:p|a.png",
  type: "image",
  role: "@Image",
  name: "소스",
  thumb: "",
  ...over,
});

const base = {
  parts: [],
  displayPrompt: "",
  optionValues: {},
  armedAutoTags: [],
};

describe("buildSpotlightCreateBody — 없는 레퍼런스 토큰 차단", () => {
  it("트레이에 이미지 1개인데 @image2 를 쓰면 에러(크레딧 낭비 방지)", () => {
    const { body, error } = buildSpotlightCreateBody({
      ...base,
      text: "@image2 스타일",
      inlineRefs: [],
      trayRefs: [img()],
      model: "nano_banana",
    });
    expect(body).toBeNull();
    expect(error).toContain("2번");
  });
  it("있는 번호(@image1)면 통과", () => {
    const { body, error } = buildSpotlightCreateBody({
      ...base,
      text: "@image1 스타일",
      inlineRefs: [],
      trayRefs: [img()],
      model: "nano_banana",
    });
    expect(error).toBeNull();
    expect(body).not.toBeNull();
  });
});

describe("buildSpotlightCreateBody — 역할 번호 부여", () => {
  it("트레이 이미지들은 @Image1,@Image2 로 순번(타입별)", () => {
    const { body } = buildSpotlightCreateBody({
      ...base,
      text: "합성",
      inlineRefs: [],
      trayRefs: [img(), img({ type: "video" }), img()],
      model: "nano_banana",
    });
    const roles = body!.references!.map((r) => r.role);
    expect(roles).toEqual(["@Image1", "@Video1", "@Image2"]);
  });
});

describe("buildSpotlightCreateBody — CLI 프롬프트 한 줄 강제", () => {
  it("줄바꿈은 공백으로 합쳐진다(레퍼런스 부착 깨짐 방지)", () => {
    const { body } = buildSpotlightCreateBody({
      ...base,
      text: "첫 줄\n둘째 줄",
      inlineRefs: [],
      trayRefs: [],
      model: "nano_banana",
    });
    expect(body!.prompt).toBe("첫 줄 둘째 줄");
  });
  it("빈 텍스트+레퍼런스만이면 (no text)", () => {
    const { body } = buildSpotlightCreateBody({
      ...base,
      text: "",
      inlineRefs: [],
      trayRefs: [img()],
      model: "nano_banana",
    });
    expect(body!.prompt).toBe("(no text)");
  });
});

describe("normalizeSpotlightBatch — 배치 요청 안전 범위", () => {
  it("노드 override는 정수화하고 1~4 범위로 제한한다", () => {
    expect(normalizeSpotlightBatch(0, 2, 4)).toBe(1);
    expect(normalizeSpotlightBatch(2.9, 1, 4)).toBe(2);
    expect(normalizeSpotlightBatch(9999, 1, 4)).toBe(4);
  });

  it("유효하지 않은 override는 UI 값을 쓰고, UI 값도 비정상이면 1로 복구한다", () => {
    expect(normalizeSpotlightBatch(Number.NaN, 3, 4)).toBe(3);
    expect(normalizeSpotlightBatch(Number.POSITIVE_INFINITY, 2, 4)).toBe(2);
    expect(normalizeSpotlightBatch(undefined, Number.NaN, 4)).toBe(1);
  });
});
