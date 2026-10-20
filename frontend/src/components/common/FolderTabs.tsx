import { Fragment, useEffect, useRef, useState } from "react";
import { WorkspaceMark } from "../common/WorkspaceMark";
import { useT } from "../../lib/i18n";
import { useDragKeyHold, useKeyOwner } from "../../lib/keyGate";
import { dropIndexAt } from "../../lib/sceneWorkspace";

interface TabDrag {
  id: number; pointerId: number; startX: number; startY: number; active: boolean; beforeId: number | null;
}

export function FolderTabs({ tabs, active, project = "", label = "에셋 폴더 탭", onSelect, onClose, onReorder }: {
  tabs: { id: number; view: { dir: string; project?: string; name?: string } }[];
  active: number;
  project?: string;
  label?: string;
  onSelect: (id: number) => boolean;
  onClose: (id: number) => void;
  onReorder: (id: number, beforeId: number | null) => void;
}) {
  const t = useT();
  const [drag, setDrag] = useState<TabDrag | null>(null);
  const dragRef = useRef<TabDrag | null>(null);
  const tabRefs = useRef(new Map<number, HTMLElement>());
  const suppressClick = useRef(false);
  const suppressTimer = useRef<number | undefined>(undefined);
  useKeyOwner(!!drag?.active);
  useDragKeyHold(!!drag?.active);
  const updateDrag = (next: TabDrag | null) => { dragRef.current = next; setDrag(next); };
  const endDrag = (commit: boolean) => {
    const current = dragRef.current;
    updateDrag(null);
    if (!current?.active) return;
    suppressClick.current = true;
    if (commit && current.id !== current.beforeId) onReorder(current.id, current.beforeId);
  };
  const releaseSuppression = () => {
    window.clearTimeout(suppressTimer.current);
    suppressTimer.current = window.setTimeout(() => { suppressClick.current = false; }, 0);
  };
  const cancelDrag = () => { endDrag(false); releaseSuppression(); };
  const onPointerDown = (event: React.PointerEvent, id: number) => {
    if (event.button !== 0 || !event.isPrimary) return;
    suppressClick.current = false;
    window.clearTimeout(suppressTimer.current);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateDrag({ id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false, beforeId: id });
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!event.buttons) { cancelDrag(); return; }
    if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
    // 가로 스크롤 뒤에도 캔버스와 같은 삽입 위치 계산을 쓰되 화면상의 새 좌표를 읽는다.
    const rects = tabs.map((tab) => tabRefs.current.get(tab.id)?.getBoundingClientRect());
    if (rects.some((rect) => !rect)) return;
    const index = dropIndexAt(rects as DOMRect[], event.clientX, event.clientY);
    updateDrag({ ...current, active: true, beforeId: tabs[index]?.id ?? null });
  };
  const onPointerUp = (event: React.PointerEvent) => {
    if (dragRef.current && dragRef.current.pointerId !== event.pointerId) return;
    endDrag(true); releaseSuppression();
  };
  useEffect(() => {
    if (!drag?.active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); endDrag(false);
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancelDrag);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancelDrag);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.active]);
  useEffect(() => () => window.clearTimeout(suppressTimer.current), []);
  return <div className="scene-bar assets-folder-tabs" role="tablist" aria-label={t(label)}>
    {tabs.map((tab, index) => {
      const tabProject = tab.view.project ?? project;
      const name = tab.view.name || tab.view.dir.split("/").pop() || tabProject || t("전체");
      return <Fragment key={tab.id}>
        {drag?.active && drag.beforeId === tab.id && drag.id !== tab.id && <span className="scene-drop-line" />}
        <span ref={(element) => { if (element) tabRefs.current.set(tab.id, element); else tabRefs.current.delete(tab.id); }}
          className={"scene-tab-wrap" + (tab.id === active ? " on" : "") + (drag?.active && drag.id === tab.id ? " dragging" : "")}
        onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
        onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }}>
        <button type="button" className="scene-tab" role="tab" aria-selected={tab.id === active}
          tabIndex={tab.id === active ? 0 : -1} title={`${tabProject} / ${tab.view.dir}`}
          onPointerDown={(event) => onPointerDown(event, tab.id)} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
          onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onSelect(tab.id); }} onKeyDown={(event) => {
            if (dragRef.current?.active) return;
            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
              : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
              : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault();
            if (!onSelect(tabs[next].id)) return;
            const list = event.currentTarget.closest('[role="tablist"]');
            list?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}>
          <WorkspaceMark label={tabProject} id={tabProject} className="sm" title={tabProject} /><span className="scene-tab-name">{name}</span>
        </button>
        <button type="button" className="scene-del" aria-label={`${name} ${t("탭 닫기")}`}
          disabled={tabs.length === 1} title={t("탭 닫기")} onClick={() => onClose(tab.id)}>×</button>
      </span></Fragment>;
    })}
    {drag?.active && drag.beforeId === null && <span className="scene-drop-line" />}
  </div>;
}
