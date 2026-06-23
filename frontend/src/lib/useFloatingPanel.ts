import { useEffect, useRef, useState } from "react";
import type { Store } from "./storage";
export function useFloatingPanel(LS: Store, keyPos: string, keySize: string, isOpen: boolean) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try { const r = LS.get(keyPos, ""); return r ? JSON.parse(r) : null; } catch { return null; }
  });
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => {
    try { const r = LS.get(keySize, ""); return r ? JSON.parse(r) : null; } catch { return null; }
  });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (pos) LS.set(keyPos, JSON.stringify(pos)); }, [pos]);
  useEffect(() => { if (size) LS.set(keySize, JSON.stringify(size)); }, [size]);
  useEffect(() => {
    if (!isOpen) return;
    const el = panelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen]);
  return { pos, setPos, size, setSize, dragRef, panelRef };
}
