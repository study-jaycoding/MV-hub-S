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
import type { Filters, GenQuery } from "../types";
import type { MediaFilter } from "./mediaTypes";
import { buildGenerationQuery } from "./appGenerationQuery";
import {
  FILTER_AUTO_TAGS_KEY,
  FILTERS_FORMAT_KEY,
  FILTERS_KEY,
  GENERATION_SCOPE_KEY,
  LEGACY_FILTERS_KEY,
  useLibraryPersistence,
  type GenerationScope,
} from "./useLibraryPersistence";

export interface WorkspaceChip {
  id: string;
  name: string;
}

type StoredFilters = Filters & { [FILTERS_FORMAT_KEY]?: string };

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
  const { [FILTERS_FORMAT_KEY]: format, ...stored } = raw;
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

export function useLibraryFilters(LS: Store) {
  const [manualRevision, setManualRevision] = useState(0);
  const bumpManualRevision = useCallback(() => setManualRevision((value) => value + 1), []);

  // 워크스페이스 침(옵트인 필터) 등록 목록 — 전역태그 블록에 표시, 클릭하면 workspace_id 필터 무장.
  const [workspaceChips, setWorkspaceChips] = useState<WorkspaceChip[]>(
    () => LS.loadJSON<WorkspaceChip[]>("workspaceChips") ?? [],
  );
  const [filters, rawSetFilters] = useState<Filters>(() => restoreFilters(LS));
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const [generationScope, rawSetGenerationScope] = useState<GenerationScope>(
    () => restoreGenerationScope(LS, filters),
  );
  const generationScopeRef = useRef(generationScope);
  generationScopeRef.current = generationScope;

  const commitGenerationScope = useCallback((next: GenerationScope) => {
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
    bumpManualRevision();
  }, [bumpManualRevision, commitGenerationScope]);

  const [typeFilter, setTypeFilter, setTypeFilterAutomatic] = useManualState<MediaFilter>(
    () => (LS.get("typeFilter", "all") as MediaFilter) || "all",
    bumpManualRevision,
  ); // 전체/이미지/영상/음성
  const [scale, setScale] = useState(() => Number(LS.get("scale", "1")) || 1); // 카드 크기 배율
  const [fill, setFill] = useState(() => LS.get("fill", "1") !== "0"); // cover ↔ contain
  const [layout, setLayout] = useState<"grid" | "list">(() =>
    LS.get("layout", "grid") === "list" ? "list" : "grid",
  );
  const [showFilters, setShowFilters] = useState(() => LS.get("showFilters", "1") !== "0");
  const [groupByDate, setGroupByDate] = useState(() => LS.get("groupByDate", "0") === "1");
  const [colorFilter, setColorFilter, setColorFilterAutomatic] = useManualState<Set<string>>(
    () => LS.loadSet("colorFilter"), bumpManualRevision,
  );
  const [sharedOnly, setSharedOnly, setSharedOnlyAutomatic] = useManualState(
    () => LS.get("sharedOnly", "0") === "1", bumpManualRevision,
  );
  const [tagFilter, setTagFilter, setTagFilterAutomatic] = useManualState<Set<string>>(
    () => LS.loadSet("tagFilter"), bumpManualRevision,
  );
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const [commentOnly, setCommentOnly, setCommentOnlyAutomatic] = useManualState(
    () => LS.get("commentOnly", "0") === "1", bumpManualRevision,
  ); // 미확인 코멘트만
  const [finalOnly, setFinalOnly, setFinalOnlyAutomatic] = useManualState(
    () => LS.get("finalOnly", "0") === "1", bumpManualRevision,
  ); // 최종(골드)만
  const [grayOn, setGrayOn, setGrayOnAutomatic] = useManualState(
    () => LS.get("grayOn", "0") === "1", bumpManualRevision,
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
    bumpManualRevision();
  }, [bumpManualRevision, commitGenerationScope]);

  // 기존 공개 setter도 같은 updater를 두 집합에 적용해 이전 호출부의 동작을 보존한다.
  const setArmedAutoTags = useCallback<Dispatch<SetStateAction<Set<string>>>>((action) => {
    const previousArmed = armedAutoTagsRef.current;
    const previousFilter = filterAutoTagsRef.current;
    const nextArmed = typeof action === "function" ? action(previousArmed) : new Set(action);
    const nextFilter = typeof action === "function" ? action(previousFilter) : new Set(action);
    if (Object.is(previousArmed, nextArmed) && Object.is(previousFilter, nextFilter)) {
      bumpManualRevision();
      return;
    }
    armedAutoTagsRef.current = nextArmed;
    filterAutoTagsRef.current = nextFilter;
    rawSetArmedAutoTags(nextArmed);
    rawSetFilterAutoTags(nextFilter);
    bumpManualRevision();
  }, [bumpManualRevision]);

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
    bumpManualRevision();
  }, [bumpManualRevision]);

  const followLocation = useCallback((location: GenerationScope) => {
    const nextFilters: Filters = { tab: filtersRef.current.tab, ...location };
    filtersRef.current = nextFilters;
    rawSetFilters(nextFilters);
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
  ]);

  // 흩어진 필터 상태(filters + 인스턴트 필터)를 서버 쿼리 하나로 합친다(서버가 전량 거름 → 무한스크롤).
  const genQuery = useMemo<GenQuery>(
    () =>
      buildGenerationQuery({
        filters,
        typeFilter,
        colorFilter,
        tagFilter,
        armedAutoTags: filterAutoTags,
        sharedOnly,
        commentOnly,
        finalOnly,
      }),
    [filters, typeFilter, colorFilter, tagFilter, filterAutoTags, sharedOnly, commentOnly, finalOnly],
  );
  // 자동 따라가기는 기존 수동 선택을 보존하고, 수동 필터 조작만 선택/비동기 응답을 무효화한다.
  const selectionResetKey = String(manualRevision);

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
    showFilters,
    store: LS,
    tagFilter,
    typeFilter,
  });

  return {
    filters, setFilters, patch,
    generationScope, followLocation, manualRevision,
    typeFilter, setTypeFilter,
    scale, setScale,
    fill, setFill,
    layout, setLayout,
    showFilters, setShowFilters,
    groupByDate, setGroupByDate,
    colorFilter, setColorFilter,
    sharedOnly, setSharedOnly,
    tagFilter, setTagFilter,
    tagPanelOpen, setTagPanelOpen,
    commentOnly, setCommentOnly,
    finalOnly, setFinalOnly,
    grayOn, setGrayOn,
    armedAutoTags, setArmedAutoTags,
    filterAutoTags, toggleAutoTag,
    armedFolder, setArmedFolder,
    workspaceChips, setWorkspaceChips,
    genQuery, selectionResetKey,
  };
}
