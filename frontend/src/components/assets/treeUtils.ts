// Assets 폴더 트리 순회 유틸(순수 함수) — FolderTree·AssetsView 공용.
import type { AssetNode } from "../../types";

const HIDDEN_FOLDER_NAMES_BY_PROJECT: Readonly<Record<string, ReadonlySet<string>>> = {
  뻘뻘뻘: new Set(["MOSAIC", "REFERENCE"]),
};

// 프로젝트별 '맨 아래로 보낼' 폴더 이름(대문자) — 뻘뻘뻘은 Reference 를 숨기고 그 자리에 CLIP.
const BOTTOM_FOLDER_NAMES_BY_PROJECT: Readonly<Record<string, readonly string[]>> = {
  뻘뻘뻘: ["CLIP"],
};

function hiddenFolderNames(project: string): ReadonlySet<string> | undefined {
  return HIDDEN_FOLDER_NAMES_BY_PROJECT[project];
}

/** 프로젝트별 표시 제외 폴더를 트리와 검색 범위에서 제거한다. 원본 트리는 변경하지 않는다. */
export function visibleAssetTree(project: string, nodes: AssetNode[]): AssetNode[] {
  const hidden = hiddenFolderNames(project);
  if (!hidden) return nodes;

  return nodes.flatMap((node) => {
    if (node.type !== "dir") return [node];
    if (hidden.has(node.name.trim().toUpperCase())) return [];
    const children = visibleAssetTree(project, node.children || []);
    return children === node.children ? [node] : [{ ...node, children }];
  });
}

/** 마지막으로 열었던 경로가 현재 프로젝트의 표시 제외 폴더인지 확인한다. */
export function isAssetFolderHidden(project: string, path: string): boolean {
  const hidden = hiddenFolderNames(project);
  return !!hidden && path.split(/[\\/]/).some((part) => hidden.has(part.trim().toUpperCase()));
}

// 제작 폴더의 약속된 표시 순서: PR을 Reference보다 먼저 보여준다.
// 이름 변경 전 프로젝트의 MOSAIC도 같은 폴더로 취급한다.
// 프로젝트별 '맨 아래' 폴더(BOTTOM_...)가 있으면 그 폴더들을 끝으로 보낸다.
// 서버가 보내준 나머지 순서는 유지하고, 원본 배열도 변경하지 않는다.
export function orderAssetFolders(nodes: AssetNode[], project?: string): AssetNode[] {
  const ordered = [...nodes];
  const referenceIndex = ordered.findIndex(
    (node) =>
      node.type === "dir" &&
      ["REFERENCE", "MOSAIC"].includes(node.name.trim().toUpperCase()),
  );
  const prIndex = ordered.findIndex(
    (node) => node.type === "dir" && node.name.toUpperCase() === "PR",
  );

  if (referenceIndex >= 0 && prIndex >= 0 && referenceIndex < prIndex) {
    [ordered[referenceIndex], ordered[prIndex]] = [
      ordered[prIndex],
      ordered[referenceIndex],
    ];
  }

  const bottomNames = project ? BOTTOM_FOLDER_NAMES_BY_PROJECT[project] : undefined;
  if (bottomNames?.length) {
    const nameOf = (node: AssetNode) => node.name.trim().toUpperCase();
    const isBottom = (node: AssetNode) =>
      node.type === "dir" && bottomNames.includes(nameOf(node));
    const rest = ordered.filter((node) => !isBottom(node));
    const bottom = bottomNames.flatMap((name) =>
      ordered.filter((node) => isBottom(node) && nameOf(node) === name),
    );
    if (bottom.length) return [...rest, ...bottom];
  }

  return ordered;
}

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
