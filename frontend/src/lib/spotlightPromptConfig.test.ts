// 모델 드롭다운 '변형' 규칙을 고정한다.
//  · 힉스필드 웹처럼 Seedance 2.0 / 2.0 Fast 를 따로 보여주되, CLI 에는 그런 job_type 이 없으므로
//    화면에서만 가른다 — 제출·견적·DB 는 (model=seedance_2_0, mode=fast) 그대로다.
//  · 표시명은 카탈로그 display_name 에서 만든다. 힉스필드가 모델 이름을 바꾸면 따라가야 한다
//    (하드코딩하면 개명 때 드롭다운만 옛 이름으로 남는다 — nano_banana_2→pro 전례).
import { describe, expect, it } from "vitest";

import {
  currentVariantValue,
  isVariantParam,
  modelRows,
  modelVariantSuffix,
} from "./spotlightPromptConfig";

const VIDEO = [
  { job_set_type: "seedance_2_5", display_name: "Seedance 2.5" },
  { job_set_type: "seedance_2_0", display_name: "Seedance 2.0" },
  { job_set_type: "seedance_2_0_mini", display_name: "Seedance 2.0 Mini" },
];

describe("modelRows", () => {
  it("변형 없는 모델은 한 줄로 남는다", () => {
    const rows = modelRows([{ job_set_type: "gpt_image_2_5", display_name: "GPT Image 2.5" }]);
    expect(rows).toEqual([
      { key: "gpt_image_2_5", model: "gpt_image_2_5", display_name: "GPT Image 2.5" },
    ]);
  });

  it("seedance_2_0 은 표준/Fast 두 줄로 갈린다", () => {
    const rows = modelRows(VIDEO);
    expect(rows.map((r) => r.display_name)).toEqual([
      "Seedance 2.5",
      "Seedance 2.0",
      "Seedance 2.0 Fast",
      "Seedance 2.0 Mini",
    ]);
    const fast = rows.find((r) => r.display_name === "Seedance 2.0 Fast")!;
    // ★갈라진 줄도 실제 모델 키는 seedance_2_0 이다 — 가짜 job_type 을 만들지 않는다.
    expect(fast.model).toBe("seedance_2_0");
    expect(fast.param).toBe("mode");
    expect(fast.value).toBe("fast");
    expect(fast.key).not.toBe(fast.model); // 드롭다운 key 는 두 줄을 구분해야 한다
  });

  it("표시명은 카탈로그 이름을 따라간다(개명해도 꼬리말만 붙는다)", () => {
    const rows = modelRows([{ job_set_type: "seedance_2_0", display_name: "Seedance 2.0 Turbo" }]);
    expect(rows.map((r) => r.display_name)).toEqual([
      "Seedance 2.0 Turbo",
      "Seedance 2.0 Turbo Fast",
    ]);
  });
});

describe("currentVariantValue", () => {
  it("값이 아직 안 실렸으면 첫 항목(=표준)으로 본다", () => {
    expect(currentVariantValue("seedance_2_0", {})).toBe("std");
    expect(currentVariantValue("seedance_2_0", { mode: "" })).toBe("std");
  });

  it("고른 값을 그대로 돌려준다", () => {
    expect(currentVariantValue("seedance_2_0", { mode: "fast" })).toBe("fast");
  });

  it("변형이 없는 모델은 null", () => {
    expect(currentVariantValue("seedance_2_5", { mode: "omni_reference" })).toBeNull();
  });
});

describe("modelVariantSuffix", () => {
  it("표준은 꼬리말이 없고 fast 만 붙는다", () => {
    expect(modelVariantSuffix("seedance_2_0", { mode: "std" })).toBe("");
    expect(modelVariantSuffix("seedance_2_0", { mode: "fast" })).toBe(" Fast");
  });

  it("변형이 없거나 모르는 값이면 꼬리말이 없다", () => {
    expect(modelVariantSuffix("seedance_2_5", { mode: "video_edit" })).toBe("");
    expect(modelVariantSuffix("seedance_2_0", { mode: "무엇" })).toBe("");
  });
});

describe("isVariantParam", () => {
  it("모델 드롭다운이 맡은 값만 고급에서 감춘다", () => {
    expect(isVariantParam("seedance_2_0", "mode")).toBe(true);
    expect(isVariantParam("seedance_2_0", "resolution")).toBe(false);
    // ★seedance_2_5 의 mode 는 생성 방식이라 가르지 않는다 — 고급에 그대로 남아야 한다.
    expect(isVariantParam("seedance_2_5", "mode")).toBe(false);
  });
});
