import { useEffect, useState, type DragEvent, type KeyboardEvent } from "react";
import { api } from "../../api";
import { isFolderDisabled, toggleDisabledFolder } from "../../lib/deactivated";
import { useDisabledFolders } from "../../lib/useDisabledFolders";
import { DRAG_TYPES } from "../../lib/dragTypes";
import { useT } from "../../lib/i18n";
import { loadJSON, saveJSON } from "../../lib/storage";
import {
  collectExpandableProjectFolders,
  loadProjectFolderExpansion,
  saveProjectFolderExpansion,
  visibleProjectFolderRoots,
  type ProjectFolderEntry,
} from "../../lib/projectFolderTree";
import type { Project, ProjectFolderState } from "../../types";
import { FolderTreeView, type FolderTreeItem } from "../common/FolderTreeView";

// 트리의 전체 폴더 노드 수(모든 하위 포함) — 스크롤 여부 판단용.
function countFolderNodes(nodes: FolderTreeItem[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1 + (node.children ? countFolderNodes(node.children) : 0);
  }
  return n;
}

// 폴더별 생성물 개수(정확 경로)를 트리 노드에 누적 반영 — 노드 count = 자신 + 하위 전부의 합.
// 디스크 파일 수 대신 '이 폴더에 담긴 생성물 수'를 보여준다(사용자 요청).
function overlayFolderCounts(
  nodes: FolderTreeItem[],
  counts: Record<string, number>,
): FolderTreeItem[] {
  return nodes.map((n) => {
    let sum = 0;
    for (const key in counts) {
      if (key === n.path || key.startsWith(n.path + "/")) sum += counts[key];
    }
    return {
      ...n,
      count: sum,
      children: n.children ? overlayFolderCounts(n.children, counts) : n.children,
    };
  });
}

