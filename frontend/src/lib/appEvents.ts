export const APP_EVENTS = {
  accountUpdated: "ch:account-updated",
  addReference: "ch:add-reference",
  authRequired: "ch:auth-required",
  disabledChanged: "ch:disabled-changed",
  flash: "ch:flash",
  focusPrompt: "ch:focus-prompt",
  // 생성물 변경(담기/폴더·최종·공유·삭제·새 생성)의 같은 창(same-window) 알림 — 사이드바 폴더 카운트
  // 즉시 갱신 등. BroadcastChannel(ch-generations)은 창 간 전달용이라, 같은 창 갱신은 이 이벤트로 확실히.
  libraryChanged: "ch:library-changed",
  reusePrompt: "ch:reuse-prompt",
  shortcutsChanged: "ch:shortcuts-changed",
} as const;

export const BROADCAST_CHANNELS = {
  assets: "ch-assets",
  // 생성물 변경(담기/폴더·최종·공유·삭제) 창 간 알림 — 관리탭(별도 창)이 즉시 재조회.
  generations: "ch-generations",
} as const;

export const ASSET_CHANNEL_MESSAGES = {
  assetsUpdated: "assets-updated",
  sessionReset: "session-reset",
} as const;

export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];

export function dispatchAppEvent<T>(name: AppEventName, detail?: T): void {
  window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));
}
