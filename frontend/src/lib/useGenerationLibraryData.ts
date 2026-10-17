import { createColorEditLedger, type ColorEditLedger } from "./generationColorState";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, GEN_PAGE, type GenCursor } from "../api";
import { isLocatedQuery, locatedItems, mergeLocatedGenerations, type GenerationLocation } from "./resolveLibraryLocation";
import { EMPTY_FACETS } from "./appConstants";
import { beginLibraryReload, finishLibraryReload } from "./librarySync";
import { isStructurallyEqual, reconcileArrayState, reconcileValueState } from "./stateReconciliation";
import { hasWorkspaceFilter, matchesWorkspaceFilter, workspaceFilterOf } from "./libraryWorkspaceScope";
import { t } from "./i18n";
import { timedLibraryRequest } from "./libraryRequestTimeout";
import { markLibraryStatsApplied } from "./statsFreshness";
import { API_PAUSED_MESSAGE, ApiPausedError } from "./http";
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
  workspaceScopeKey?: string;
  // 지금 화면의 자료 주인을 **실행할 때** 읽는다(App 이 커밋마다 적는다 — 83회차). 없으면 늘 이 훅의 목록이 주인이다.
  owner?: () => LibraryOwner | null;
}

/** 다시 받기가 바라는 것 — ensure = 진입(자료 확보) · check = 주기 조회·창 복귀의 확인 · invalidate = 실제로 바뀌었다(내 변경·통보·사람이 누른 다시 받기).
 *  목록에는 전처럼 같은 조회다. 걸러 보는 컷 화면이 주인이면 그쪽이 뜻대로 받는다(lib/useLocalFolderCards). 셋 다 아니면 invalidate 로 본다. */
export type LibraryIntent = "ensure" | "check" | "invalidate";
const INTENT_RANK: Record<LibraryIntent, number> = { ensure: 0, check: 1, invalidate: 2 };
/** 지금 화면의 자료 주인(App 이 커밋마다 적는다). cut = 걸러 보는 컷 화면 — 이 훅은 그 조회의 목록(200건 원문)을 보내지 않고 request 로 그쪽 갱신을 기다린다.
 *  list = 이 훅의 목록 — request 가 있으면 낱장 판정에 쓰는 걸러진 목록이다(실제 바뀜만 넘긴다). sig = 판정한 조회([휴지통, 조회] — 이 훅의 sig 꼴).
 *  cut 인데 sig 가 지금 조회와 다르면 아직 이 조회의 판정이 안 섰다 — 목록을 보내지 않고 다음 진입 요청에 맡긴다(일반 목록으로 대신 받지 않는다). */
export interface LibraryOwner {
  kind: "list" | "cut";
  sig: string;
  key: string | null; // cut: 그쪽 조회 **회차**의 키(조회 + 회차) — 결과(key)가 지금 주인의 것인지 가린다(A → B → A 의 옛 A 결과 포함)
  request: ((intent: LibraryIntent) => Promise<{ status: string; key: string | null }>) | null;
}

export const GENERATION_TAB_CACHE_FRESH_MS = 15_000;
const NO_GENS: Generation[] = []; // 탭 전환 렌더의 빈 목록 — 렌더마다 새 배열이면 쓰는 쪽의 effect 가 매번 다시 돈다
const LOCATED_VIEW = "located"; // shownSigRef 의 '위치 주입 목록' 표시 — sig(JSON 배열 글)와 겹치지 않는다

type GenerationTabCacheEntry = {
  gens: Generation[];
  hasMore: boolean;
  sig: string;
  loadedAt: number;
  cursor?: GenCursor | null;
  trashOffset?: number;
};

export function generationTabCacheIsFresh(
  entry: GenerationTabCacheEntry | undefined,
  sig: string,
  now = Date.now(),
  maxAge = GENERATION_TAB_CACHE_FRESH_MS,
): boolean {
  return !!entry && entry.sig === sig && now - entry.loadedAt >= 0 && now - entry.loadedAt < maxAge;
}

// ── 한 탭에서 한 편집과 다른 탭의 캐시 ──
//  탭마다 목록 캐시가 따로 있고, 15초 안에 돌아온 탭은 다시 받지 않는다(reloadIfStale). 편집은 지금 탭의 캐시만 고쳤다 → 다른 탭으로
//  가면 옛 값이 보였고, '작업 공간' 탭은 주기 조회도 없어 그대로 남았다(격리 실측 2026-10-11: 공유 & 리뷰에서 칠한 색이 작업 공간
//  탭에 45초 내내 없었다).
//  규칙: 편집·내 변경이 있었으면 다른 탭의 캐시는 낡은 것이다 — 다음에 그 탭으로 가면 다시 받고, 값은 서버가 준다.
//  다른 탭 캐시에 값을 **옮겨 적지 않는다**. 탭을 넘어 '같은 카드'를 프론트가 가려낼 길이 없다: 공유 & 리뷰의 카드 id 는 공유 서버의
//  것이라 로컬 id 와 다르고, job_id 로 이으면 job_id 가 같은 별개의 카드(실패한 카드와 그 정상 결과)까지 칠한다. 옮겨 적은 색은 색 장부
//  (키 = 카드 id)의 보호도 받지 못해 늦은 응답이 지우고, 그 사이의 색 키가 틀린 색을 저장했다(Codex 리뷰 2026-10-11). 개인 표시를
//  두 탭에 맞게 덧입히는 일은 백엔드가 한다. 잃는 것: 편집 뒤 처음 가는 탭의 첫 화면이 응답이 올 때까지 옛 값이다 — 그 순간의 색 키는
//  화면에 보이는 색을 기준으로 하므로 화면과 저장은 어긋나지 않는다.

// 다른 탭의 캐시를 낡은 것으로 표시한다. 낡은 캐시도 탭을 옮긴 첫 화면에는 쓰인다(탭 전환 effect·공유 탭의 공간 effect) —
//  신선하다고 믿지 않을 뿐이다. 표시가 '캐시를 비운 것'처럼 굴면 안 된다(편집할 때마다 빈 화면이 번쩍인다).
function staleOtherTabs(cache: Record<string, GenerationTabCacheEntry>, own: string | null): void {
  for (const [tab, entry] of Object.entries(cache)) {
    if (tab !== own) cache[tab] = { ...entry, loadedAt: -Infinity };
  }
}

// 이 갱신(previous → next)이 편집인가 — 있던 카드가 바뀌었거나 목록에서 빠졌다. 값이 같은 새 객체·새로 붙인 카드는 편집이 아니다
//  (짧은 탭 왕복의 '다시 받지 않기'를 깨지 않는다).
function editsExistingCards(previous: Generation[], next: Generation[]): boolean {
  const before = new Map(previous.map((generation) => [generation.id, generation]));
  for (const generation of next) {
    const was = before.get(generation.id);
    if (!was) continue;
    before.delete(generation.id);
    if (was !== generation && !isStructurallyEqual(was, generation)) return true;
  }
  return before.size > 0; // 남은 것 = 목록에서 빠진 카드
}

