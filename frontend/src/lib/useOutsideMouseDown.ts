import { useEffect, type RefObject } from "react";

export function useOutsideMouseDown<T extends HTMLElement, U extends HTMLElement = HTMLElement>(
  ref: RefObject<T>,
  onOutside: () => void,
  enabled = true,
  // 메뉴를 body 로 옮겨 그리는(포털) 화면용 — 그 요소 안을 눌러도 '바깥'으로 보지 않는다.
  alsoInside?: RefObject<U>,
  // 초점이 밖으로 옮겨 가도(Tab) 닫는다 — 쓰는 쪽이 켠다(규칙 58). 기본은 꺼짐: 닫으면서 초점을 밖으로 되돌리는 메뉴(편집 탭의 북마크 메뉴 —
  //  Esc 로 버리며 편집 뿌리로 초점을 옮긴다)에서 그 focusin 이 '바깥'으로 읽혀 저장 닫기가 한 번 더 불렸다(tests/editCutFolder).
  closeOnFocusOut = false,
): void {
  useEffect(() => {
    if (!enabled) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current || ref.current.contains(target)) return;
      if (alsoInside?.current?.contains(target)) return;
      onOutside();
    };
    // pointerdown 도 듣는다 — 누름을 pointerdown 에서 막는 곳(사이드바 폭 손잡이 등)은 mousedown 이 아예 안 와서, 그곳을 눌러도
    //  메뉴가 떠 있는 채였다(2026-10-10 격리 실측). 보통의 누름에는 둘 다 오지만 닫기는 두 번 해도 같다.
    //  **잡는 단계**로 듣는다 — 그 손잡이는 전파까지 멈춰서(stopPropagation) 오르는 단계의 document 리스너에는 닿지도 않는다
    //  (편집 탭 재실측: 메뉴 8종이 손잡이 누름에 하나도 안 닫혔다).
    document.addEventListener("pointerdown", onDoc, true);
    document.addEventListener("mousedown", onDoc);
    // 초점이 밖으로 옮겨 가도(Tab·Shift+Tab) 닫는다 — 전엔 바깥 누름·Esc 만 닫아서, Tab 으로 빠져나간 뒤에도 메뉴가 열린 채 남아
    //  뒤 화면의 단축키를 계속 막았다(Esc 겹, 30회차 Codex 점검). focusin 은 초점이 **생길 때**만 온다 — BODY 로 떨어지는 blur 는 안 닫는다.
    //  body 로 옮겨 그리는 메뉴(알림 패널·계정 메뉴)는 켜지 않는다: 키보드로 열면 다음 Tab 이 패널이 아니라 DOM 순서의 다음 단추로 가서
    //  닿기도 전에 닫힌다(Codex 코드 리뷰). 그쪽은 열릴 때 패널 안으로 초점을 옮긴 뒤에 켤 것.
    const onFocus = (e: FocusEvent) => onDoc(e as unknown as MouseEvent);
    if (closeOnFocusOut) document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("focusin", onFocus);
    };
  }, [alsoInside, closeOnFocusOut, enabled, onOutside, ref]);
}
