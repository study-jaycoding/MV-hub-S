// GPT Image 2.6 은 SVG 출력에 참조 이미지를 못 쓴다(CLI: "SVG output is only supported without reference images", 2026-11-19 R&D 시험).
//  참조가 붙어 있으면 Set 창에서 svg 를 잠그고, 이미 svg 를 고른 채 참조가 붙으면 프롬프트 창 위 띠(캔버스는 모델 노드 알약·모델 창 띠)로 알리며
//  생성을 막는다(Jay A안). 생성창·씬 보드·모델 창이 같이 쓰는 순수 함수라 무거운 모듈(useModels 등)을 끌어오지 않는다 — 이 파일은 import 가 없다.
import type { ModelParam } from "../types";

export const SVG_REF_MESSAGE = "SVG 는 참조 이미지와 함께 쓸 수 없습니다. 참조를 빼거나 출력 형식을 바꾸세요.";
const SVG_REF_NOTE = "참조 이미지가 있으면 SVG 로 만들 수 없습니다. 참조를 빼면 고를 수 있습니다.";
const SVG_REF_MODELS: ReadonlySet<string> = new Set(["gpt_image_2_6", "gpt_image_2_6_flare"]);

type OptionValues = Record<string, string | number | boolean>;

export const isSvgWithReferences = (model: string, optionValues: OptionValues, imageRefCount: number): boolean =>
  SVG_REF_MODELS.has(model) && optionValues.output_format === "svg" && imageRefCount > 0;

/** 참조 이미지가 있으면 output_format 제약에서 svg 를 뺀 지도를 돌려준다(없거나 다른 모델이면 입력 그대로). */
export function withSvgReferenceConstraint(
  constraints: Record<string, { allow: Set<string>; note: string }>,
  model: string,
  tunable: readonly ModelParam[],
  imageRefCount: number,
): Record<string, { allow: Set<string>; note: string }> {
  if (!SVG_REF_MODELS.has(model) || imageRefCount <= 0) return constraints;
  const param = tunable.find((p) => p.name === "output_format");
  if (!param?.enum?.length) return constraints;
  return { ...constraints, output_format: { allow: new Set(param.enum.filter((v) => v !== "svg")), note: SVG_REF_NOTE } };
}
