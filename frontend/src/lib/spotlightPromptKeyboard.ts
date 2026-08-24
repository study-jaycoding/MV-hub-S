export type SpotlightEnterAction = "submit" | "line_break" | "consume" | null;

interface SpotlightEnterKey {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  shiftKey: boolean;
}

/**
 * 프롬프트 Enter 안전 규칙.
 * 정확히 Alt+Enter인 경우만 생성하고, 나머지 Enter 조합은 줄바꿈으로 처리한다.
 */
export function spotlightEnterAction(event: SpotlightEnterKey): SpotlightEnterAction {
  if (event.key !== "Enter") return null;
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    // 키를 누르고 있을 때 keydown 반복으로 여러 유료 요청이 나가지 않게 첫 입력만 허용한다.
    return event.repeat ? "consume" : "submit";
  }
  return "line_break";
}
