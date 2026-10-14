// 저장하지 못한 것이 있는 동안 창을 닫거나 새로고침하면 브라우저가 한 번 묻게 하는 문지기(beforeunload). 묻는 글은 브라우저의 것이다.
//  · holdUnload(이름, 켬) — 누가 쥐고 있는 동안만 묻는다(편집 탭의 '저장 안 됨' 문서 · 캔버스 저장 실패 · 작업표 설명 초안 · 부분 수정 창 —
//    56회차 전에는 편집 탭뿐이었다). 이름은 아래 PLACES 의 것 — 안내 글이 쥔 곳을 말한다.
//  · **이 문지기는 사용자가 직접 창을 닫거나 새로고침할 때의 것이다.** 앱이 스스로 하는 새로고침은 reloadNow() 로 문지기를 풀고 한다 —
//    서버·계정의 상태를 이미 바꾼 뒤라 '머무르기'를 고르면 화면만 옛 상태로 남는다(계정 전환·로그아웃·DB 가져오기·서버 주소 전환.
//    Codex 배포 전 재검토 2026-10-13). 그런 길 가운데 사용자가 미리 고를 수 있는 것(로그아웃·업데이트 완료)은 unloadHeld() 로 먼저 묻는다.
const holders = new Set<string>();
const PLACES: Record<string, string> = { "edit-docs": "편집 탭", "scene-save": "캔버스", "task-desc": "작업표 설명", "partial-edit": "부분 수정 창",
  "member-planning": "PM 관리 표" };

/** 저장하지 못한 것을 쥔 쪽이 있는가 — 앱이 스스로 새로고침하기 전에 묻는 데 쓴다. */
export const unloadHeld = (): boolean => holders.size > 0;
/** 저장하지 못한 것을 쥔 곳("편집 탭" · "편집 탭·캔버스", 없으면 "") — 안내 글에 쓴다. */
export const unsavedPlaces = (): string => [...holders].map((name) => PLACES[name] ?? name).join("·");

const warn = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = "";
};

export function holdUnload(name: string, on: boolean): void {
  const before = holders.size;
  if (on) holders.add(name);
  else holders.delete(name);
  // 바뀐 것이 없으면 리스너도 그대로 — 캔버스는 저장이 성공할 때마다 '놓는다'고 부른다(56회차). 창 없는 곳(node 시험)에서 부르는 모듈도 있다.
  if (holders.size === before || typeof window === "undefined") return;
  if (holders.size) window.addEventListener("beforeunload", warn); // 같은 함수라 여러 번 걸어도 하나다
  else window.removeEventListener("beforeunload", warn);
}

export function reloadNow(): void {
  holders.clear();
  window.removeEventListener("beforeunload", warn);
  window.location.reload();
}

/** '끝났으니 새 화면을 연다'는 새로고침(업데이트 완료) — 저장하지 못한 것이 있으면 하지 않고 false 를 돌려준다(부르는 쪽이 알린다).
 *  **새로고침하는 그 순간에** 본다: 예약한 뒤(0.5초 남짓) 그사이에 '저장 안 됨'이 생길 수 있다(Codex 재검토 3회째). */
export function reloadIfFree(): boolean {
  if (unloadHeld()) return false;
  window.location.reload();
  return true;
}

/** 저장하지 못한 것이 있을 때 확인 창의 글 뒤에 붙이는 한 줄(없으면 빈 문자열) — 새로고침으로 끝나는 작업을 **시작하기 전에** 알린다. */
export const unsavedNote = (): string =>
  unloadHeld() ? `\n\n${unsavedPlaces()}에 저장하지 못한 변경이 있습니다 — 이 작업이 끝나면 화면이 새로고침되어 그 변경은 사라집니다.` : "";

// 앱이 곧 떠난다(로그아웃 요청을 보내고 응답을 기다리는 동안) — 그사이의 편집은 받지 않는다(useEditDoc). 로그아웃의 확인은 요청 전에
//  한 번뿐이라, 그 뒤에 새로 생긴 '저장 안 됨'은 묻지 못한 채 새로고침에 사라진다. 응답 뒤에 다시 물을 수도 없다 — 서버는 이미
//  로그아웃됐다(머무르면 화면만 옛 계정의 것으로 남는다. Codex 재검토 3회째).
let leaving = false;
export const setLeaving = (on: boolean): void => {
  leaving = on;
};
export const isLeaving = (): boolean => leaving;
