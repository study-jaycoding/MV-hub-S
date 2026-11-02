import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Project } from "../../types";
import { sceneKeepApi, sceneKeepErrorMessage, type SceneKeepRow } from "../../lib/sceneKeep";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { useModalFocus } from "../../lib/keyGate";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { CloseIcon, GridIcon, ListIcon } from "../common/ViewIcons";
import { WorkspaceMark } from "../common/WorkspaceMark";
import { HostConfirm } from "../common/HostConfirm";

function Preview({ row }: { row: SceneKeepRow }) {
  return <span className="scene-keep-preview" aria-hidden="true">{row.preview.map(([kind, x, y, w, h], i) =>
    <span key={i} className={`scene-minimap-card k-${kind}`} style={{ left: `${x / 10}%`, top: `${y / 10}%`, width: `${w / 10}%`, height: `${h / 10}%` }} />
  )}</span>;
}

function KeepTitle({ row }: { row: SceneKeepRow }) {
  return <span className="scene-keep-item-title">
    {row.project_id && row.workspace?.id && <WorkspaceMark id={row.workspace.id} label={row.workspace.name ?? "?"} className="sm" />}
    <span className="scene-keep-item-name">{row.name}</span>
  </span>;
}

function DescriptionButton({ description, onOpen }: { description: string; onOpen: () => void }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => setMore(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [description]);
  return <button type="button" className={`scene-keep-item-desc${more ? " more" : ""}`}
    onClick={event => { event.stopPropagation(); onOpen(); }}>
    <span ref={textRef}>{description}</span>
  </button>;
}

function DescriptionWindow({ row, onClose }: { row: SceneKeepRow; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref);
  useEscapeClose(onClose, true, true, true);
  return <div className="admin-confirm-backdrop" onMouseDown={onClose}>
    <div ref={ref} className="admin-confirm scene-keep-desc-window" role="dialog" aria-modal="true" aria-label="보관본 설명" onMouseDown={event => event.stopPropagation()}>
      <header className="scene-keep-desc-head"><KeepTitle row={row} /><button type="button" className="assets-x" title="닫기" onClick={onClose}><CloseIcon /></button></header>
      <div className="scene-keep-desc-body">{row.description}</div>
    </div>
  </div>;
}

