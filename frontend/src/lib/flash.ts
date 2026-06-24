// 전역 토스트 디스패치 — flash 함수에 접근 못 하는 lib/하위 컴포넌트가 실패/알림을 사용자에게
// 보이게 한다(App 이 "ch:flash" 를 수신해 표시). prop drilling 없이 fire-and-forget 액션의
// 실패를 정직하게 알리는 용도.
export function flashMsg(msg: string): void {
  try {
    window.dispatchEvent(new CustomEvent("ch:flash", { detail: msg }));
  } catch {
    /* SSR/비브라우저 환경 무시 */
  }
}
