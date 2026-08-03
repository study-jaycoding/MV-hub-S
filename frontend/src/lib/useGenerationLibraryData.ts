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
  // reload 코얼레싱 — 이미 실행 중이면 새 호출을 큐에 '병합'해 동시 네트워크를 1개로 줄인다.
  // reloadSeqRef 가 정합성(최신 결과만 반영)을 보장하므로, 여기선 중복 요청만 없앤다.
  const inflightRef = useRef<Promise<void> | null>(null);
  const pendingArgsRef = useRef<{ silent: boolean; light: boolean } | null>(null);
  const pendingResolversRef = useRef<Array<() => void>>([]);

  const runReload = useCallback(async (silent: boolean, light: boolean) => {
    if (!authReadyRef.current) return;
    // 시작 시점의 탭/쿼리를 스냅샷 — await 뒤 ref 가 다른 탭 값으로 바뀌어 있어도 안전.
    const tab = filtersRef.current.tab;
    if (tab === "compose") {
      setLoading(false);
      // 캔버스(구성)탭은 그리드를 안 그리지만, 좌측 폴더 사이드바(ProjectSection)엔 projects 가 필요하다.
      // 예전엔 여기서 전부 return 해, 새로고침 후 캔버스에선 폴더 트리가 비어 보이다가(라이브러리 방문
      // 전까지) 다른 탭을 왕복해야 떴다. projects/미분류 수만 가볍게 로드한다(그리드·facets 는 스킵).
      const seq = ++reloadSeqRef.current;
      api
        .projects("my")
        .then((pr) => {
          if (seq !== reloadSeqRef.current || !pr) return;
          setProjects(pr.projects);
          setUnassignedCount(pr.unassigned);
          setArchivedCount(pr.archived_count ?? 0);
          projectsLoadedRef.current = true;
        })
        .catch(() => {});
      return;
    }
    if (!silent) setLoading(true);
    const seq = ++reloadSeqRef.current;
    const query = genQueryRef.current;
    const trashMode = !!filtersRef.current.deleted_only;
    const scope = tab === "team" ? "team" : "my";
    // 1) 그리드 목록 먼저 — 도착 즉시 표시(느린 메타 호출에 그리드가 묶이지 않게).
    try {
      const g = trashMode
        ? await api.listTrash(query.search, 0)
        : await api.listGenerations(query, null);
      if (seq !== reloadSeqRef.current) return;
      setGens(g);
      setHasMore(g.length >= GEN_PAGE);
    } catch (e) {
      if (seq === reloadSeqRef.current) flash("로드 실패: " + String(e));
    } finally {
      if (!silent && seq === reloadSeqRef.current) setLoading(false);
    }
    // 2) 메타(실패수·안읽음 배지·facets·projects)는 뒤따라 — 실패해도 그리드 표시엔 영향 없음.
    const now = Date.now();
    const wantStats = !light || now - lastStatsAtRef.current > 10000; // stats 는 비싸 10초 스로틀
    const [st, f, pr] = await Promise.all([
      wantStats ? api.generationStats().catch(() => null) : Promise.resolve(null),
      light ? Promise.resolve(null) : api.facets(scope).catch(() => null),
      light ? Promise.resolve(null) : api.projects(scope).catch(() => null),
    ]);
    if (seq !== reloadSeqRef.current) return;
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
  }, [flash]);

  // 실제 실행 1건을 돌리고, 끝나면 큐에 쌓인(병합된) 다음 실행을 이어서 돌린다.
  // 병합 실행이 끝나면 그동안 대기하던 호출자들의 promise 를 resolve → awaited 호출도 '자기 요청을
  // 포함한' 실행이 끝난 뒤 신선한 데이터를 본다.
  const launch = useCallback(
    (silent: boolean, light: boolean): Promise<void> => {
      const p = runReload(silent, light).finally(() => {
        inflightRef.current = null;
        const next = pendingArgsRef.current;
        if (next) {
          pendingArgsRef.current = null;
          const resolvers = pendingResolversRef.current;
          pendingResolversRef.current = [];
          void launch(next.silent, next.light)
            .finally(() => {
              for (const r of resolvers) r();
            })
            .catch(() => {}); // 방어: runReload 는 정상 reject 안 하지만 leak 방지
        } else {
          // 체인 종료 — 무효화된(seq 불일치) non-silent run 이 남긴 스피너를 확실히 내린다.
          setLoading(false);
        }
      });
      inflightRef.current = p;
      return p;
    },
    [runReload],
  );

  const reload = useCallback(
    (silent = false, light = false): Promise<void> => {
      if (!inflightRef.current) return launch(silent, light);
      // 실행 중인 stale run 을 즉시 무효화(seq++) — 그 run 은 완료돼도 결과를 적용하지 않는다.
      //  (새 필터로 바꿨을 때 옛 필터 결과가 잠깐 번쩍이거나, 그 run 이 실패해도 잔존하지 않게.)
      reloadSeqRef.current++;
      // 큐에 병합. '강한' 옵션 우선: 하나라도 non-silent/non-light 면 그걸로(전체 로드·스피너).
      const prev = pendingArgsRef.current;
      pendingArgsRef.current = prev
        ? { silent: prev.silent && silent, light: prev.light && light }
        : { silent, light };
      return new Promise<void>((res) => pendingResolversRef.current.push(res));
    },
    [launch],
  );

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
        const next = [...prev, ...batch.filter((x) => !seen.has(x.id))];
        // 소프트 캡(A5) — 무한 스크롤 누적의 고수위 메모리 억제. 넘으면 앞(최신 쪽)부터 잘라도
        //  키셋 커서는 배열 끝(가장 오래된 것) 기준이라 다음 페이지 로딩은 정상 동작한다.
        //  맨 위 복귀는 필터/탭 전환의 reload 가 재충전(2000장 이상 내려간 드문 경우만 해당).
        const GEN_SOFT_CAP = 2000;
        return next.length > GEN_SOFT_CAP ? next.slice(next.length - GEN_SOFT_CAP) : next;
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
    setFacets,
    setGens,
    stats,
    unassignedCount,
  };
}
