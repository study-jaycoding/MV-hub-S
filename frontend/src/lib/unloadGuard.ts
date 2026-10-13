// 저장하지 못한 것이 있는 동안 창을 닫거나 새로고침하면 브라우저가 한 번 묻게 하는 문지기(beforeunload). 묻는 글은 브라우저의 것이다.
//  · holdUnload(이름, 켬) — 누가 쥐고 있는 동안만 묻는다(지금은 편집 탭의 '저장 안 됨' 문서 — lib/editTimelineStore).
//  · **이 문지기는 사용자가 직접 창을 닫거나 새로고침할 때의 것이다.** 앱이 스스로 하는 새로고침은 reloadNow() 로 문지기를 풀고 한다 —
//    서버·계정의 상태를 이미 바꾼 뒤라 '머무르기'를 고르면 화면만 옛 상태로 남는다(계정 전환·로그아웃·DB 가져오기·서버 주소 전환.
//    Codex 배포 전 재검토 2026-10-13). 그런 길 가운데 사용자가 미리 고를 수 있는 것(로그아웃·업데이트 완료)은 unloadHeld() 로 먼저 묻는다.
const holders = new Set<string>();

/** 저장하지 못한 것을 쥔 쪽이 있는가 — 앱이 스스로 새로고침하기 전에 묻는 데 쓴다. */
export const unloadHeld = (): boolean => holders.size > 0;

const warn = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = "";
};

export function holdUnload(name: string, on: boolean): void {
  if (on) holders.add(name);
  else holders.delete(name);
  if (holders.size) window.addEventListener("beforeunload", warn); // 같은 함수라 여러 번 걸어도 하나다
  else window.removeEventListener("beforeunload", warn);
}

export function reloadNow(): void {
  holders.clear();
  window.removeEventListener("beforeunload", warn);
  window.location.reload();
}
