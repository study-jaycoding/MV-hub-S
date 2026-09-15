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
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [alsoInside, enabled, onOutside, ref]);
}
