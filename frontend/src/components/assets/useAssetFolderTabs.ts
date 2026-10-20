import { useViewTabs } from "../../lib/useViewTabs";
import type { AssetSortDir, AssetSortField, AssetTypeFilter } from "./assetsViewModel";

export type AssetFolderLayout = "grid" | "list" | "table";

export interface AssetFolderViewState {
  dir: string;
  query: string;
  typeFilter: AssetTypeFilter;
  activeColors: Set<string>;
  activeTags: Set<string>;
  sourceOnly: boolean;
  commentOnly: boolean;
  grayOn: boolean;
  sortField: AssetSortField;
  sortDir: AssetSortDir;
  scale: number;
  fit: "cover" | "contain";
  layout: "grid" | "list";
  folderScale?: number;
  folderFit?: "cover" | "contain";
  folderLayout?: AssetFolderLayout;
  groupByDate: boolean;
  folderMode: boolean;
  folderModePath?: string;
  scrollTop: number;
}

export function useAssetFolderTabs({ scope, read, apply, canLeave }: {
  scope: string;
  read: () => AssetFolderViewState;
  apply: (view: AssetFolderViewState) => void;
  canLeave: () => boolean;
}) {
  const tabs = useViewTabs({ scope, read, apply, canLeave, keyOf: (view) => view.dir });
  return { ...tabs, open: (dir: string) => tabs.open({ ...read(), dir, query: "", scrollTop: 0 }) };
}
