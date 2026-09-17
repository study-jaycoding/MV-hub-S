import { useEffect, useRef } from "react";

/** 패널 바깥 클릭은 원래 클릭 동작도 유지하고, Escape는 열린 확인창에서 소비한다. */
export function useOverlayDismiss(onDismiss: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) dismissRef.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        dismissRef.current();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, []);
  return panelRef;
}
