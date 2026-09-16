import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, GEN_PAGE, type GenCursor } from "../api";
import { isLocatedQuery, locatedItems, mergeLocatedGenerations, type GenerationLocation } from "./resolveLibraryLocation";
import { EMPTY_FACETS } from "./appConstants";
import { beginLibraryReload, finishLibraryReload } from "./librarySync";
import { startLibraryRequests } from "./libraryRequestPlan";
import { reconcileArrayState, reconcileValueState } from "./stateReconciliation";
import type { Facets, Filters, GenQuery, GenStats, Generation, Project } from "../types";

interface UseGenerationLibraryDataArgs {
  authReady: boolean;
  authKey?: string;
  filters: Filters;
  flash: (message: string) => void;
  genQuery: GenQuery;
  // 사이드바 프로젝트 목록 스코프 — 실제 선택된 워크스페이스(크레딧 컨텍스트)를 따른다.
  // 생성물 목록(genQuery.workspace_id = 옵트인 침 필터)과는 별개.
  projectWorkspaceId?: string;
  // 캔버스 '폴더 보기' 창이 열려 있으면 compose 탭에서도 목록(그리드)을 조회·추가 로드한다(2026-09-09).
  //  서버 목록 API 의 tab 은 my|team 만 받으므로 compose 는 my 로 보낸다(캔버스 격자 = 내 작업).
  composeListEnabled?: boolean;
}

export const GENERATION_TAB_CACHE_FRESH_MS = 15_000;

type GenerationTabCacheEntry = {
  gens: Generation[];
  hasMore: boolean;
  sig: string;
  loadedAt: number;
  cursor?: GenCursor | null;
};

export function generationTabCacheIsFresh(
  entry: GenerationTabCacheEntry | undefined,
  sig: string,
  now = Date.now(),
  maxAge = GENERATION_TAB_CACHE_FRESH_MS,
): boolean {
  return !!entry && entry.sig === sig && now - entry.loadedAt >= 0 && now - entry.loadedAt < maxAge;
}

