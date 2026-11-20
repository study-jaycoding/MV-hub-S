// @vitest-environment jsdom
// GPT Image 2.6 은 SVG 출력에 참조 이미지를 못 쓴다(CLI 거절) — 미리 막는다(Jay A안): Set 창 svg 잠금 · 프롬프트 창 위 띠 · Generate 잠금.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpotlightGenerateControls } from "../src/components/spotlight/SpotlightGenerateControls";
import { SvgReferenceBand } from "../src/components/spotlight/SvgReferenceBand";
import { SVG_REF_MESSAGE, isSvgWithReferences, withSvgReferenceConstraint } from "../src/lib/useModels";
import type { ModelParam } from "../src/types";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const FORMAT = { name: "output_format", type: "string", default: "png", required: false, enum: ["png", "jpeg", "webp", "gif", "svg"] } as ModelParam;

describe("SVG + 참조 이미지 판정", () => {
  it("GPT 2.6(·Flare)에서 svg 이고 참조 이미지가 1장 이상일 때만 막힌다", () => {
    for (const model of ["gpt_image_2_6", "gpt_image_2_6_flare"]) {
      expect(isSvgWithReferences(model, { output_format: "svg" }, 1)).toBe(true);
      expect(isSvgWithReferences(model, { output_format: "svg" }, 0)).toBe(false); // 참조 없으면 SVG 가능
      expect(isSvgWithReferences(model, { output_format: "png" }, 3)).toBe(false);
      expect(isSvgWithReferences(model, {}, 3)).toBe(false);
    }
    expect(isSvgWithReferences("gpt_image_2_5", { output_format: "svg" }, 2)).toBe(false); // 다른 모델은 건드리지 않는다
    expect(isSvgWithReferences("seedream_5_5", { output_format: "svg" }, 2)).toBe(false);
  });

  it("참조가 있으면 output_format 제약에서 svg 만 빠지고, 없거나 다른 모델이면 입력 그대로", () => {
    const base = { aspect_ratio: { allow: new Set(["1:1"]), note: "x" } };
    const locked = withSvgReferenceConstraint(base, "gpt_image_2_6", [FORMAT], 2);
    expect([...locked.output_format.allow]).toEqual(["png", "jpeg", "webp", "gif"]);
    expect(locked.output_format.note).toContain("참조 이미지가 있으면 SVG");
    expect(locked.aspect_ratio).toBe(base.aspect_ratio); // 기존 제약 보존
    expect(withSvgReferenceConstraint(base, "gpt_image_2_6", [FORMAT], 0)).toBe(base);
    expect(withSvgReferenceConstraint(base, "gpt_image_2_5", [FORMAT], 2)).toBe(base);
    expect(withSvgReferenceConstraint(base, "gpt_image_2_6", [], 2)).toBe(base); // 칸이 없으면 그대로
  });
});

describe("띠와 Generate 잠금", () => {
  it("띠에 문구와 [png 로 바꾸기] 가 있고, 누르면 onFix 한 번", () => {
    const onFix = vi.fn();
    act(() => root.render(<SvgReferenceBand onFix={onFix} />));
    const band = host.querySelector(".sl-svg-band")!;
    expect(band.getAttribute("role")).toBe("alert");
    expect(band.textContent).toContain("SVG 는 참조 이미지와 함께 쓸 수 없습니다.");
    expect(band.textContent).toContain("참조를 빼거나 출력 형식을 바꾸세요.");
    act(() => host.querySelector<HTMLButtonElement>(".sl-svg-band-fix")!.click());
    expect(onFix).toHaveBeenCalledTimes(1);
  });

  it("blockedReason 이 있으면 Generate 가 잠기고 이유가 툴팁, 없으면 종전처럼", () => {
    const onSubmit = vi.fn();
    const render = (blockedReason: string | null) => act(() => root.render(
      <SpotlightGenerateControls count={1} maxCount={4} setCount={vi.fn()} busy={false} cost={1} costLoading={false}
        onSubmit={onSubmit} blockedReason={blockedReason}><span /></SpotlightGenerateControls>));
    render(SVG_REF_MESSAGE);
    const gen = host.querySelector<HTMLButtonElement>(".sl-gen")!;
    expect(gen.disabled).toBe(true);
    expect(gen.title).toBe(SVG_REF_MESSAGE);
    render(null);
    expect(host.querySelector<HTMLButtonElement>(".sl-gen")!.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>(".sl-gen")!.title).toBe("생성 (Alt+Enter)");
    act(() => host.querySelector<HTMLButtonElement>(".sl-gen")!.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
