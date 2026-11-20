// 업스케일 모델 — 크게 보기 [⤢ Upscale] 창(docs/status/업스케일_크게보기_2026-11-20.md, Jay 시안 v3 "이 배치로").
//  값은 CLI 1.2.2 `model get`(11-20). 첫 모델·첫 값이 기본. 원본은 레퍼런스 1개(image_references / video_references)로 간다.
import type { Generation } from "../types";
import type { GenerationCreateBody } from "../shared/contracts/generation";

export type UpscaleKind = "image" | "video";
export type UpscaleValue = string | number | boolean;
export interface UpscaleChoice { value: UpscaleValue; label: string }
/** 칩 하나 — key 는 CLI 인자 이름(배율 scale 만 앱 계산용: output_width·output_height 로 바뀐다). */
export interface UpscaleOption { key: string; label: string; choices: UpscaleChoice[]; initial: UpscaleValue; toggle?: boolean }
export interface UpscaleModel { id: string; kind: UpscaleKind; label: string; description: string; options: UpscaleOption[] }

const onOff = (key: string, label: string): UpscaleOption =>
  ({ key, label, toggle: true, initial: false, choices: [{ value: false, label: "OFF" }, { value: true, label: "ON" }] });
const pick = (key: string, label: string, initial: UpscaleValue, choices: [UpscaleValue, string][]): UpscaleOption =>
  ({ key, label, initial, choices: choices.map(([value, text]) => ({ value, label: text })) });
const SCALE = pick("scale", "배율", 2, [[2, "2×"], [4, "4×"]]);

export const UPSCALE_MODELS: UpscaleModel[] = [
  { id: "bytedance_image_upscale", kind: "image", label: "Bytedance Upscale", description: "빠르고 단순 · 2K / 4K · 배경 제거 옵션",
    options: [pick("resolution", "해상도", "4k", [["2k", "2K"], ["4k", "4K"]]), onOff("remove_bg", "배경 제거")] },
  { id: "topaz_image", kind: "image", label: "Topaz", description: "원본 그대로 키움 · 2× / 4× · 종류 · 얼굴 보정",
    options: [SCALE, pick("variant", "종류", "Standard V2", ["Standard V2", "Low Resolution V2", "CGI", "High Fidelity V2", "Text Refine"].map((v) => [v, v])),
      onOff("face_enhancement", "얼굴 보정")] },
  { id: "topaz_image_generative", kind: "image", label: "Topaz Generative", description: "디테일을 새로 그려 넣으며 키움 · 2× / 4× · 종류",
    options: [SCALE, pick("variant", "종류", "Redefine", ["Redefine", "Standard MAX", "Recovery", "Recovery V2", "Wonder 2", "Wonder 3.5"].map((v) => [v, v]))] },
  { id: "bytedance_video_upscale", kind: "video", label: "Bytedance Video Upscale", description: "1080p / 2K / 4K · 영상 종류 · FPS 24/30/60 · Standard/Pro",
    options: [pick("resolution", "해상도", "2k", [["1080p", "1080p"], ["2k", "2K"], ["4k", "4K"]]),
      pick("preset", "영상 종류", "aigc", [["common", "일반"], ["aigc", "AI 생성"], ["short_series", "숏폼"], ["ugc", "UGC"], ["old_film", "옛날 필름"]]),
      pick("fps", "FPS", 24, [[24, "24"], [30, "30"], [60, "60"]]),
      pick("model_version", "품질", "standard", [["standard", "Standard"], ["pro", "Pro"]])] },
  { id: "topaz_video", kind: "video", label: "Topaz", description: "1080p / 4K(2160p) · 화면비 자동",
    options: [pick("resolution", "해상도", "1080p", [["1080p", "1080p"], ["2160p", "4K"]])] },
  // CLI 기본은 prores — 우선 H.265 만 연다(Codex 설계 확인 P3): 허브는 결과 배열의 첫 URL 만 받고(cli_bridge.parse_job)
  //  EXR 은 미디어 종류에 없으며, ProRes 는 브라우저 미리보기가 안 될 수 있다. 유료 응답·저장·미리보기를 확인한 뒤 더한다.
  { id: "topaz_hyperion_2_5", kind: "video", label: "Topaz Hyperion 2.5", description: "편집용 고화질로 · 지금은 H.265 만(ProRes·EXR 은 확인 뒤)",
    options: [pick("output_format", "파일 형식", "h265", [["h265", "H.265"]])] },
];

