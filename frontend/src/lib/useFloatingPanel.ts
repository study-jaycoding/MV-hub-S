import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { Store } from "./storage";
import { addWindowMouseDrag, removeWindowMouseDrag } from "./windowDrag";

// 저장된 위치가 화면 밖이면 안으로 끌어온다. 창을 화면 밖까지 끌고 놓거나 더 큰 화면에서 저장된
// 좌표가 남으면, 다음부터는 열어도 안 보이는 '유령 창'이 된다(에셋 코멘트 창 실측 2026-08-19 —
// DOM 엔 있는데 (2600,1500) 에 렌더). 저장 크기와 실제 렌더 크기를 함께 써서 창 전체를 보정한다.
export function clampFloatingPanelPosition(
  p: { x: number; y: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { x: number; y: number } {
  const width = Math.min(Math.max(0, panel.width), Math.max(0, viewport.width - margin * 2));
  const height = Math.min(Math.max(0, panel.height), Math.max(0, viewport.height - margin * 2));
  const x = Math.min(Math.max(margin, p.x), Math.max(margin, viewport.width - width - margin));
  const y = Math.min(Math.max(margin, p.y), Math.max(margin, viewport.height - height - margin));
  return x === p.x && y === p.y ? p : { x, y };
}

function clampToViewport(
  p: { x: number; y: number } | null,
  panel: { width: number; height: number } = { width: 120, height: 60 },
): { x: number; y: number } | null {
  if (!p) return p;
  return clampFloatingPanelPosition(
    p,
    panel,
    { width: window.innerWidth, height: window.innerHeight },
  );
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
  // ★콜백 ref — key 리마운트(코멘트 창 파일 전환)로 DOM 이 갈리는 순간을 state 로 잡는다.
  //   객체 ref + [isOpen] 이펙트만으론 리마운트를 감지 못해, ResizeObserver 가 떼어진 옛 DOM 을
  //   계속 관찰하고(크기 저장·보정 중단) 분리된 DOM 이 z-order 집합에 누적됐다(적대 리뷰 P2).
  const nodeRef = useRef<HTMLDivElement | null>(null); // 이벤트 핸들러용 동기 읽기
  const [panelNode, setPanelNode] = useState<HTMLDivElement | null>(null); // 이펙트 재배선 트리거
  const panelRef = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node;
    setPanelNode(node);
  }, []);

  const onDrag = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const el = nodeRef.current;
    setPos(clampToViewport(
      { x: e.clientX - d.dx, y: e.clientY - d.dy },
      el ? { width: el.offsetWidth, height: el.offsetHeight } : undefined,
    ));
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
  // 다시 열 때·리마운트로 새 DOM 이 붙을 때 보정 — 같은 세션에서 화면 밖으로 끌고 닫았다 열면
  // 초기 로드 보정만으론 못 잡는다.
  useLayoutEffect(() => {
    if (!isOpen || !panelNode) return;
    const rect = panelNode.getBoundingClientRect();
    setPos((prev) => clampToViewport(
      prev || { x: rect.left, y: rect.top },
      { width: rect.width, height: rect.height },
    ));
  }, [isOpen, panelNode]);
  useEffect(() => { if (size) LS.setJSON(keySize, size); }, [size]);
  useEffect(() => () => onDragEnd(), [onDragEnd]);
  useEffect(() => {
    // panelNode 의존 — 리마운트로 노드가 갈리면 옛 노드는 cleanup 에서 관찰·등록 해제되고
    // 새 노드에 ResizeObserver·z-order 등록이 즉시 다시 배선된다.
    if (!isOpen || !panelNode) return;
    const el = panelNode;
    const ro = new ResizeObserver(() => {
      // 0 크기는 저장하지 않는다 — 패널이 remount/detach 될 때 RO 가 0 으로 fire 해 저장 크기를
      // 덮어쓰는 것 방어(카드 전환 시 코멘트창 크기 초기화 버그의 안전망).
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        const measured = { width: el.offsetWidth, height: el.offsetHeight };
        setSize((prev) =>
          prev?.w === measured.width && prev?.h === measured.height
            ? prev
            : { w: measured.width, h: measured.height },
        );
        const rect = el.getBoundingClientRect();
        setPos((prev) => clampToViewport(
          prev || { x: rect.left, y: rect.top },
          measured,
        ));
      }
    });
    ro.observe(el);
    // 앞뒤 전환 — 새로 열린 창은 맨 앞, 이후엔 잡은 창이 앞. 리스너는 문서 캡처 단계에 둬서
    // 내부 버튼의 stopPropagation(머리 A−/A+ 등 드래그 방지용)에 가려지지 않게 한다.
    floatPanels.add(el);
    bringPanelToFront(el);
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && el.contains(event.target)) {
        bringPanelToFront(el);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    const onWindowResize = () => {
      const rect = el.getBoundingClientRect();
      setPos((prev) => clampToViewport(
        prev || { x: rect.left, y: rect.top },
        { width: rect.width, height: rect.height },
      ));
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      ro.disconnect();
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", onWindowResize);
      floatPanels.delete(el);
    };
  }, [isOpen, panelNode]);
  return { pos, setPos, size, setSize, dragRef, panelRef, onHeadMouseDown };
}
