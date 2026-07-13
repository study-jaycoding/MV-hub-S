import { useMemo } from "react";
import type { AssetMeta, AssetNode } from "../../types";
import {
  assetBreadcrumb,
  collectAssetTags,
  countAssetTypes,
  filterAssetFiles,
  groupAssetsByDate,
  hasUnreadAssetMeta,
  isAssetSearchActive,
  type AssetSortDir,
  type AssetSortField,
  type AssetTypeFilter,
} from "./assetsViewModel";

export function useAssetViewData({
  activeColors,
  activeTags,
  commentOnly,
  dir,
  disabledAssets,
  grayOn,
  groupByDate,
  meta,
  query,
  sortDir,
  sortField,
  sourceOnly,
  tree,
  typeFilter,
}: {
  activeColors: Set<string>;
  activeTags: Set<string>;
  commentOnly: boolean;
  dir: string;
  disabledAssets: Set<string>;
  grayOn: boolean;
  groupByDate: boolean;
  meta: Record<string, AssetMeta>;
  query: string;
  sortDir: AssetSortDir;
  sortField: AssetSortField;
  sourceOnly: boolean;
  tree: AssetNode[];
  typeFilter: AssetTypeFilter;
}) {
  const searchActive = isAssetSearchActive({
    query,
    activeColors,
    sourceOnly,
    commentOnly,
    activeTags,
  });

  const hasAnyUnread = useMemo(() => hasUnreadAssetMeta(meta), [meta]);
  const typeCounts = useMemo(() => countAssetTypes(tree), [tree]);
  const files = useMemo(
    () =>
      filterAssetFiles({
        tree,
        dir,
        query,
        meta,
        searchActive,
        activeColors,
        sourceOnly,
        commentOnly,
        activeTags,
        typeFilter,
        grayOn,
        disabledAssets,
        groupByDate,
        sortField,
        sortDir,
      }),
    [
      tree,
      dir,
      query,
      meta,
      searchActive,
      activeColors,
      sourceOnly,
      commentOnly,
      activeTags,
      typeFilter,
      groupByDate,
      grayOn,
      disabledAssets,
      sortField,
      sortDir,
    ],
  );
  const dateGroups = useMemo(() => groupAssetsByDate(files), [files]);
  const allTags = useMemo(() => collectAssetTags(meta), [meta]);
  const breadcrumb = assetBreadcrumb(dir);

  return { allTags, breadcrumb, dateGroups, files, hasAnyUnread, searchActive, typeCounts };
}
