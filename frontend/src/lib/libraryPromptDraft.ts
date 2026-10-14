// 라이브러리 프롬프트 초안 — 쓰다 만 글·칩·트레이 참조를 같은 브라우저에 담아 두고 다시 열면 되살린다(Jay 결정 5B, 10-15).
//  계정마다 따로 담아 섞이지 않는다. `ch.` 접두가 아니라 계정을 바꿀 때 개인 설정 지우기(clearPersonalSettings)에 지워지지 않는다.
//  모델·설정·공간은 담지 않는다(결정 범위 = 글과 참조).
import { getAccountNamespace } from "./accountScope";
import type { ChipRef, PromptPart } from "./promptEditor";

export interface LibraryPromptDraft {
  parts: PromptPart[];
  trayRefs: ChipRef[];
}

export const libraryDraftKey = (): string => `mvhub.libraryPromptDraft:${getAccountNamespace()}`;

const isBlank = (draft: LibraryPromptDraft): boolean =>
  !draft.trayRefs.length && draft.parts.every((part) => part.t === "text" && !part.v.trim());

/** 담아 둔 초안. 없거나 손상이면 null — 글 조각은 받는 쪽이 한 번 더 거른다(SpotlightPrompt 의 draftParse). */
export function readLibraryDraft(key = libraryDraftKey()): LibraryPromptDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<LibraryPromptDraft> | null;
    const parts = Array.isArray(value?.parts) ? value.parts : [];
    const trayRefs = (Array.isArray(value?.trayRefs) ? value.trayRefs : []).filter(
      (ref): ref is ChipRef => !!ref && typeof ref === "object" && typeof ref.file_path === "string",
    );
    const draft = { parts, trayRefs };
    return isBlank(draft) ? null : draft;
  } catch {
    return null;
  }
}

/** 비었으면 지운다. 저장소가 막혀도 조용히 넘긴다 — 초안은 편의다. */
export function writeLibraryDraft(key: string, draft: LibraryPromptDraft): void {
  try {
    if (isBlank(draft)) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ v: 1, ...draft }));
  } catch {
    /* 용량·막힘 */
  }
}
