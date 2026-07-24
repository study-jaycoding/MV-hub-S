import type { AssetMeta, AssetNode } from "../../types";
import { FolderTree } from "./FolderTree";
import { INTERNAL_COMBINED_PROJECT, type AssetTypeFilter } from "./assetsViewModel";

const TYPE_ROWS: Array<[Exclude<AssetTypeFilter, null>, string, string]> = [
  ["image", "🖼", "Image"],
  ["video", "🎬", "Video"],
  ["audio", "🎵", "Audio"],
];

export function AssetsSidebar({
  project,
  typeFilter,
  typeCounts,
  onTypeFilterChange,
  dir,
  meta,
  sourceOnly,
  onRoot,
  loading,
  tree,
  expanded,
  onToggleDir,
  onSelectDir,
}: {
  project: string;
  typeFilter: AssetTypeFilter;
  typeCounts: { image: number; video: number; audio: number };
  onTypeFilterChange: (value: AssetTypeFilter) => void;
  dir: string;
  meta: Record<string, AssetMeta>;
  sourceOnly: boolean;
  onRoot: () => void;
  loading: boolean;
  tree: AssetNode[];
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectDir: (path: string) => void;
}) {
  const total = typeCounts.image + typeCounts.video + typeCounts.audio;
  // 합본(imp/cap)은 폴더 아이콘을 회색으로 — 내장 스크래치 폴더임을 구분.
  const isInternal = project === INTERNAL_COMBINED_PROJECT;
  return (
    <aside className={"assets-tree" + (isInternal ? " internal-project" : "")}>
      <div className="type-filter">
        <div
          className={"type-row type-all" + (!typeFilter ? " active" : "")}
          onClick={() => onTypeFilterChange(null)}
        >
          <span className="type-icon">▦</span>
          <span className="type-label">All</span>
          <span className="type-count">{total || "-"}</span>
        </div>
        {TYPE_ROWS.map(([type, icon, label]) => (
          <div
            key={type}
            className={
              "type-row" +
              (typeFilter === type ? " active" : "") +
              (typeCounts[type] === 0 ? " zero" : "")
            }
            onClick={() => {
              if (typeCounts[type] === 0) return;
              onTypeFilterChange(typeFilter === type ? null : type);
            }}
          >
            <span className="type-icon">{icon}</span>
            <span className="type-label">{label}</span>
            <span className="type-count">{typeCounts[type] > 0 ? typeCounts[type] : "-"}</span>
          </div>
        ))}
      </div>

      <button
        type="button"
        className={
          "folder-tree-row root assets-root-row" + (dir === "" ? " selected" : "")
        }
        onClick={onRoot}
      >
        <span className="folder-tree-caret hidden" />
        <span className="folder-tree-icon" />
        <span className="folder-tree-name">{project || "…"}</span>
      </button>
      {loading ? (
        <div className="assets-loading">로딩…</div>
      ) : (
        <FolderTree
          nodes={tree}
          current={dir}
          onSelect={onSelectDir}
          expanded={expanded}
          onToggle={onToggleDir}
          typeFilter={typeFilter}
          meta={meta}
          sourceOnly={sourceOnly}
        />
      )}
    </aside>
  );
}
