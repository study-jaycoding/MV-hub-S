import type { Generation } from "../types";

type LegacyPromptPart =
  | { t: "text"; v: string }
  | { t: "chip"; ref: { name: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function legacyPromptPart(value: unknown): LegacyPromptPart | null {
  if (!isRecord(value)) return null;
  if (value.t === "text" && typeof value.v === "string") {
    return { t: "text", v: value.v };
  }
  if (value.t === "chip" && isRecord(value.ref) && typeof value.ref.name === "string") {
    return { t: "chip", ref: { name: value.ref.name } };
  }
  return null;
}

// 예전 씬 생성 경로 일부가 contentEditable 내부 PromptPart[]를 문자열로 만들어 generation.prompt에
// 저장했다. 정확히 그 전용 형식인 경우에만 사람이 읽는 텍스트로 되돌린다. 일반 JSON 프롬프트와
// 손상된 배열은 원문을 그대로 보존해 화면·재사용에서 뜻이 바뀌지 않게 한다.
export function decodeLegacySerializedPrompt(raw: string): string {
  const candidate = raw.trim();
  if (!candidate.startsWith("[") || !candidate.endsWith("]")) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return raw;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return raw;

  const parts: LegacyPromptPart[] = [];
  for (const value of parsed) {
    const part = legacyPromptPart(value);
    if (!part) return raw;
    parts.push(part);
  }

  const decoded = parts
    .map((part) => (part.t === "text" ? part.v : `@${part.ref.name}`))
    .join("")
    .replace(/[ \t]+$/gm, "")
    .trim();
  return decoded || raw;
}

// 서버/복사 DB의 원문은 보존하고, 프론트 API 경계에서만 과거 직렬화 실수를 정상 Generation 모양으로
// 보정한다. 정상 행은 같은 객체를 반환해 목록 200건마다 불필요한 React 객체 교체가 생기지 않는다.
export function normalizeGenerationPromptCompatibility(generation: Generation): Generation {
  const prompt = decodeLegacySerializedPrompt(generation.prompt || "");
  const displayPrompt = generation.display_prompt
    ? decodeLegacySerializedPrompt(generation.display_prompt)
    : generation.display_prompt;
  if (prompt === generation.prompt && displayPrompt === generation.display_prompt) return generation;
  return { ...generation, prompt, display_prompt: displayPrompt };
}
