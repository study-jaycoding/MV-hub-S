// 같은 브라우저의 다른 탭(창)이 로그아웃했는가 — storage 알림으로 가린다(Jay 결정 4B). 메인 창(useHubAuth)과 분리 창(main.tsx)이 같이 쓴다.
//  · 공유 서버 방식: 토큰 키가 지워졌고 이 창은 아직 토큰을 쥐었다. 판정은 **알림의 새 값**으로 한다 — 지운 뒤 곧바로 새 로그인이 저장되면
//    지금 저장소에는 새 토큰이 있어, 저장소를 보고 판정하면 로그아웃을 놓친다(Codex 4B P1). 새 토큰은 그대로 둔다(이 창만 정리).
//  · 로컬 허브 방식: 로그아웃한 탭이 시각 키를 쓴다(허브의 활성 계정이 풀렸다).
import { forgetAuthToken, getApiPause, getAuthToken, setApiPause } from "./http";
import { loadString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import { confirmLeaveUnsaved, reloadNow, unloadHeld } from "./unloadGuard";

export function loggedOutKind(event: StorageEvent): "shared" | "hub" | null {
  if (event.key === STORAGE_KEYS.hubLogoutAt) return event.newValue ? "hub" : null;
  const removed = event.key === STORAGE_KEYS.authToken
    ? event.newValue === null
    : event.key === null && !loadString(STORAGE_KEYS.authToken); // 저장소를 통째로 비웠다
  return removed && getAuthToken() ? "shared" : null;
}

/** 분리 창(Assets·관리) — 로그인 화면이 없어, 지킬 것이 없으면 지금처럼(공유 서버: 창이 토큰 변화를 따라감 · 로컬 허브: 새로 고침),
 *  있으면 멈춘다. 창의 다른 storage 리스너보다 먼저 걸어 그들이 멈춤을 보게 한다(main.tsx 가 렌더 전에). */
export function installPopupLogoutWatch(): void {
  window.addEventListener("storage", (event) => {
    if (getApiPause()) return;
    const kind = loggedOutKind(event);
    if (!kind) return;
    if (kind === "shared") forgetAuthToken();
    if (unloadHeld()) setApiPause(kind);
    else if (kind === "hub") reloadNow();
  });
}

/** 분리 창 띠의 단추 — 저장하지 못한 것이 아직 있으면 묻고 새로 고친다. */
export function leavePopupPause(): void {
  if (confirmLeaveUnsaved()) reloadNow();
}
