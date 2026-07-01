// 공통 폴더 트리 뷰 — 생성탭/어셋탭/관리자창이 같은 시각 언어를 공유한다.
export interface FolderTreeItem {
  name: string;
  path: string;
  count?: number | null;
  children?: FolderTreeItem[];
}

export function FolderTreeView({
  nodes,
  selectedPath = "",
  expanded,
  onToggle,
  onSelect,
  scroll = false,
  className = "",
}: {
  nodes: FolderTreeItem[];
  selectedPath?: string;
  expanded?: Set<string>;
  onToggle?: (path: string) => void;
  onSelect: (path: string) => void;
  scroll?: boolean;
  className?: string;
}) {
  if (!nodes.length) return null;
  return (
    <div className={"folder-tree" + (scroll ? " scroll-15" : "") + (className ? ` ${className}` : "")}>
      {nodes.map((node) => (
        <FolderTreeRow
          key={node.path || node.name}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function FolderTreeRow({
  node,
  depth,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
}: {
  node: FolderTreeItem;
  depth: number;
  selectedPath: string;
  expanded?: Set<string>;
  onToggle?: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const children = node.children || [];
  const hasChildren = children.length > 0;
  const canToggle = hasChildren && !!onToggle;
  const controlled = !!expanded && !!onToggle;
  const open = !hasChildren || (controlled ? expanded.has(node.path) : true);
  const selected = selectedPath === node.path;
  const count = node.count || 0;
  return (
    <div className="folder-tree-node">
      <button
        type="button"
        className={
          "folder-tree-row" +
          (depth === 0 ? " root" : "") +
          (selected ? " selected" : "")
        }
        style={{ paddingLeft: 6 + depth * 14 }}
        title={node.path || node.name}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(node.path);
        }}
      >
        <span
          className={"folder-tree-caret" + (canToggle ? "" : " hidden")}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren && onToggle) onToggle(node.path);
          }}
        >
          {canToggle ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="folder-tree-icon" />
        <span className="folder-tree-name">{node.name}</span>
        <span className={"folder-tree-count" + (count > 0 ? "" : " zero")}>
          {count > 0 ? count : "-"}
        </span>
      </button>
      {hasChildren &&
        open &&
        children.map((child) => (
          <FolderTreeRow
            key={child.path || child.name}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}
