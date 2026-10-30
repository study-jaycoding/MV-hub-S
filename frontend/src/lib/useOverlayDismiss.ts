import { useEffect, useRef, type RefObject } from "react";
import { useEscapeClose } from "./useEscapeClose";

/** 패널 바깥 클릭은 원래 클릭 동작도 유지하고, Escape는 열린 확인창에서 소비한다. ignoreRef = 바깥으로 치지 않을 요소(창을 연 단추). */
export function useOverlayDismiss(onDismiss: () => void, ignoreRef?: RefObject<Element | null>) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !ignoreRef?.current?.contains(target)) dismissRef.current();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [ignoreRef]);
  // Esc 는 겹 순서대로(lib/useEscapeClose) — 떠 있는 동안 뒤 격자의 단축키도 쉰다.
  useEscapeClose(() => dismissRef.current(), true, true, true);
  return panelRef;
}
