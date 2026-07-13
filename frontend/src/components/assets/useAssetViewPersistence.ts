import { useEffect } from "react";
import type { MutableRefObject } from "react";
import { DISABLED_EVENT, loadDisabledAssets } from "../../lib/deactivated";
import type { Store } from "../../lib/storage";
import { useCustomEvent } from "../../lib/useCustomEvent";
import type { AssetSortDir, AssetSortField, AssetTypeFilter } from "./assetsViewModel";

interface UseAssetViewPersistenceArgs {
  activeColors: Set<string>;
  activeTags: Set<string>;
  commentOnly: boolean;
  dir: string;
  expanded: Set<string>;
  expandedSeeded: MutableRefObject<boolean>;
  fit: "cover" | "contain";
  grayOn: boolean;
  groupByDate: boolean;
  layout: "grid" | "list";
  project: string;
  query: string;
  scale: number;
  setDisabledAssets: (assets: Set<string>) => void;
  sortDir: AssetSortDir;
  sortField: AssetSortField;
  sourceOnly: boolean;
  store: Store;
  typeFilter: AssetTypeFilter;
}

export function useAssetViewPersistence({
  activeColors,
  activeTags,
  commentOnly,
  dir,
  expanded,
  expandedSeeded,
  fit,
  grayOn,
  groupByDate,
  layout,
  project,
  query,
  scale,
  setDisabledAssets,
  sortDir,
  sortField,
  sourceOnly,
  store,
  typeFilter,
}: UseAssetViewPersistenceArgs) {
  useEffect(() => {
    if (project) store.set("project", project);
  }, [project, store]);
  useEffect(() => store.set("dir", dir), [dir, store]);
  useEffect(() => store.set("typeFilter", typeFilter || ""), [typeFilter, store]);
  useEffect(() => {
    if (!expandedSeeded.current) return;
    store.setSet("expanded", expanded);
  }, [expanded, expandedSeeded, store]);
  useEffect(() => store.set("scale", String(scale)), [scale, store]);
  useEffect(() => store.set("layout", layout), [layout, store]);
  useEffect(() => store.set("groupByDate", groupByDate ? "1" : "0"), [groupByDate, store]);
  useEffect(() => store.set("fit", fit), [fit, store]);
  useEffect(() => store.set("query", query), [query, store]);
  useEffect(() => store.setSet("colors", activeColors), [activeColors, store]);
  useEffect(() => store.set("grayOn", grayOn ? "1" : "0"), [grayOn, store]);
  useCustomEvent(DISABLED_EVENT, () => setDisabledAssets(loadDisabledAssets()));
  useEffect(() => store.set("sourceOnly", sourceOnly ? "1" : "0"), [sourceOnly, store]);
  useEffect(() => store.set("commentOnly", commentOnly ? "1" : "0"), [commentOnly, store]);
  useEffect(() => store.setSet("activeTags", activeTags), [activeTags, store]);
  useEffect(() => store.set("sortField", sortField), [sortField, store]);
  useEffect(() => store.set("sortDir", sortDir), [sortDir, store]);
}
