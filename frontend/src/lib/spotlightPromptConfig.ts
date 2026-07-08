// SpotlightPrompt 옵션 표시/검증 보조값.

// duration 초 범위 — CLI 스키마(model get)에 min/max 가 없어 모델 스펙(models_explore)으로 보강.
const DURATION_RANGE: Record<string, { min: number; max: number }> = {
  seedance_2_0: { min: 4, max: 15 },
  seedance_2_0_mini: { min: 4, max: 15 },
  gemini_omni: { min: 4, max: 10 }, // 실측(generate cost): 4 미만/10 초과 거부
};

export function durationRange(model: string, fallback: number): { min: number; max: number } {
  return DURATION_RANGE[model] || { min: 1, max: Math.max(12, fallback * 2) };
}

// 자주 바꾸는 핵심 파라미터만 인라인 칩으로 두고, 나머지는 고급 팝오버로 모은다.
export const SPOTLIGHT_PRIMARY_PARAMS = new Set(["aspect_ratio", "resolution", "duration"]);

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
