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

describe("buildSpotlightCreateBody — Seedance 2.5 모드 계약", () => {
  const seedance = {
    ...base, model: "seedance_2_5", text: "장면 생성", inlineRefs: [], trayRefs: [],
  };
  const video = () => img({ type: "video", file_path: "asset:p|clip.mp4" });

  it.each([
    { trayRefs: [], inlineRefs: [], mode: "t2v" },
    { trayRefs: [img()], inlineRefs: [], mode: "omni_reference" },
    { trayRefs: [], inlineRefs: [img()], mode: "omni_reference" },
    { trayRefs: [img()], inlineRefs: [video()], mode: "omni_reference" },
  ])("토큰 없이 트레이+인라인 첨부로 모드 결정: $mode", ({ trayRefs, inlineRefs, mode }) => {
    for (const initialMode of ["t2v", "omni_reference"]) {
      const options = Object.freeze({ mode: initialMode, duration: 8 });
      const { body, error } = buildSpotlightCreateBody({ ...seedance, trayRefs, inlineRefs, optionValues: options });
      expect(error).toBeNull();
      expect(body?.params).toEqual({ mode, duration: 8 });
      expect(body?.references).toHaveLength(trayRefs.length + inlineRefs.length);
      expect(options).toEqual({ mode: initialMode, duration: 8 });
      expect(body?.params).not.toBe(options);
    }
  });

  it("빈 본문에 첨부만 있어도 omni로 전송한다", () => {
    const { body, error } = buildSpotlightCreateBody({ ...seedance, text: "", trayRefs: [img()], optionValues: { mode: "t2v" } });
    expect(error).toBeNull();
    expect(body?.prompt).toBe("(no text)");
    expect(body?.params?.mode).toBe("omni_reference");
  });

  it("인라인 영상 하나로도 edit 가능하고 무시되는 길이·비율은 전송한다", () => {
    const options = Object.freeze({ mode: "video_edit", duration: 12, aspect_ratio: "auto" });
    const { body, error } = buildSpotlightCreateBody({ ...seedance, trayRefs: [img()], inlineRefs: [video()], optionValues: options });
    expect(error).toBeNull();
    expect(body?.params).toEqual(options);
    expect(body?.references?.map((ref) => ref.role)).toEqual(["@Image1", "@Video1"]);
  });

  it("edit 영상 개수는 트레이+인라인 합계로 차단한다", () => {
    const { body, error } = buildSpotlightCreateBody({ ...seedance, trayRefs: [video()], inlineRefs: [video()], optionValues: { mode: "video_edit" } });
    expect(body).toBeNull();
    expect(error).toBe("영상은 1개만 넣을 수 있습니다 — 지금 2개입니다.");
  });

  it.each(["video_edit", "video_extension"])("영상 없는 %s를 t2v로 바꾸어 제출하지 않는다", (mode) => {
    const { body, error } = buildSpotlightCreateBody({ ...seedance, optionValues: { mode, extension_mode: "forward" } });
    expect(body).toBeNull();
    expect(error).toContain(mode === "video_edit" ? "고칠 영상" : "이어붙일 영상");
  });

  it.each([undefined, null, "", " "])("extension_mode=%s이면 방향을 추측하지 않고 오류", (direction) => {
    const options = Object.freeze({ mode: "video_extension", extension_mode: direction });
    const { body, error } = buildSpotlightCreateBody({ ...seedance, inlineRefs: [video()], optionValues: options });
    expect(body).toBeNull();
    expect(error).toContain("extension_mode");
    expect(options.extension_mode).toBe(direction);
  });

  it.each(["forward", "backward"])("extension은 복수 영상과 명시한 %s 방향을 유지", (direction) => {
    const options = Object.freeze({ mode: "video_extension", extension_mode: direction, duration: 9, aspect_ratio: "16:9" });
    const { body, error } = buildSpotlightCreateBody({ ...seedance, trayRefs: [video()], inlineRefs: [video(), img()], optionValues: options });
    expect(error).toBeNull();
    expect(body?.params).toEqual(options);
    expect(body?.references).toHaveLength(3);
  });

  it.each(["t2v", "omni_reference", "video_edit"])("%s의 잔존 방향은 복사본에서만 제거", (mode) => {
    const options = Object.freeze({ mode, extension_mode: "backward", duration: 8 });
    const { body, error } = buildSpotlightCreateBody({ ...seedance, trayRefs: [video()], optionValues: options });
    expect(error).toBeNull();
    expect(body?.params).not.toHaveProperty("extension_mode");
    expect(options).toEqual({ mode, extension_mode: "backward", duration: 8 });
  });

  it("토큰 정합 오류를 모드 오류보다 먼저 알린다", () => {
    const { body, error } = buildSpotlightCreateBody({ ...seedance, text: "@simage2", trayRefs: [img()], optionValues: { mode: "video_edit" } });
    expect(body).toBeNull();
    expect(error).toBe("이미지 레퍼런스 2번이 없습니다.");
  });

  it.each(["@simage1", "@eimage1"])("edit의 유효한 이미지 토큰 %s도 모드 검사로 막는다", (token) => {
    const { body, error } = buildSpotlightCreateBody({ ...seedance, text: token, trayRefs: [img(), video()], optionValues: { mode: "video_edit" } });
    expect(body).toBeNull();
    expect(error).toContain("첫/끝 프레임은 레퍼런스 모드에서만");
  });

  it("첫/끝 프레임만 붙어도 omni로 선택하고 역할을 보존한다", () => {
    const { body, error } = buildSpotlightCreateBody({ ...seedance, text: "@simage1 @eimage2", trayRefs: [img(), img()], optionValues: { mode: "t2v" } });
    expect(error).toBeNull();
    expect(body?.params?.mode).toBe("omni_reference");
    expect(body?.references?.map((ref) => ref.role)).toEqual(["@Start", "@End"]);
  });

  it.each(["seedance_2_0", "seedance_2_0_mini"])("%s의 std/fast·파라미터에는 간섭하지 않는다", (model) => {
    for (const mode of ["std", "fast"]) {
      const options = Object.freeze({ mode, extension_mode: "backward" });
      const { body, error } = buildSpotlightCreateBody({ ...seedance, model, trayRefs: [img()], optionValues: options });
      expect(error).toBeNull();
      expect(body?.params).toEqual(options);
    }
  });
});

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

describe("buildSpotlightCreateBody — 일반 태그와 전역 태그 분리", () => {
  it("Set 태그는 tags, 상단 전역 태그는 auto_tags로 보낸다", () => {
    const { body, error } = buildSpotlightCreateBody({
      ...base,
      text: "생성",
      inlineRefs: [],
      trayRefs: [],
      model: "nano_banana",
      tags: ["set-tag"],
      armedAutoTags: ["global-tag"],
    });
    expect(error).toBeNull();
    expect(body).toMatchObject({ tags: ["set-tag"], auto_tags: ["global-tag"] });
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
