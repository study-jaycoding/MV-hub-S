import { useLayoutEffect, useRef, useState } from "react";
import { moveItem } from "./sceneWorkspace";

export function useViewTabs<T>({ scope, read, apply, canLeave, keyOf, enabled = true }: {
  scope: string;
  read: () => T;
  apply: (view: T) => void;
  canLeave: () => boolean;
  keyOf: (view: T) => string;
  enabled?: boolean;
}) {
  const nextId = useRef(1);
  const last = useRef<{ scope: string; view: T }>();
  const live = useRef({ read, apply, canLeave });
  live.current = { read, apply, canLeave };
  const [session, setSession] = useState(() => ({
    scope, active: 0, tabs: enabled ? [{ id: 0, view: read() }] : [] as { id: number; view: T }[],
  }));
  useLayoutEffect(() => {
    setSession((old) => old.scope === scope ? old : { scope, active: nextId.current++, tabs: [] });
  }, [scope]);
  const current = enabled ? read() : last.current?.scope === scope ? last.current.view : undefined;
  // 숨겨진 주 탭이나 팝업의 필터로 이전 탭의 기억을 덮지 않는다.
  useLayoutEffect(() => {
    if (enabled && current !== undefined) last.current = { scope, view: current };
  });
  const active = session.active;
  const saved = session.scope === scope ? session.tabs : [];
  const tabs = current === undefined ? saved : saved.length === 0
    ? [{ id: active, view: current }]
    : saved.map((tab) => tab.id === active ? { ...tab, view: current } : tab);
  const capture = () => enabled
    ? tabs.map((tab) => tab.id === active ? { ...tab, view: live.current.read() } : tab)
    : tabs;
  const open = (view: T) => {
    if (!enabled) return false;
    const saved = capture();
    if (saved.some((tab) => keyOf(tab.view) === keyOf(view))) return false;
    setSession({ scope, active, tabs: [...saved, { id: nextId.current++, view }] });
    return true;
  };
  const select = (id: number) => {
    if (!enabled) return false;
    if (id === active) return true;
    if (!live.current.canLeave()) return false;
    const saved = capture();
    const target = saved.find((tab) => tab.id === id);
    if (!target) return false;
    setSession({ scope, active: id, tabs: saved });
    live.current.apply(target.view);
    return true;
  };
  const close = (id: number) => {
    if (!enabled || tabs.length === 1 || (id === active && !live.current.canLeave())) return;
    const saved = capture();
    const index = saved.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const remaining = saved.filter((tab) => tab.id !== id);
    const target = id === active ? remaining[Math.min(index, remaining.length - 1)] : undefined;
    setSession({ scope, active: target?.id ?? active, tabs: remaining });
    if (target) live.current.apply(target.view);
  };
  const reorder = (id: number, beforeId: number | null) => {
    if (!enabled) return;
    const saved = capture();
    const from = saved.findIndex((tab) => tab.id === id);
    const to = beforeId === null ? saved.length : saved.findIndex((tab) => tab.id === beforeId);
    if (from < 0 || to < 0) return;
    const next = moveItem(saved, from, to);
    if (next !== saved) setSession({ scope, active, tabs: next });
  };
  const resume = () => {
    const target = tabs.find((tab) => tab.id === active);
    if (!target) return false;
    live.current.apply(target.view);
    return true;
  };
  return { tabs, active, open, select, close, reorder, resume };
}
