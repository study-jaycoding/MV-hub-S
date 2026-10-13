// 저장하지 못한 것이 있는 동안 창을 닫거나 새로고침하면 브라우저가 한 번 묻게 하는 문지기(beforeunload). 묻는 글은 브라우저의 것이다.
//  · holdUnload(이름, 켬) — 누가 쥐고 있는 동안만 묻는다(지금은 편집 탭의 '저장 안 됨' 문서 — lib/editTimelineStore).
//  · reloadNow() — **반드시 새로고침해야 하는 길**(계정 전환·로그아웃)은 문지기를 풀고 새로고침한다. 거기서 사용자가 '머무르기'를 고르면
//    계정 범위만 바뀌고 화면은 옛 계정의 것으로 남는다(Codex 배포 전 재검토 2026-10-13).
const holders = new Set<string>();

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
