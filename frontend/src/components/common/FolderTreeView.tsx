// 공통 폴더 트리 뷰 — 생성탭/어셋탭/관리자창이 같은 시각 언어를 공유한다.
import { useState, type DragEvent, type KeyboardEvent } from "react";

export interface FolderTreeItem {
  name: string;
  path: string;
  count?: number | null;
  children?: FolderTreeItem[];
  virtual?: boolean; // 디스크에 없는 논리 폴더(팀 데이터의 folder_path로 합성) — 표식만 다르게
}

export function FolderTreeView({
  nodes,
  selectedPath = "",
  expanded,
  onToggle,
  onSelect,
  onDropFolder,
  isDisabled,
  onRowKeyDown,
  scroll = false,
  className = "",
}: {
  nodes: FolderTreeItem[];
  selectedPath?: string;
  expanded?: Set<string>;
  onToggle?: (path: string) => void;
  onSelect: (path: string) => void;
  // 카드를 이 폴더로 드래그해 놓으면 호출(드롭). 지정 시 폴더 행이 드롭 타깃이 된다.
  onDropFolder?: (path: string, e: DragEvent) => void;
  // 이 폴더가 비활성(생략)인가 — true 면 회색 표시.
  isDisabled?: (path: string) => boolean;
  // 폴더 행 포커스 상태에서 키 입력(예: d 로 비활성 토글).
  onRowKeyDown?: (path: string, e: KeyboardEvent) => void;
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
          onDropFolder={onDropFolder}
          isDisabled={isDisabled}
          onRowKeyDown={onRowKeyDown}
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
  onDropFolder,
  isDisabled,
  onRowKeyDown,
}: {
  node: FolderTreeItem;
  depth: number;
  selectedPath: string;
  expanded?: Set<string>;
  onToggle?: (path: string) => void;
  onSelect: (path: string) => void;
  onDropFolder?: (path: string, e: DragEvent) => void;
  isDisabled?: (path: string) => boolean;
  onRowKeyDown?: (path: string, e: KeyboardEvent) => void;
}) {
  const children = node.children || [];
  const hasChildren = children.length > 0;
  const canToggle = hasChildren && !!onToggle;
  const controlled = !!expanded && !!onToggle;
  const open = !hasChildren || (controlled ? expanded.has(node.path) : true);
  const selected = selectedPath === node.path;
  const disabled = isDisabled ? isDisabled(node.path) : false;
  const count = node.count || 0;
  const [dropOver, setDropOver] = useState(false);
  // 하위가 있는 부모 폴더(예 ep001)는 드롭 대상에서 제외 — 말단 폴더(c0010 등)에만 담는다.
  const dropProps = onDropFolder && !hasChildren
    ? {
        onDragOver: (e: DragEvent) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!dropOver) setDropOver(true);
        },
        onDragLeave: () => setDropOver(false),
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setDropOver(false);
          onDropFolder(node.path, e);
        },
      }
    : {};
  return (
    <div className="folder-tree-node">
      <button
        type="button"
        className={
          "folder-tree-row" +
          (depth === 0 ? " root" : "") +
          (selected ? " selected" : "") +
          (disabled ? " disabled" : "") +
          (node.virtual ? " virtual" : "") +
          (dropOver ? " drop-over" : "")
        }
        style={{ paddingLeft: 6 + depth * 14 }}
        title={node.virtual ? `${node.path} (팀 데이터 폴더 — 내 디스크엔 없음)` : node.path || node.name}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(node.path);
        }}
        onKeyDown={
          onRowKeyDown
            ? (e) => {
                e.stopPropagation(); // 전역 카드선택 단축키(d 등)와 충돌 방지
                onRowKeyDown(node.path, e);
              }
            : undefined
        }
        {...dropProps}
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
            onDropFolder={onDropFolder}
            isDisabled={isDisabled}
            onRowKeyDown={onRowKeyDown}
          />
        ))}
    </div>
  );
}
