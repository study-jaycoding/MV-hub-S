// SpotlightPrompt 옵션 표시/검증 보조값.

// duration 초 범위 — CLI 스키마(model get)에 min/max 가 없어 모델 스펙(models_explore)으로 보강.
const DURATION_RANGE: Record<string, { min: number; max: number }> = {
  seedance_2_5: { min: 4, max: 30 }, // 실측(generate cost): 3 거부·30 허용·31 거부. 6.5크레딧/초(720p)
  seedance_2_0: { min: 4, max: 15 },
  seedance_2_0_mini: { min: 4, max: 15 },
  gemini_omni: { min: 4, max: 10 }, // 실측(generate cost): 4 미만/10 초과 거부
};

export function durationRange(model: string, fallback: number): { min: number; max: number } {
  return DURATION_RANGE[model] || { min: 1, max: Math.max(12, fallback * 2) };
}

// 자주 바꾸는 핵심 파라미터만 인라인 칩으로 두고, 나머지는 고급 팝오버로 모은다.
export const SPOTLIGHT_PRIMARY_PARAMS = new Set(["aspect_ratio", "resolution", "duration"]);

// ── 모델 드롭다운 '변형' ────────────────────────────────────────────────────
// CLI 모델 하나를 옵션 고정값으로 갈라 **드롭다운에서만** 별도 항목처럼 보여준다. 힉스필드 웹이
// Seedance 2.0 / 2.0 Fast 를 따로 내놓는 것과 같은 표시다.
// ★CLI 에는 `seedance_2_0_fast` 라는 job_type 이 **없다**. 제출·견적·DB 저장은 그대로
//   (model=seedance_2_0, mode=fast) 로 나가므로 카탈로그 대조·재생성·씬 노드·팩트 집계가 전부
//   종전대로 동작한다. 가짜 모델 키를 만들면 저 경로 전부에 번역기를 달아야 한다 — 그래서 화면에서만 가른다.
// 표시명은 CLI 카탈로그 display_name 에 suffix 를 붙여 만든다(힉스필드가 이름을 바꿔도 따라간다).
//  · 2026-09-15 견적 실측(4초): std 480p 12 · 720p 18 · 1080p 36 · 4k 88 / fast 480p 6 · 720p 14.
//    fast 는 1080p·4k 를 CLI 가 명시 거부 → 해상도는 MODEL_CONSTRAINTS(useModels) 가 함께 좁힌다.
//  ★seedance_2_5.mode 는 가르지 않는다 — 속도가 아니라 생성 방식(t2v/omni_reference/video_edit/
//    video_extension)이 갈려 모델 이름으로 표현할 성질이 아니고, 기본값이 틀어지면 레퍼런스가 거부된다.
type ModelVariantEntry = { value: string; suffix: string };
const MODEL_VARIANTS: Record<string, { param: string; entries: ModelVariantEntry[] }> = {
  seedance_2_0: {
    param: "mode",
    entries: [
      { value: "std", suffix: "" },
      { value: "fast", suffix: " Fast" },
    ],
  },
};

/** 드롭다운 한 줄. 평범한 모델이면 1줄, 변형이 있으면 값마다 1줄(param/value 가 붙는다). */
export type ModelRow = {
  key: string;
  model: string;
  display_name: string;
  param?: string;
  value?: string;
};

export function modelRows(models: { job_set_type: string; display_name: string }[]): ModelRow[] {
  const out: ModelRow[] = [];
  for (const m of models) {
    const v = MODEL_VARIANTS[m.job_set_type];
    if (!v) {
      out.push({ key: m.job_set_type, model: m.job_set_type, display_name: m.display_name });
      continue;
    }
    for (const e of v.entries)
      out.push({
        key: `${m.job_set_type}:${e.value}`,
        model: m.job_set_type,
        display_name: m.display_name + e.suffix,
        param: v.param,
        value: e.value,
      });
  }
  return out;
}

/** 지금 옵션값이 가리키는 변형 값. 아직 안 실렸으면 첫 항목(=기본)으로 본다. */
export function currentVariantValue(
  model: string,
  optionValues: Record<string, string | number | boolean>,
): string | null {
  const v = MODEL_VARIANTS[model];
  if (!v) return null;
  return String(optionValues[v.param] ?? "") || v.entries[0].value;
}

/** 이 파라미터를 모델 드롭다운이 대신 맡고 있는가 — 맞으면 '고급'에서 감춘다(같은 설정 두 곳 방지). */
export function isVariantParam(model: string, name: string): boolean {
  return MODEL_VARIANTS[model]?.param === name;
}

/** 모델 칩에 붙일 꼬리말(" Fast" 등). 변형이 없으면 빈 문자열. */
export function modelVariantSuffix(
  model: string,
  optionValues: Record<string, string | number | boolean>,
): string {
  const v = MODEL_VARIANTS[model];
  if (!v) return "";
  const cur = currentVariantValue(model, optionValues);
  return v.entries.find((e) => e.value === cur)?.suffix ?? "";
}

const ADVANCED_PARAM_ORDER = ["mode", "genre", "bitrate_mode"];

export function spotlightAdvancedParamRank(name: string): number {
  const index = ADVANCED_PARAM_ORDER.indexOf(name);
  return index === -1 ? ADVANCED_PARAM_ORDER.length : index;
}

const PARAM_LABEL: Record<string, string> = {
  aspect_ratio: "비율",
  resolution: "해상도",
  duration: "길이",
  bitrate_mode: "비트레이트",
  genre: "장르",
  mode: "모드",
  quality: "품질",
};

export function spotlightParamLabel(name: string): string {
  return PARAM_LABEL[name] || name;
}

const VALUE_LABEL: Record<string, string> = {
  std: "표준(std)",
  fast: "빠름(fast)",
  standard: "표준(standard)",
  high: "고화질(high)",
  auto: "자동(auto)",
};

export function spotlightValueLabel(value: string): string {
  return VALUE_LABEL[value] || value;
}