function SidebarFolderTree({
  state,
  loading,
  counts,
  expanded,
  onToggle,
  onSelect,
  onDropFolder,
  isDisabled,
  onRowKeyDown,
}: {
  state?: ProjectFolderEntry;
  loading?: boolean;
  counts?: Record<string, number>;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDropFolder?: (path: string, e: DragEvent) => void;
  isDisabled?: (path: string) => boolean;
  onRowKeyDown?: (path: string, e: KeyboardEvent) => void;
}) {
  if (!state?.root_path) return null;
  if (loading && !state.tree) return <div className="side-folder-note">폴더 로딩...</div>;
  if (state.error) return <div className="side-folder-note error">{state.error}</div>;
  if (!state.tree) return null;
  let roots: FolderTreeItem[] = visibleProjectFolderRoots(state.tree);
  if (!roots.length) return null;
  if (counts) roots = overlayFolderCounts(roots, counts);
  // 폴더가 15개를 넘을 때만 스크롤(max-height) 적용 — 적을 땐 스크롤바가 깜빡이지 않게.
  const scroll = countFolderNodes(roots) > 15;
  return (
    <div title={state.render_path || state.root_path}>
      <FolderTreeView
        nodes={roots}
        selectedPath={state.selected_path || ""}
        expanded={expanded}
        onToggle={onToggle}
        onSelect={onSelect}
        onDropFolder={onDropFolder}
        isDisabled={isDisabled}
        onRowKeyDown={onRowKeyDown}
        scroll={scroll}
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
  tab = "my",
  deletedOnly,
  onFilter,
  onViewDeleted,
  onArmFolder,
  onDropToFolder,
  onDropToUnassigned,
}: {
  projects: Project[];
  unassignedCount: number;
  archivedCount: number;
  activeId?: string;
  tab?: "my" | "team"; // 폴더 개수 뱃지를 현재 라이브러리 탭 기준으로 조회
  deletedOnly: boolean;
  onFilter: (projectId?: string) => void;
  onViewDeleted: () => void;
  // 폴더 선택 시 무장(전역변수) — 그 프로젝트로 생성 시 folder_path 로 자동 라벨링
  onArmFolder?: (projectId: string, path: string) => void;
  // 카드를 폴더로 드래그해 담기 — 그 프로젝트+폴더로 귀속
  onDropToFolder?: (projectId: string, path: string, genId: string) => void;
  // 카드를 '미분류'로 드래그 — 귀속 해제
  onDropToUnassigned?: (genId: string) => void;
}) {
  const tr = useT();
  const disabledFolders = useDisabledFolders(); // 폴더 단위 비활성(생략) — d 로 토글, 회색 표시
  const [order, setOrder] = useState<Project[]>(projects);
  useEffect(() => setOrder(projects), [projects]);
  const [folders, setFolders] = useState<Record<string, ProjectFolderEntry>>({});
  const [folderLoading, setFolderLoading] = useState<Record<string, boolean>>({});
  const [folderCounts, setFolderCounts] = useState<Record<string, Record<string, number>>>({});
  // 고정핀 — 켠 프로젝트는 활성이 아니어도 폴더 트리를 계속 보여준다(드래그 담기 상시 가능). 영속.
  const [pinned, setPinned] = useState<Set<string>>(
    () => new Set(loadJSON<string[]>("ch.pinnedProjects") || []),
  );
  const togglePin = (pid: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      saveJSON("ch.pinnedProjects", [...next]);
      return next;
    });
  };
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
            .catch(() => {
              // 조용히 삼키지 않고 트리에 사유 표시(SidebarFolderTree 가 state.error 렌더).
              if (alive)
                setFolders((prev) => ({
                  ...prev,
                  [pid]: { ...prev[pid], error: "폴더 정보를 불러오지 못했습니다" },
                }));
            })
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

  // 활성 + 고정핀 프로젝트의 폴더별 생성물 개수 로드(트리 뱃지). 진입·리로드 시 최신화.
  useEffect(() => {
    let alive = true;
    const ids = new Set<string>(pinned);
    if (activeId && activeId !== "none") ids.add(activeId);
    ids.forEach((pid) => {
      api
        .projectFolderCounts(pid, tab)
        .then((r) => alive && setFolderCounts((prev) => ({ ...prev, [pid]: r.counts || {} })))
        .catch(() => {});
    });
    return () => {
      alive = false;
    };
    // projects 는 라이브러리 리로드(생성·담기 후)마다 새 배열 → 개수 최신화 트리거.
    // 탭(my/team) 전환 시에도 재조회 → 팀 탭에서 팀 기준 개수 표시.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, projects, pinned, tab]);

  const selectFolder = async (pid: string, path: string) => {
    const cur = folders[pid];
    if (!cur?.root_path) return;
    onFilter(pid);
    onArmFolder?.(pid, path); // 무장: 이 폴더로 생성하면 folder_path 자동 라벨링
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
  const [unassignOver, setUnassignOver] = useState(false); // 카드를 '미분류'로 드래그 중 강조
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
              "proj-row proj-unassigned" +
              (activeId === "none" && !deletedOnly ? " on" : "") +
              (unassignOver ? " drop-over" : "")
            }
            onClick={() => onFilter(activeId === "none" ? undefined : "none")}
            title="아직 프로젝트에 담기지 않은 결과물 — 카드를 여기로 끌어놓으면 귀속 해제"
            onDragOver={
              onDropToUnassigned
                ? (e) => {
                    if (e.dataTransfer.types.includes(DRAG_TYPES.generation)) {
                      e.preventDefault();
                      if (!unassignOver) setUnassignOver(true);
                    }
                  }
                : undefined
            }
            onDragLeave={() => setUnassignOver(false)}
            onDrop={
              onDropToUnassigned
                ? (e) => {
                    e.preventDefault();
                    setUnassignOver(false);
                    const genId = e.dataTransfer.getData(DRAG_TYPES.generation);
                    if (genId) onDropToUnassigned(genId);
                  }
                : undefined
            }
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
            const isPinned = pinned.has(project.id);
            const showTree = projectActive || isPinned;
            return (
              <div
                key={project.id}
                className={"proj-tree-wrap" + (projectActive ? " on" : "") + (isPinned ? " pinned" : "")}
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
                  <button
                    className={"proj-pin" + (isPinned ? " on" : "")}
                    title={isPinned ? "고정 해제 — 폴더 상시 표시 끄기" : "고정 — 폴더를 항상 보이게(드래그 담기 상시)"}
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePin(project.id);
                    }}
                  >
                    📌
                  </button>
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
                {showTree && (
                  <SidebarFolderTree
                    state={folders[project.id]}
                    loading={folderLoading[project.id]}
                    counts={folderCounts[project.id]}
                    expanded={expandedFolders[project.id] || new Set()}
                    onToggle={(path) => toggleProjectFolderNode(project.id, path)}
                    onSelect={(path) => selectFolder(project.id, path)}
                    onDropFolder={
                      onDropToFolder
                        ? (path, e) => {
                            const genId = e.dataTransfer.getData(DRAG_TYPES.generation);
                            if (genId) onDropToFolder(project.id, path, genId);
                          }
                        : undefined
                    }
                    isDisabled={(path) => isFolderDisabled(disabledFolders, project.id, path)}
                    onRowKeyDown={(path, e) => {
                      // d = 이 폴더(및 하위) 비활성(생략) 토글. 그 폴더 생성물이 회색·관리창 생략 연동.
                      if (e.key === "d" || e.key === "D") {
                        e.preventDefault();
                        toggleDisabledFolder(project.id, path);
                      }
                    }}
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
