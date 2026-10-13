import { useEffect } from "react";
import type { MediaFilter } from "./mediaTypes";
import type { Store } from "./storage";
import type { Filters, GenQuery } from "../types";

/** 저장된 filters 의 형식 번호. 옛 저장값에만 도는 일회성 청소(useLibraryFilters)의 기준이다. */
export const FILTERS_FORMAT = "2";
/** 형식 2 저장 키. **옛 키(`filters`)와 분리한다** — 옛 릴리스로 롤백했다 돌아오는 사이에
 *  두 버전이 같은 JSON 을 번갈아 덮어써 단수/배열이 섞이는 것을 막는다(코덱스 P2).
 *  옛 키는 지우지 않고 그대로 둔다(롤백하면 그쪽 선택이 그대로 살아 있다). */
export const FILTERS_KEY = "filtersV2";
/** 형식 2 이전의 저장 키 — 새 키가 없을 때 한 번 읽어 옮기는 데만 쓴다. */
export const LEGACY_FILTERS_KEY = "filters";
/** 형식 번호를 담는 자리 — filters 와 **같은 JSON** 에 넣어 한 번의 쓰기로 함께 남긴다.
 *  따로 두면 한쪽만 저장에 성공했을 때(Store 는 예외를 삼킨다) 둘이 어긋난다:
 *  청소된 filters 저장 실패 + 표식 저장 성공 → 다음 로드에서 옛 잔재가 되살아난다(코덱스 P2). */
export const FILTERS_FORMAT_KEY = "__v";
/** filters 를 저장할 때 **어느 공간의 자동 범위에서** 고른 것인지도 같은 JSON 에 남긴다(`[scope, id]` 문자열, 전체 보기 중이면 빈 값).
 *  다시 켤 때 같은 공간이면 공유 탭의 프로젝트·폴더 선택을 그대로 되살린다 — 전엔 첫 렌더가 늘 '공간이 바뀐 것' 으로 보고
 *  지웠다(Jay 2026-10-08 "전에 선택한 폴더를 기억해야 한다"). 다른 공간·전체 보기에서 고른 것은 전처럼 지운다. */
export const FILTERS_VIEW_KEY = "__view";
/** 현재 화면 위치와 분리한 다음 생성 목적지. 빈 객체도 유효한 "목적지 없음" 값이다. */
export const GENERATION_SCOPE_KEY = "generationScopeV1";
/** 공유 탭에서 **마지막으로 본 자리**(프로젝트·폴더) — 탭을 떠났다 공유 탭을 **직접 눌러** 돌아올 때 되살린다(Jay 2026-10-13 ①: 처음엔 프로젝트
 *  맨 위, 그 뒤로는 마지막 본 곳). 어느 문맥(계정·서버·확정된 자동 공간)에서 본 것인지 `ctx` 와 함께 둔다 — 다른 문맥의 자리는 되살리지 않는다
 *  (전체 보기·공간 미확정 중에는 저장도 복원도 안 한다). 뒤로·앞으로 가기는 이것이 아니라 브라우저 기록의 자리를 쓴다(lib/useAppNavigation). */
export const TEAM_LOCATION_KEY = "teamLocationV1";
export interface TeamLocationMemory {
  ctx: string;
  project_id?: string;
  folder_path?: string;
}
/** 생성물 목록에만 적용하는 전역 태그 필터. 빈 배열도 유효한 저장값이다. */
export const FILTER_AUTO_TAGS_KEY = "filterAutoTagsV1";

export interface GenerationScope {
  project_id?: string;
  folder_path?: string;
}

interface UseLibraryPersistenceArgs {
  armedAutoTags: Set<string>;
  armedFolder: { projectId: string; path: string } | null;
  colorFilter: Set<string>;
  workspaceChips: { id: string; name: string }[];
  commentOnly: boolean;
  fill: boolean;
  filterAutoTags?: Set<string>;
  filters: Filters;
  finalOnly: boolean;
  generationScope?: GenerationScope;
  grayOn: boolean;
  sharedOnly: boolean;
  reviewFilter?: GenQuery["review_filter"];
  showFilters: boolean;
  store: Store;
  tagFilter: Set<string>;
  typeFilter: MediaFilter;
  scale: number;
  viewKey?: string; // 공유 탭의 자동 범위 공간 키(FILTERS_VIEW_KEY) — 전체 보기 중이거나 공간이 없으면 ""
}

export function useLibraryPersistence({
  armedAutoTags,
  armedFolder,
  colorFilter,
  workspaceChips,
  commentOnly,
  fill,
  filterAutoTags = new Set<string>(),
  filters,
  finalOnly,
  generationScope = {},
  grayOn,
  scale,
  sharedOnly,
  reviewFilter = "shared",
  showFilters,
  store,
  tagFilter,
  typeFilter,
  viewKey = "",
}: UseLibraryPersistenceArgs) {
  useEffect(
    () => store.setJSON(FILTERS_KEY, {
      ...filters, [FILTERS_FORMAT_KEY]: FILTERS_FORMAT, ...(viewKey ? { [FILTERS_VIEW_KEY]: viewKey } : {}),
    }),
    [filters, store, viewKey],
  );
  useEffect(() => store.set("typeFilter", typeFilter), [store, typeFilter]);
  useEffect(() => store.set("scale", String(scale)), [scale, store]);
  useEffect(() => store.set("fill", fill ? "1" : "0"), [fill, store]);
  // 모양(`layout`·`groupByDate`)은 자리마다 기억하는 lib/usePlaceView 가 저장한다(같은 키)
  useEffect(() => store.set("showFilters", showFilters ? "1" : "0"), [showFilters, store]);
  useEffect(() => store.setSet("colorFilter", colorFilter), [colorFilter, store]);
  useEffect(() => store.set("sharedOnly", sharedOnly ? "1" : "0"), [sharedOnly, store]);
  useEffect(() => store.set("reviewFilter", reviewFilter), [reviewFilter, store]);
  useEffect(() => store.set("commentOnly", commentOnly ? "1" : "0"), [commentOnly, store]);
  useEffect(() => store.set("finalOnly", finalOnly ? "1" : "0"), [finalOnly, store]);
  useEffect(() => store.set("grayOn", grayOn ? "1" : "0"), [grayOn, store]);
  useEffect(() => store.setSet("tagFilter", tagFilter), [store, tagFilter]);
  useEffect(() => store.setSet("armedAutoTags", armedAutoTags), [armedAutoTags, store]);
  useEffect(
    () => store.setJSON(FILTER_AUTO_TAGS_KEY, [...filterAutoTags]),
    [filterAutoTags, store],
  );
  useEffect(
    () => store.setJSON(GENERATION_SCOPE_KEY, generationScope),
    [generationScope, store],
  );
  // null 도 저장 → loadJSON 이 그대로 null 로 복원(해제 상태 영속).
  useEffect(() => store.setJSON("armedFolder", armedFolder), [armedFolder, store]);
  useEffect(() => store.setJSON("workspaceChips", workspaceChips), [store, workspaceChips]);
}
