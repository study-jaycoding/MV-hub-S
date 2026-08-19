import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { Store } from "./storage";
import { addWindowMouseDrag, removeWindowMouseDrag } from "./windowDrag";

// 저장된 위치가 화면 밖이면 안으로 끌어온다. 창을 화면 밖까지 끌고 놓거나 더 큰 화면에서 저장된
// 좌표가 남으면, 다음부터는 열어도 안 보이는 '유령 창'이 된다(에셋 코멘트 창 실측 2026-08-19 —
// DOM 엔 있는데 (2600,1500) 에 렌더). 머리(잡는 부분)가 반드시 화면 안에 남게 보정한다.
function clampToViewport(p: { x: number; y: number } | null): { x: number; y: number } | null {
  if (!p) return p;
  const x = Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - 120));
  const y = Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - 60));
  return x === p.x && y === p.y ? p : { x, y };
}

export function useFloatingPanel(LS: Store, keyPos: string, keySize: string, isOpen: boolean) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() =>
    clampToViewport(LS.loadJSON(keyPos)),
  );
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
  // 다시 열 때도 보정 — 같은 세션에서 화면 밖으로 끌고 닫았다 열면 초기 로드 보정만으론 못 잡는다.
  useEffect(() => {
    if (isOpen) setPos((prev) => clampToViewport(prev));
  }, [isOpen]);
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
