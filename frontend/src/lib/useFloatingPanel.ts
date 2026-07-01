import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { Store } from "./storage";
import { addWindowMouseDrag, removeWindowMouseDrag } from "./windowDrag";

export function useFloatingPanel(LS: Store, keyPos: string, keySize: string, isOpen: boolean) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => LS.loadJSON(keyPos));
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => LS.loadJSON(keySize));
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const onDrag = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({ x: e.clientX - d.dx, y: e.clientY - d.dy });
  }, []);

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    removeWindowMouseDrag(onDrag, onDragEnd);
  }, [onDrag]);

  const onHeadMouseDown = useCallback(
    (e: ReactMouseEvent, fallback: { x: number; y: number } = { x: 180, y: 150 }) => {
      const p = pos || fallback;
      dragRef.current = { dx: e.clientX - p.x, dy: e.clientY - p.y };
      addWindowMouseDrag(onDrag, onDragEnd);
    },
    [onDrag, onDragEnd, pos],
  );

  useEffect(() => { if (pos) LS.setJSON(keyPos, pos); }, [pos]);
  useEffect(() => { if (size) LS.setJSON(keySize, size); }, [size]);
  useEffect(() => () => onDragEnd(), [onDragEnd]);
  useEffect(() => {
    if (!isOpen) return;
    const el = panelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen]);
  return { pos, setPos, size, setSize, dragRef, panelRef, onHeadMouseDown };
}
