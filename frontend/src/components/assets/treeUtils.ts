// Assets 폴더 트리 순회 유틸(순수 함수) — FolderTree·AssetsView 공용.
import type { AssetNode } from "../../types";

// 트리 전체에서 미디어 파일만 평탄화(검색용) — 이미지/영상/오디오 모두 포함
export function flattenFiles(nodes: AssetNode[]): AssetNode[] {
  const out: AssetNode[] = [];
  for (const n of nodes) {
    if (n.type === "dir") {
      if (n.children) out.push(...flattenFiles(n.children));
    } else {
      out.push(n); // image · video · audio
    }
  }
  return out;
}

// 트리에서 path 의 폴더 children 반환
export function findFolder(nodes: AssetNode[], path: string): AssetNode[] {
  if (!path) return nodes;
  for (const n of nodes) {
    if (n.type !== "dir") continue;
    if (n.path === path) return n.children || [];
    if (path.startsWith(n.path + "/") && n.children) {
      return findFolder(n.children, path);
    }
  }
  return [];
}
