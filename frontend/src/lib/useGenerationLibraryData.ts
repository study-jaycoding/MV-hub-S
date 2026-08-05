import { useCallback, useEffect, useRef, useState } from "react";
import { api, GEN_PAGE } from "../api";
import { EMPTY_FACETS } from "./appConstants";
import { beginLibraryReload, finishLibraryReload } from "./librarySync";
import { reconcileArrayState, reconcileValueState } from "./stateReconciliation";
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
  const lastLoadedTabRef = useRef<string | null>(null); // 현재 gens 가 어느 탭 데이터인지
  // 탭별 마지막 목록 캐시 — 탭을 오갈 때 이전에 보던 그 탭 화면을 '즉시' 띄우고(딜레이 제거),
  // 뒤에서 fetch 가 최신본으로 조용히 갱신한다. sig(쿼리 직렬화)가 다르면(필터 초기화 등) 캐시를 안 쓴다.
  const tabCacheRef = useRef<Record<string, { gens: Generation[]; hasMore: boolean; sig: string }>>({});
  // reload 코얼레싱 — 이미 실행 중이면 새 호출을 큐에 '병합'해 동시 네트워크를 1개로 줄인다.
  // reloadSeqRef 가 정합성(최신 결과만 반영)을 보장하므로, 여기선 중복 요청만 없앤다.
  const inflightRef = useRef<Promise<void> | null>(null);
  const pendingArgsRef = useRef<{ silent: boolean; light: boolean } | null>(null);
  const pendingResolversRef = useRef<Array<() => void>>([]);

  // 목록이 바뀌면(삭제·태그·컬러·추가 로드 등) 현재 탭 캐시도 동기화 —
  // 탭을 오갔다 돌아와도 방금 편집한 결과가 캐시 화면에 그대로 보이게.
  useEffect(() => {
    const t = lastLoadedTabRef.current;
    if (!t) return;
    const c = tabCacheRef.current[t];
    if (c) tabCacheRef.current[t] = { ...c, gens, hasMore };
  }, [gens, hasMore]);

  // ★탭이 바뀌면 '그 자리에서' 화면 컨텍스트를 전환 — 진행 중 reload(코얼레싱 큐)가 끝나길 기다리면
  //  이전 탭 카드가 새 탭에 남는다(코덱스 P1). 캐시(sig 일치)가 있으면 즉시 그 탭 목록, 없으면 비움.
  //  이후 fetch(seq 가드)가 최신본으로 갱신한다. 첫 마운트(null)는 초기 로드에 맡긴다.
  useEffect(() => {
    const tab = filters.tab;
    if (tab === "compose") return; // 캔버스는 그리드를 안 그림 — 표시 컨텍스트 유지
    if (lastLoadedTabRef.current === null || lastLoadedTabRef.current === tab) return;
    lastLoadedTabRef.current = tab;
    const sig = JSON.stringify([!!filtersRef.current.deleted_only, genQueryRef.current]);
    const cached = tabCacheRef.current[tab];
    if (cached && cached.sig === sig) {
      setGens(cached.gens);
      setHasMore(cached.hasMore);
      setLoading(false);
    } else {
      setGens([]);
      setHasMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.tab]);

  const runReload = useCallback(async (silent: boolean, light: boolean) => {
    if (!authReadyRef.current) return;
    const syncToken = beginLibraryReload();
    let syncFinished = false;
    const finishSync = (applied: boolean) => {
      if (syncFinished) return;
      syncFinished = true;
      finishLibraryReload(syncToken, applied);
    };
    try {
      // 시작 시점의 탭/쿼리를 스냅샷 — await 뒤 ref가 다른 탭 값으로 바뀌어 있어도 안전.
      const tab = filtersRef.current.tab;
      if (tab === "compose") {
        setLoading(false);
        // 캔버스(구성)탭은 그리드를 안 그리지만, 좌측 폴더 사이드바(ProjectSection)엔 projects가 필요하다.
        // 예전엔 여기서 전부 return해, 새로고침 후 캔버스에선 폴더 트리가 비어 보이다가(라이브러리 방문
        // 전까지) 다른 탭을 왕복해야 떴다. projects/미분류 수만 가볍게 로드한다(그리드·facets는 스킵).
        const seq = ++reloadSeqRef.current;
        try {
          // 반드시 await해야 reload 코얼레싱이 이 요청이 끝날 때까지 실행 중으로 본다. fire-and-forget이면
          // 연속 synced가 프로젝트 요청을 동시에 띄우고 seq를 서로 무효화해 폴더가 늦게 나타난다.
          const pr = await api.projects("my");
          if (seq !== reloadSeqRef.current || !pr) return;
          setProjects((prev) => reconcileArrayState(prev, pr.projects));
          setUnassignedCount(pr.unassigned);
          setArchivedCount(pr.archived_count ?? 0);
          projectsLoadedRef.current = true;
          finishSync(true);
        } catch {
          // 캔버스는 기존 프로젝트 캐시를 유지하고 다음 sync/focus에서 재시도한다.
        }
        return;
      }
      if (!silent) setLoading(true);
      const seq = ++reloadSeqRef.current;
      const query = genQueryRef.current;
      const trashMode = !!filtersRef.current.deleted_only;
      const scope = tab === "team" ? "team" : "my";
      const sig = JSON.stringify([trashMode, query]);
      // 탭 전환의 '즉시 표시'는 위 filters.tab effect가 담당 — 여기(비동기 실행 시점)는 최신본 fetch만.
      // 1) 그리드 목록 먼저 — 도착 즉시 표시(느린 메타 호출에 그리드가 묶이지 않게).
      try {
        const g = trashMode
          ? await api.listTrash(query.search, 0)
          : await api.listGenerations(query, null);
        if (seq !== reloadSeqRef.current) return;
        setGens((prev) => reconcileArrayState(prev, g));
        setHasMore(g.length >= GEN_PAGE);
        lastLoadedTabRef.current = tab;
        tabCacheRef.current[tab] = { gens: g, hasMore: g.length >= GEN_PAGE, sig };
        // 이 목록 요청을 시작하기 전에 성공한 내 변경 id들은 이제 화면 데이터에 포함됐다.
        finishSync(true);
      } catch (e) {
        if (seq === reloadSeqRef.current) flash("로드 실패: " + String(e));
      } finally {
        if (!silent && seq === reloadSeqRef.current) setLoading(false);
      }
      // 2) 메타(실패수·안읽음 배지·facets·projects)는 뒤따라 — 실패해도 그리드 표시엔 영향 없음.
      const now = Date.now();
      const wantStats = !light || now - lastStatsAtRef.current > 10000; // stats는 비싸 10초 스로틀
      const [st, f, pr] = await Promise.all([
        wantStats ? api.generationStats().catch(() => null) : Promise.resolve(null),
        light ? Promise.resolve(null) : api.facets(scope).catch(() => null),
        light ? Promise.resolve(null) : api.projects(scope).catch(() => null),
      ]);
      if (seq !== reloadSeqRef.current) return;
      if (st) {
        setStats((prev) => reconcileValueState(prev, st));
        lastStatsAtRef.current = now;
      }
      if (f) setFacets((prev) => reconcileValueState(prev, f));
      if (pr) {
        setProjects((prev) => reconcileArrayState(prev, pr.projects));
        setUnassignedCount(pr.unassigned);
        setArchivedCount(pr.archived_count ?? 0);
        projectsLoadedRef.current = true;
      }
    } finally {
      // 실패·탭/필터 전환으로 결과가 폐기된 reload는 변경을 덮었다고 표시하지 않는다.
      finishSync(false);
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
      // 시작 시점 seq 스냅샷 — 응답이 오기 전에 탭/필터가 바뀌었으면(reload 가 seq 를 올림) 폐기.
      // 가드 없이는 '내 작업' 추가 페이지가 팀 탭 목록에 합쳐지고 탭 캐시까지 오염된다(코덱스 P1).
      const seq = reloadSeqRef.current;
      const trashMode = !!filtersRef.current.deleted_only;
      let batch: Generation[];
      if (trashMode) {
        batch = await api.listTrash(genQueryRef.current.search, gensRef.current.length);
      } else {
        const last = gensRef.current[gensRef.current.length - 1];
        const cursor = last ? { ts: last.sort_ts ?? 0, id: last.id } : null;
        batch = await api.listGenerations(genQueryRef.current, cursor);
      }
      if (seq !== reloadSeqRef.current) return; // 다른 탭/쿼리로 바뀐 뒤 도착한 이전 컨텍스트 페이지
      // ★gens 누적 캡(A5)은 넣지 않는다(코덱스 리뷰로 폐기): 앞부분 트림이 휴지통 offset 페이지네이션·
      //  virtua 스크롤 앵커·focusIdx(인덱스 기반)·선택 Set 을 동시에 깨뜨린다. 항목당 메타 수 KB 뿐이고
      //  진짜 메모리(썸네일 비트맵·DOM)는 가상 스크롤이 이미 상한 — 실이득 대비 회귀 위험이 커서 제외.
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
    setFacets,
    setGens,
    stats,
    unassignedCount,
  };
}
