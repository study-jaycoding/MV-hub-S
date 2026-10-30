import type { AssetNode } from "../../types";
import { compareAssetsBy, type AssetSortDir, type AssetSortField } from "./assetsViewModel";
import { findFolder, orderAssetFolders } from "./treeUtils";

export interface AssetFolderSort { field: AssetSortField; dir: AssetSortDir }

// 폴더 카드 화면의 정렬 창 — 폴더에는 유형이 없다(Jay 2026-10-30)
export const FOLDER_SORT_FIELDS: { key: AssetSortField; label: string }[] = [
  { key: "name", label: "이름" },
  { key: "date", label: "날짜" },
];

export interface AssetFolderGroup {
  folder: AssetNode;
  files: AssetNode[];
  category: string;
  folderCount: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  children: { folder: AssetNode; count: number; cover?: AssetNode }[];
}

function folderCategory(path: string) {
  const [root = "", category = ""] = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (root.toLowerCase() !== "assets") return root;
  const key = category.toUpperCase();
  return ["BG", "CH", "PR", "CLIP"].includes(key) ? key : "Assets";
}

// 서버가 주는 폴더 순서(영문 먼저)에 맞춘다 — 한국어 환경의 기본 비교는 한글을 앞에 둬서 처음 화면이 지금과 달라진다.
const folderNameCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

// 폴더에는 날짜가 없어 안에 든 가장 최근 파일로 줄 세운다. 약속된 순서(PR·맨 아래 폴더)는 이름 오름차순에서만 지킨다.
function sortFolders<T extends { folder: AssetNode }>(items: T[], latest: Map<string, number>, { field, dir }: AssetFolderSort, project: string) {
  const sign = dir === "asc" ? 1 : -1;
  const time = (item: T) => latest.get(item.folder.path) ?? 0;
  const byName = (a: T, b: T) => folderNameCollator.compare(a.folder.name, b.folder.name);
  const sorted = [...items].sort((a, b) => field === "date" ? sign * (time(a) - time(b)) || byName(a, b) : sign * byName(a, b));
  if (field !== "name" || dir !== "asc") return sorted;
  const byPath = new Map(sorted.map((item) => [item.folder.path, item]));
  return orderAssetFolders(sorted.map((item) => item.folder), project).map((folder) => byPath.get(folder.path)!);
}

// 이미 필터·정렬된 목록을 나누므로 카드 수와 '전체'의 파일 수가 같은 범위를 가리킨다.
export function assetFolderGroups(tree: AssetNode[], dir: string, files: AssetNode[], project: string, sort?: AssetFolderSort) {
  const children = findFolder(tree, dir);
  const groups: AssetFolderGroup[] = orderAssetFolders(children.filter((node) => node.type === "dir"), project)
    .map((folder) => ({ folder, files: [], category: folderCategory(folder.path),
      folderCount: (folder.children ?? []).filter((node) => node.type === "dir").length,
      imageCount: 0, videoCount: 0, audioCount: 0,
      children: orderAssetFolders((folder.children ?? []).filter((node) => node.type === "dir"), project)
        .map((child) => ({ folder: child, count: 0 })) }));
  const byPath = new Map(groups.map((group) => [group.folder.path, group]));
  const childByPath = new Map(groups.flatMap((group) => group.children.map((child) => [child.folder.path, child] as const)));
  const directFiles: AssetNode[] = [];
  const prefix = dir ? `${dir}/` : "";
  const latest = new Map<string, number>(); // 폴더 경로 → 안에 든 가장 최근 파일
  const touch = (path: string, mtime?: number | null) => latest.set(path, Math.max(latest.get(path) ?? 0, mtime ?? 0));
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const group = slash < 0 ? undefined : byPath.get(prefix + rest.slice(0, slash));
    if (group) {
      group.files.push(file);
      touch(group.folder.path, file.mtime);
      if (file.type === "image") group.imageCount++;
      else if (file.type === "video") group.videoCount++;
      else if (file.type === "audio") group.audioCount++;
      const childSlash = rest.indexOf("/", slash + 1);
      const child = childSlash < 0 ? undefined : childByPath.get(prefix + rest.slice(0, childSlash));
      if (child) { child.count++; child.cover ??= file; touch(child.folder.path, file.mtime); }
    }
    else if (slash < 0) directFiles.push(file);
  }
  if (sort) {
    directFiles.sort((a, b) => compareAssetsBy(a, b, sort.field, sort.dir));
    for (const group of groups) group.children = sortFolders(group.children, latest, sort, project);
  }
  // 검색 결과로 표시 방식을 바꾸면 직접 파일이 걸러지는 순간 폴더 카드로 되돌아간다.
  return { groups: sort ? sortFolders(groups, latest, sort, project) : groups, directFiles, hasDirectFiles: children.some((node) => node.type !== "dir") };
}
