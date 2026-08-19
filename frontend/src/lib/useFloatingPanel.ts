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

// 겹친 떠있는 창의 앞뒤 — 마지막으로 잡은(누른) 창이 앞으로. CSS 의 고정 z(태그 80·코멘트 82)를
// 인라인 스타일로 덮는다. 다른 오버레이(정보팝업 240, 미리보기 1000 등)보다는 항상 아래 머물게
// 좁은 밴드(100~199)만 쓰고, 상한에 닿으면 현재 순서를 유지한 채 아래로 눌러 담는다(정규화).
const FLOAT_Z_BASE = 100;
const FLOAT_Z_MAX = 199;
let floatZ = FLOAT_Z_BASE;
const floatPanels = new Set<HTMLElement>();
function bringPanelToFront(el: HTMLElement): void {
  if (floatZ >= FLOAT_Z_MAX) {
    const ordered = [...floatPanels].sort(
      (a, b) => Number(a.style.zIndex || 0) - Number(b.style.zIndex || 0),
    );
    floatZ = FLOAT_Z_BASE;
    for (const p of ordered) p.style.zIndex = String(floatZ++);
  }
  el.style.zIndex = String(++floatZ);
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
    // 앞뒤 전환 — 새로 열린 창은 맨 앞, 이후엔 잡은 창이 앞. 리스너는 문서 캡처 단계에 두고
    // 매번 panelRef.current 를 읽는다: ① 내부 버튼의 stopPropagation(머리 A−/A+ 등 드래그
    // 방지용)에 가려지지 않고 ② key 리마운트로 DOM 이 갈려도(코멘트 창의 파일 전환) 계속 동작.
    floatPanels.add(el);
    bringPanelToFront(el);
    const onDown = (event: MouseEvent) => {
      const cur = panelRef.current;
      if (cur && event.target instanceof Node && cur.contains(event.target)) {
        if (!floatPanels.has(cur)) {
          floatPanels.delete(el);
          floatPanels.add(cur); // 리마운트로 갈린 새 노드를 정규화 대상에 반영
        }
        bringPanelToFront(cur);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    return () => {
      ro.disconnect();
      document.removeEventListener("mousedown", onDown, true);
      floatPanels.delete(el);
      const cur = panelRef.current;
      if (cur) floatPanels.delete(cur);
    };
  }, [isOpen]);
  return { pos, setPos, size, setSize, dragRef, panelRef, onHeadMouseDown };
}
