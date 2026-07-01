import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../lib/i18n";
import {
  collectExpandableProjectFolders,
  loadProjectFolderExpansion,
  saveProjectFolderExpansion,
  visibleProjectFolderRoots,
  type ProjectFolderEntry,
} from "../../lib/projectFolderTree";
import type { Project, ProjectFolderState } from "../../types";
import { FolderTreeView } from "../common/FolderTreeView";

function SidebarFolderTree({
  state,
  loading,
  expanded,
  onToggle,
  onSelect,
}: {
  state?: ProjectFolderEntry;
  loading?: boolean;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  if (!state?.root_path) return null;
  if (loading && !state.tree) return <div className="side-folder-note">폴더 로딩...</div>;
  if (state.error) return <div className="side-folder-note error">{state.error}</div>;
  if (!state.tree) return null;
  const roots = visibleProjectFolderRoots(state.tree);
  if (!roots.length) return null;
  return (
    <div title={state.render_path || state.root_path}>
      <FolderTreeView
        nodes={roots}
        selectedPath={state.selected_path || ""}
        expanded={expanded}
        onToggle={onToggle}
        onSelect={onSelect}
        scroll
      />
      {state.truncated && <div className="side-folder-note">일부만 표시</div>}
    </div>
  );
}

export function ProjectSection({
  projects,
  unassignedCount,
  archivedCount,
  activeId,
  deletedOnly,
  onFilter,
  onViewDeleted,
}: {
  projects: Project[];
  unassignedCount: number;
  archivedCount: number;
  activeId?: string;
  deletedOnly: boolean;
  onFilter: (projectId?: string) => void;
  onViewDeleted: () => void;
}) {
  const tr = useT();
  const [order, setOrder] = useState<Project[]>(projects);
  useEffect(() => setOrder(projects), [projects]);
  const [folders, setFolders] = useState<Record<string, ProjectFolderEntry>>({});
  const [folderLoading, setFolderLoading] = useState<Record<string, boolean>>({});
  const [expandedFolders, setExpandedFolders] =
    useState<Record<string, Set<string>>>(loadProjectFolderExpansion);
  const projectKey = projects.map((project) => project.id).join("|");

  const seedProjectExpansion = (pid: string, state: ProjectFolderState) => {
    const tree = state.tree;
    if (!tree) return;
    setExpandedFolders((prev) => {
      if (Object.prototype.hasOwnProperty.call(prev, pid)) return prev;
      const next = {
        ...prev,
        [pid]: collectExpandableProjectFolders(visibleProjectFolderRoots(tree)),
      };
      saveProjectFolderExpansion(next);
      return next;
    });
  };

  useEffect(() => {
    let alive = true;
    const visibleIds = new Set(projects.map((project) => project.id));
    api
      .projectFolderLinks()
      .then((res) => {
        if (!alive) return;
        const links = res.links || {};
        const linkedIds = Object.keys(links).filter(
          (pid) => visibleIds.has(pid) && !!links[pid]?.root_path,
        );
        setFolders((prev) => {
          const next: Record<string, ProjectFolderEntry> = {};
          for (const pid of linkedIds) next[pid] = { ...prev[pid], ...links[pid] };
          return next;
        });
        linkedIds.forEach((pid) => {
          setFolderLoading((prev) => ({ ...prev, [pid]: true }));
          api
            .projectFolder(pid)
            .then((state) => {
              if (!alive) return;
              seedProjectExpansion(pid, state);
              setFolders((prev) => ({ ...prev, [pid]: state }));
            })
            .catch(() => {})
            .finally(() => {
              if (alive) setFolderLoading((prev) => ({ ...prev, [pid]: false }));
            });
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey]);

  const selectFolder = async (pid: string, path: string) => {
    const cur = folders[pid];
    if (!cur?.root_path) return;
    onFilter(pid);
    setFolders((prev) => ({ ...prev, [pid]: { ...cur, selected_path: path } }));
    try {
      const state = await api.setProjectFolder(pid, {
        root_path: cur.root_path,
        selected_path: path,
      });
      setFolders((prev) => ({ ...prev, [pid]: state }));
    } catch {
      /* 권한이 없는 사용자는 화면 선택만 반영한다. */
    }
  };

  const toggleProjectFolderNode = (pid: string, path: string) => {
    setExpandedFolders((prev) => {
      const cur = new Set(prev[pid] || []);
      if (cur.has(path)) cur.delete(path);
      else cur.add(path);
      const next = { ...prev, [pid]: cur };
      saveProjectFolderExpansion(next);
      return next;
    });
  };

  const [dragArmed, setDragArmed] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const dropAt = async (toIdx: number) => {
    const from = dragIdx;
    setDragArmed(false);
    setDragIdx(null);
    setOverIdx(null);
    if (from === null || from === toIdx) return;
    const next = order.slice();
    const [moved] = next.splice(from, 1);
    next.splice(toIdx, 0, moved);
    setOrder(next);
    api.reorderProjects(next.map((project) => project.id)).catch(() => {});
  };

  const [archived, setArchived] = useState<Project[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const loadArchived = () =>
    api
      .projects("my", true)
      .then((res) => {
        setArchived(res.projects.filter((project) => project.archived));
        setArchivedLoaded(true);
      })
      .catch(() => {});
  const toggleArchived = () => {
    const next = !showArchived;
    setShowArchived(next);
    if (next && !archivedLoaded) loadArchived();
  };
  useEffect(() => {
    if (showArchived) loadArchived();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  return (
    <>
      <section>
        <h4 className="auto-tag-head">Millionvolt</h4>
        <div className="proj-list">
          <button
            className={"proj-row" + (!activeId && !deletedOnly ? " on" : "")}
            onClick={() => onFilter(undefined)}
          >
            <span className="proj-name">{tr("라이브러리")}</span>
          </button>
          <button
            className={
              "proj-row proj-unassigned" + (activeId === "none" && !deletedOnly ? " on" : "")
            }
            onClick={() => onFilter(activeId === "none" ? undefined : "none")}
            title="아직 프로젝트에 담기지 않은 결과물"
          >
            <span className="proj-name">{tr("미분류")}</span>
            <span className="proj-count">{unassignedCount}</span>
          </button>
          <button
            className={"proj-row proj-trash" + (deletedOnly ? " on" : "")}
            onClick={onViewDeleted}
            title="지운 것만 보기 — 힉스필드 원본엔 영향 없음(우리 카탈로그 휴지통)"
          >
            <span className="proj-name">{tr("휴지통 보기")}</span>
          </button>
        </div>
      </section>

      <section>
        <h4 className="auto-tag-head">{tr("프로젝트")}</h4>
        <div className="proj-list">
          {order.length === 0 && <span className="muted">{tr("없음")}</span>}
          {order.map((project, index) => {
            const projectActive = activeId === project.id && !deletedOnly;
            return (
              <div
                key={project.id}
                className={"proj-tree-wrap" + (projectActive ? " on" : "")}
              >
                <div
                  role="button"
                  tabIndex={0}
                  className={
                    "proj-row" +
                    (projectActive ? " on" : "") +
                    (dragIdx === index ? " row-dragging" : "") +
                    (overIdx === index && dragIdx !== index ? " row-dragover" : "")
                  }
                  onClick={() => onFilter(activeId === project.id ? undefined : project.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") onFilter(activeId === project.id ? undefined : project.id);
                  }}
                  title={project.name}
                  draggable={dragArmed}
                  onDragStart={(e) => {
                    setDragIdx(index);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (dragIdx === null) return;
                    e.preventDefault();
                    if (overIdx !== index) setOverIdx(index);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropAt(index);
                  }}
                  onDragEnd={() => {
                    setDragArmed(false);
                    setDragIdx(null);
                    setOverIdx(null);
                  }}
                >
                  <span
                    className="proj-drag-handle"
                    title="드래그해서 순서 변경"
                    onMouseDown={() => setDragArmed(true)}
                    onMouseUp={() => setDragArmed(false)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    ⠿
                  </span>
                  <span className="proj-name">{project.name}</span>
                  <span className="proj-count">{project.count}</span>
                </div>
                {projectActive && (
                  <SidebarFolderTree
                    state={folders[project.id]}
                    loading={folderLoading[project.id]}
                    expanded={expandedFolders[project.id] || new Set()}
                    onToggle={(path) => toggleProjectFolderNode(project.id, path)}
                    onSelect={(path) => selectFolder(project.id, path)}
                  />
                )}
              </div>
            );
          })}
          {archivedCount > 0 && (
            <div className="proj-archived">
              <button
                className="proj-archived-head"
                onClick={toggleArchived}
                title="보관한 프로젝트 — 펼칠 때만 불러옴(평소 로드 가벼움)"
              >
                {showArchived ? "▾" : "▸"} {tr("보관함")} ({archivedCount})
              </button>
              {showArchived &&
                archived.map((project) => (
                  <button
                    key={project.id}
                    className={"proj-row archived" + (activeId === project.id ? " on" : "")}
                    onClick={() => onFilter(activeId === project.id ? undefined : project.id)}
                    title={project.name}
                  >
                    <span className="proj-name">{project.name}</span>
                    <span className="proj-count">{project.count}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
