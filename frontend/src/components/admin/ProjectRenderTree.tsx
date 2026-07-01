import { visibleProjectFolderRoots, type ProjectFolderEntry } from "../../lib/projectFolderTree";
import { FolderTreeView } from "../common/FolderTreeView";

export type { ProjectFolderEntry } from "../../lib/projectFolderTree";

export function ProjectRenderTree({
  state,
  loading,
  onSelect,
}: {
  state?: ProjectFolderEntry;
  loading?: boolean;
  onSelect: (path: string) => void;
}) {
  if (loading && !state?.tree) return <div className="proj-folder-empty">폴더 구조 로딩…</div>;
  if (!state?.root_path) return null;
  if (state.error) return <div className="proj-folder-error">{state.error}</div>;
  if (!state.tree) return <div className="proj-folder-empty">Render 폴더 구조 없음</div>;
  return (
    <div className="proj-folder-panel" title={state.render_path || state.root_path}>
      <FolderTreeView
        nodes={visibleProjectFolderRoots(state.tree)}
        selectedPath={state.selected_path || ""}
        onSelect={onSelect}
      />
      {state.truncated && <div className="proj-folder-empty">일부만 표시</div>}
    </div>
  );
}
