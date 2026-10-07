export const APP_EVENTS = {
  accountUpdated: "ch:account-updated",
  addReference: "ch:add-reference",
  authRequired: "ch:auth-required",
  disabledChanged: "ch:disabled-changed",
  flash: "ch:flash",
  focusPrompt: "ch:focus-prompt",
  // 태그 저장 묶음이 끝났다(성공·실패 모두, 마지막 저장 뒤 한 번) — 생성물 사본을 따로 든 화면(캔버스)이 서버 값으로 다시 읽는다.
  // libraryChanged 와 따로 둔다: 태그는 폴더 집계·생성자 목록을 바꾸지 않아 그 구독자들까지 깨울 이유가 없다.
  generationTagsSettled: "ch:generation-tags-settled",
  // 생성물 변경(담기/폴더·최종·공유·삭제·새 생성)의 같은 창(same-window) 알림 — 사이드바 폴더 카운트
  // 즉시 갱신 등. BroadcastChannel(ch-generations)은 창 간 전달용이라, 같은 창 갱신은 이 이벤트로 확실히.
  libraryChanged: "ch:library-changed",
  // 부분 수정(브러시 인페인트) 모달 열기 — InfoPopup → App 의 PartialEditHost. detail={genId}
  partialEdit: "ch:partial-edit",
  reusePrompt: "ch:reuse-prompt",
  resolveSelection: "ch:resolve-selection",
  resolveSelectionSettingsChanged: "ch:resolve-selection-settings-changed",
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
