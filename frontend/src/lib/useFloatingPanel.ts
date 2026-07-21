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
    const ro = new ResizeObserver(() => {
      // 0 크기는 저장하지 않는다 — 패널이 remount/detach 될 때 RO 가 0 으로 fire 해 저장 크기를
      // 덮어쓰는 것 방어(카드 전환 시 코멘트창 크기 초기화 버그의 안전망).
      if (el.offsetWidth > 0 && el.offsetHeight > 0) setSize({ w: el.offsetWidth, h: el.offsetHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen]);
  return { pos, setPos, size, setSize, dragRef, panelRef, onHeadMouseDown };
}
