// 좌측 폴더 트리(재귀) — 폴더만 표시, 펼침 상태 + 재귀 미디어 카운트 배지.
import type { AssetNode } from "../../types";
import { FolderTreeView, type FolderTreeItem } from "../common/FolderTreeView";
import { flattenFiles } from "./treeUtils";

type TypeFilter = "image" | "video" | "audio" | null;

function toFolderItem(node: AssetNode, typeFilter: TypeFilter): FolderTreeItem {
  const children = node.children || [];
  const count = flattenFiles(children).filter((f) => !typeFilter || f.type === typeFilter).length;
  return {
    name: node.name,
    path: node.path,
    count,
    children: children
      .filter((child) => child.type === "dir")
      .map((child) => toFolderItem(child, typeFilter)),
  };
}

export function FolderTree({
  nodes,
  current,
  onSelect,
  expanded,
  onToggle,
  typeFilter = null,
}: {
  nodes: AssetNode[];
  current: string;
  onSelect: (p: string) => void;
  expanded: Set<string>;
  onToggle: (p: string) => void;
  typeFilter?: TypeFilter;
}) {
  const items = nodes
    .filter((node) => node.type === "dir")
    .map((node) => toFolderItem(node, typeFilter));
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