export function useGenerationLibraryData({
  authReady,
  authKey = "",
  filters,
  flash,
  genQuery,
  projectWorkspaceId,
  composeListEnabled = false,
  workspaceScopeKey = "",
  owner,
}: UseGenerationLibraryDataArgs) {
  const [gens, setGens] = useState<Generation[]>([]);
  const [locatedReload, setLocatedReload] = useState(0);
  const [locatedVisibleIds, setLocatedVisibleIds] = useState<ReadonlySet<string> | null>(null);
  // 위치 주입 뒤 첫 정상 목록을 적용할 때마다 하나 오른다 — 격자가 주입 카드로 먼저 내려간 뒤 그 목록에서 대상이 옮겨 갔으면 한 번 더
  //  맞추는 신호다(81회차 P2b 3-a). 그 목록이 실패하거나 조회가 바뀌면 기다림을 닫는다(주기 조회로는 오르지 않는다).
  const [locatedSettle, setLocatedSettle] = useState(0);
  const locatedSettlePendingRef = useRef(false);
  // Resolve의 오래된 대상은 페이지 밖에서도 보이지만, 다음 페이지 커서는 그 대상을 따라가지 않는다.
  const pageCursorRef = useRef<GenCursor | null>(null);
  // 휴지통은 offset 방식이다. 공간 필터로 숨긴 행도 소비한 원본 건수에 포함한다.
  const trashOffsetRef = useRef(0);
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
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  // compose 탭의 목록 쿼리 — 서버 tab 은 my|team 뿐이라 my 로 정규화(폴더 보기 창).
  const listQuery = () => {
    const q = genQueryRef.current;
    return q.tab === "compose" ? { ...q, tab: "my" as const } : q;
  };
  // 주인이 걸러 보는 컷 화면이면 그 주인과, 그 판정이 지금 조회의 것인지(settled) — 아니면 null(이 훅의 목록이 주인)
  const cutOwnerNow = (): { owner: LibraryOwner; settled: boolean } | null => {
    const own = ownerRef.current?.() ?? null;
    if (own?.kind !== "cut" || !own.request) return null;
    return { owner: own, settled: own.sig === JSON.stringify([!!filtersRef.current.deleted_only, listQuery()]) };
  };
  // 목록이 컷 화면에 자리를 내준 탭 — 그 탭의 새 첫 쪽을 적용할 때까지 화면의 목록은 지금 조회의 것이 아니다(listBehind — 같은 조회로 돌아와도:
  //  캐시 sig 는 같지만 그동안의 변경이 없다, Codex fix8 P1). 잠금·자동 조회 쉬기·더 받기 막기·실패 때 치우기가 이것을 본다.
  const asideRef = useRef<string | null>(null);
  const [asideTab, setAsideTab] = useState<string | null>(null);
  const setAside = useCallback((tab: string | null) => {
    asideRef.current = tab;
    setAsideTab(tab);
  }, []);
  // 폴더 창을 열고 닫았다 — 다음 컷 진입은 확인(check)으로(창에서 바꾼 것이 뒤의 걸러진 목록에 아직 없다)
  const recheckRef = useRef(false);
  const gensRef = useRef(gens);
  gensRef.current = gens;
  // 색 편집 장부 — 재조회의 응답이 그사이 칠한 색을 덮지 않게(lib/generationColorState). 색을 칠하는 쪽(색 단축키)이 begin/end 를 부른다.
  const colorLedger = useRef(createColorEditLedger()).current;
  const loadingMoreRef = useRef(false);
  const projectsLoadedRef = useRef(false);
  const reloadSeqRef = useRef(0);
  const lastStatsAtRef = useRef(0); // stats(전역 집계) 마지막 조회 시각 — light 폴링 스로틀용
  const lastLoadedTabRef = useRef<string | null>(null); // 현재 gens 가 어느 탭 데이터인지
  // 보이는 목록이 어느 조회의 것인가(sig) — 실패가 확정될 때 다른 조회의 목록이 남았는지 가린다(81회차 F1). 탭 캐시로는 못 가린다:
  //  휴지통 추가 조회 실패·위치 주입·폴더 창에서 지워진다(Codex 리뷰). 위치 주입 목록은 LOCATED_VIEW — 그 자리를 보는 조회의 것으로 친다.
  //  null = 빈 목록 또는 사본(사본은 staleList 가 맡는다). 목록을 갈아 끼우는 곳마다 같이 적는다.
  const shownSigRef = useRef<string | null>(null);
  const loadErrorRef = useRef(loadError);
  loadErrorRef.current = loadError;
  // ── 목록 탭의 '폴더 보기' 창을 닫을 때 먼저 보일 '본 목록 첫 쪽 사본'(Jay 2026-10-07: 닫은 직후의 빈 화면을 없앤다) ──
  //  창을 열 때 본 목록의 첫 쪽을 따로 담아 두고(backListRef), 닫을 때 그것을 먼저 그린 뒤 반드시 첫 쪽을 다시 받는다.
  //  탭 캐시(tabCacheRef)는 못 쓴다 — 창의 조회가 같은 탭 칸을 덮는다. 사본은 낡았을 수 있으므로(창에서 지우거나 공유를
  //  바꾼 카드) staleList 가 켜진 동안 화면은 조작을 막는다. staleList 는 **지금 문맥의 첫 쪽 응답을 실제로 적용한 순간**
  //  (성공·실패)에만 끈다 — 조회 Promise 의 종료(버려진 응답·메타 대기 포함)에 묶으면 안 된다(Codex 설계 검토).
  //  사본은 창을 열 때마다 새로 담고 꺼내는 길은 닫기 하나뿐이라, 문맥(탭·계정·공간)이 바뀌어도 낡은 칸이 쓰일 일은 없다.
  const backListRef = useRef<{ key: string; gens: Generation[] } | null>(null);
  const [staleList, setStaleListState] = useState(false);
  const staleListRef = useRef(false);
  const setStaleList = useCallback((on: boolean) => {
    staleListRef.current = on;
    setStaleListState(on);
  }, []);
  // 지금 문맥의 새 첫 쪽을 적용할 때마다 하나씩 오른다 — 목록과 같은 때에 다시 받아야 하는 것(공유 탭의 폴더 카드)의 신호.
  //  목록 배열은 내용이 같으면 그대로 두므로(reconcileArrayState), 배열이 바뀌었는지로는 '다시 받았다' 를 알 수 없다.
  const [listRevision, setListRevision] = useState(0);
  // 탭별 마지막 목록 캐시 — 탭을 오갈 때 이전에 보던 그 탭 화면을 '즉시' 띄우고(딜레이 제거),
  // 뒤에서 fetch 가 최신본으로 조용히 갱신한다. sig(쿼리 직렬화)가 다르면(필터 초기화 등) 캐시를 안 쓴다.
  const tabCacheRef = useRef<Record<string, GenerationTabCacheEntry>>({});
  // 밖에서 들어오는 목록 편집의 통로 — 이 훅이 돌려주는 setGens(색·태그·공간 지정·진행 통지 …). 지금 탭의 캐시는 아래 effect 가
  //  맞추고, 다른 탭의 캐시는 여기서 낡은 것으로 표시한다(위 '한 탭에서 한 편집과 다른 탭의 캐시'). 이 훅 안의 목록 교체(재조회
  //  응답·탭 전환)는 편집이 아니라 원래의 setGens 를 쓴다.
  //  updater 안에서 캐시(ref)를 고친다: 같은 편집이 두 번 계산돼도(StrictMode·버려진 렌더) 결과가 같다.
  //  아직 믿고 있는 다른 탭 캐시가 없으면 비교도 하지 않는다 — 탭 하나만 쓸 때·이미 낡은 것으로 표시한 뒤의 편집에 비용을 얹지 않는다.
  const editGens = useCallback<Dispatch<SetStateAction<Generation[]>>>((action) => {
    setGens((previous) => {
      const next = typeof action === "function" ? action(previous) : action;
      const cache = tabCacheRef.current;
      const own = lastLoadedTabRef.current;
      const trusted = Object.entries(cache).some(([tab, entry]) => tab !== own && entry.loadedAt !== -Infinity);
      if (next !== previous && trusted && editsExistingCards(previous, next)) staleOtherTabs(cache, own);
      return next;
    });
  }, []);
  // reload 코얼레싱 — 이미 실행 중이면 새 호출을 큐에 '병합'해 동시 네트워크를 1개로 줄인다.
  // reloadSeqRef 가 정합성(최신 결과만 반영)을 보장하므로, 여기선 중복 요청만 없앤다.
  // ★줄은 둘이다(2026-10-07): 아래 셋은 **목록 줄** — 한 실행의 목록 구간(첫 쪽 + 위치 확인)이 끝날 때까지만 잡는다.
  const inflightRef = useRef<Promise<void> | null>(null);
  const pendingArgsRef = useRef<{ silent: boolean; light: boolean; intent: LibraryIntent } | null>(null);
  const pendingResolversRef = useRef<Array<() => void>>([]);
  // **앞지르기**(2026-10-13 Jay "아직 폴더 이동할 때 딜레이") — 조회(자리·필터·탭)가 바뀌었는데 앞 실행의 목록이 아직 안 왔으면, 그것이 끝나길
  //  기다리지 않고 줄을 바로 넘겨받는다. 앞 실행의 목록은 어차피 seq 로 버려진다 — 기다리면 새 폴더의 목록이 에피소드의 첫 쪽(200장)이나
  //  주기 조회만큼 늦는다. **같은 조회를 다시 받는 것은 전처럼 줄을 선다**(동시 요청 하나로 합치기는 그대로).
  //  줄을 잡은 실행의 조회(sig)와 그 실행을 앞지르는 길을 적어 둔다. 앞지른 요청은 취소하지 못한다(api 에 signal 이 없다) — 그래서
  //  **동시에 떠 있는 목록 요청은 둘까지**(낡은 것 하나 + 지금 것): 낡은 요청이 아직 떠 있는 동안 또 옮기면 전처럼 줄을 선다. 느린 서버에서
  //  폴더를 연달아 옮겨 낡은 요청이 연결을 차지하면 정작 마지막 조회가 늦는다(Codex 31회차 설계 검토). 낡은 요청 수는 줄을 넘길 때가 아니라
  //  그 목록 구간이 **실제로 끝날 때** 내린다.
  const laneSigRef = useRef<string | null>(null);
  const laneOvertakeRef = useRef<(() => void) | null>(null);
  const overtakenFlightsRef = useRef(0);
  // **메타 줄** — 메타 묶음(통계·태그·폴더)은 따로 줄을 선다. 목록 줄이 메타까지 잡고 있으면 다음 실행의 목록이 앞 실행의
  //  메타가 끝날 때까지 출발하지 못한다(폴더 창을 닫은 뒤 카드가 한참 안 눌리던 원인 — 메타가 느린 순간에만 드러난다).
  //  한 번에 한 묶음만 떠 있고, 그동안 들어온 요구는 하나로 합쳐 앞 묶음이 끝난 뒤 **그때의 문맥**으로 보낸다.
  const metaBusyRef = useRef(false);
  const metaWaitersRef = useRef<Array<(applied: boolean) => void> | null>(null); // 못 보낸 요구 = 그 요구를 맡긴 호출들
  // 전체 메타(태그·폴더 포함) 요구가 아직 지금 문맥에서 처리되지 않았다 — 못 보냈든, 보낸 뒤 seq 로 버려졌든 다음 묶음이
  //  전체로 나간다(가벼운 요청이 뒤따라와도 요구를 잃지 않는다). 빚만으로 스스로 다시 보내지는 않는다 — 다음 요청이 올 때 갚는다.
  const metaOwedRef = useRef(false);
  // 지금 화면의 태그·폴더가 어느 범위(내 작업|팀 · 공간)의 것인가 — 둘 다 받았을 때만 적는다(null = 모름). 탭 캐시는 목록만 담으므로
  //  15초 안에 돌아온 탭(reloadIfStale)은 이것으로 '다른 범위의 숫자가 남았는가' 를 본다(52회차: 워크스페이스 숫자가 공유 탭에 남았다).
  const metaScopeRef = useRef<string | null>(null);
  const metaScopeKey = () => JSON.stringify([filtersRef.current.tab === "team" ? "team" : "my", projectWorkspaceIdRef.current]);

  // 목록이 바뀌면(삭제·태그·컬러·추가 로드 등) 현재 탭 캐시도 동기화 —
  // 탭을 오갔다 돌아와도 방금 편집한 결과가 캐시 화면에 그대로 보이게.
  //  layout 이고 소유 탭을 바꾸는 아래 효과들(공간 전환·탭 교체)보다 **먼저** 선언한다 — 편집과 탭 이동이 한 갱신에 묶이면 그것들이
  //  소유 탭을 먼저 바꿔, 편집한 목록이 새 탭 캐시에 적히고 편집한 탭 캐시에는 빠졌다(15초 안에 돌아오면 편집 전 색. 배포 준비 Codex
  //  리뷰 P2 — 공유 탭으로 갈 때는 공간 범위 키도 같이 바뀌어 그 효과가 먼저 돌았다, 재검토).
  useLayoutEffect(() => {
    const cachedTab = lastLoadedTabRef.current;
    if (!cachedTab) return;
    const c = tabCacheRef.current[cachedTab];
    if (c) tabCacheRef.current[cachedTab] = { ...c, gens, hasMore, cursor: pageCursorRef.current, trashOffset: trashOffsetRef.current };
  }, [gens, hasMore]);

  // 같은 공유 탭 안의 공간 전환도 비동기 응답의 문맥 경계다. 효과가 돌기 전부터 차단한다.
  const workspaceScopeRef = useRef(workspaceScopeKey);
  const resetWorkspaceRef = useRef(false);
  if (workspaceScopeRef.current !== workspaceScopeKey) {
    workspaceScopeRef.current = workspaceScopeKey;
    reloadSeqRef.current++;
    locatedRef.current = null;
    resetWorkspaceRef.current = true;
  }
  useLayoutEffect(() => {
    if (!resetWorkspaceRef.current) return;
    resetWorkspaceRef.current = false;
    setLocatedVisibleIds(null);
    if (filtersRef.current.tab !== "team") return;
    setStaleList(false); // 아래에서 목록을 이 공간의 것으로 갈아 끼운다 — 사본 구간 끝(다른 탭은 목록을 안 바꾸므로 새 첫 쪽이 풀 때까지 잠근 채 둔다)
    const sig = JSON.stringify([!!filtersRef.current.deleted_only, genQueryRef.current]);
    const cached = tabCacheRef.current.team;
    // 같은 조회(sig)의 캐시면 낡았어도 첫 화면에 쓴다 — 신선한지는 '다시 받을지'만 정한다(reloadIfStale). 이 effect 는 작업 공간에서
    //  공유 & 리뷰로 들어올 때마다 돈다(그때 공간 범위 키가 생긴다). 여기서 신선도까지 따지면 15초가 지난 캐시·편집으로 낡은 것이 된
    //  캐시를 비워, 들어올 때마다 빈 화면이 번쩍인다(격리 실측 2026-10-11: 0장인 구간 65~74ms). 다른 공간·다른 필터에서 받은
    //  캐시는 sig 가 달라 전처럼 쓰지 않는다.
    const reuse = cached?.sig === sig ? cached : undefined;
    const next = reuse?.gens ?? [];
    gensRef.current = next;
    setGens(next);
    shownSigRef.current = reuse ? sig : null;
    pageCursorRef.current = reuse?.cursor ?? null;
    trashOffsetRef.current = reuse?.trashOffset ?? 0;
    setHasMore(reuse?.hasMore ?? false);
    setLoadError(null);
    lastLoadedTabRef.current = "team";
    if (!reuse) {
      delete tabCacheRef.current.team;
      // 비운 그 자리에서 '불러오는 중'으로 — 뒤따르는 조회(호출부가 반드시 건다)가 스피너를 올리기 전의 한 번에 "항목이 없습니다"가
      //  비치지 않게(beginComposeList 와 같은 이유). 조회를 할 수 없는 상태(공간 미확인)면 올리지 않는다 — 내려 줄 조회가 없다.
      if (authReadyRef.current) setLoading(true);
    }
  }, [workspaceScopeKey]);

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
    trashOffsetRef.current = 0;
    lastLoadedTabRef.current = null;
    projectsLoadedRef.current = false;
  }
  useLayoutEffect(() => {
    if (!resetAuthRef.current) return;
    resetAuthRef.current = false;
    gensRef.current = [];
    setGens([]);
    shownSigRef.current = null;
    setProjects([]);
    setFacets(EMPTY_FACETS);
    setHasMore(false);
    setLoadError(null);
    setLocatedVisibleIds(null);
    setStaleList(false);
    setAside(null); // 목록을 비웠다 — 보이는 사본이 없다
  }, [authScope]);

  // ★탭이 바뀌면 '그 자리에서' 화면 컨텍스트를 전환 — 진행 중 reload(코얼레싱 큐)가 끝나길 기다리면
  //  이전 탭 카드가 새 탭에 남는다(코덱스 P1). 캐시(sig 일치)가 있으면 즉시 그 탭 목록, 없으면 비움.
  //  이후 fetch(seq 가드)가 최신본으로 갱신한다. 첫 마운트(null)는 초기 로드에 맡긴다.
  //  그리기 전에(layout) 갈아 끼운다 — 그린 뒤에 하면 새 탭 아래 이전 탭 목록이 한 번 칠해졌다(69회차 격리 실측: 공유 탭 컷 카드 화면 →
  //  워크스페이스에서 153ms 에 공유 목록, 206ms 에 내 목록). 읽는 ref 들은 렌더 중에 갱신돼 여기서 이미 최신이다.
  useLayoutEffect(() => {
    const tab = filters.tab;
    if (tab === "compose") return; // 캔버스는 그리드를 안 그림 — 표시 컨텍스트 유지
    if (lastLoadedTabRef.current === null || lastLoadedTabRef.current === tab) return;
    lastLoadedTabRef.current = tab;
    setStaleList(false); // 아래에서 목록을 이 탭의 것으로 갈아 끼운다 — 사본 구간 끝
    // 실패 표시도 앞 탭의 것이다 — 남기면 신선한 캐시로 돌아온 이 탭의 첫 조용한 실패를 알리지 않았다(60회차 Codex 검토)
    loadErrorRef.current = null;
    setLoadError(null);
    const sig = JSON.stringify([!!filtersRef.current.deleted_only, genQueryRef.current]);
    const cached = tabCacheRef.current[tab];
    if (cached && cached.sig === sig) {
      setGens(cached.gens);
      shownSigRef.current = sig;
      pageCursorRef.current = cached.cursor ?? null;
      trashOffsetRef.current = cached.trashOffset ?? 0;
      setHasMore(cached.hasMore);
      setLoading(false);
    } else {
      setGens([]);
      shownSigRef.current = null;
      pageCursorRef.current = null;
      trashOffsetRef.current = 0;
      setHasMore(false);
      // 비운 그 자리에서 '불러오는 중'으로 — 그리기 전에 비우니 뒤따르는 조회가 스피너를 올리기 전의 한 번에 "항목이 없습니다"가 비쳤다
      //  (위 팀 탭 비우기·beginComposeList 와 같은 이유). 조회를 할 수 없는 상태(공간 미확인)면 올리지 않는다.
      if (authReadyRef.current) setLoading(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.tab]);

  // 탭을 막 바꾼 렌더 — 위 layout effect 가 갈아 끼우기 전의 그 한 번에도 이전 탭 목록을 내주지 않고, 갈아 끼울 것(그 탭 캐시 또는 빈 목록)을
  //  미리 내준다. 이전 탭 목록을 내주면 쓰는 쪽이 그 카드들을 새로 붙였다 곧바로 뗐다(69회차 재실측: 공유 컷 카드 화면 → 워크스페이스 클릭 직후
  //  긴 작업 약 80ms). 조건은 위 effect 와 같다 — 탭 전환이 아닌 '소유 탭' 바뀜(폴더 창의 beginComposeList)은 직전에 그린 탭과 같아 걸리지 않는다.
  const committedTabRef = useRef(filters.tab);
  useLayoutEffect(() => { committedTabRef.current = filters.tab; }, [filters.tab]);
  const swapping = filters.tab !== committedTabRef.current && filters.tab !== "compose" &&
    lastLoadedTabRef.current !== null && lastLoadedTabRef.current !== filters.tab;
  const swapCache = swapping ? tabCacheRef.current[filters.tab] : undefined;
  const swapHit = !!swapCache && swapCache.sig === JSON.stringify([!!filters.deleted_only, genQuery]);
  const shownGens = !swapping ? gens : swapHit ? swapCache!.gens : NO_GENS;
  const shownLoading = !swapping ? loading : !swapHit && authReadyRef.current; // 위 effect 가 곧 둘 값과 같게

  const queryKey = JSON.stringify(genQuery);
  useEffect(() => {
    const located = locatedRef.current;
    if (located && !isLocatedQuery(genQueryRef.current, located.tab, located.location)) {
      delete tabCacheRef.current[located.tab];
      locatedRef.current = null;
      locatedSettlePendingRef.current = false;
      setLocatedVisibleIds(null);
    }
  }, [queryKey]);

  // keepPainted = 위치 조회가 **출발할 때** 찍은 색 장부의 도장(lib/useResolveLibraryFollow). 아래 합치기는 이미 있는 카드를 응답으로
  //  갈아 끼우므로, 출발 뒤에 칠한 색을 덮지 않게 덧입힌다. 여기서(응답이 온 뒤) 찍으면 안 된다 — 저장이 이미 끝난 색을 놓친다.
  const revealLocated = useCallback((
    tab: "my" | "team", location: GenerationLocation, keepPainted?: ReturnType<ColorEditLedger["stamp"]>,
  ) => {
    const sameView = isLocatedQuery(genQueryRef.current, tab, location);
    const items = locatedItems(location, tab, genQueryRef.current);
    const visibleIds = new Set(gensRef.current.map((item) => item.id));
    const sig = JSON.stringify([!!filtersRef.current.deleted_only, genQueryRef.current]);
    // 보이는 목록이 이미 이 자리(지금 조회)의 것일 때만 거기에 합친다 — 새 자리의 목록을 기다리는 중에 따라가면 앞 조회의 카드가 이 자리의
    //  위치 목록으로 남아, 뒤따른 조회가 실패해도 걷히지 않았다(81회차 F1 Codex 재확인). 아니면 주입한 카드만 두고 커서·다음 쪽도 처음부터.
    const prevLocated = locatedRef.current;
    const keep = sameView && (shownSigRef.current === sig || (shownSigRef.current === LOCATED_VIEW && !!prevLocated &&
      isLocatedQuery(genQueryRef.current, prevLocated.tab, prevLocated.location)));
    // 선택 대상은 직전 locate에서 서버 확인했다. 필터 해제/폴더 이동이 필요 없고
    // 정상 페이지가 신선할 때만 추가 전체 재조회를 생략한다(캐시 수명은 연장하지 않는다).
    const reusePage = keep && !filtersRef.current.deleted_only &&
      lastLoadedTabRef.current === tab && !loadError &&
      !inflightRef.current && !pendingArgsRef.current && !metaBusyRef.current && !loadingMoreRef.current &&
      generationTabCacheIsFresh(tabCacheRef.current[tab], sig) &&
      items.length > 0 && items.every((item) => visibleIds.has(item.id));
    locatedRef.current = { tab, location: { ...location, items } };
    locatedSettlePendingRef.current = !reusePage; // 보던 쪽을 그대로 쓰면 기다릴 목록이 없다
    setLocatedVisibleIds(new Set(items.map((item) => item.id)));
    reloadSeqRef.current++;
    lastLoadedTabRef.current = tab; // 왕복 중 탭 전환도 기존 즉시 전환 가드를 유지한다.
    if (!reusePage) delete tabCacheRef.current[tab];
    if (!keep) {
      pageCursorRef.current = null;
      trashOffsetRef.current = 0;
      setHasMore(false);
    }
    setGens((previous) => mergeLocatedGenerations(keep ? previous : [], keepPainted ? keepPainted(items) : items));
    shownSigRef.current = LOCATED_VIEW;
    setLoadError(null);
    if (sameView && !reusePage) setLocatedReload((value) => value + 1);
  }, [loadError]);

  // 메타 묶음 한 번 — 보내는 순간의 문맥(seq·탭·공간·시각)으로 계획을 세우고, 그 seq 가 그대로일 때만 적용한다.
  //  각 요청은 실패를 스스로 삼킨다(null) — 그리드 표시에는 영향이 없고, 한 요청의 실패가 다른 것을 막지 않는다.
  //  돌려주는 값 = 태그·폴더 가운데 무엇이든 적용했는가 — 목록이 없는 캔버스 실행이 '내 변경을 반영했다'고 표시할지 정하는
  //  데만 쓴다(통계만 받은 것은 반영이 아니다 — 기다리는 사이 탭이 바뀌어 목록 탭 계획으로 나간 묶음도 같은 기준).
  const sendMeta = useCallback(async (): Promise<boolean> => {
    metaBusyRef.current = true;
    const seq = reloadSeqRef.current;
    const full = metaOwedRef.current;
    const now = Date.now();
    const tab = filtersRef.current.tab;
    const scope = tab === "team" ? "team" : "my";
    // 캔버스(목록 없음)는 좌측 폴더(projects)와 등록 태그 패널(facets)을 직접 쓴다 — 폴더는 light 여도 받고 통계는 받지 않는다.
    const bare = tab === "compose" && !composeListEnabledRef.current;
    const workspaceId = projectWorkspaceIdRef.current;
    const scopeKey = metaScopeKey();
    const ask =<T,>(wanted: boolean, fetch: () => Promise<T>): Promise<T | null> =>
      wanted && authReadyRef.current ? fetch().catch(() => null) : Promise.resolve(null);
    const [st, f, pr] = await Promise.all([
      ask(!bare && (full || now - lastStatsAtRef.current > 10000), () => api.generationStats()), // stats는 비싸 10초 스로틀
      ask(full, () => api.facets(scope)),
      ask(full || bare, () => api.projects(scope, false, workspaceId)),
    ]);
    const current = seq === reloadSeqRef.current;
    if (current) {
      if (full) {
        metaOwedRef.current = false;
        metaScopeRef.current = f && pr ? scopeKey : null;
      }
      if (st) {
        setStats((prev) => reconcileValueState(prev, st));
        lastStatsAtRef.current = now;
        markLibraryStatsApplied();
      }
      if (f) setFacets((prev) => reconcileValueState(prev, f));
      if (pr) {
        setProjects((prev) => reconcileArrayState(prev, pr.projects));
        setUnassignedCount(pr.unassigned);
        setArchivedCount(pr.archived_count ?? 0);
        projectsLoadedRef.current = true;
      }
    }
    // 그동안 쌓인 요구가 있으면 지금 문맥으로 한 번 더 — 맡긴 호출들은 그 묶음이 처리된 뒤에 풀린다.
    const waiters = metaWaitersRef.current;
    metaWaitersRef.current = null;
    if (waiters) void sendMeta().then((applied) => { for (const done of waiters) done(applied); });
    else metaBusyRef.current = false;
    return current && !!(f || pr);
  }, []);

  const requestMeta = useCallback((light: boolean): Promise<boolean> => {
    if (!light) metaOwedRef.current = true;
    if (!metaBusyRef.current) return sendMeta();
    return new Promise<boolean>((done) => { (metaWaitersRef.current ??= []).push(done); });
  }, [sendMeta]);

  // ── 걸러 보는 컷 화면이 주인일 때의 다시 받기(83회차 — Codex FH) ──
  //  이 조회의 목록(200건 원문)은 화면에 쓰이지 않는다 — 보내지 않고, 메타는 전처럼 맡긴 채 주인(걸러진 목록·서버 카드)의 갱신을 **기다린다**.
  //  목록 줄에 서지 않는다(주인 쪽 줄이 한 번에 하나를 맡는다). 내 변경 표식(syncToken)은 **그 갱신이 지금 주인의 조회에 실제로 적용됐을 때만**
  //  덮었다고 적는다 — 재사용·실패·폐기·메타만 성공은 아니다. 덮지 않은 내 변경이 있으면 ensure·check 라도 invalidate 로 올린다.
  //  이 탭의 목록 캐시는 낡은 것으로 둔다(사본으로는 쓴다) — 목록이 주인을 되찾으면 첫 쪽부터 다시 확인한다(Codex FE-09). 받던 목록·더 받기는 버린다.
  const runCut = useCallback(async (own: LibraryOwner, light: boolean, intent: LibraryIntent) => {
    if (!authReadyRef.current) return;
    const syncToken = beginLibraryReload();
    let syncFinished = false;
    const finishSync = (applied: boolean) => {
      if (syncFinished) return;
      syncFinished = true;
      finishLibraryReload(syncToken, applied);
    };
    try {
      const tab = filtersRef.current.tab;
      if (syncToken.mutationIds.size) staleOtherTabs(tabCacheRef.current, tab);
      reloadSeqRef.current++;
      const cached = tabCacheRef.current[tab];
      if (cached) tabCacheRef.current[tab] = { ...cached, loadedAt: -Infinity };
      setAside(tab);
      const metaDone = requestMeta(light);
      const done = await own.request!(syncToken.mutationIds.size ? "invalidate" : intent).catch(() => null);
      finishSync(done?.status === "applied" && done.key === own.key && cutOwnerNow()?.owner.key === own.key);
      await metaDone; // 호출자의 `await reload()` 는 맡긴 메타까지 처리된 뒤에 풀린다(목록 쪽과 같다)
    } finally {
      finishSync(false);
    }
  }, [requestMeta, setAside]);

  // listSettled = 목록 구간이 끝났다(적용·실패·폐기 모두) — 부르는 쪽(launch)이 목록 줄을 다음 실행에 넘긴다.
  const runReload = useCallback(async (silent: boolean, light: boolean, intent: LibraryIntent, listSettled: () => void) => {
    if (!authReadyRef.current) return;
    // 줄을 서는 사이 주인이 컷 화면으로 바뀌었다 — 이 조회의 목록은 보내지 않는다(판정이 안 섰으면 메타만 — 다음 진입이 맡는다)
    const cutOwner = cutOwnerNow();
    if (cutOwner) {
      listSettled();
      if (cutOwner.settled) await runCut(cutOwner.owner, light, intent);
      else await requestMeta(light);
      return;
    }
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
      // 아직 어느 목록 조회에도 담기지 않은 내 변경이 있다 — 삭제·공유·이동처럼 끝나면 지금 탭을 다시 받는 동작, 저장을 마친 색·태그.
      //  다른 탭의 캐시는 그 변경 전의 것이다. 목록 구성이 바뀌는 변경은 캐시를 고쳐서 맞출 수 없으니 다시 받게만 한다.
      if (syncToken.mutationIds.size) staleOtherTabs(tabCacheRef.current, tab);
      if (tab === "compose" && !composeListEnabledRef.current) {
        setLoading(false);
        // 캔버스는 그리드를 안 그리지만 좌측 폴더(projects)와 등록 태그 패널(facets)을 직접 사용한다.
        // 둘 다 여기서 채워야 새로고침 직후에도 다른 탭 왕복 없이 폴더·태그가 바로 보인다(무엇을 받는지는 sendMeta 의 bare).
        ++reloadSeqRef.current;
        const metaDone = requestMeta(light);
        // 목록이 없으니 목록 줄은 바로 넘긴다 — 연달아 온 요청을 하나로 합치는 일은 메타 줄이 한다.
        listSettled();
        // 반드시 await — 호출자의 `await reload()` 는 맡긴 메타가 처리된 뒤에 풀려야 한다.
        if (await metaDone) finishSync(true);
        return;
      }
      if (!silent) {
        setLoading(true);
        setLoadError(null); // 탭·필터가 바뀐 새 로드에 이전 화면의 실패가 잠깐 비치지 않게
      }
      const seq = ++reloadSeqRef.current;
      const query = listQuery();
      const trashMode = !!filtersRef.current.deleted_only;
      const sig = JSON.stringify([trashMode, query]);
      laneSigRef.current = sig; // 이 실행이 줄을 잡은 조회 — 조회가 바뀌면 reload 가 앞지른다(여기까지 await 가 없다)
      // 낱장으로 보이는 걸러진 컷 자리 — 실제 바뀜(내 변경·통보)은 낱장 판정에 쓰는 걸러진 목록에도 넘긴다(첫 쪽 밖의 변경으로 다시 컷이 될 수 있다).
      //  진입·확인은 넘기지 않는다 — 처음 낱장으로 판정돼 원문을 받는 것 자체는 새 바뀜이 아니다(같은 500건을 다시 받지 않는다).
      const side = ownerRef.current?.() ?? null;
      if ((syncToken.mutationIds.size || intent === "invalidate") && side?.kind === "list" && side.request && side.sig === sig) {
        void side.request("invalidate").catch(() => {});
      }
      // 탭 전환의 '즉시 표시'는 위 filters.tab effect가 담당 — 여기(비동기 실행 시점)는 최신본 fetch만.
      // 1) 목록과 메타를 **함께 시작**한다(2026-09-12, C-6). 종전에는 목록을 다 받은 **뒤에야**
      //    메타를 시작해, 왼쪽 폴더·태그·배지가 목록 왕복(로컬 47ms·3.38MB)만큼 늦게 왔다.
      //    그리드 표시는 목록만 기다린다. 메타는 메타 줄이 받아 적용한다 — 줄이 비어 있으면 지금 이 자리에서 출발하고,
      //    앞 묶음이 떠 있으면 그 뒤에 선다(이 실행의 목록은 그것을 기다리지 않는다).
      const keepPainted = colorLedger.stamp(); // 출발 시점을 찍는다 — 이 뒤에 칠한 색은 아래 응답이 덮지 못한다
      const list = timedLibraryRequest((signal) =>
        trashMode ? api.listTrash(query.search, 0, GEN_PAGE, signal) : api.listGenerations(query, null, GEN_PAGE, { signal }));
      const metaDone = requestMeta(light);
      const located = locatedRef.current;
      // 共有解除・削除・移動は毎回の通常更新と一緒に再確認。古い注入カードを復活させない。
      const locationCheck = located && isLocatedQuery(query, located.tab, located.location)
        ? timedLibraryRequest((signal) => api.locateGenerations({
            tab: located.tab, gen_ids: located.location.focus_ids,
            ...workspaceFilterOf(query),
            project_id: located.location.project_id || "none",
            folder_path: located.location.folder_path,
          }, signal)).catch(() => null)
        : Promise.resolve(null);
      try {
        const [page, checked] = await Promise.all([list, locationCheck]);
        if (seq !== reloadSeqRef.current) {
          // 낡은 실행 — 목록은 버린다. 다만 맡긴 메타 요구가 처리될 때까지는 끝나지 않는다(전체 요구는 다음 묶음이 이어받는다).
          finishSync(false);
          listSettled();
          await metaDone;
          return;
        }
        const last = page[page.length - 1];
        pageCursorRef.current = last ? { ts: last.sort_ts ?? 0, id: last.id } : null;
        trashOffsetRef.current = trashMode ? page.length : 0;
        let g = page.filter((item) => matchesWorkspaceFilter(item, query));
        if (located && located === locatedRef.current && isLocatedQuery(query, located.tab, located.location)) {
          const valid = checked && isLocatedQuery(query, located.tab, checked)
            ? locatedItems(checked, located.tab, query) : [];
          const oldIds = new Set(located.location.focus_ids);
          // locate만 일시 실패해도 정상 목록에서 확인된 행은 보존하되 Resolve 강조는 해제한다.
          g = checked ? mergeLocatedGenerations(g.filter((item) => !oldIds.has(item.id)), valid) : g;
          setLocatedVisibleIds(new Set(valid.map((item) => item.id)));
          if (locatedSettlePendingRef.current) {
            locatedSettlePendingRef.current = false;
            setLocatedSettle((value) => value + 1);
          }
        }
        g = keepPainted(g); // 화면·탭 캐시 둘 다 같은 값을 쓴다
        setGens((prev) => reconcileArrayState(prev, g));
        shownSigRef.current = sig;
        setHasMore(page.length >= GEN_PAGE);
        loadErrorRef.current = null; // 다시 그리기 전에 끝나는 다음 실패도 '새 실패'로 알린다(Codex 검토)
        setLoadError(null);
        setStaleList(false); // 새 첫 쪽이 들어왔다 — 사본 구간 끝(내용이 사본과 같아도 푼다)
        if (asideRef.current === tab) setAside(null); // 이 탭의 새 첫 쪽과 커서 — 지금 조회의 목록이 됐다(더 받기도 다시 연다)
        setListRevision((revision) => revision + 1);
        lastLoadedTabRef.current = tab;
        tabCacheRef.current[tab] = {
          gens: g,
          hasMore: page.length >= GEN_PAGE,
          cursor: pageCursorRef.current,
          trashOffset: trashOffsetRef.current,
          sig,
          loadedAt: Date.now(),
        };
        // 이 목록 요청을 시작하기 전에 성공한 내 변경 id들은 이제 화면 데이터에 포함됐다.
        finishSync(true);
      } catch (e) {
        if (e instanceof ApiPausedError) {
          // 다른 탭 로그아웃으로 멈췄다(4B) — 실패가 아니다. 띠가 이미 알리니 목록·실패 표시는 그대로 두고, 사람이 누른 다시 받기만 멈춤을 알린다(64회차 실측)
          if (!silent && seq === reloadSeqRef.current) flash(API_PAUSED_MESSAGE);
        } else if (seq === reloadSeqRef.current) {
          locatedSettlePendingRef.current = false; // 위치 주입 뒤 기다리던 목록이 실패했다 — 다음 성공에서 다시 맞추지 않는다
          // 조용한 다시 받기(자동 조회 — 3초·15초마다)는 이미 실패 표시가 떠 있으면 다시 알리지 않는다: 매번 알리면 다른 조작의 안내를
          //  덮었다(60회차). 사람이 직접 한 다시 받기는 전처럼 알린다. 성공하면 표시가 걷혀 다음 실패는 또 알린다.
          if (!silent || !loadErrorRef.current) flash("로드 실패: " + String(e));
          // 화면에 남는 실패 상태 — 빈 그리드가 "항목 없음"으로 오인되지 않게(재시도 UI 근거). ref 도 바로 — 다시 그리기 전에 끝나는
          //  다음 조용한 실패가 이것을 보게(Codex 검토).
          loadErrorRef.current = String(e).replace(/^Error:\s*/, "");
          setLoadError(loadErrorRef.current);
          // 사본·다른 조회의 목록(shownSigRef)을 보이던 중이면 치운다 — 낡은 목록을 지금 조회의 것처럼 남기지 않고 실패·재시도를
          //  보인다(81회차 F1). 같은 조회를 다시 받다 실패한 것이면(그 자리의 위치 주입 포함) 보던 목록을 그대로 둔다.
          const shown = shownSigRef.current;
          const sameList = shown === sig || (shown === LOCATED_VIEW && !!located && located === locatedRef.current &&
            isLocatedQuery(query, located.tab, located.location));
          //  컷 화면에 자리를 내준 뒤 되찾은 목록(asideRef)도 사본과 같다 — 같은 조회라도 그동안의 변경이 없다.
          if (staleListRef.current || asideRef.current === tab || !sameList) {
            delete tabCacheRef.current[tab]; // 비운 목록이 이 탭의 캐시로 적히지 않게(돌아오면 첫 쪽부터 다시 받는다)
            shownSigRef.current = null;
            pageCursorRef.current = null; // 앞 조회의 커서로 다음 쪽을 받지 않게
            trashOffsetRef.current = 0;
            setHasMore(false);
            setGens([]);
            setStaleList(false);
          }
        }
      } finally {
        if (!silent && seq === reloadSeqRef.current) setLoading(false);
      }
      // 2) 목록 구간 끝 — 목록 줄을 넘긴다. 다음 실행의 목록은 이 실행의 메타(실패수·안읽음 배지·facets·projects)를
      //    기다리지 않고 출발한다. 이 실행의 약속은 맡긴 메타가 처리된 뒤에 풀린다(`await reload()` 의 뜻은 그대로).
      listSettled();
      await metaDone;
    } finally {
      // 실패·탭/필터 전환으로 결과가 폐기된 reload는 변경을 덮었다고 표시하지 않는다.
      finishSync(false);
    }
  }, [flash, requestMeta, runCut, setAside, setStaleList]);

  // 실제 실행 1건을 돌리고, **목록 구간이 끝나면** 큐에 쌓인(병합된) 다음 실행을 이어서 돌린다.
  // 병합 실행이 끝나면(메타 처리까지) 그동안 대기하던 호출자들의 promise 를 resolve → awaited 호출도 '자기 요청을
  // 포함한' 실행이 끝난 뒤 신선한 데이터를 본다.
  const launch = useCallback(
    (silent: boolean, light: boolean, intent: LibraryIntent): Promise<void> => {
      // 줄 넘기기는 실행마다 한 번 — 목록 구간 끝(runReload 가 부른다)과 실행 종료 중 먼저 온 쪽. 이미 넘긴 옛 실행의
      //  종료가 그 뒤에 출발한 실행의 줄·스피너를 건드리지 않는다.
      let handed = false;
      let overtaken = false; // 앞지름당했다 — 줄은 넘겼지만 이 실행의 목록 요청은 아직 떠 있다
      const handOver = () => {
        if (handed) {
          // 앞지름당한 실행의 목록 구간이 실제로 끝났다(runReload 의 listSettled) — 떠 있는 낡은 요청 수를 내린다(한 번만)
          if (overtaken) {
            overtaken = false;
            overtakenFlightsRef.current -= 1;
          }
          return;
        }
        handed = true;
        inflightRef.current = null;
        laneSigRef.current = null;
        laneOvertakeRef.current = null;
        const next = pendingArgsRef.current;
        if (next) {
          pendingArgsRef.current = null;
          const resolvers = pendingResolversRef.current;
          pendingResolversRef.current = [];
          void launch(next.silent, next.light, next.intent)
            .finally(() => {
              for (const r of resolvers) r();
            })
            .catch(() => {}); // 방어: runReload 는 정상 reject 안 하지만 leak 방지
        } else {
          // 체인 종료 — 무효화된(seq 불일치) non-silent run 이 남긴 스피너를 확실히 내린다(silent 실행이 이어받은 것 포함).
          setLoading(false);
        }
      };
      const p = runReload(silent, light, intent, handOver).finally(handOver);
      // 목록이 없는 실행(캔버스)은 호출 도중에 이미 줄을 넘겼다 — 넘긴 줄에 자기를 다시 세우면 뒤의 요청이 영영 못 나간다.
      if (!handed) {
        inflightRef.current = p;
        laneOvertakeRef.current = () => {
          overtaken = true;
          overtakenFlightsRef.current += 1;
          handOver();
        };
      }
      return p;
    },
    [runReload],
  );

  const reload = useCallback(
    (silent = false, light = false, intent: LibraryIntent = "invalidate"): Promise<void> => {
      // 걸러 보는 컷 화면이 주인이다 — 목록 줄에 서지 않고 그쪽 갱신을 기다린다(판정이 안 섰으면 메타만 — 다음 진입이 맡는다)
      const cutOwner = cutOwnerNow();
      if (cutOwner) return cutOwner.settled ? runCut(cutOwner.owner, light, intent) : requestMeta(light).then(() => undefined);
      if (!inflightRef.current) return launch(silent, light, intent);
      // 실행 중인 stale run 을 즉시 무효화(seq++) — 그 run 은 완료돼도 결과를 적용하지 않는다.
      //  (새 필터로 바꿨을 때 옛 필터 결과가 잠깐 번쩍이거나, 그 run 이 실패해도 잔존하지 않게.)
      reloadSeqRef.current++;
      // 큐에 병합. '강한' 옵션 우선: 하나라도 non-silent/non-light 면 그걸로(전체 로드·스피너). 바람도 강한 쪽(invalidate > check > ensure).
      const prev = pendingArgsRef.current;
      pendingArgsRef.current = prev
        ? { silent: prev.silent && silent, light: prev.light && light, intent: INTENT_RANK[prev.intent] >= INTENT_RANK[intent] ? prev.intent : intent }
        : { silent, light, intent };
      const waiting = new Promise<void>((res) => pendingResolversRef.current.push(res));
      // 조회가 바뀌었다 — 줄을 잡은 실행의 목록을 기다리지 않는다(위 '앞지르기'). 줄을 넘기면 방금 세운 실행이 그 자리에서 출발한다.
      //  이미 앞지른 낡은 요청이 떠 있으면 줄을 선다(동시에 둘까지).
      const held = laneSigRef.current;
      if (held !== null && overtakenFlightsRef.current < 1 && held !== JSON.stringify([!!filtersRef.current.deleted_only, listQuery()])) {
        laneOvertakeRef.current?.();
      }
      return waiting;
    },
    [launch, requestMeta, runCut],
  );

  // 탭 왕복용 stale-while-revalidate 게이트. 같은 필터의 목록을 방금 받았다면 캐시 화면을
  // 그대로 쓰고, 팀 탭의 15초 안전망 폴링이 다음 최신화를 맡는다. 명시적 수정/재시도는 기존
  // reload()를 호출하므로 절대 생략되지 않는다.
  const reloadIfStale = useCallback(
    (maxAge = GENERATION_TAB_CACHE_FRESH_MS): Promise<void> => {
      if (!authReadyRef.current) return Promise.resolve();
      const tab = filtersRef.current.tab;
      if (tab === "compose") return reload();
      // 걸러 보는 컷 화면이 주인이면 그쪽의 진입(받는 중이면 합류 · 답이 있으면 그대로). 목록의 탭 캐시로 건너뛸지 정하지 않는다.
      //  폴더 창을 열고 닫은 뒤의 첫 진입은 확인이다 — 창에서 바꾼 것이 뒤의 걸러진 목록에 아직 없다.
      const cutOwner = cutOwnerNow();
      if (cutOwner) {
        const recheck = recheckRef.current;
        recheckRef.current = false;
        return reload(false, false, recheck ? "check" : "ensure");
      }
      const sig = JSON.stringify([!!filtersRef.current.deleted_only, genQueryRef.current]);
      if (generationTabCacheIsFresh(tabCacheRef.current[tab], sig, Date.now(), maxAge)) {
        // 캐시를 쓰더라도 진행 중이던 '이전 탭' 요청은 무효화해야 한다 — 안 그러면 그 늦은
        // 응답이 seq 가드를 통과해 현재 탭 목록·추가 페이지·탭 캐시를 덮는다(Workspace 로
        // 돌아왔는데 Share & Review 카드가 섞여 나타남 — 코덱스 레인B P1).
        reloadSeqRef.current++;
        // 목록은 캐시로 충분해도 태그·폴더는 탭마다 담아 두지 않는다 — 다른 범위의 것이 남아 있으면 그것만 다시 받는다.
        if (metaScopeRef.current !== metaScopeKey()) return requestMeta(false).then(() => undefined);
        return Promise.resolve();
      }
      return reload(false, false, "ensure");
    },
    [reload, requestMeta],
  );

  useEffect(() => {
    if (locatedReload) void reload(true, true);
  }, [locatedReload, reload]);

  // 캔버스 '폴더 보기' 창이 열릴 때 — 이전 탭(내 작업·팀) 카드가 남아 있으므로 비우되, 먼저 목록 소유 탭을 compose 로
  //  넘긴다. 그냥 setGens([]) 하면 위 캐시 동기화 effect 가 이전 탭 캐시를 빈 목록으로 덮어, 창을 닫고 15초 안에
  //  라이브러리로 돌아오면 '최신' 빈 캐시를 믿고 조회를 건너뛴다(코덱스 2차 P2).
  //  목록 탭의 폴더 창(카드의 폴더 이름표)도 열고 닫을 때 같은 이유로 이것을 부른다 — 소유 탭 표식 "compose" 는
  //  '어느 탭 캐시에도 속하지 않는 목록' 이라는 뜻으로 쓰이고, 뒤따르는 조회가 성공하면 실제 탭으로 되돌린다.
  //  비운 뒤에는 반드시 새로 받아야 한다: 지금 탭의 캐시를 지워 reloadIfStale 이 '신선한 캐시' 를 믿고 조회를 건너뛰지 못하게
  //  하고(건너뛰면 비운 채로 남는다 — 창을 열자마자 닫거나, 닫자마자 같은 폴더를 다시 열 때), 진행 중이던 조회·추가 로드의
  //  응답은 버린다(비운 목록에 옛 조건의 카드가 다시 들어오지 않게).
  //  back = 목록 탭의 폴더 창 전용. keep(열 때) = 지금 본 목록 조회의 키 — 화면의 목록이 그 조회의 첫 쪽이 확실할 때만 사본을
  //  담는다. restore(닫을 때) = 지금 본 목록 조회의 키 — 담을 때와 같으면(창에서 툴바 필터를 안 바꿨다) 사본을 먼저 그린다.
  //  어느 쪽이든 아래의 무효화(캐시 삭제·seq·커서)는 그대로라 닫은 뒤에는 반드시 첫 쪽을 다시 받는다.
  const beginComposeList = useCallback((back?: { keep?: string; restore?: string }) => {
    const tab = filtersRef.current.tab;
    let restored: Generation[] | null = null;
    if (back?.keep !== undefined) {
      // 출처 확인: 탭 캐시의 sig = 마지막으로 **적용된** 목록의 조회. 필터를 막 바꿔 새 응답을 기다리는 중이면 화면의 카드는
      //  옛 조건의 것이라 sig 가 안 맞는다(그것을 새 키로 담으면 닫을 때 엉뚱한 목록이 뜬다). 비운 직후(사본을 보이는 중 포함)에는
      //  캐시가 없어 저절로 걸러진다. 다빈치가 끼워 넣은 행이 섞인 화면(그 행은 첫 쪽이 아니다)·실패한 화면도 담지 않는다.
      const sig = JSON.stringify([!!filtersRef.current.deleted_only, genQueryRef.current]);
      const trusted = tabCacheRef.current[tab]?.sig === sig && !locatedRef.current && !loadErrorRef.current;
      backListRef.current = trusted ? { key: back.keep, gens: gensRef.current.slice(0, GEN_PAGE) } : null;
    } else if (back?.restore !== undefined && backListRef.current?.key === back.restore) {
      restored = backListRef.current.gens;
    }
    reloadSeqRef.current++;
    delete tabCacheRef.current[tab];
    locatedRef.current = null;
    pageCursorRef.current = null;
    trashOffsetRef.current = 0;
    lastLoadedTabRef.current = "compose";
    setGens(restored ?? []);
    shownSigRef.current = null;
    setHasMore(false); // 사본을 보이는 동안에도 — 옛 커서로 다음 쪽을 받지 않는다
    setStaleList(!!restored);
    recheckRef.current = true; // 창을 열고 닫았다 — 뒤가 걸러 보는 컷 화면이면 돌아온 뒤 확인한다
    // 비운 그 자리에서 '불러오는 중'으로 — 조회 effect 가 돌기 전의 한 번에 "항목이 없습니다"가 비치지 않게.
    //  뒤따르는 조회(호출부가 반드시 건다)의 묶음이 끝나면 내려간다.
    setLoading(true);
  }, [setStaleList]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !authReadyRef.current) return;
    if (staleListRef.current) return; // 사본을 보이는 중 — 커서가 없다(새 첫 쪽이 온 뒤에 이어 받는다)
    // 걸러 보는 컷 화면이 주인이거나, 주인을 막 되찾아 이 조회의 새 첫 쪽을 아직 적용하지 않았다 — 옛 커서로 더 받지 않는다(Codex FE-02)
    if (asideRef.current === filtersRef.current.tab || cutOwnerNow()) return;
    if (filtersRef.current.tab === "compose" && !composeListEnabledRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const seq = reloadSeqRef.current;
    const trashMode = !!filtersRef.current.deleted_only;
    const query = listQuery();
    const keepPainted = colorLedger.stamp(); // 아래 합치기(위치 주입분)는 이미 있는 카드를 응답으로 갈아 끼운다 — 그사이 칠한 색을 덮지 않게
    try {
      // 시작 시점 seq 스냅샷 — 응답이 오기 전에 탭/필터가 바뀌었으면(reload 가 seq 를 올림) 폐기.
      // 가드 없이는 '내 작업' 추가 페이지가 팀 탭 목록에 합쳐지고 탭 캐시까지 오염된다(코덱스 P1).
      let batch: Generation[];
      if (trashMode) {
        const offset = trashOffsetRef.current;
        batch = await timedLibraryRequest((signal) => api.listTrash(query.search, offset, GEN_PAGE, signal));
      } else {
        const cursor = pageCursorRef.current;
        batch = await timedLibraryRequest((signal) => api.listGenerations(query, cursor, GEN_PAGE, { signal }));
      }
      if (seq !== reloadSeqRef.current) return; // 다른 탭/쿼리로 바뀐 뒤 도착한 이전 컨텍스트 페이지
      if (trashMode) trashOffsetRef.current += batch.length;
      const last = batch[batch.length - 1];
      if (last) pageCursorRef.current = { ts: last.sort_ts ?? 0, id: last.id };
      const visibleBatch = batch.filter((item) => matchesWorkspaceFilter(item, query));
      // ★gens 누적 캡(A5)은 넣지 않는다(코덱스 리뷰로 폐기): 앞부분 트림이 휴지통 offset 페이지네이션·
      //  virtua 스크롤 앵커·focusIdx(인덱스 기반)·선택 Set 을 동시에 깨뜨린다. 항목당 메타 수 KB 뿐이고
      //  진짜 메모리(썸네일 비트맵·DOM)는 가상 스크롤이 이미 상한 — 실이득 대비 회귀 위험이 커서 제외.
      setGens((prev) => {
        if (locatedRef.current && !trashMode) return mergeLocatedGenerations(prev, keepPainted(visibleBatch));
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...visibleBatch.filter((x) => !seen.has(x.id))];
      });
      setHasMore(batch.length >= GEN_PAGE);
    } catch {
      // 공간 밖 행만 있으면 App이 빈 페이지를 자동으로 당긴다. 실패한 같은 offset은
      // 자동 반복하지 않고 명시적 새로고침을 기다린다. 옛 문맥의 실패는 현재 화면에 쓰지 않는다.
      if (seq === reloadSeqRef.current && trashMode && hasWorkspaceFilter(query)) {
        setHasMore(false);
        setLoadError(t("휴지통 추가 조회에 실패했습니다. 새로고침 후 다시 시도하세요."));
        // 이 탭의 캐시(빈 목록 · '더 없음')는 믿을 수 없다 — 남기면 15초 안에 돌아올 때 다시 받지 않고, 탭 전환이 걷은 실패 표시 없이
        //  '항목 없음'으로 보였다(60회차 Codex 검토). 돌아오면 첫 쪽부터 다시 받는다.
        delete tabCacheRef.current[filtersRef.current.tab];
      }
      // 일반 목록은 기존대로 다음 스크롤에 재시도한다.
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  const listBehind = filters.tab !== "compose" &&
    (tabCacheRef.current[filters.tab]?.sig !== JSON.stringify([!!filters.deleted_only, genQuery]) || asideTab === filters.tab);
  return {
    archivedCount,
    facets,
    filtersRef,
    gens: shownGens,
    gensRef,
    colorLedger,
    hasMore,
    listRevision,
    loadError,
    loadMore,
    loading: shownLoading,
    loadingMore,
    projects,
    projectsLoadedRef,
    reload,
    reloadIfStale,
    revealLocated,
    locatedVisibleIds,
    locatedSettle,
    isLocatedView: !!locatedRef.current && isLocatedQuery(genQuery, locatedRef.current.tab, locatedRef.current.location),
    // 화면의 목록이 아직 지금 조회의 것이 아니다 — 조회(자리·필터)가 바뀐 뒤 새 첫 쪽이 적용되기 전. 탭 캐시의 sig = 마지막으로 **적용된**
    //  목록의 조회다(beginComposeList 의 출처 확인과 같은 기준). 캐시를 지운 구간(위치 주입·폴더 창·실패)에도 참이라 쓰는 쪽이 그것을 가린다.
    listBehind,
    // 화면의 목록이 **컷 화면의 갱신으로 낡았다고 알려진 사본**이다 — 컷 화면이 이 탭을 갱신한 뒤 이 탭에 남아 있던(캐시에서 꺼낸) 행이고, 아직 어떤 조회의
    //  응답으로도 바뀌지 않았다. 쓰는 쪽(App)은 이것이 참인 동안 자리 이동·기다림 한도(4초)와 무관하게 조작을 잠근다 — 새 응답으로 바뀌거나(그 탭의 첫 쪽 적용)
    //  실패 정리로 비워질 때 풀린다(목록 요청은 30초 제한으로 끝난다). Codex fix8c P1.
    shownStaleCopy: asideTab === filters.tab && shownGens.length > 0,
    // 자동 조회(주기·창 복귀)를 쉴 때 — 폴더 창을 닫은 직후 옛 첫 쪽을 보이는 동안(staleList), 그리고 바뀐 조회의 첫 쪽을 받는 동안.
    //  끼어들면 받던 첫 쪽이 seq 로 버려지고 같은 목록을 한 번 더 받았다 — 직전 화면의 진행 중 카드로 3초 조회가 남아 있으면
    //  자리를 옮길 때마다 생겼다(81회차 F2-2). 실패하면 loading 이 내려가 다시 돈다.
    autoRefreshPaused: staleList || (listBehind && loading),
    setFacets,
    setGens: editGens,
    beginComposeList,
    staleList,
    stats,
    unassignedCount,
  };
}
