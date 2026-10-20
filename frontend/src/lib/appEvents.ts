import { generationChangeMatchesScope, generationChangeReceiver, readGenerationChange, type GenerationChange } from "../features/library/api";
import { generationChangeScope, invalidateGenerationReadModels } from "../features/library/api";

export const APP_EVENTS = {
  accountUpdated: "ch:account-updated",
  addReference: "ch:add-reference",
  assetSyncReady: "ch:asset-sync-ready",
  authRequired: "ch:auth-required",
  disabledChanged: "ch:disabled-changed",
  // 최종 지정·해제가 권한 없음(403)으로 거절됐다 — 그사이 검수 역할이 회수됐을 수 있다. 인증 훅이 최종 권한 목록을 다시 읽는다(49회차).
  finalizeRolesStale: "ch:finalize-roles-stale",
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

export type GenerationTagsSettledDetail = {
  ids: string[];
  fields: ("tags" | "auto_tags")[];
  change?: GenerationChange;
};

// 옛 발신자·잘못된 payload는 기존 전체 조회로 복구한다. 유효한 빈 ids는 조회할 일이 없다는 뜻이다.
export function readGenerationTagsSettled(event: Event): GenerationTagsSettledDetail | null {
  if (!isCurrentGenerationEvent(event)) return { ids: [], fields: [] };
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return null;
  const { ids, fields } = detail as Partial<GenerationTagsSettledDetail>;
  if (!Array.isArray(ids) || ![...ids].every(id => typeof id === "string" && id.trim().length > 0)
    || !Array.isArray(fields) || !fields.length || ![...fields].every(field => field === "tags" || field === "auto_tags")) return null;
  return { ids: [...new Set(ids)], fields: [...new Set(fields)] };
}

export function isCurrentGenerationEvent(event: Event): boolean {
  const change = readGenerationChange((event as CustomEvent<{ change?: unknown }>).detail?.change);
  return !change || (generationChangeMatchesScope(change, generationChangeScope())
    && (change.affectsMembership || change.changedFields === undefined || (!!change.resourceIds.length && !!change.changedFields.length)));
}

// libraryChanged 의 detail — 실제 변경이 아니라 팀 탭의 유휴 폴링(15초)이 '사이드바 숫자를 깨우려고' 쏜 것(useGenerationAutoRefresh).
// 숫자만 다시 받으면 되는 구독자는 이것을 보고 무거운 조회를 건너뛴다 — 편집 탭이 이 틱마다 시퀀스의 공유 목록 전체를 다시 받았다
// (2026-10-13 격리 실측: 60초에 8.7MB, 밑의 탭이 작업 공간이면 0.5MB). detail 을 보지 않는 구독자에게는 전과 같은 알림이다.
export const LIBRARY_POLL_TICK = { poll: true } as const;
export const isLibraryPollTick = (event: Event): boolean =>
  (event as CustomEvent<{ poll?: boolean } | null | undefined>).detail?.poll === true;

export function dispatchAppEvent<T>(name: AppEventName, detail?: T): void {
  if (name === APP_EVENTS.libraryChanged || name === APP_EVENTS.generationTagsSettled) {
    const value = (detail as { change?: unknown } | undefined)?.change;
    const decision = receiveGenerationChange(value, generationChangeScope());
    if (decision === "ignore" || decision === "none") return;
    const change = readGenerationChange(value);
    if (change) invalidateGenerationReadModels(change.affectsMembership ? undefined : change.resourceIds, change.changedFields);
    else if (name === APP_EVENTS.generationTagsSettled) {
      const tags = readGenerationTagsSettled(new CustomEvent(name, { detail }));
      if (tags) invalidateGenerationReadModels(tags.ids, tags.fields);
      else invalidateGenerationReadModels();
    } else if (!(detail as { poll?: boolean } | undefined)?.poll) invalidateGenerationReadModels();
  }
  window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));
}
const receiveGenerationChange = generationChangeReceiver();