export function useGenerationLibraryData({
  authReady,
  authKey = "",
  filters,
  flash,
  genQuery,
  projectWorkspaceId,
  composeListEnabled = false,
}: UseGenerationLibraryDataArgs) {
  const [gens, setGens] = useState<Generation[]>([]);
  const [locatedReload, setLocatedReload] = useState(0);
  const [locatedVisibleIds, setLocatedVisibleIds] = useState<ReadonlySet<string> | null>(null);
  // Resolve의 오래된 대상은 페이지 밖에서도 보이지만, 다음 페이지 커서는 그 대상을 따라가지 않는다.
  const pageCursorRef = useRef<GenCursor | null>(null);
  const locatedRef = useRef<{ tab: "my" | "team"; location: GenerationLocation } | null>(null);
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
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
  const projectWorkspaceIdRef = useRef(projectWorkspaceId);
  projectWorkspaceIdRef.current = projectWorkspaceId;
  const composeListEnabledRef = useRef(composeListEnabled);
  composeListEnabledRef.current = composeListEnabled;
  // compose 탭의 목록 쿼리 — 서버 tab 은 my|team 뿐이라 my 로 정규화(폴더 보기 창).
  const listQuery = () => {
    const q = genQueryRef.current;
    return q.tab === "compose" ? { ...q, tab: "my" as const } : q;
  };
  const gensRef = useRef(gens);
  gensRef.current = gens;
  const loadingMoreRef = useRef(false);
  const projectsLoadedRef = useRef(false);
  const reloadSeqRef = useRef(0);
  const lastStatsAtRef = useRef(0); // stats(전역 집계) 마지막 조회 시각 — light 폴링 스로틀용
  const lastLoadedTabRef = useRef<string | null>(null); // 현재 gens 가 어느 탭 데이터인지
  // 탭별 마지막 목록 캐시 — 탭을 오갈 때 이전에 보던 그 탭 화면을 '즉시' 띄우고(딜레이 제거),
  // 뒤에서 fetch 가 최신본으로 조용히 갱신한다. sig(쿼리 직렬화)가 다르면(필터 초기화 등) 캐시를 안 쓴다.
  const tabCacheRef = useRef<Record<string, GenerationTabCacheEntry>>({});
  // reload 코얼레싱 — 이미 실행 중이면 새 호출을 큐에 '병합'해 동시 네트워크를 1개로 줄인다.
  // reloadSeqRef 가 정합성(최신 결과만 반영)을 보장하므로, 여기선 중복 요청만 없앤다.
  const inflightRef = useRef<Promise<void> | null>(null);
  const pendingArgsRef = useRef<{ silent: boolean; light: boolean } | null>(null);
  const pendingResolversRef = useRef<Array<() => void>>([]);

  const authScope = JSON.stringify([authKey, authReady]);
  const authScopeRef = useRef(authScope);
  const resetAuthRef = useRef(false);
  if (authScopeRef.current !== authScope) {
    authScopeRef.current = authScope;
    resetAuthRef.current = true;
    reloadSeqRef.current++;
    locatedRef.current = null;
    tabCacheRef.current = {};
    pageCursorRef.current = null;
    lastLoadedTabRef.current = null;
    projectsLoadedRef.current = false;
  }
  useLayoutEffect(() => {
    if (!resetAuthRef.current) return;
    resetAuthRef.current = false;
    gensRef.current = [];
    setGens([]);
    setProjects([]);
    setFacets(EMPTY_FACETS);
    setHasMore(false);
    setLoadError(null);
    setLocatedVisibleIds(null);
  }, [authScope]);

  // 목록이 바뀌면(삭제·태그·컬러·추가 로드 등) 현재 탭 캐시도 동기화 —
  // 탭을 오갔다 돌아와도 방금 편집한 결과가 캐시 화면에 그대로 보이게.
  useEffect(() => {
    const t = lastLoadedTabRef.current;
    if (!t) return;
    const c = tabCacheRef.current[t];
    if (c) tabCacheRef.current[t] = { ...c, gens, hasMore, cursor: pageCursorRef.current };
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
      pageCursorRef.current = cached.cursor ?? null;
      setHasMore(cached.hasMore);
      setLoading(false);
    } else {
      setGens([]);
      pageCursorRef.current = null;
      setHasMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.tab]);

  const queryKey = JSON.stringify(genQuery);
  useEffect(() => {
    const located = locatedRef.current;
    if (located && !isLocatedQuery(genQueryRef.current, located.tab, located.location)) {
      delete tabCacheRef.current[located.tab];
      locatedRef.current = null;
      setLocatedVisibleIds(null);
    }
  }, [queryKey]);

  const revealLocated = useCallback((tab: "my" | "team", location: GenerationLocation) => {
    const sameView = isLocatedQuery(genQueryRef.current, tab, location);
    const items = locatedItems(location, tab);
    locatedRef.current = { tab, location: { ...location, items } };
    setLocatedVisibleIds(new Set(items.map((item) => item.id)));
    reloadSeqRef.current++;
    lastLoadedTabRef.current = tab; // 왕복 중 탭 전환도 기존 즉시 전환 가드를 유지한다.
    // 같은 위치여도 캐시 때문에 권한 재검증을 건너뛰지 않는다.
    delete tabCacheRef.current[tab];
    if (!sameView) {
      pageCursorRef.current = null;
      setHasMore(false);
    }
    setGens((previous) => mergeLocatedGenerations(sameView ? previous : [], items));
    setLoadError(null);
    if (sameView) setLocatedReload((value) => value + 1);
  }, []);

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
      if (tab === "compose" && !composeListEnabledRef.current) {
        setLoading(false);
        // 캔버스는 그리드를 안 그리지만 좌측 폴더(projects)와 등록 태그 패널(facets)을 직접 사용한다.
        // 둘 다 여기서 채워야 새로고침 직후에도 다른 탭 왕복 없이 폴더·태그가 바로 보인다.
        const seq = ++reloadSeqRef.current;
        // 반드시 await해야 reload 코얼레싱이 이 요청이 끝날 때까지 실행 중으로 본다. 각 요청 실패는
        // 서로 격리해 프로젝트가 잠시 실패해도 태그는 갱신되고, 반대도 동일하게 한다.
        const [pr, f] = await Promise.all([
          api.projects("my", false, projectWorkspaceIdRef.current).catch(() => null),
          light ? Promise.resolve(null) : api.facets("my").catch(() => null),
        ]);
        if (seq !== reloadSeqRef.current) return;
        if (pr) {
          setProjects((prev) => reconcileArrayState(prev, pr.projects));
          setUnassignedCount(pr.unassigned);
          setArchivedCount(pr.archived_count ?? 0);
          projectsLoadedRef.current = true;
        }
        if (f) setFacets((prev) => reconcileValueState(prev, f));
        if (pr || f) finishSync(true);
        return;
      }
      if (!silent) {
        setLoading(true);
        setLoadError(null); // 탭·필터가 바뀐 새 로드에 이전 화면의 실패가 잠깐 비치지 않게
      }
      const seq = ++reloadSeqRef.current;
      const query = listQuery();
      const trashMode = !!filtersRef.current.deleted_only;
      const scope = tab === "team" ? "team" : "my";
      const sig = JSON.stringify([trashMode, query]);
      // 탭 전환의 '즉시 표시'는 위 filters.tab effect가 담당 — 여기(비동기 실행 시점)는 최신본 fetch만.
      // 1) 목록과 메타를 **함께 시작**한다(2026-09-12, C-6). 종전에는 목록을 다 받은 **뒤에야**
      //    메타를 시작해, 왼쪽 폴더·태그·배지가 목록 왕복(로컬 47ms·3.38MB)만큼 늦게 왔다.
      //    그리드 표시는 여전히 목록만 기다린다 — 아래에서 `list` 를 먼저 받아 그린다.
      const now = Date.now();
      const wantStats = !light || now - lastStatsAtRef.current > 10000; // stats는 비싸 10초 스로틀
      // ★요청을 띄우는 시점의 값으로 고정한다 — seq·sig 와 같은 스냅샷 규칙.
      const workspaceId = projectWorkspaceIdRef.current;
      const { list, meta } = startLibraryRequests(
        () => (trashMode ? api.listTrash(query.search, 0) : api.listGenerations(query, null)),
        wantStats ? () => api.generationStats() : null,
        light ? null : () => api.facets(scope),
        light ? null : () => api.projects(scope, false, workspaceId),
      );
      const located = locatedRef.current;
      // 共有解除・削除・移動は毎回の通常更新と一緒に再確認。古い注入カードを復活させない。
      const locationCheck = located && isLocatedQuery(query, located.tab, located.location)
        ? api.locateGenerations({
            tab: located.tab, gen_ids: located.location.focus_ids,
            project_id: located.location.project_id || "none",
            folder_path: located.location.folder_path,
          }).catch(() => null)
        : Promise.resolve(null);
      try {
        const [page, checked] = await Promise.all([list, locationCheck]);
        if (seq !== reloadSeqRef.current) return;
        const last = page[page.length - 1];
        pageCursorRef.current = last ? { ts: last.sort_ts ?? 0, id: last.id } : null;
        let g = page;
        if (located && located === locatedRef.current && isLocatedQuery(query, located.tab, located.location)) {
          const valid = checked && isLocatedQuery(query, located.tab, checked)
            ? locatedItems(checked, located.tab) : [];
          const oldIds = new Set(located.location.focus_ids);
          // locate만 일시 실패해도 정상 목록에서 확인된 행은 보존하되 Resolve 강조는 해제한다.
          g = checked ? mergeLocatedGenerations(page.filter((item) => !oldIds.has(item.id)), valid) : page;
          setLocatedVisibleIds(new Set(valid.map((item) => item.id)));
        }
        setGens((prev) => reconcileArrayState(prev, g));
        setHasMore(page.length >= GEN_PAGE);
        setLoadError(null);
        lastLoadedTabRef.current = tab;
        tabCacheRef.current[tab] = {
          gens: g,
          hasMore: page.length >= GEN_PAGE,
          cursor: pageCursorRef.current,
          sig,
          loadedAt: Date.now(),
        };
        // 이 목록 요청을 시작하기 전에 성공한 내 변경 id들은 이제 화면 데이터에 포함됐다.
        finishSync(true);
      } catch (e) {
        if (seq === reloadSeqRef.current) {
          flash("로드 실패: " + String(e));
          // 화면에 남는 실패 상태 — 빈 그리드가 "항목 없음"으로 오인되지 않게(재시도 UI 근거).
          setLoadError(String(e).replace(/^Error:\s*/, ""));
        }
      } finally {
        if (!silent && seq === reloadSeqRef.current) setLoading(false);
      }
      // 2) 메타(실패수·안읽음 배지·facets·projects)는 위에서 이미 떠 있다 — 여기서 받기만 한다.
      //    실패해도 그리드 표시엔 영향 없음(각 요청이 스스로 삼켜 null 로 온다).
      const [st, f, pr] = await meta;
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

  // 탭 왕복용 stale-while-revalidate 게이트. 같은 필터의 목록을 방금 받았다면 캐시 화면을
  // 그대로 쓰고, 팀 탭의 15초 안전망 폴링이 다음 최신화를 맡는다. 명시적 수정/재시도는 기존
  // reload()를 호출하므로 절대 생략되지 않는다.
  const reloadIfStale = useCallback(
    (maxAge = GENERATION_TAB_CACHE_FRESH_MS): Promise<void> => {
      if (!authReadyRef.current) return Promise.resolve();
      const tab = filtersRef.current.tab;
      if (tab === "compose") return reload();
      const sig = JSON.stringify([!!filtersRef.current.deleted_only, genQueryRef.current]);
      if (generationTabCacheIsFresh(tabCacheRef.current[tab], sig, Date.now(), maxAge)) {
        // 캐시를 쓰더라도 진행 중이던 '이전 탭' 요청은 무효화해야 한다 — 안 그러면 그 늦은
        // 응답이 seq 가드를 통과해 현재 탭 목록·추가 페이지·탭 캐시를 덮는다(Workspace 로
        // 돌아왔는데 Share & Review 카드가 섞여 나타남 — 코덱스 레인B P1).
        reloadSeqRef.current++;
        return Promise.resolve();
      }
      return reload();
    },
    [reload],
  );

  useEffect(() => {
    if (locatedReload) void reload(true, true);
  }, [locatedReload, reload]);

  // 캔버스 '폴더 보기' 창이 열릴 때 — 이전 탭(내 작업·팀) 카드가 남아 있으므로 비우되, 먼저 목록 소유 탭을 compose 로
  //  넘긴다. 그냥 setGens([]) 하면 위 캐시 동기화 effect 가 이전 탭 캐시를 빈 목록으로 덮어, 창을 닫고 15초 안에
  //  라이브러리로 돌아오면 '최신' 빈 캐시를 믿고 조회를 건너뛴다(코덱스 2차 P2).
  const beginComposeList = useCallback(() => {
    locatedRef.current = null;
    pageCursorRef.current = null;
    lastLoadedTabRef.current = "compose";
    setGens([]);
    setHasMore(false);
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !authReadyRef.current) return;
    if (filtersRef.current.tab === "compose" && !composeListEnabledRef.current) return;
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
        batch = await api.listGenerations(listQuery(), pageCursorRef.current);
      }
      if (seq !== reloadSeqRef.current) return; // 다른 탭/쿼리로 바뀐 뒤 도착한 이전 컨텍스트 페이지
      const last = batch[batch.length - 1];
      if (last) pageCursorRef.current = { ts: last.sort_ts ?? 0, id: last.id };
      // ★gens 누적 캡(A5)은 넣지 않는다(코덱스 리뷰로 폐기): 앞부분 트림이 휴지통 offset 페이지네이션·
      //  virtua 스크롤 앵커·focusIdx(인덱스 기반)·선택 Set 을 동시에 깨뜨린다. 항목당 메타 수 KB 뿐이고
      //  진짜 메모리(썸네일 비트맵·DOM)는 가상 스크롤이 이미 상한 — 실이득 대비 회귀 위험이 커서 제외.
      setGens((prev) => {
        if (locatedRef.current && !trashMode) return mergeLocatedGenerations(prev, batch);
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
    loadError,
    loadMore,
    loading,
    loadingMore,
    projects,
    projectsLoadedRef,
    reload,
    reloadIfStale,
    revealLocated,
    locatedVisibleIds,
    isLocatedView: !!locatedRef.current && isLocatedQuery(genQuery, locatedRef.current.tab, locatedRef.current.location),
    setFacets,
    setGens,
    beginComposeList,
    stats,
    unassignedCount,
  };
}
