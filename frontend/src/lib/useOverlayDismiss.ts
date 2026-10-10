import { useEffect, useRef } from "react";
import { useEscapeClose } from "./useEscapeClose";

/** 패널 바깥 클릭은 원래 클릭 동작도 유지하고, Escape는 열린 확인창에서 소비한다. */
export function useOverlayDismiss(onDismiss: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) dismissRef.current();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  // Esc 는 겹 순서대로(lib/useEscapeClose) — 떠 있는 동안 뒤 격자의 단축키도 쉰다.
  useEscapeClose(() => dismissRef.current(), true, true, true);
  return panelRef;
}
