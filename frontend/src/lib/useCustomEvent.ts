import { useEffect, useRef } from "react";

// window 커스텀 이벤트(ch:*) 구독 헬퍼 — 핸들러를 ref 로 잡아 항상 '최신' 핸들러를 호출한다.
// 따라서 deps 배열을 관리하거나 stale 클로저를 피하려 재구독할 필요가 없다(name 이 바뀔 때만 재구독).
// 마운트 시 등록, 언마운트 시 자동 해제. addEventListener/removeEventListener 보일러플레이트 제거.
export function useCustomEvent(name: string, handler: (e: Event) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const fn = (e: Event) => ref.current(e);
    window.addEventListener(name, fn);
    return () => window.removeEventListener(name, fn);
  }, [name]);
}
