import { useEffect, type RefObject } from "react";

export function useOutsideMouseDown<T extends HTMLElement>(
  ref: RefObject<T>,
  onOutside: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [enabled, onOutside, ref]);
}
