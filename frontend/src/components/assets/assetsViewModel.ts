import { dayInfoFromEpochSeconds } from "../../lib/dateGroups";
import { assetFileUrl } from "../../lib/assetUrls";
import type { AssetMeta, AssetNode, PreviewTarget } from "../../types";
import { findFolder, flattenFiles } from "./treeUtils";

export const EMPTY_ASSET_META: AssetMeta = {
  is_source: false,
  source_name: null,
  tags: [],
  comment: null,
  color: null,
  comment_count: 0,
  has_unread: false,
};

export type AssetTypeFilter = "image" | "video" | "audio" | null;

export function hasUnreadAssetMeta(meta: Record<string, AssetMeta>): boolean {
  return Object.values(meta).some((m) => m?.has_unread);
}

export function countAssetTypes(tree: AssetNode[]): { image: number; video: number; audio: number } {
  const c = { image: 0, video: 0, audio: 0 };
  for (const f of flattenFiles(tree)) {
    if (f.type === "image" || f.type === "video" || f.type === "audio") c[f.type]++;
  }
  return c;
}

export function isAssetSearchActive({
  query,
  activeColors,
  sourceOnly,
  commentOnly,
  activeTags,
}: {
  query: string;
  activeColors: Set<string>;
  sourceOnly: boolean;
  commentOnly: boolean;
  activeTags: Set<string>;
}): boolean {
  return (
    query.trim().length > 0 ||
    activeColors.size > 0 ||
    sourceOnly ||
    commentOnly ||
    activeTags.size > 0
  );
}

export function filterAssetFiles({
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
}: {
  tree: AssetNode[];
  dir: string;
  query: string;
  meta: Record<string, AssetMeta>;
  searchActive: boolean;
  activeColors: Set<string>;
  sourceOnly: boolean;
  commentOnly: boolean;
  activeTags: Set<string>;
  typeFilter: AssetTypeFilter;
  grayOn: boolean;
  disabledAssets: Set<string>;
  groupByDate: boolean;
}): AssetNode[] {
  const q = query.trim();
  // 검색·필터는 현재 선택한 폴더(및 하위) 안에서만 — 폴더 미선택(루트)이면 프로젝트 전체.
  // (이전에는 검색 시 항상 전체 프로젝트를 뒤졌다.)
  const scope = dir ? findFolder(tree, dir) : tree;
  let result = flattenFiles(scope);
  if (searchActive) {
    if (q.startsWith("#")) {
      const tag = q.slice(1).toLowerCase();
      if (tag)
        result = result.filter((f) =>
          (meta[f.path]?.tags || []).some((t) => t.toLowerCase().includes(tag)),
        );
    } else if (q) {
      const nq = q.toLowerCase();
      result = result.filter((f) => f.name.toLowerCase().includes(nq));
    }
    if (activeColors.size)
      result = result.filter((f) => {
        const c = meta[f.path]?.color;
        return c ? activeColors.has(c) : false;
      });
    if (sourceOnly) result = result.filter((f) => meta[f.path]?.is_source);
    if (commentOnly) result = result.filter((f) => meta[f.path]?.has_unread);
    if (activeTags.size)
      result = result.filter((f) => (meta[f.path]?.tags || []).some((t) => activeTags.has(t)));
  }

  if (typeFilter) result = result.filter((f) => f.type === typeFilter);
  if (grayOn) result = result.filter((f) => !disabledAssets.has(f.path));
  if (groupByDate) result = [...result].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  return result;
}

export function groupAssetsByDate(files: AssetNode[]): Map<string, { label: string; idxs: number[] }> {
  const m = new Map<string, { label: string; idxs: number[] }>();
  files.forEach((f, i) => {
    const { key, label } = dayInfoFromEpochSeconds(f.mtime);
    let e = m.get(key);
    if (!e) {
      e = { label, idxs: [] };
      m.set(key, e);
    }
    e.idxs.push(i);
  });
  return m;
}

export function collectAssetTags(meta: Record<string, AssetMeta>): string[] {
  const tags = new Set<string>();
  for (const item of Object.values(meta)) item.tags.forEach((tag) => tags.add(tag));
  return [...tags].sort((a, b) => a.localeCompare(b));
}

export function assetBreadcrumb(path: string): string[] {
  return path ? path.split("/") : [];
}

export function toggleAssetDateSelection(
  selected: Set<number>,
  idxs: number[],
  allSelected: boolean,
): Set<number> {
  const next = new Set(selected);
  if (allSelected) idxs.forEach((index) => next.delete(index));
  else idxs.forEach((index) => next.add(index));
  return next;
}

export function assetFileBaseName(path: string, files: AssetNode[]): string {
  const node = files.find((file) => file.path === path);
  const name = node?.name || path.split("/").pop() || path;
  return name.replace(/\.[^.]+$/, "");
}

export function assetDragItemsForPath({
  project,
  files,
  selected,
  path,
}: {
  project: string;
  files: AssetNode[];
  selected: Set<number>;
  path: string;
}): { items: { project: string; path: string; name: string; type: string }[]; multi: boolean } {
  const selectedPaths = [...selected]
    .map((index) => files[index]?.path)
    .filter(Boolean) as string[];
  const multi = selectedPaths.length > 1 && selectedPaths.includes(path);
  const indices = multi
    ? [...selected].sort((a, b) => a - b)
    : [files.findIndex((file) => file.path === path)];
  const items = indices
    .map((index) => files[index])
    .filter(Boolean)
    .map((file) => ({ project, path: file.path, name: file.name, type: file.type }));
  return { items, multi };
}

export function assetPreviewTarget(
  project: string,
  files: AssetNode[],
  target: AssetNode,
): PreviewTarget | null {
  if (target.type !== "image" && target.type !== "video") return null;
  const media = files.filter((file) => file.type === "image" || file.type === "video");
  const items = media.map((file) => ({
    url: assetFileUrl(project, file.path),
    type: file.type as "image" | "video",
    name: file.name,
  }));
  const index = media.findIndex((file) => file.path === target.path);
  return {
    url: assetFileUrl(project, target.path),
    type: target.type,
    name: target.name,
    items,
    index,
  };
}
