import type { AssetMeta, AssetNode } from "../../types";
import { FolderTree } from "./FolderTree";
import { INTERNAL_COMBINED_PROJECT, type AssetTypeFilter } from "./assetsViewModel";

export function AssetsSidebar({
  project,
  projects,
  linkedProjects,
  onProjectChange,
  typeFilter,
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
  projects: string[];
  linkedProjects: Set<string>;
  onProjectChange: (project: string) => void;
  typeFilter: AssetTypeFilter;
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
  // 타입 필터 행(All/Image/Video/Audio)은 하단 바의 4점 슬라이더로 대체됐다(Jay 요청) —
  // 프로젝트 선택 드롭다운(헤더에서 이동)이 폴더 트리 위에 온다. typeFilter 는 트리 배지 계산용.
  return (
    <aside className="assets-tree">
      <select
        className={
          "assets-project"
          + (project === INTERNAL_COMBINED_PROJECT ? " internal" : "")
          + (linkedProjects.has(project) ? " linked" : "")
        }
        value={project}
        onChange={(e) => onProjectChange(e.target.value)}
      >
        {projects.map((p) => (
          <option
            key={p}
            value={p}
            className={
              p === INTERNAL_COMBINED_PROJECT
                ? "internal"
                : linkedProjects.has(p)
                  ? "linked"
                  : undefined
            }
          >
            {p}
          </option>
        ))}
      </select>
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
          project={project}
        />
      )}
    </aside>
  );
}