export function SceneKeepWindow({ scope, projects, onOpen, onClose }: {
  scope: string; projects: Project[]; onOpen: (id: string) => Promise<void>; onClose: () => void;
}) {
  const [rows, setRows] = useState<SceneKeepRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SceneKeepRow | null>(null);
  const [reading, setReading] = useState<SceneKeepRow | null>(null);
  const [menu, setMenu] = useState<{ row: SceneKeepRow; x: number; y: number } | null>(null);
  const [view, setView] = useState<"grid" | "list">(() => {
    try { return localStorage.getItem(STORAGE_KEYS.sceneKeepView) === "list" ? "list" : "grid"; } catch { return "grid"; }
  });
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  useModalFocus(ref, !deleting && !reading);
  useEscapeClose(() => { if (!busy) onClose(); });
  useEscapeClose(() => setMenu(null), !!menu, true, true);
  useModalFocus(menuRef, !!menu);
  useEffect(() => {
    let active = true;
    void sceneKeepApi.list(scope).then(items => { if (active) setRows(items); }, e => { if (active) setError(sceneKeepErrorMessage(e, "보관함을 불러오지 못했습니다.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [scope]);
  const groups = useMemo(() => {
    const result = new Map<string, { name: string; count: number; workspace: SceneKeepRow["workspace"] }>();
    for (const row of rows) {
      const item = result.get(row.project_id);
      if (item) item.count++;
      else result.set(row.project_id, { name: projects.find(p => p.id === row.project_id)?.name ?? row.project_name ?? "프로젝트 없음", count: 1, workspace: row.workspace });
    }
    return [...result];
  }, [rows, projects]);
  const visible = rows.filter(row => projectId === null || row.project_id === projectId);
  const openMenu = (row: SceneKeepRow, x: number, y: number) => { setSelected(row.id); setMenu({ row, x, y }); };
  async function perform(action: () => Promise<void>) {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (e) { setError(sceneKeepErrorMessage(e, "처리하지 못했습니다.")); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <>
    <div className="admin-backdrop" onMouseDown={() => { if (!busy && !deleting && !reading) onClose(); }} />
    <div ref={ref} className="admin-window scene-keep-window" role="dialog" aria-modal="true" aria-label="보관함">
      <header className="admin-head"><span className="admin-title">보관함</span><button className="assets-x" title="닫기" disabled={busy} onClick={onClose}><CloseIcon /></button></header>
      <nav className="admin-tabs" aria-label="프로젝트">
        <button className={`admin-tab${projectId === null ? " on" : ""}`} onClick={() => { setProjectId(null); setSelected(null); }}>전체 <span>{rows.length}</span></button>
        {groups.map(([id, group]) => <button key={id} className={`admin-tab${projectId === id ? " on" : ""}`} onClick={() => { setProjectId(id); setSelected(null); }}>
          {id && group.workspace?.id && <WorkspaceMark id={group.workspace.id} label={group.workspace.name ?? "?"} className="sm" />}{group.name} <span>{group.count}</span>
        </button>)}
      </nav>
      <div className="admin-body">
        <div className="scene-keep-toolbar">
          <div className="layout-toggle">{(["grid", "list"] as const).map(mode => <button key={mode} title={mode === "grid" ? "이미지 보기" : "리스트 보기"} aria-pressed={view === mode} className={view === mode ? "on" : ""} onClick={() => {
            setView(mode); try { localStorage.setItem(STORAGE_KEYS.sceneKeepView, mode); } catch { /* 보기 기억 실패는 열기를 막지 않는다. */ }
          }}>{mode === "grid" ? <GridIcon /> : <ListIcon />}</button>)}</div>
        </div>
        {error && <p className="login-error" role="alert">{error}</p>}
        {loading ? <p>불러오는 중</p> : !visible.length ? <p>보관본이 없습니다.</p> : <div className={`scene-keep-items ${view}`} role="list">
          {visible.map(row => <div key={row.id} className={`scene-keep-item${selected === row.id ? " on" : ""}`} role="listitem" tabIndex={0} onClick={() => setSelected(row.id)}
            onContextMenu={event => { event.preventDefault(); openMenu(row, event.clientX, event.clientY); }}
            onKeyDown={event => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(row.id); }
            }}>
            <Preview row={row} />
            <span className="scene-keep-item-text"><KeepTitle row={row} />{row.description && <DescriptionButton description={row.description} onOpen={() => setReading(row)} />}</span>
            <span className="scene-keep-item-meta"><span>{new Date(row.updated_at).toLocaleString()}</span><span>노드 {row.node_count}개</span></span>
          </div>)}
        </div>}
      </div>
    </div>
    {menu && createPortal(<div className="preview-menu-catcher"
      onMouseDown={event => { event.stopPropagation(); setMenu(null); }}
      onContextMenu={event => { event.preventDefault(); setMenu(null); }}>
      <div ref={menuRef} className="preview-menu scene-keep-menu" role="menu"
        style={{ left: Math.max(4, Math.min(menu.x, window.innerWidth - 100)), top: Math.max(4, Math.min(menu.y, window.innerHeight - 72)) }}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".preview-menu-item:not(:disabled)")];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
        }}>
        <button type="button" role="menuitem" className="preview-menu-item open" disabled={busy} autoFocus onClick={() => {
          const row = menu.row; setMenu(null); void perform(() => onOpen(row.id));
        }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M14 3h7v7M21 3l-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" /></svg>열기</button>
        <button type="button" role="menuitem" className="preview-menu-item remove" disabled={busy} onClick={() => { setDeleting(menu.row); setMenu(null); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>삭제
        </button>
      </div>
    </div>, document.body)}
    {reading && <DescriptionWindow row={reading} onClose={() => setReading(null)} />}
    {deleting && <HostConfirm label="보관본 삭제" title="보관본 삭제" confirmLabel="삭제" onCancel={() => { if (!busy) setDeleting(null); }} onConfirm={() => void perform(async () => {
      try {
        await sceneKeepApi.remove(scope, deleting.id, deleting.revision);
        setRows(previous => previous.filter(row => row.id !== deleting.id)); setSelected(null);
      } finally { setDeleting(null); }
    })}>'{deleting.name}' 보관본을 삭제하시겠습니까?</HostConfirm>}
  </>;
}
