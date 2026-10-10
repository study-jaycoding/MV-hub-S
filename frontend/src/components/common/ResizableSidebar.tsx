import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { loadJSON, saveJSON } from "../../lib/storage";

const WIDTH_KEY = "ch.sidebarWidth";
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

interface Drag {
  pointerId: number;
  focusBefore: HTMLElement | null; // 끌기 전에 초점이 있던 자리 — 끝나면 돌려준다
  startX: number;
  startWidth: number;
  preferredWidth: number;
  width: number;
}

// 세 탭의 폴더 사이드바 폭만 공유한다. 카드/폴더 데이터와 상위 App은 드래그마다 갱신하지 않는다.
//  편집 탭의 미디어 풀도 같은 손잡이를 쓴다 — 그때는 자기 칸(className)·저장 키·폭 범위를 넘긴다(안 주면 사이드바 그대로).
export function ResizableSidebar({
  children, className = "sidebar", widthKey = WIDTH_KEY, min = MIN_WIDTH, max = MAX_WIDTH, base = min,
}: {
  children: ReactNode;
  className?: string;
  widthKey?: string;
  min?: number;
  max?: number;
  base?: number; // 저장된 폭이 없을 때·더블클릭으로 되돌릴 때의 폭
}) {
  const maxVisibleWidth = useCallback(() => Math.max(min, Math.min(max, Math.floor(window.innerWidth / 2))), [min, max]);
  const clamp = useCallback((width: number, limit: number) => Math.max(min, Math.min(limit, Math.round(width))), [min]);
  const t = useT();
  const id = useId();
  const sidebar = useRef<HTMLElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(() => {
    const saved = loadJSON<unknown>(widthKey);
    return typeof saved === "number" && Number.isFinite(saved) ? clamp(saved, max) : base;
  });
  const [maxWidth, setMaxWidth] = useState(maxVisibleWidth);
  const width = Math.min(preferredWidth, maxWidth);

  const showWidth = useCallback((next: number) => {
    sidebar.current?.style.setProperty("--sidebar-w", `${next}px`);
    handle.current?.setAttribute("aria-valuenow", String(next));
  }, []);
  const finishDrag = useCallback((cancel: boolean, unmount = false) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null; // releasePointerCapture가 lostpointercapture를 보내도 두 번 처리하지 않는다.
    const changed = !cancel && current.width !== current.startWidth;
    const next = changed ? current.width : current.preferredWidth;
    showWidth(Math.min(next, maxVisibleWidth()));
    handle.current?.classList.remove("resizing");
    if (handle.current?.hasPointerCapture(current.pointerId)) handle.current.releasePointerCapture(current.pointerId);
    // 마우스로 끈 뒤에는 초점을 끌기 전 자리로 돌려준다(없으면 내려놓는다) — 손잡이에 남으면 ←·→ 가 화면의 키가 아니라 칸 폭을 바꾸고
    //  Space 같은 단축키가 죽는다(2026-10-10 격리 실측 3/3). Tab 으로 손잡이에 와서 방향키로 조절하는 길은 끌기가 아니라 그대로다.
    if (!unmount && document.activeElement === handle.current) {
      const back = current.focusBefore;
      if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
      else handle.current?.blur();
    }
    if (!unmount) setPreferredWidth(next);
    if (changed) saveJSON(widthKey, next);
  }, [showWidth, maxVisibleWidth, widthKey]);

  useEffect(() => {
    const cancel = () => finishDrag(true);
    const resize = () => { cancel(); setMaxWidth(maxVisibleWidth()); };
    window.addEventListener("resize", resize);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", cancel);
      finishDrag(true, true);
    };
  }, [finishDrag, maxVisibleWidth]);

  const commitWidth = (next: number) => {
    finishDrag(true);
    next = clamp(next, maxVisibleWidth());
    setPreferredWidth(next);
    showWidth(next);
    saveJSON(widthKey, next);
  };
  return <>
    <aside id={id} ref={sidebar} className={className} style={{ "--sidebar-w": `${width}px` } as CSSProperties}>
      {children}
    </aside>
    <div ref={handle} className="sidebar-resize-handle" role="separator" tabIndex={0}
      aria-label={t("사이드바 너비 조절")} aria-controls={id} aria-orientation="vertical"
      aria-valuemin={min} aria-valuemax={maxWidth} aria-valuenow={width}
      title={t("드래그하여 너비 조절 · 더블클릭하여 기본 너비로 복원")}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return;
        event.preventDefault(); event.stopPropagation();
        const focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, preferredWidth, width, focusBefore };
        event.currentTarget.classList.add("resizing");
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        current.width = clamp(current.startWidth + event.clientX - current.startX, maxVisibleWidth());
        showWidth(current.width);
      }}
      onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(false); }}
      onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(true); }}
      onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(true); }}
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); commitWidth(base); }}
      onKeyDown={event => {
        const next = event.key === "ArrowLeft" ? width - 8 : event.key === "ArrowRight" ? width + 8
          : event.key === "Home" ? min : event.key === "End" ? maxWidth : null;
        if (next !== null || (event.key === "Escape" && drag.current)) {
          event.preventDefault(); event.stopPropagation();
          if (event.key === "Escape") finishDrag(true); else commitWidth(next!);
        }
      }}
    />
  </>;
}
