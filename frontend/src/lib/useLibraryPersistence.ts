import { useEffect } from "react";
import type { MediaFilter } from "./mediaTypes";
import type { Store } from "./storage";
import type { Filters } from "../types";

interface UseLibraryPersistenceArgs {
  armedAutoTags: Set<string>;
  armedFolder: { projectId: string; path: string } | null;
  colorFilter: Set<string>;
  commentOnly: boolean;
  fill: boolean;
  filters: Filters;
  finalOnly: boolean;
  grayOn: boolean;
  groupByDate: boolean;
  layout: "grid" | "list";
  sharedOnly: boolean;
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
  commentOnly,
  fill,
  filters,
  finalOnly,
  grayOn,
  groupByDate,
  layout,
  scale,
  sharedOnly,
  showFilters,
  store,
  tagFilter,
  typeFilter,
}: UseLibraryPersistenceArgs) {
  useEffect(() => store.setJSON("filters", filters), [filters, store]);
  useEffect(() => store.set("typeFilter", typeFilter), [store, typeFilter]);
  useEffect(() => store.set("scale", String(scale)), [scale, store]);
  useEffect(() => store.set("fill", fill ? "1" : "0"), [fill, store]);
  useEffect(() => store.set("layout", layout), [layout, store]);
  useEffect(() => store.set("showFilters", showFilters ? "1" : "0"), [showFilters, store]);
  useEffect(() => store.set("groupByDate", groupByDate ? "1" : "0"), [groupByDate, store]);
  useEffect(() => store.setSet("colorFilter", colorFilter), [colorFilter, store]);
  useEffect(() => store.set("sharedOnly", sharedOnly ? "1" : "0"), [sharedOnly, store]);
  useEffect(() => store.set("commentOnly", commentOnly ? "1" : "0"), [commentOnly, store]);
  useEffect(() => store.set("finalOnly", finalOnly ? "1" : "0"), [finalOnly, store]);
  useEffect(() => store.set("grayOn", grayOn ? "1" : "0"), [grayOn, store]);
  useEffect(() => store.setSet("tagFilter", tagFilter), [store, tagFilter]);
  useEffect(() => store.setSet("armedAutoTags", armedAutoTags), [armedAutoTags, store]);
  // null 도 저장 → loadJSON 이 그대로 null 로 복원(해제 상태 영속).
  useEffect(() => store.setJSON("armedFolder", armedFolder), [armedFolder, store]);
}
