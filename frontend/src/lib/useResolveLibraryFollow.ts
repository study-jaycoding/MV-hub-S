import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Filters, Generation } from "../types";
import { locatedItems, locationFilters, type GenerationLocation } from "./resolveLibraryLocation";
import { hasWorkspaceFilter, workspaceFilterOf, type LibraryWorkspaceFilter } from "./libraryWorkspaceScope";

interface Args {
  filters: Filters;
  enabled: boolean;
  authReady: boolean;
  authKey: string;
  manualRevision: number;
  gens: Generation[];
  locatedVisibleIds?: ReadonlySet<string> | null;
  followLocation: (location: { project_id?: string; folder_path?: string }) => void;
  revealLocated: (tab: "my" | "team", location: GenerationLocation) => void;
  canFollow: () => boolean;
  workspaceFilter?: LibraryWorkspaceFilter;
  workspaceScopeKey?: string;
  onWorkspaceFilterUnsupported?: () => void;
}

type Request = { ids: string[]; truncated: boolean; seq: number; context: string };
type Focus = { ids: string[]; nonce: number; context: string; location?: GenerationLocation };

/** Resolve 이벤트만 소비한다. 목록의 수동 선택/대표/Last viewed에는 쓰지 않는다. */
export function useResolveLibraryFollow(args: Args) {
  const latest = useRef(args);
  latest.current = args;
  const context = JSON.stringify([args.filters.tab, args.enabled, args.authReady, args.authKey,
    args.manualRevision, args.workspaceScopeKey, workspaceFilterOf(args.workspaceFilter ?? {})]);
  const contextRef = useRef(context);
  const sequence = useRef(0);
  const pending = useRef<Request | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  const [focus, setFocus] = useState<Focus | null>(null);
  const unsupportedContext = useRef<string | null>(null);
  if (contextRef.current !== context) {
    contextRef.current = context;
    sequence.current++;
    pending.current = null;
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current++; pending.current = null; };
  }, []);

  const clear = useCallback(() => {
    sequence.current++;
    pending.current = null;
    setFocus(null);
  }, []);

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (pending.current && mounted.current) {
        const request = pending.current;
        pending.current = null;
        const before = latest.current;
        const tab = before.filters.tab;
        if (!before.authReady || tab === "compose") continue;
        try {
          const response = await api.locateGenerations({
            tab, gen_ids: request.ids,
            ...workspaceFilterOf(before.workspaceFilter ?? {}),
            project_id: before.filters.project_id,
            folder_path: before.filters.folder_path,
          });
          if (!mounted.current || request.seq !== sequence.current ||
              request.context !== contextRef.current || !latest.current.canFollow()) continue;
          if (hasWorkspaceFilter(before.workspaceFilter ?? {}) && response.workspace_filter_applied !== true) {
            if (unsupportedContext.current !== request.context) {
              unsupportedContext.current = request.context;
              latest.current.onWorkspaceFilterUnsupported?.();
            }
            setFocus(null);
            continue;
          }
          const items = locatedItems(response, tab, before.workspaceFilter);
          if (!items.length) { setFocus(null); continue; }
          const automatic = before.enabled && !request.truncated;
          const location = { ...response, items, focus_ids: items.map((item) => item.id) };
          if (automatic) {
            latest.current.followLocation(locationFilters(location));
            latest.current.revealLocated(tab, location);
          }
          const visibleIds = new Set(latest.current.gens.map((item) => item.id));
          setFocus({
            ids: location.focus_ids.filter((id) => automatic || visibleIds.has(id)),
            nonce: request.seq, context: request.context,
            location: automatic ? location : undefined,
          });
        } catch (error) {
          // 구버전/오프라인/접근 거부: 화면을 바꾸거나 비공개 로컬 정보를 대신 보여주지 않는다.
          if (mounted.current && request.seq === sequence.current) {
            setFocus(null);
            if (hasWorkspaceFilter(before.workspaceFilter ?? {}) && String(error).includes("409") &&
                unsupportedContext.current !== request.context) {
              unsupportedContext.current = request.context;
              latest.current.onWorkspaceFilterUnsupported?.();
            }
          }
        }
      }
    } finally { running.current = false; }
  }, []);

  const receive = useCallback((ids: string[], truncated: boolean) => {
    const seq = ++sequence.current;
    setFocus(null);
    pending.current = ids.length
      ? { ids: [...new Set(ids)].slice(0, 200), truncated, seq, context: contextRef.current }
      : null;
    if (pending.current) void drain();
  }, [drain]);

  const current = focus?.context === context ? focus : null;
  const visibleIds = useMemo(() => new Set(args.gens.map((item) => item.id)), [args.gens]);
  const highlightedIds = useMemo(() => new Set(current?.ids.filter((id) => visibleIds.has(id) &&
    (!current.location || !args.locatedVisibleIds || args.locatedVisibleIds.has(id))) ?? []),
  [current, visibleIds, args.locatedVisibleIds]);
  const firstId = current?.ids.find((id) => highlightedIds.has(id));
  return {
    receive,
    clear,
    highlightedIds,
    scrollRequest: current?.location && firstId
      ? { generationId: firstId, nonce: current.nonce } : null,
    viewedFolder: current?.location?.project_id
      ? { projectId: current.location.project_id, projectName: current.location.items[0]?.project_name || undefined,
          path: current.location.folder_path || "", nonce: current.nonce }
      : null,
  };
}
