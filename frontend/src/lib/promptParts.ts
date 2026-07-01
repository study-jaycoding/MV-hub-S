// display_prompt(칩 자리에 @소스명) + references → 순서 보존 파트 목록(텍스트/칩).
// InfoPopup(인라인 칩 렌더)과 SpotlightPrompt 드롭 복원에서 공용으로 쓴다.
//  · 참조는 제출 순서대로 저장되고(repo ORDER BY gr.rowid), display_prompt 의
//    @이름 토큰도 같은 순서이므로 references 를 큐로 소비하며 위치를 매칭한다.
import { assetFileUrl } from "./assetUrls";
import type { Reference } from "../types";

// 에셋 소스 레퍼런스(asset:proj|path 토큰)를 서빙 가능한 URL 로 변환(옛 생성 썸네일 구제).
export function refSrc(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  if (s.startsWith("asset:")) {
    const [proj, path] = s.slice(6).split("|");
    if (proj && path) {
      return assetFileUrl(proj, path);
    }
  }
  return s;
}

// SpotlightPrompt 의 ChipRef 와 동일 구조(구조적 호환).
export interface PartChipRef {
  file_path: string;
  type: "image" | "video";
  role: string;
  name: string;
  thumb: string;
}
export type PromptPart = { t: "text"; v: string } | { t: "chip"; ref: PartChipRef };

function chipFromRef(ref: Reference, name: string): PartChipRef {
  return {
    file_path: ref.source_url || ref.file_path, // 캐시 경로 대신 원본/토큰(CLI 재resolve)
    type: ref.type,
    role: ref.role || "@Image1",
    name,
    thumb: refSrc(ref.thumbnail_path || ref.file_path) || "",
  };
}

// 폴백: display_prompt 가 없거나 매칭이 안 되는 옛 생성을 재사용할 때, 레퍼런스를 칩으로 변환.
// 이름은 source(칩 이름) > role > 순번 순으로 유도.
export function refsToChips(refs: Reference[]): PromptPart[] {
  return refs.map((r, i) => {
    const name =
      r.source && r.source !== "uploaded" ? r.source : (r.role || `ref${i + 1}`).replace(/^@/, "");
    return { t: "chip" as const, ref: chipFromRef(r, name) };
  });
}

// display_prompt 를 스캔하며 @이름 토큰을 references(큐)와 매칭해 칩으로 치환.
// 매칭 실패한 @ 는 평범한 텍스트로 둔다(옛 생성: source='uploaded' → 토큰 불일치 → 텍스트).
export function buildPromptParts(displayPrompt: string, refs: Reference[]): PromptPart[] {
  const parts: PromptPart[] = [];
  const queue = [...refs];
  let buf = "";
  const flush = () => {
    if (buf) {
      parts.push({ t: "text", v: buf });
      buf = "";
    }
  };
  let i = 0;
  while (i < displayPrompt.length) {
    if (displayPrompt[i] === "@" && queue.length) {
      const ref = queue[0];
      const name = ref.source || "";
      if (name && displayPrompt.substr(i + 1, name.length) === name) {
        flush();
        queue.shift();
        parts.push({ t: "chip", ref: chipFromRef(ref, name) });
        i += 1 + name.length;
        continue;
      }
    }
    buf += displayPrompt[i];
    i++;
  }
  flush();
  return parts;
}
