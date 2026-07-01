import { useEffect } from "react";

export function useEscapeClose(onClose: () => void, enabled = true, capture = false) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, capture);
    return () => window.removeEventListener("keydown", onKey, capture);
  }, [onClose, enabled, capture]);
}
