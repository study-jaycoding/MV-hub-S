import type { Generation, Reference } from "../types";

// 참조(소스) 동일성 키 — 원본 URL 우선(가장 안정적), 없으면 파일경로/ id.
export function refKey(ref: Reference): string {
  return ref.source_url || ref.file_path || ref.id;
}

// 비교표에서 숨기는 내부/노이즈 필드 — 의미 있는 파라미터 차이만 보이게(로드맵 §3-2-2 의도).
export const HIDDEN_COMPARE_PARAMS = new Set(["prompt", "medias", "reference_elements"]);

// 프롬프트를 단어 토큰으로 — 공백 분리, 빈 토큰 제거. 비교는 소문자 기준(표시는 원형 유지).
export function tokenizePrompt(text: string): string[] {
  return (text || "").split(/(\s+)/).filter((token) => token.trim().length > 0);
}

// 모든 열에 공통으로 들어간 단어 집합(소문자) — 여기 없는 단어가 '바뀐 단어'.
export function commonPromptTokens(prompts: string[]): Set<string> {
  const sets = prompts.map((prompt) =>
    new Set(tokenizePrompt(prompt).map((token) => token.toLowerCase())),
  );
  if (sets.length === 0) return new Set();
  let common = sets[0];
  for (let i = 1; i < sets.length; i++) {
    common = new Set([...common].filter((token) => sets[i].has(token)));
  }
  return common;
}

// 엘리먼트 토큰 패턴(<<<x>>> 형태). 판정·추출·split 세 변형을 한 소스에서 파생해 서로 어긋나지 않게.
const ELEMENT_SRC = "<{2,}[^<>]*>{2,}";
export const ELEMENT_RE = new RegExp(`^${ELEMENT_SRC}$`);
export const ELEMENT_RE_G = new RegExp(ELEMENT_SRC, "g");
export const ELEMENT_SPLIT_RE = new RegExp(`(${ELEMENT_SRC})`);

export function extractPromptElements(text: string): string[] {
  return text.match(ELEMENT_RE_G) || [];
}

// 모든 버전에 공통으로 든 엘리먼트(소문자) — 여기 없는 엘리먼트가 '바뀐 엘리먼트'.
export function commonPromptElements(prompts: string[]): Set<string> {
  const sets = prompts.map((prompt) =>
    new Set(extractPromptElements(prompt).map((element) => element.toLowerCase())),
  );
  if (sets.length === 0) return new Set();
  let common = sets[0];
  for (let i = 1; i < sets.length; i++) {
    common = new Set([...common].filter((element) => sets[i].has(element)));
  }
  return common;
}

export function compareParamValue(gen: Generation, key: string): string {
  const value = (gen.params || {})[key];
  if (value === undefined || value === null) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function compareParamKeys(gens: Generation[], onlyDiff: boolean): string[] {
  const allKeys: string[] = [];
  for (const gen of gens) {
    for (const key of Object.keys(gen.params || {})) {
      if (!allKeys.includes(key)) allKeys.push(key);
    }
  }

  const meaningful = allKeys.filter((key) => {
    if (HIDDEN_COMPARE_PARAMS.has(key)) return false;
    return gens.some((gen) => {
      const value = (gen.params || {})[key];
      return value != null && typeof value !== "object";
    });
  });

  if (!onlyDiff) return meaningful;
  return meaningful.filter((key) => compareParamDiffers(gens, key));
}

export function compareParamDiffers(gens: Generation[], key: string): boolean {
  return new Set(gens.map((gen) => compareParamValue(gen, key))).size > 1;
}
