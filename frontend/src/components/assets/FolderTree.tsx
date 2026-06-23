// 좌측 폴더 트리(재귀) — 폴더만 표시, 펼침 상태 + 재귀 미디어 카운트 배지.
import type { AssetNode } from "../../types";
import { flattenFiles } from "./treeUtils";

type TypeFilter = "image" | "video" | "audio" | null;

export function FolderTree({
  nodes,
  current,
  onSelect,
  expanded,
  onToggle,
  typeFilter = null,
  depth = 0,
}: {
  nodes: AssetNode[];
  current: string;
  onSelect: (p: string) => void;
  expanded: Set<string>;
  onToggle: (p: string) => void;
  typeFilter?: TypeFilter;
  depth?: number;
}) {
  return (
    <>
      {nodes
        .filter((n) => n.type === "dir")
        .map((n) => (
          <FolderRow
            key={n.path}
            node={n}
            current={current}
            onSelect={onSelect}
            expanded={expanded}
            onToggle={onToggle}
            typeFilter={typeFilter}
            depth={depth}
          />
        ))}
    </>
  );
}

function FolderRow({
  node,
  current,
  onSelect,
  expanded,
  onToggle,
  typeFilter,
  depth,
}: {
  node: AssetNode;
  current: string;
  onSelect: (p: string) => void;
  expanded: Set<string>;
  onToggle: (p: string) => void;
  typeFilter: TypeFilter;
  depth: number;
}) {
  const hasSub = (node.children || []).some((c) => c.type === "dir");
  const open = expanded.has(node.path);
  const active = current === node.path;
  // 폴더 내 미디어 수(재귀) — 타입 모드면 그 타입만 카운트(영상 모드 → 영상 개수)
  const count = flattenFiles(node.children || []).filter(
    (f) => !typeFilter || f.type === typeFilter,
  ).length;
  return (
    <div className="tree-node">
      <div
        className={"tree-row" + (active ? " active" : "")}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(node.path)}
      >
        <span
          className={"tree-caret" + (hasSub ? "" : " hidden")}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.path);
          }}
        >
          {open ? "▾" : "▸"}
        </span>
        <span className="tree-name">📁 {node.name}</span>
        <span className={"tree-count" + (count === 0 ? " zero" : "")}>
          {count > 0 ? count : "-"}
        </span>
      </div>
      {open && hasSub && (
        <FolderTree
          nodes={node.children || []}
          current={current}
          onSelect={onSelect}
          expanded={expanded}
          onToggle={onToggle}
          typeFilter={typeFilter}
          depth={depth + 1}
        />
      )}
    </div>
  );
}
