// 라이브러리 필터/뷰 상태(전부 localStorage 백업) + 파생 쿼리를 App.tsx 에서 추출.
//  · 흩어진 필터/뷰 프리퍼런스(타입·색·태그·공유·최종·회색·무장태그/폴더·레이아웃·크기 등)를 한곳에 모은다.
//  · genQuery(서버 쿼리) / selectionResetKey(필터 변경 시 선택 초기화 키) 파생값도 여기서 계산.
//  · 저장은 기존 useLibraryPersistence(effect 방식) 를 그대로 내부 호출한다.
// 공개 setter 모양은 보존하되 수동 변경만 revision에 기록해 자동 따라가기 응답과 구분한다.
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Store } from "./storage";
import { useT } from "./i18n";
import type { Filters, GenQuery, WorkspaceContext } from "../types";
import { sharedWorkspaceFilter, workspaceViewKey, type SharedWorkspaceMode } from "./libraryWorkspaceScope";
import type { MediaFilter } from "./mediaTypes";
import { buildGenerationQuery } from "./appGenerationQuery";
import {
  FILTER_AUTO_TAGS_KEY,
  FILTERS_FORMAT_KEY,
  FILTERS_KEY,
  FILTERS_VIEW_KEY,
  GENERATION_SCOPE_KEY,
  LEGACY_FILTERS_KEY,
  useLibraryPersistence,
  type GenerationScope,
} from "./useLibraryPersistence";

export interface WorkspaceChip {
  id: string;
  name: string;
}

type StoredFilters = Filters & { [FILTERS_FORMAT_KEY]?: string; [FILTERS_VIEW_KEY]?: string };

/** 저장된 filters 가 어느 공간의 자동 범위에서 고른 것인지(없거나 전체 보기 중이었으면 ""). 새 키에만 있다. */
export function restoreViewKey(LS: Store): string {
  const view = LS.loadJSON<StoredFilters>(FILTERS_KEY)?.[FILTERS_VIEW_KEY];
  return typeof view === "string" ? view : "";
}

function generationScopeOf(value: Pick<Filters, "project_id" | "folder_path">): GenerationScope {
  const scope: GenerationScope = {};
  if (value.project_id) scope.project_id = value.project_id;
  if (value.folder_path) scope.folder_path = value.folder_path;
  return scope;
}

function sameGenerationScope(a: GenerationScope, b: GenerationScope): boolean {
  return a.project_id === b.project_id && a.folder_path === b.folder_path;
}

function restoreGenerationScope(LS: Store, filters: Filters): GenerationScope {
  const stored = LS.loadJSON<GenerationScope>(GENERATION_SCOPE_KEY);
  if (stored !== null && stored && typeof stored === "object") {
    return generationScopeOf(stored as Filters);
  }
  return generationScopeOf(filters);
}

function restoreFilterAutoTags(LS: Store, armedAutoTags: Set<string>): Set<string> {
  const stored = LS.loadJSON<unknown>(FILTER_AUTO_TAGS_KEY);
  if (Array.isArray(stored)) {
    return new Set(stored.filter((tag): tag is string => typeof tag === "string" && !!tag));
  }
  return new Set(armedAutoTags);
}

/** React setter 모양은 유지하면서 수동 필터 변경만 revision에 기록한다. */
function useManualState<T>(
  initial: T | (() => T),
  bump: () => void,
): [T, Dispatch<SetStateAction<T>>, (next: T) => void] {
  const [value, rawSetValue] = useState(initial);
  const valueRef = useRef(value);
  valueRef.current = value;

  const setAutomatic = useCallback((next: T) => {
    valueRef.current = next;
    rawSetValue(next);
  }, []);
  const setManual = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const previous = valueRef.current;
    const next = typeof action === "function"
      ? (action as (current: T) => T)(previous)
      : action;
    if (Object.is(previous, next)) {
      bump();
      return;
    }
    valueRef.current = next;
    rawSetValue(next);
    bump();
  }, [bump]);

  return [value, setManual, setAutomatic];
}

/** 저장값의 워크스페이스 선택을 **깨끗한 배열 하나**로 모은다.
 *  옛 단수(`workspace_id`)와 새 배열이 섞여 있어도 합치고, 빈 문자열·중복은 버린다
 *  (`loadJSON` 은 JSON 파싱만 하고 모양은 확인하지 않는다 — 손상값이 그대로 들어온다). */
