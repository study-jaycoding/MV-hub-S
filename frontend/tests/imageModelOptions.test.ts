// 새로 넣은 이미지 모델의 막히는 옵션 — R&D 제이/101 실측(2026-11-19)에서 드러난 것을 칸에서 막는다.
//  Seedream 5.0 Pro width·height 지정은 생성 실패, Flash 는 무시, Pro remove_bg 는 효과 없음, GPT 2.6 frame_* 는 GIF 에서만, size 는 미확인.
import { describe, expect, it } from "vitest";
import { activeConstraints, correctedOptions, defaultOptions, isModelHiddenParam, paramGateAllows } from "../src/lib/useModels";
import { durationRange } from "../src/lib/spotlightPromptConfig";
import type { ModelParam } from "../src/types";

const p = (name: string, type: string, def: unknown = null, en?: string[]): ModelParam =>
  ({ name, type, default: def, required: false, ...(en ? { enum: en } : {}) }) as ModelParam;

// CLI 1.2.2 `model get` 스키마에서 옮긴 칸들(프롬프트·참조 칸 제외)
const PRO = [p("aspect_ratio", "string", "1:1", ["1:1", "4:3", "3:2"]), p("resolution", "string", "2k", ["1k", "1.5k", "2k"]),
  p("width", "integer|null"), p("height", "integer|null"), p("remove_bg", "boolean", false), p("is_inpaint", "boolean", false)];
const FLASH = [p("aspect_ratio", "string", "4:3", ["auto", "1:1", "4:3"]), p("resolution", "string", "2k", ["1k", "1.5k", "2k"]),
  p("width", "integer|null"), p("height", "integer|null")];
const GPT26 = [p("aspect_ratio", "string", "1:1", ["auto", "1:1"]), p("quality", "string", "low", ["low", "medium"]),
  p("resolution", "string", "1k", ["1k", "2k"]), p("output_format", "string", "png", ["png", "jpeg", "webp", "gif", "svg"]),
  p("frame_count", "integer|null"), p("frame_duration_ms", "integer|null"), p("size", "string|null")];

describe("모델별 숨김 칸", () => {
  it("Seedream Pro 는 width·height·remove_bg, Flash 는 width·height, GPT 2.6 두 개는 size 를 숨긴다", () => {
    for (const name of ["width", "height", "remove_bg"]) expect(isModelHiddenParam("seedream_v5_pro", name)).toBe(true);
    for (const name of ["width", "height"]) expect(isModelHiddenParam("seedream_5_0_flash", name)).toBe(true);
    expect(isModelHiddenParam("gpt_image_2_6", "size")).toBe(true);
    expect(isModelHiddenParam("gpt_image_2_6_flare", "size")).toBe(true);
    // 다른 모델·다른 칸은 그대로
    expect(isModelHiddenParam("seedream_5_5", "width")).toBe(false);
    expect(isModelHiddenParam("seedream_v5_pro", "aspect_ratio")).toBe(false);
    expect(isModelHiddenParam("gpt_image_2", "size")).toBe(false);
  });

  it("기본 옵션에 숨긴 칸이 실리지 않고, 나머지(비율·해상도·품질)는 기본값 그대로", () => {
    const pro = defaultOptions(PRO, "seedream_v5_pro");
    expect(pro).toEqual({ aspect_ratio: "1:1", resolution: "2k" }); // remove_bg(기본 false)도 안 실린다
    expect(defaultOptions(FLASH, "seedream_5_0_flash")).toEqual({ aspect_ratio: "4:3", resolution: "2k" });
    expect(defaultOptions(GPT26, "gpt_image_2_6")).toEqual({ aspect_ratio: "1:1", quality: "low", resolution: "1k", output_format: "png" });
  });

  it("옛 카드·복원값으로 되살아온 숨긴 칸은 보정에서 걷어 낸다(나머지는 그대로)", () => {
    const fixed = correctedOptions("seedream_v5_pro", PRO, { aspect_ratio: "3:2", resolution: "1k", width: 768, height: 512, remove_bg: true });
    expect(fixed).toEqual({ aspect_ratio: "3:2", resolution: "1k" });
    const same = { aspect_ratio: "1:1", resolution: "1k" };
    expect(correctedOptions("seedream_v5_pro", PRO, same)).toBe(same); // 바꿀 것이 없으면 같은 객체
    expect(correctedOptions("seedream_5_0_flash", FLASH, { aspect_ratio: "auto", width: 768, height: 512 })).toEqual({ aspect_ratio: "auto" });
    expect(correctedOptions("gpt_image_2_6", GPT26, { output_format: "png", size: "1024x1024" })).toEqual({ output_format: "png" });
  });
});

