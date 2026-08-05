import { useEffect } from "react";

export function useEscapeClose(
  onClose: () => void,
  enabled = true,
  capture = false,
  consume = false,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (consume) {
        e.preventDefault();
        e.stopPropagation();
      }
      onClose();
    };
    window.addEventListener("keydown", onKey, capture);
    return () => window.removeEventListener("keydown", onKey, capture);
  }, [onClose, enabled, capture, consume]);
}