function collectWorkspaceIds(stored: StoredFilters): string[] {
  const ids = new Set<string>();
  const raw = Array.isArray(stored.workspace_ids) ? stored.workspace_ids : [];
  for (const id of [...raw, stored.workspace_id]) {
    if (typeof id === "string" && id.trim()) ids.add(id);
  }
  return [...ids];
}

/** 저장된 filters 를 읽어 되살린다 — 형식별 일회성 이사를 포함한다.
 *
 *  형식 0(표식 없음): 가시성 분리(2026-08-21) 잔재 청소. 예전엔 워크스페이스 전환이
 *    `workspace_id` 필터를 자동 주입했다. 등록 침에 없는 값은 그 잔재이므로 버린다.
 *  형식 1: 단일 선택 시절. 청소 없이 배열로 옮긴다.
 *  형식 2: 지금 형식(배열).
 *
 *  ★새 키(FILTERS_KEY)가 있으면 옛 키는 아예 안 본다. 옛 릴리스는 옛 키만 쓰므로 두 버전이
 *   서로의 저장값을 망가뜨리지 않는다 — 대신 **두 버전의 선택이 실시간으로 같아지지는 않는다**.
 */
export function restoreFilters(LS: Store): Filters {
  const fresh = LS.loadJSON<StoredFilters>(FILTERS_KEY);
  const raw: StoredFilters = fresh ?? LS.loadJSON<StoredFilters>(LEGACY_FILTERS_KEY) ?? { tab: "my" };
  const { [FILTERS_FORMAT_KEY]: format, [FILTERS_VIEW_KEY]: _view, ...stored } = raw;
  if (!fresh && !format && stored.workspace_id) {
    const chips = LS.loadJSON<WorkspaceChip[]>("workspaceChips") ?? [];
    if (!chips.some((chip) => chip && chip.id === stored.workspace_id)) {
      delete stored.workspace_id;
    }
  }
  const workspaceIds = collectWorkspaceIds(stored as StoredFilters);
  delete stored.workspace_id;
  return { ...stored, ...(workspaceIds.length ? { workspace_ids: workspaceIds } : { workspace_ids: undefined }) };
}

/** 보는 **자리**를 바꾸는 키 — 탭·프로젝트·폴더·휴지통. 이 키가 든 변경만 선택을 통째로 비운다(아래 patch·selectionResetKey).
 *  그 밖의 키(검색어·W 침·생성자·공유 방향…)는 같은 자리를 다르게 거르는 '보기 필터'다 — 보이는 카드는 고른 채로 둔다. */
const LOCATION_KEYS = new Set<keyof Filters>(["tab", "project_id", "folder_path", "deleted_only", "include_deleted"]);
const isLocationPatch = (p: Partial<Filters>): boolean =>
  Object.keys(p).some((key) => LOCATION_KEYS.has(key as keyof Filters));

