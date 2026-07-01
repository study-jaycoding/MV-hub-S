import { useCallback, useRef, useState } from "react";
import { api, GEN_PAGE } from "../api";
import { EMPTY_FACETS } from "./appConstants";
import type { Facets, Filters, GenQuery, GenStats, Generation, Project } from "../types";

interface UseGenerationLibraryDataArgs {
  authReady: boolean;
  filters: Filters;
  flash: (message: string) => void;
  genQuery: GenQuery;
}

export function useGenerationLibraryData({
  authReady,
  filters,
  flash,
  genQuery,
}: UseGenerationLibraryDataArgs) {
  const [gens, setGens] = useState<Generation[]>([]);
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [archivedCount, setArchivedCount] = useState(0);
  const [stats, setStats] = useState<GenStats>({ failed_count: 0, has_unread: false });

  const authReadyRef = useRef(authReady);
  authReadyRef.current = authReady;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const genQueryRef = useRef(genQuery);
  genQueryRef.current = genQuery;
  const gensRef = useRef(gens);
  gensRef.current = gens;
  const loadingMoreRef = useRef(false);
  const projectsLoadedRef = useRef(false);
  const reloadSeqRef = useRef(0);
  const lastStatsAtRef = useRef(0); // stats(전역 집계) 마지막 조회 시각 — light 폴링 스로틀용

  const reload = useCallback(async (silent = false, light = false) => {
    if (!authReadyRef.current) return;
    if (filtersRef.current.tab === "compose") {
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    const seq = ++reloadSeqRef.current;
    try {
      const trashMode = !!filtersRef.current.deleted_only;
      // stats(실패수·안읽음 배지)는 전역 집계라 비쌈 — 3초 폴링(light)마다 재계산하지 않고 10초 스로틀.
      const now = Date.now();
      const wantStats = !light || now - lastStatsAtRef.current > 10000;
      const [g, st, f, pr] = await Promise.all([
        trashMode
          ? api.listTrash(genQueryRef.current.search, 0)
          : api.listGenerations(genQueryRef.current, null),
        wantStats ? api.generationStats() : Promise.resolve(null),
        light ? Promise.resolve(null) : api.facets(filtersRef.current.tab === "team" ? "team" : "my"),
        light ? Promise.resolve(null) : api.projects(filtersRef.current.tab === "team" ? "team" : "my"),
      ]);
      if (seq !== reloadSeqRef.current) return;
      setGens(g);
      setHasMore(g.length >= GEN_PAGE);
      if (st) {
        setStats(st);
        lastStatsAtRef.current = now;
      }
      if (f) setFacets(f);
      if (pr) {
        setProjects(pr.projects);
        setUnassignedCount(pr.unassigned);
        setArchivedCount(pr.archived_count ?? 0);
        projectsLoadedRef.current = true;
      }
    } catch (e) {
      if (seq === reloadSeqRef.current) flash("로드 실패: " + String(e));
    } finally {
      if (!silent && seq === reloadSeqRef.current) setLoading(false);
    }
  }, [flash]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !authReadyRef.current) return;
    if (filtersRef.current.tab === "compose") return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const trashMode = !!filtersRef.current.deleted_only;
      let batch: Generation[];
      if (trashMode) {
        batch = await api.listTrash(genQueryRef.current.search, gensRef.current.length);
      } else {
        const last = gensRef.current[gensRef.current.length - 1];
        const cursor = last ? { ts: last.sort_ts ?? 0, id: last.id } : null;
        batch = await api.listGenerations(genQueryRef.current, cursor);
      }
      setGens((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...batch.filter((x) => !seen.has(x.id))];
      });
      setHasMore(batch.length >= GEN_PAGE);
    } catch {
      /* 다음 스크롤에 재시도 */
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  return {
    archivedCount,
    facets,
    filtersRef,
    gens,
    gensRef,
    hasMore,
    loadMore,
    loading,
    loadingMore,
    projects,
    projectsLoadedRef,
    reload,
    setGens,
    stats,
    unassignedCount,
  };
}
