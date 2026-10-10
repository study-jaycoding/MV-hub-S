import { useEffect, type RefObject } from "react";

export function useOutsideMouseDown<T extends HTMLElement, U extends HTMLElement = HTMLElement>(
  ref: RefObject<T>,
  onOutside: () => void,
  enabled = true,
  // 메뉴를 body 로 옮겨 그리는(포털) 화면용 — 그 요소 안을 눌러도 '바깥'으로 보지 않는다.
  alsoInside?: RefObject<U>,
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
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [alsoInside, enabled, onOutside, ref]);
}
