// 좌측 폴더 트리(재귀) — 폴더만 표시, 펼침 상태 + 재귀 카운트 배지(미디어 수 또는 소스 수).
import { useMemo } from "react";
import type { AssetMeta, AssetNode } from "../../types";
import { FolderTreeView, type FolderTreeItem } from "../common/FolderTreeView";
import { flattenFiles, orderAssetFolders } from "./treeUtils";

type TypeFilter = "image" | "video" | "audio" | null;

function toFolderItem(
  node: AssetNode,
  typeFilter: TypeFilter,
  meta: Record<string, AssetMeta>,
  sourceOnly: boolean,
  project?: string,
): FolderTreeItem {
  const children = node.children || [];
  const files = flattenFiles(children);
  // 소스 필터가 켜지면 배지 숫자를 '그 폴더(하위 포함) 안 소스 개수'로, 아니면 미디어 파일 수로.
  const count = sourceOnly
    ? files.filter((f) => meta[f.path]?.is_source).length
    : files.filter((f) => !typeFilter || f.type === typeFilter).length;
  return {
    name: node.name,
    path: node.path,
    count,
    children: orderAssetFolders(children.filter((child) => child.type === "dir"), project)
      .map((child) => toFolderItem(child, typeFilter, meta, sourceOnly, project)),
  };
}

export function FolderTree({
  nodes,
  current,
  onSelect,
  expanded,
  onToggle,
  typeFilter = null,
  meta,
  sourceOnly = false,
  project,
}: {
  nodes: AssetNode[];
  current: string;
  onSelect: (p: string) => void;
  expanded: Set<string>;
  onToggle: (p: string) => void;
  typeFilter?: TypeFilter;
  meta: Record<string, AssetMeta>;
  sourceOnly?: boolean;
  project?: string; // 프로젝트별 표시 순서 규칙(예: assets 는 CLIP 맨 아래)
}) {
  // 배지 카운트(재귀 flatten)는 tree/meta/필터에만 의존 — 폴더 전환(current 변경)으로는 재계산 안 되게
  // memo. 예전엔 매 렌더(setDir 포함)마다 전체 트리를 재귀로 세어 큰 프로젝트에서 전환 딜레이의 한 원인.
  const items = useMemo(
    () =>
      orderAssetFolders(nodes.filter((node) => node.type === "dir"), project)
        .map((node) => toFolderItem(node, typeFilter, meta, sourceOnly, project)),
    [nodes, typeFilter, meta, sourceOnly, project],
  );
  return (
    <FolderTreeView
      nodes={items}
      selectedPath={current}
      expanded={expanded}
      onToggle={onToggle}
      onSelect={onSelect}
    />
  );
}
