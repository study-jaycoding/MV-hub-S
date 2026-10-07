// 한 키 입력을 '이미 쓴 것'으로 표시하고 확인한다.
// 같은 keydown 이 안쪽 처리(예: 격자의 Esc = 선택 해제)를 거친 뒤 window 의 전역 단축키에도 닿을 때, 전역 쪽이 한 번 더
// 처리하지 않게 하는 약속이다(Esc 한 번에 선택 해제 + 창 닫힘). stopPropagation 과 달리 같은 키를 기다리는 다른 리스너
// (확인창·메뉴)는 그대로 받는다. 전역 쪽이 '지금 선택이 비었나'를 직접 보면 안 된다 — 안쪽 처리가 선택을 푼 직후라 이미 비어 있다.
const handled = new WeakSet<Event>();

export function markKeyHandled(event: Event): void {
  handled.add(event);
}

export function isKeyHandled(event: Event): boolean {
  return handled.has(event);
}
