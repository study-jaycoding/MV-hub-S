import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { loadJSON, saveJSON } from "../../lib/storage";

const WIDTH_KEY = "ch.sidebarWidth";
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
const maxVisibleWidth = () => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(window.innerWidth / 2)));
const clamp = (width: number, max: number) => Math.max(MIN_WIDTH, Math.min(max, Math.round(width)));

interface Drag {
  pointerId: number;
  startX: number;
  startWidth: number;
  preferredWidth: number;
  width: number;
}

// 세 탭의 폴더 사이드바 폭만 공유한다. 카드/폴더 데이터와 상위 App은 드래그마다 갱신하지 않는다.
export function ResizableSidebar({ children }: { children: ReactNode }) {
  const t = useT();
  const id = useId();
  const sidebar = useRef<HTMLElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(() => {
    const saved = loadJSON<unknown>(WIDTH_KEY);
    return typeof saved === "number" && Number.isFinite(saved) ? clamp(saved, MAX_WIDTH) : MIN_WIDTH;
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
    if (!unmount) setPreferredWidth(next);
    if (changed) saveJSON(WIDTH_KEY, next);
  }, [showWidth]);

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
  }, [finishDrag]);

  const commitWidth = (next: number) => {
    finishDrag(true);
    next = clamp(next, maxVisibleWidth());
    setPreferredWidth(next);
    showWidth(next);
    saveJSON(WIDTH_KEY, next);
  };
  return <>
    <aside id={id} ref={sidebar} className="sidebar" style={{ "--sidebar-w": `${width}px` } as CSSProperties}>
      {children}
    </aside>
    <div ref={handle} className="sidebar-resize-handle" role="separator" tabIndex={0}
      aria-label={t("사이드바 너비 조절")} aria-controls={id} aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH} aria-valuemax={maxWidth} aria-valuenow={width}
      title={t("드래그하여 너비 조절 · 더블클릭하여 기본 너비로 복원")}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return;
        event.preventDefault(); event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, preferredWidth, width };
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
      onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); commitWidth(MIN_WIDTH); }}
      onKeyDown={event => {
        const next = event.key === "ArrowLeft" ? width - 8 : event.key === "ArrowRight" ? width + 8
          : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maxWidth : null;
        if (next !== null || (event.key === "Escape" && drag.current)) {
          event.preventDefault(); event.stopPropagation();
          if (event.key === "Escape") finishDrag(true); else commitWidth(next!);
        }
      }}
    />
  </>;
}
