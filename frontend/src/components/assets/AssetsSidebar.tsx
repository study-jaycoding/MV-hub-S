import { useMemo } from "react";
import type { AssetMeta, AssetNode } from "../../types";
import { SideMark } from "../common/FolderTreeView";
import { WorkspaceMark } from "../common/WorkspaceMark";
import { assetFileCount, FolderTree } from "./FolderTree";
import type { AssetTypeFilter } from "./assetsViewModel";

export function AssetsSidebar({
  project,
  projectId,
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
  onOpenTab,
}: {
  project: string;
  projectId?: string; // PM 프로젝트 id — 마크 색이 메인과 같아진다. 수동 등록 폴더에는 없다
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
  onOpenTab?: (path: string) => void;
}) {
  // 타입 필터 행(All/Image/Video/Audio)은 하단 바의 4점 슬라이더로 대체됐고(Jay 요청),
  // 프로젝트 선택 드롭다운은 헤더 경로 첫 자리로 갔다. typeFilter 는 트리 배지 계산용.
  const count = useMemo(() => assetFileCount(tree, typeFilter, meta, sourceOnly), [tree, typeFilter, meta, sourceOnly]);
  const atRoot = dir === "";
  return (
    <aside className="assets-tree">
      <div className="proj-tree-wrap">
        {/* 맨 윗줄 = 메인 프로젝트 줄과 같은 모양 — 마크·이름·개수(Jay 2026-11-02). 개수는 어셋 파일 수다. */}
        <button
          type="button"
          className={"proj-row open assets-root-row" + (atRoot ? " state st-see" : "")}
          title={project}
          onClick={onRoot}
          onMouseDown={(e) => { if (e.button === 1 && onOpenTab) e.preventDefault(); }}
          onAuxClick={(e) => { if (e.button === 1 && onOpenTab) { e.preventDefault(); onOpenTab(""); } }}
        >
          {project && <WorkspaceMark label={project} id={projectId || project} />}
          <span className="proj-name">{project || "…"}</span>
          {atRoot && <SideMark kind="see" />}
          {!loading && <span className="proj-count">{count}</span>}
        </button>
        {loading ? (
          <div className="assets-loading">로딩…</div>
        ) : (
          <FolderTree
            nodes={tree}
            current={dir}
            onSelect={onSelectDir}
            onOpenTab={onOpenTab}
            expanded={expanded}
            onToggle={onToggleDir}
            typeFilter={typeFilter}
            meta={meta}
            sourceOnly={sourceOnly}
            project={project}
          />
        )}
      </div>
    </aside>
  );
}