export function useLibraryFilters(LS: Store, workspace?: WorkspaceContext) {
  const t = useT();
  const [manualRevision, setManualRevision] = useState(0);
  // 선택을 비우는 수동 변경의 횟수 — manualRevision 과 따로 센다(28회차 ⑤-2 → 29회차 Jay "검색과 같게"): **보는 자리**(탭·프로젝트·폴더·휴지통)가
  //  바뀔 때만 오른다. 보기 필터(검색어·종류·색·태그·공유·검수·코멘트·최종·회색·자동태그·W 침)는 올리지 않는다 — 응답 전엔 옛 목록이 그대로이고
  //  (useGenerationLibraryData 는 응답이 와야 목록을 바꾼다), 결과가 오면 App 의 '목록에서 사라진 카드는 선택에서 뺀다'(규칙 42 레이아웃 효과)가
  //  결과에 없는 카드만 걷는다 — 남은 카드는 고른 채로. 전엔 보기 필터도 전부 비웠다(27회차 실측 M01 관측 — 다시 골라야 했다).
  //  manualRevision 은 어느 수동 변경이든 올린다 — Resolve 따라가기의 늦은 응답을 무효로 하는 '수동 변경'에는 보기 필터도 든다
  //  (useResolveLibraryFollow 의 문맥 키 — 검색 중에 온 옛 위치 응답이 새 검색을 덮으면 안 된다).
  const [selectionRevision, setSelectionRevision] = useState(0);
  const bumpManualRevision = useCallback((resetSelection = true) => {
    setManualRevision((value) => value + 1);
    if (resetSelection) setSelectionRevision((value) => value + 1);
  }, []);
  /** 보기 필터의 수동 변경 — 수동 횟수만 올리고 선택은 그대로(위). */
  const bumpViewFilter = useCallback(() => bumpManualRevision(false), [bumpManualRevision]);
  // 자동 따라가기가 필터를 갈아 끼운 횟수 — 상단바가 검색칸을 다시 올리는 신호로 쓴다(아래 followLocation). 검색어가 확정되기 전이면
  //  검색 값은 undefined → undefined 라 검색칸이 값으로는 초기화를 알 수 없고, 예약해 둔 검색(0.3초 뒤)이 찾아간 자리에 다시 걸렸다.
  const [followRevision, setFollowRevision] = useState(0);

  // 워크스페이스 침(옵트인 필터) 등록 목록 — 전역태그 블록에 표시, 클릭하면 workspace_id 필터 무장.
  const [workspaceChips, setWorkspaceChips] = useState<WorkspaceChip[]>(
    () => LS.loadJSON<WorkspaceChip[]>("workspaceChips") ?? [],
  );
  const [storedFilters, rawSetFilters] = useState<Filters>(() => restoreFilters(LS));
  const workspaceKey = workspace ? workspaceViewKey(workspace) : "";
  // 전체 보기는 이번 공간에서만 유효하다. 영속화하지 않으므로 재실행도 자동 모드다.
  //  시작 키 = 저장된 선택이 지금 공간의 자동 범위에서 고른 것이면 지금 공간(그대로 되살린다), 아니면 ""(아래에서 공간이 바뀐
  //  것으로 보고 공유 탭의 프로젝트·폴더를 지운다 — 다른 공간·전체 보기에서 고른 폴더는 지금 범위에선 빈 목록이다).
  const [sharedView, setSharedView] = useState<{ key: string; mode: SharedWorkspaceMode }>(
    () => ({ key: workspaceKey && restoreViewKey(LS) === workspaceKey ? workspaceKey : "", mode: "auto" }),
  );
  let filters = storedFilters;
  if (sharedView.key !== workspaceKey) {
    setSharedView({ key: workspaceKey, mode: "auto" });
    if (storedFilters.tab === "team") {
      // 렌더 중 문맥 전환을 확정해 옛 폴더+새 공간의 중간 조회를 만들지 않는다.
      // 생성 목적지(generationScope)에는 쓰지 않는 표시 전용 변경이다.
      filters = { ...storedFilters, project_id: undefined, folder_path: undefined,
        deleted_only: undefined, include_deleted: undefined, creator_uid: undefined };
      rawSetFilters(filters);
    }
  }
  const sharedMode = sharedView.key === workspaceKey ? sharedView.mode : "auto";
  const workspaceScopeKey = workspace && filters.tab === "team"
    ? JSON.stringify([workspaceKey, sharedMode]) : "";
  const workspaceQueryReady = !workspace || filters.tab !== "team" || sharedMode === "all" ||
    workspace.scope === "personal" || (workspace.scope === "team" && !!workspace.id);
  // 공유 탭에 **들어가면** 갖게 될 공간 범위 키와 '확정된 자동 공간인가' — 지금 탭과 무관하게 센다(공유 탭의 마지막 자리 기억의 문맥 — App).
  const teamScopeKey = JSON.stringify([workspaceKey, sharedMode]);
  const teamAutoReady = !!workspace && sharedMode === "auto" &&
    (workspace.scope === "personal" || (workspace.scope === "team" && !!workspace.id));
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const [generationScope, rawSetGenerationScope] = useState<GenerationScope>(
    () => restoreGenerationScope(LS, storedFilters),
  );
  const generationScopeRef = useRef(generationScope);
  generationScopeRef.current = generationScope;
  // 되살린 자리 표식(2026-10-13 ① Codex 3차 P2): 뒤로 가기·공유 탭 기억으로 **보기만** 옮긴 자리는 생성 위치와 우연히 같아도 App 의 '낡은 프로젝트'
  //  효과가 지우지 않는다(사이드바 목록에 없다고 지워진 것이 아니다). 눌러서 자리를 고르면(commitGenerationScope) 표식이 내린다.
  const restoredLocationRef = useRef(false);

  const commitGenerationScope = useCallback((next: GenerationScope) => {
    restoredLocationRef.current = false;
    if (sameGenerationScope(generationScopeRef.current, next)) return false;
    generationScopeRef.current = next;
    rawSetGenerationScope(next);
    return true;
  }, []);

  const setFilters = useCallback<Dispatch<SetStateAction<Filters>>>((action) => {
    const previous = filtersRef.current;
    const next = typeof action === "function"
      ? (action as (current: Filters) => Filters)(previous)
      : action;
    // useAppNavigation의 마운트 시 동일 객체 반환은 수동 조작이 아니다.
    if (Object.is(previous, next)) return;
    if (
      previous.project_id !== next.project_id
      || previous.folder_path !== next.folder_path
    ) {
      commitGenerationScope(generationScopeOf(next));
    }
    filtersRef.current = next;
    rawSetFilters(next);
    // 자리 키가 바뀐 setFilters(탭 전환·폴더 이동 — useAppNavigation)만 선택을 비운다. W 침 토글(App 의 toggleWorkspaceChip)처럼 보기 필터만 바꾸는
    //  setFilters 는 patch 와 같이 고른 카드를 둔다(Codex 2차 리뷰 P2).
    bumpManualRevision([...LOCATION_KEYS].some((key) => previous[key] !== next[key]));
  }, [bumpManualRevision, commitGenerationScope]);

  const [typeFilter, setTypeFilter, setTypeFilterAutomatic] = useManualState<MediaFilter>(
    () => (LS.get("typeFilter", "all") as MediaFilter) || "all",
    bumpViewFilter,
  ); // 전체/이미지/영상/음성
  // 카드 크기 배율 — 저장값은 툴바 슬라이더의 범위(LibraryToolbar 의 0.7~1.7)로 잘라 읽는다. 범위 밖 값(옛 저장·손상)은 슬라이더로는
  //  만들 수도 고칠 수도 없는데 그대로 쓰였다: 0.7 미만이면 리스트 보기의 줄(300×배율)이 낮아져 선택 칸이 C 단추에 가릴 수 있다
  //  (조작 점검 7회 R37). 숫자가 아니거나 0 이하면 기본값. 캔버스 줌(0.3~2.5)은 이 값이 아니다 — 건드리지 않는다.
  const [scale, setScale] = useState(() => {
    const saved = Number(LS.get("scale", "1"));
    return Number.isFinite(saved) && saved > 0 ? Math.min(1.7, Math.max(0.7, saved)) : 1;
  });
  const [fill, setFill] = useState(() => LS.get("fill", "1") !== "0"); // cover ↔ contain
  const [layout, setLayout] = useState<"grid" | "list">(() =>
    LS.get("layout", "grid") === "list" ? "list" : "grid",
  );
  const [showFilters, setShowFilters] = useState(() => LS.get("showFilters", "1") !== "0");
  const [groupByDate, setGroupByDate] = useState(() => LS.get("groupByDate", "0") === "1");
  const [colorFilter, setColorFilter, setColorFilterAutomatic] = useManualState<Set<string>>(
    () => LS.loadSet("colorFilter"), bumpViewFilter,
  );
  const [sharedOnly, setSharedOnly, setSharedOnlyAutomatic] = useManualState(
    () => LS.get("sharedOnly", "0") === "1", bumpViewFilter,
  );
  const [reviewFilter, setReviewFilter] = useManualState<"shared" | "held">(
    () => LS.get("reviewFilter", "shared") === "held" ? "held" : "shared", bumpViewFilter,
  );
  const [tagFilter, setTagFilter, setTagFilterAutomatic] = useManualState<Set<string>>(
    () => LS.loadSet("tagFilter"), bumpViewFilter,
  );
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const [commentOnly, setCommentOnly, setCommentOnlyAutomatic] = useManualState(
    () => LS.get("commentOnly", "0") === "1", bumpViewFilter,
  ); // 미확인 코멘트만
  const [finalOnly, setFinalOnly, setFinalOnlyAutomatic] = useManualState(
    () => LS.get("finalOnly", "0") === "1", bumpViewFilter,
  ); // 최종(골드)만
  const [grayOn, setGrayOn, setGrayOnAutomatic] = useManualState(
    () => LS.get("grayOn", "0") === "1", bumpViewFilter,
  ); // 비활성(회색) 숨김
  const [armedAutoTags, rawSetArmedAutoTags] = useState<Set<string>>(
    () => LS.loadSet("armedAutoTags"),
  );
  const armedAutoTagsRef = useRef(armedAutoTags);
  armedAutoTagsRef.current = armedAutoTags;
  const [filterAutoTags, rawSetFilterAutoTags] = useState<Set<string>>(
    () => restoreFilterAutoTags(LS, armedAutoTags),
  );
  const filterAutoTagsRef = useRef(filterAutoTags);
  filterAutoTagsRef.current = filterAutoTags;
  const [armedFolder, setArmedFolder] = useState<{ projectId: string; path: string } | null>(
    () => LS.loadJSON<{ projectId: string; path: string }>("armedFolder") ?? null,
  );

  const patch = useCallback((p: Partial<Filters>) => {
    const next = { ...filtersRef.current, ...p };
    // 위치 키가 명시된 클릭은 화면이 이미 그 폴더여도 다음 생성 위치 채택 의사다.
    if (
      Object.prototype.hasOwnProperty.call(p, "project_id")
      || Object.prototype.hasOwnProperty.call(p, "folder_path")
    ) {
      commitGenerationScope(generationScopeOf(next));
    }
    filtersRef.current = next;
    rawSetFilters(next);
    // 자리를 바꾸는 변경만 선택을 비운다(위 selectionRevision 주석) — 검색어·W 침 같은 보기 필터는 보이는 카드를 고른 채로 둔다.
    bumpManualRevision(isLocationPatch(p));
  }, [bumpManualRevision, commitGenerationScope]);

  // 보는 자리만 되살린다(브라우저 뒤로·앞으로 가기, 공유 탭의 마지막 자리 기억 — 2026-10-13 ①②): 다음 생성 위치(generationScope)·무장 폴더는 건드리지
  //  않는다(그것은 사이드바·컷 카드를 **눌러** 들어갈 때만 바뀐다). 자리가 바뀌니 선택은 비우고 수동 횟수도 올린다 — 늦게 온 Resolve 따라가기 응답이
  //  되살린 자리를 덮지 않게(Codex 설계 검토). 같은 자리면 아무 일도 없다.
  const restoreLocation = useCallback((location: GenerationScope & { deleted_only?: boolean; include_deleted?: boolean }) => {
    const previous = filtersRef.current;
    const deletedOnly = location.deleted_only || undefined; // 휴지통 보기도 자리다(없으면 지운다 — 기록에서 돌아온 일반 목록)
    const includeDeleted = location.include_deleted || undefined;
    if (
      previous.project_id === location.project_id && previous.folder_path === location.folder_path &&
      previous.deleted_only === deletedOnly && previous.include_deleted === includeDeleted
    ) return;
    const next = {
      ...previous, project_id: location.project_id, folder_path: location.folder_path, deleted_only: deletedOnly, include_deleted: includeDeleted,
    };
    filtersRef.current = next;
    restoredLocationRef.current = true;
    rawSetFilters(next);
    bumpManualRevision();
  }, [bumpManualRevision]);

  const setSharedWorkspaceMode = useCallback((mode: SharedWorkspaceMode) => {
    setSharedView({ key: workspaceKey, mode });
    // 다른 공간의 폴더에서 자동 모드로 복귀해 빈 교집합이 되는 것을 막는다.
    const next = { ...filtersRef.current, project_id: undefined, folder_path: undefined,
      deleted_only: undefined, include_deleted: undefined, creator_uid: undefined };
    filtersRef.current = next;
    rawSetFilters(next);
    bumpManualRevision();
  }, [workspaceKey, bumpManualRevision]);

  // 기존 공개 setter도 같은 updater를 두 집합에 적용해 이전 호출부의 동작을 보존한다.
  const setArmedAutoTags = useCallback<Dispatch<SetStateAction<Set<string>>>>((action) => {
    const previousArmed = armedAutoTagsRef.current;
    const previousFilter = filterAutoTagsRef.current;
    const nextArmed = typeof action === "function" ? action(previousArmed) : new Set(action);
    const nextFilter = typeof action === "function" ? action(previousFilter) : new Set(action);
    if (Object.is(previousArmed, nextArmed) && Object.is(previousFilter, nextFilter)) {
      bumpViewFilter();
      return;
    }
    armedAutoTagsRef.current = nextArmed;
    filterAutoTagsRef.current = nextFilter;
    rawSetArmedAutoTags(nextArmed);
    rawSetFilterAutoTags(nextFilter);
    bumpViewFilter();
  }, [bumpViewFilter]);

  const toggleAutoTag = useCallback((tag: string) => {
    if (!tag) return;
    const turnOn = !filterAutoTagsRef.current.has(tag);
    const nextFilter = new Set(filterAutoTagsRef.current);
    const nextArmed = new Set(armedAutoTagsRef.current);
    if (turnOn) {
      nextFilter.add(tag);
      nextArmed.add(tag);
    } else {
      nextFilter.delete(tag);
      nextArmed.delete(tag);
    }
    filterAutoTagsRef.current = nextFilter;
    armedAutoTagsRef.current = nextArmed;
    rawSetFilterAutoTags(nextFilter);
    rawSetArmedAutoTags(nextArmed);
    bumpViewFilter();
  }, [bumpViewFilter]);

  const followLocation = useCallback((location: GenerationScope) => {
    const previous = filtersRef.current;
    const nextFilters: Filters = { tab: previous.tab, ...location,
      ...(workspace && previous.tab === "team" ? { workspace_ids: previous.workspace_ids } : {}) };
    filtersRef.current = nextFilters;
    rawSetFilters(nextFilters);
    setFollowRevision((value) => value + 1);
    setTypeFilterAutomatic("all");
    setColorFilterAutomatic(new Set());
    setTagFilterAutomatic(new Set());
    const emptyAutoTags = new Set<string>();
    filterAutoTagsRef.current = emptyAutoTags;
    rawSetFilterAutoTags(emptyAutoTags);
    setSharedOnlyAutomatic(false);
    setCommentOnlyAutomatic(false);
    setFinalOnlyAutomatic(false);
    setGrayOnAutomatic(false);
  }, [
    setColorFilterAutomatic,
    setCommentOnlyAutomatic,
    setFinalOnlyAutomatic,
    setGrayOnAutomatic,
    setSharedOnlyAutomatic,
    setTagFilterAutomatic,
    setTypeFilterAutomatic,
    workspace,
  ]);

  // 흩어진 필터 상태(filters + 인스턴트 필터)를 서버 쿼리 하나로 합친다(서버가 전량 거름 → 무한스크롤).
  const genQuery = useMemo<GenQuery>(
    () => {
      const query = buildGenerationQuery({
        filters,
        typeFilter,
        colorFilter,
        tagFilter,
        armedAutoTags: filterAutoTags,
        sharedOnly,
        reviewFilter,
        commentOnly,
        finalOnly,
      });
      if (!workspace || filters.tab !== "team") return query;
      // 저장된 수동 W 필터는 다른 탭을 위해 보존하고 공유 조회에만 자동 범위를 입힌다.
      return { ...query, workspace_ids: undefined, workspace_id: undefined,
        ...(sharedMode === "auto" ? sharedWorkspaceFilter(workspace) : {}) };
    },
    [filters, typeFilter, colorFilter, tagFilter, filterAutoTags, sharedOnly, reviewFilter, commentOnly, finalOnly,
      workspace, sharedMode],
  );
  // 자동 따라가기는 기존 수동 선택을 보존하고, 수동 필터 조작만 선택/비동기 응답을 무효화한다.
  const selectionResetKey = workspaceScopeKey ? JSON.stringify([selectionRevision, workspaceScopeKey]) : String(selectionRevision);
  const workspaceFollow = workspace && filters.tab === "team" ? {
    mode: sharedMode,
    label: workspace.scope === "personal" ? t("개인") : workspace.name || t("확인 중"),
    pending: !workspaceQueryReady,
    onChange: setSharedWorkspaceMode,
  } : undefined;

  useLibraryPersistence({
    armedAutoTags,
    armedFolder,
    colorFilter,
    filterAutoTags,
    workspaceChips,
    commentOnly,
    fill,
    filters,
    finalOnly,
    generationScope,
    grayOn,
    groupByDate,
    layout,
    scale,
    sharedOnly,
    reviewFilter,
    showFilters,
    store: LS,
    tagFilter,
    typeFilter,
    viewKey: sharedMode === "auto" ? workspaceKey : "",
  });

  return {
    filters, setFilters, patch, restoreLocation, restoredLocationRef,
    generationScope, followLocation, manualRevision, followRevision,
    teamScopeKey, teamAutoReady,
    typeFilter, setTypeFilter,
    scale, setScale,
    fill, setFill,
    layout, setLayout,
    showFilters, setShowFilters,
    groupByDate, setGroupByDate,
    colorFilter, setColorFilter,
    sharedOnly, setSharedOnly,
    reviewFilter, setReviewFilter,
    tagFilter, setTagFilter,
    tagPanelOpen, setTagPanelOpen,
    commentOnly, setCommentOnly,
    finalOnly, setFinalOnly,
    grayOn, setGrayOn,
    armedAutoTags, setArmedAutoTags,
    filterAutoTags, toggleAutoTag,
    armedFolder, setArmedFolder,
    workspaceChips, setWorkspaceChips,
    genQuery, selectionResetKey, workspaceFollow, workspaceScopeKey, workspaceQueryReady,
  };
}
