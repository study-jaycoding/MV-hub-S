export const APP_EVENTS = {
  accountUpdated: "ch:account-updated",
  addReference: "ch:add-reference",
  authRequired: "ch:auth-required",
  disabledChanged: "ch:disabled-changed",
  flash: "ch:flash",
  focusPrompt: "ch:focus-prompt",
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
