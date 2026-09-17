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
/** 현재 화면 위치와 분리한 다음 생성 목적지. 빈 객체도 유효한 "목적지 없음" 값이다. */
export const GENERATION_SCOPE_KEY = "generationScopeV1";
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
  groupByDate: boolean;
  layout: "grid" | "list";
  sharedOnly: boolean;
  reviewFilter?: GenQuery["review_filter"];
  showFilters: boolean;
  store: Store;
  tagFilter: Set<string>;
  typeFilter: MediaFilter;
  scale: number;
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
  groupByDate,
  layout,
  scale,
  sharedOnly,
  reviewFilter = "shared",
  showFilters,
  store,
  tagFilter,
  typeFilter,
}: UseLibraryPersistenceArgs) {
  useEffect(
    () => store.setJSON(FILTERS_KEY, { ...filters, [FILTERS_FORMAT_KEY]: FILTERS_FORMAT }),
    [filters, store],
  );
  useEffect(() => store.set("typeFilter", typeFilter), [store, typeFilter]);
  useEffect(() => store.set("scale", String(scale)), [scale, store]);
  useEffect(() => store.set("fill", fill ? "1" : "0"), [fill, store]);
  useEffect(() => store.set("layout", layout), [layout, store]);
  useEffect(() => store.set("showFilters", showFilters ? "1" : "0"), [showFilters, store]);
  useEffect(() => store.set("groupByDate", groupByDate ? "1" : "0"), [groupByDate, store]);
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