const BY_ID = new Map(UPSCALE_MODELS.map((m) => [m.id, m]));
export const upscaleModel = (id: string) => BY_ID.get(id);
export const upscaleModelsFor = (kind: UpscaleKind) => UPSCALE_MODELS.filter((m) => m.kind === kind);
/** 견적이 원본 영상(힉스필드 작업 id)을 받아야 나오는 모델 — 백엔드 cli_bridge 와 같은 목록. */
export const UPSCALE_VIDEO_COST_MODELS: ReadonlySet<string> = new Set(["bytedance_video_upscale", "topaz_hyperion_2_5"]);
/** CLI 가 견적을 주지 않는 모델(`does not support alpha v2 cost estimation`, 11-20 실측). */
export const UPSCALE_NO_COST_MODELS: ReadonlySet<string> = new Set(["topaz_image", "topaz_image_generative", "topaz_video"]);

export function initialValues(model: UpscaleModel): Record<string, UpscaleValue> {
  return Object.fromEntries(model.options.map((o) => [o.key, o.initial]));
}

export const choiceLabel = (option: UpscaleOption, value: UpscaleValue) =>
  option.choices.find((c) => c.value === value)?.label ?? String(value);

/** 보낼 params. Topaz 이미지는 배율을 원본 픽셀에 곱해 출력 크기로 — 원본 크기를 모르면 null(보내지 않는다). */
export function upscaleParams(modelId: string, values: Record<string, UpscaleValue>, src?: { w: number; h: number } | null): Record<string, UpscaleValue> | null {
  const model = upscaleModel(modelId);
  if (!model) return null;
  const out: Record<string, UpscaleValue> = {};
  for (const option of model.options) {
    const value = values[option.key] ?? option.initial;
    if (option.key !== "scale") out[option.key] = value;
  }
  if (model.options.some((o) => o.key === "scale")) {
    const scale = Number(values.scale ?? SCALE.initial);
    if (!src || !(src.w > 0) || !(src.h > 0)) return null;
    out.output_width = Math.round(src.w * scale);
    out.output_height = Math.round(src.h * scale);
  }
  if (modelId === "topaz_video") out.aspect_ratio = "auto"; // 원본 화면 그대로(CLI 기본도 auto — 명시해 둔다)
  return out;
}

/** 창의 '원본 → 결과' 오른쪽 글자. Topaz 이미지만 정확한 픽셀을 안다 — 나머지는 고른 해상도·형식 이름. */
export function upscaleTarget(modelId: string, values: Record<string, UpscaleValue>, src?: { w: number; h: number } | null): string {
  const params = upscaleParams(modelId, values, src);
  if (params?.output_width && params.output_height) return `${params.output_width}×${params.output_height}`;
  const model = upscaleModel(modelId);
  const option = model?.options.find((o) => o.key === "resolution" || o.key === "output_format");
  if (!option) return "";
  const label = choiceLabel(option, values[option.key] ?? option.initial);
  return option.key === "output_format" ? `고화질 · ${label}` : label; // Hyperion 은 해상도가 아니라 파일 형식을 고른다
}

/** 결과 카드의 '⤢ …' 글자 — 업스케일 결과가 아니면 null. */
export function upscaleBadge(model: string | null | undefined, params: Record<string, unknown> | null | undefined): string | null {
  const spec = model ? upscaleModel(model) : undefined;
  if (!spec) return null;
  const p = params ?? {};
  if (typeof p.output_width === "number" && typeof p.output_height === "number") return `${p.output_width}×${p.output_height}`;
  const option = spec.options.find((o) => o.key === "resolution" || o.key === "output_format");
  const value = option ? p[option.key] : undefined;
  return option && (typeof value === "string" || typeof value === "number") ? choiceLabel(option, value) : spec.label;
}

/** 업스케일 생성 요청 몸통 — 원본 카드와 같은 프로젝트·폴더, 원본 1개를 레퍼런스로(계보는 source_gen_id 가 만든다).
 *  prompt 는 서버가 빈 값을 거절해 화면 자리표시를 보낸다 — 에이전트가 업스케일 모델이면 CLI 에 넘기지 않는다. */
export function upscaleRequestBody(gen: Generation, filePath: string, kind: UpscaleKind, modelId: string,
  params: Record<string, UpscaleValue>): GenerationCreateBody {
  return {
    prompt: "(no text)",
    model: modelId,
    params,
    project_id: gen.project_id || undefined,
    folder_path: gen.folder_path || undefined,
    references: [{
      file_path: filePath,
      type: kind,
      role: kind === "video" ? "video_references" : "image_references",
      source_gen_id: gen.id,
      name: gen.source_name || undefined,
    }],
  };
}
