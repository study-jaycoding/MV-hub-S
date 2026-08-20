import type { AssetMeta, AssetNode } from "../../types";
import { FolderTree } from "./FolderTree";
import type { AssetTypeFilter } from "./assetsViewModel";

export function AssetsSidebar({
  project,
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
  // 타입 필터 행(All/Image/Video/Audio)은 하단 바의 4점 슬라이더로 대체됐고(Jay 요청),
  // 프로젝트 선택 드롭다운은 헤더 경로 첫 자리로 갔다. typeFilter 는 트리 배지 계산용.
  return (
    <aside className="assets-tree">
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
