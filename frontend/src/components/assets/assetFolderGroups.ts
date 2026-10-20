import type { AssetNode } from "../../types";
import { findFolder, orderAssetFolders } from "./treeUtils";

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

// 이미 필터·정렬된 목록을 나누므로 카드 수와 '전체'의 파일 수가 같은 범위를 가리킨다.
export function assetFolderGroups(tree: AssetNode[], dir: string, files: AssetNode[], project: string) {
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
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const group = slash < 0 ? undefined : byPath.get(prefix + rest.slice(0, slash));
    if (group) {
      group.files.push(file);
      if (file.type === "image") group.imageCount++;
      else if (file.type === "video") group.videoCount++;
      else if (file.type === "audio") group.audioCount++;
      const childSlash = rest.indexOf("/", slash + 1);
      const child = childSlash < 0 ? undefined : childByPath.get(prefix + rest.slice(0, childSlash));
      if (child) { child.count++; child.cover ??= file; }
    }
    else if (slash < 0) directFiles.push(file);
  }
  // 검색 결과로 표시 방식을 바꾸면 직접 파일이 걸러지는 순간 폴더 카드로 되돌아간다.
  return { groups, directFiles, hasDirectFiles: children.some((node) => node.type !== "dir") };
}
