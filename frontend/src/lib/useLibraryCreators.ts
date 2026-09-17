import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Creator } from "../types";
import { APP_EVENTS } from "./appEvents";
import { isHttpStatus } from "./http";
import { onLibraryChanged } from "./libraryBroadcast";
import { workspaceFilterOf, type LibraryWorkspaceFilter } from "./libraryWorkspaceScope";
import { useCustomEvent } from "./useCustomEvent";

const EMPTY: Creator[] = [];
interface CreatorState {
  key: string;
  items: Creator[];
  loading: boolean;
  error: "update" | "failed" | null;
}

/** 카드의 유효 공간과 같은 서버 집계. 로딩한 카드 일부나 생성자 자신으로 집계하지 않는다. */
export function useLibraryCreators({ tab, projectId, workspaceFilter, ready = true, contextKey = "" }: {
  tab: "my" | "team";
  projectId?: string;
  workspaceFilter?: LibraryWorkspaceFilter;
  ready?: boolean;
  contextKey?: string;
}) {
  const scopeKey = JSON.stringify(workspaceFilterOf(tab === "team" ? workspaceFilter ?? {} : {}));
  const scope = useMemo<LibraryWorkspaceFilter>(() => JSON.parse(scopeKey), [scopeKey]);
  const key = JSON.stringify([tab, projectId, scopeKey, contextKey, ready]);
  const [state, setState] = useState<CreatorState | null>(null);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    if (!ready) return;
    const request = ++sequence.current;
    setState((previous) => ({ key, items: previous?.key === key ? previous.items : EMPTY,
      loading: true, error: null }));
    try {
      const items = await api.creators(tab, projectId, scope);
      if (sequence.current !== request) return;
      setState({ key, items: [...items].sort((a, b) => Number(b.is_mine) - Number(a.is_mine)),
        loading: false, error: null });
    } catch (error) {
      if (sequence.current !== request) return;
      setState({ key, items: EMPTY, loading: false, error: isHttpStatus(error, 409) ? "update" : "failed" });
    }
  }, [key, tab, projectId, scope, ready]);

  useEffect(() => {
    void reload();
    return () => { sequence.current += 1; };
  }, [reload]);
  useEffect(() => onLibraryChanged(() => { void reload(); }), [reload]);
  useCustomEvent(APP_EVENTS.libraryChanged, () => { void reload(); });

  // effect 정리 전의 렌더에서도 이전 공간·이전 계정의 행을 보이지 않는다.
  const current = ready && state?.key === key ? state : null;
  return { creators: current?.items ?? EMPTY, loading: ready && (!current || current.loading),
    error: current?.error ?? null, reload };
}
