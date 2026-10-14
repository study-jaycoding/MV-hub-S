import { APP_EVENTS, dispatchAppEvent } from "./appEvents";

// 전역 토스트 디스패치 — flash 함수에 접근 못 하는 lib/하위 컴포넌트가 실패/알림을 사용자에게
// 보이게 한다(App 이 "ch:flash" 를 수신해 표시). prop drilling 없이 fire-and-forget 액션의
// 실패를 정직하게 알리는 용도.
export function flashMsg(msg: string): void {
  try {
    dispatchAppEvent(APP_EVENTS.flash, msg);
  } catch {
    /* SSR/비브라우저 환경 무시 */
  }
}

/** 글자를 클립보드에 담는다 — 못 담았으면(클립보드 없음·쓰기 막힘) 알리고 거짓. 담았는가를 돌려준다(59회차: 실패가 조용해 예전 클립보드가 붙었다). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText !== "function") throw new Error("clipboard write unsupported");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    flashMsg("클립보드에 복사하지 못했습니다 — 브라우저가 막았습니다.");
    return false;
  }
}
