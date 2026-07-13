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

// 정렬 — 파일 정렬 기준(이름/날짜/유형)과 방향(오름/내림). 에셋 목록은 전부 로컬(클라이언트)이라
// 여기서 바로 정렬한다(생성물과 달리 서버 정렬·페이지네이션 아님).
export type AssetSortField = "name" | "date" | "type";
export type AssetSortDir = "asc" | "desc";

// 유형 정렬 순서 — 폴더 없이 파일만 오지만(flattenFiles) 안전하게 dir 도 둔다. 이미지→영상→오디오.
const ASSET_TYPE_RANK: Record<string, number> = { dir: 0, image: 1, video: 2, audio: 3 };

function _byName(a: AssetNode, b: AssetNode): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function compareAssetsBy(
  a: AssetNode,
  b: AssetNode,
  field: AssetSortField,
  dir: AssetSortDir,
): number {
  let r = 0;
  if (field === "name") r = _byName(a, b);
  else if (field === "type") {
    r = (ASSET_TYPE_RANK[a.type] ?? 9) - (ASSET_TYPE_RANK[b.type] ?? 9);
    if (r === 0) r = _byName(a, b); // 같은 유형끼리는 이름순
  } else r = (a.mtime ?? 0) - (b.mtime ?? 0); // date
  if (dir === "desc") r = -r;
  if (r === 0) {
    r = _byName(a, b); // 같은 값이면 이름 오름차순
    if (r === 0) r = a.path < b.path ? -1 : a.path > b.path ? 1 : 0; // 이름도 동률이면 경로로 결정적 순서
  }
  return r;
}

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
  sortField,
  sortDir,
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
  sortField: AssetSortField;
  sortDir: AssetSortDir;
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

  // 선택한 기준(이름/날짜/유형)·방향으로 항상 정렬(정렬 버튼). 예전엔 날짜구분 켰을 때만 mtime 내림차순이었다.
  result = [...result].sort((a, b) => compareAssetsBy(a, b, sortField, sortDir));
  if (groupByDate) {
    // 날짜 구분이 켜지면 같은 날짜끼리 붙어야 섹션이 이어진다 → 일(day) 버킷으로 '안정' 재정렬(Array.sort
    // 는 안정 정렬이라 같은 날 안에서는 위 정렬 순서가 그대로 유지된다). 그룹(날짜) 자체의 순서는
    // 정렬기준이 '날짜'면 방향을 따르고, 이름/유형 정렬일 때는 최신 날짜 그룹을 위로 둔다.
    // ★일 버킷은 '숫자'(로컬 자정 timestamp)로 비교한다 — 그룹 key 문자열('2026-10-1')은 0-padding 이
    //  없어 문자열 비교 시 10월이 9월보다 앞서는 등 월/일 순서가 어긋난다. '날짜 없음'은 어느 방향이든 맨 끝.
    const dayDir: AssetSortDir = sortField === "date" ? sortDir : "desc";
    const NO_DATE = dayDir === "asc" ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER;
    const dayNum = new Map<AssetNode, number>();
    for (const f of result) {
      const s = f.mtime ?? 0;
      if (!s) dayNum.set(f, NO_DATE);
      else {
        const d = new Date(s * 1000);
        dayNum.set(f, Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); // 로컬 날짜의 자정
      }
    }
    result.sort((a, b) => {
      const c = (dayNum.get(a) ?? 0) - (dayNum.get(b) ?? 0);
      return dayDir === "asc" ? c : -c;
    });
  }
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
  if (target.type !== "image" && target.type !== "video" && target.type !== "audio") return null;
  const media = files.filter(
    (file) => file.type === "image" || file.type === "video" || file.type === "audio",
  );
  const items = media.map((file) => ({
    url: assetFileUrl(project, file.path),
    type: file.type as "image" | "video" | "audio",
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