describe("새 영상 모델(2026-11-19 R&D 견적으로 맞춘 값)", () => {
  const KLING = [p("aspect_ratio", "string", "16:9", ["21:9", "16:9", "9:16", "1:1", "auto"]), p("duration", "integer", 10),
    p("kling_element_ids", "array"), p("mode", "string", "text-to-video", ["text-to-video", "image-to-video", "reference-to-video", "video-edit"]),
    p("resolution", "string", "1080p", ["720p", "1080p"])];
  const MAX = [p("aspect_ratio", "string", "auto", ["auto", "16:9"]), p("duration", "integer", 5), p("resolution", "string", "768p", ["480p", "768p"])];

  it("길이 범위: 견적으로 잰 경계", () => {
    const r = (m: string) => durationRange(m, 5);
    expect(r("kling4_0")).toEqual({ min: 3, max: 30 });
    expect(r("kling_4_0_flash")).toEqual({ min: 3, max: 20 });
    expect(r("gemini_omni_flash_1_2")).toEqual({ min: 3, max: 15 });
    expect(r("wan3_0")).toEqual({ min: 2, max: 30 });
    expect(r("wan3_0_prime")).toEqual({ min: 2, max: 30 });
    expect(r("minimax_h3")).toEqual({ min: 4, max: 15 });
    expect(r("minimax_h3_max")).toEqual({ min: 5, max: 15 });
  });

  it("MiniMax H3 Max 의 기본 길이는 최소 5초(공통 4초는 거부되는 값), 다른 새 모델은 공통 4초", () => {
    expect(defaultOptions(MAX, "minimax_h3_max").duration).toBe("5");
    expect(defaultOptions(MAX, "minimax_h3").duration).toBe("4");
    expect(defaultOptions(KLING, "kling4_0").duration).toBe("4");
  });

  it("Kling 4.0 계열: 글→영상에서는 auto 비율을 막고, kling_element_ids 칸은 숨기며, 그림·영상 모드에서는 auto 가 열린다", () => {
    for (const model of ["kling4_0", "kling_4_0_flash"]) {
      expect(isModelHiddenParam(model, "kling_element_ids")).toBe(true);
      const t2v = activeConstraints(model, { mode: "text-to-video" }).aspect_ratio;
      expect(t2v.allow.has("auto")).toBe(false);
      expect(t2v.allow.has("16:9")).toBe(true);
      expect(activeConstraints(model, { mode: "image-to-video" }).aspect_ratio).toBeUndefined();
    }
    expect(defaultOptions(KLING, "kling4_0")).toEqual({ aspect_ratio: "16:9", duration: "4", mode: "text-to-video", resolution: "1080p" });
    // auto 로 둔 채 글→영상이 되면 허용값으로 돌려놓는다(제출 거절 방지)
    expect(correctedOptions("kling4_0", KLING, { mode: "text-to-video", aspect_ratio: "auto" }).aspect_ratio).not.toBe("auto");
  });
});

describe("GPT Image 2.6 jpeg 는 투명 배경 불가(R&D: jpeg+transparent 는 사유 없이 실패)", () => {
  const BG = p("background", "string|null", null, ["auto", "opaque", "transparent"]);
  it("output_format 이 jpeg 일 때만 background 의 transparent 를 막는다", () => {
    for (const model of ["gpt_image_2_6", "gpt_image_2_6_flare"]) {
      const jpeg = activeConstraints(model, { output_format: "jpeg" }).background;
      expect(jpeg.allow.has("transparent")).toBe(false);
      expect(jpeg.allow.has("opaque")).toBe(true);
      for (const format of ["png", "webp", "gif", "svg"]) expect(activeConstraints(model, { output_format: format }).background).toBeUndefined();
    }
  });
  it("transparent 로 둔 채 jpeg 가 되면 허용값으로 돌려놓는다(제출 실패 방지)", () => {
    const fixed = correctedOptions("gpt_image_2_6", [p("output_format", "string", "png", ["png", "jpeg"]), BG], { output_format: "jpeg", background: "transparent" });
    expect(fixed.background).toBe("opaque");
    expect(correctedOptions("gpt_image_2_6", [BG], { output_format: "png", background: "transparent" }).background).toBe("transparent");
  });
});

describe("GPT Image 2.6 frame 칸은 GIF 일 때만", () => {
  it("output_format 이 gif 일 때만 frame_count·frame_duration_ms 가 보인다", () => {
    for (const model of ["gpt_image_2_6", "gpt_image_2_6_flare"]) {
      for (const name of ["frame_count", "frame_duration_ms"]) {
        expect(paramGateAllows(model, name, { output_format: "png" })).toBe(false);
        expect(paramGateAllows(model, name, { output_format: "svg" })).toBe(false);
        expect(paramGateAllows(model, name, { output_format: "gif" })).toBe(true);
      }
      expect(paramGateAllows(model, "quality", { output_format: "png" })).toBe(true); // 다른 칸은 게이트 없음
    }
  });

  it("png 로 돌아오면 gif 때 넣은 frame 값이 제출에서 빠진다", () => {
    const gif = { output_format: "gif", frame_count: 4, frame_duration_ms: 200 };
    expect(correctedOptions("gpt_image_2_6", GPT26, gif)).toEqual(gif); // gif 면 그대로
    expect(correctedOptions("gpt_image_2_6", GPT26, { ...gif, output_format: "png" })).toEqual({ output_format: "png" });
  });
});
