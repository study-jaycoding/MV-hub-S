import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { api } from "../../api";
import { isFolderDisabled, toggleDisabledFolder } from "../../lib/deactivated";
import { buildFolderCountTree, hasMoreThanFolderNodes } from "../../lib/folderTreeModel";
import { useDisabledFolders } from "../../lib/useDisabledFolders";
import { APP_EVENTS } from "../../lib/appEvents";
import { DRAG_TYPES } from "../../lib/dragTypes";
import { encodeSceneFolderDrag } from "../../lib/sceneSet";
import { onLibraryChanged } from "../../lib/libraryBroadcast";
import { useCustomEvent } from "../../lib/useCustomEvent";
import { useT } from "../../lib/i18n";
import { reconcileArrayState, reconcileRecordState } from "../../lib/stateReconciliation";
import { loadJSON, saveJSON } from "../../lib/storage";
import { getTeamBase, getTeamSeenVersion, isAckedFor, subscribeTeamSeen } from "../../lib/teamSeen";
import {
  cachedProjectFolderEntries,
  initialProjectFolderExpansion,
  loadProjectFolderExpansion,
  rememberProjectFolderEntry,
  rememberProjectFolderLink,
  saveProjectFolderExpansion,
  visibleProjectFolderRoots,
  type ProjectFolderEntry,
} from "../../lib/projectFolderTree";
import type { Project, ProjectFolderState } from "../../types";
import { FolderTreeView, type FolderTreeItem } from "../common/FolderTreeView";

function SidebarFolderTree({
  state,
  loading,
  counts,
  newCounts,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
  onDropFolder,
  onDragFolder,
  isDisabled,
  onRowKeyDown,
}: {
  state?: ProjectFolderEntry;
  loading?: boolean;
  counts?: Record<string, number>;
  newCounts?: Record<string, number>; // 마지막 방문 이후 새로 공유된 개수(팀 탭) — 라임 배지
  // 빨간 하이라이트 = 실제 생성 목적지(armedFolder). 서버 저장 selected_path 가 아니라 이걸 쓴다
  // — 무장이 풀리면(기본 라이브러리로 감) 하이라이트도 사라져 '어디로 생성되는지'와 정확히 일치.
  selectedPath?: string;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDropFolder?: (path: string, e: DragEvent) => void;
  onDragFolder?: (path: string, e: DragEvent) => void;
  isDisabled?: (path: string) => boolean;
  onRowKeyDown?: (path: string, e: KeyboardEvent) => void;
}) {
  // 트리 파생(정규화→가상폴더 합성→카운트 누적)은 입력이 바뀔 때만 계산한다.
  // (훅 규칙상 아래 early return 들보다 먼저 호출)
  const roots = useMemo(() => {
    if (!state?.tree) return [] as FolderTreeItem[];
    return buildFolderCountTree(visibleProjectFolderRoots(state.tree), counts, newCounts);
  }, [state?.tree, counts, newCounts]);
  if (!state?.root_path) return null;
  if (loading && !state.tree) return <div className="side-folder-note">폴더 로딩...</div>;
  if (state.error) return <div className="side-folder-note error">{state.error}</div>;
  if (!state.tree) return null;
  if (!roots.length) return null; // 합성 후에도 비면(디스크·데이터 모두 없음) 트리 숨김
  // 폴더가 15개를 넘을 때만 스크롤(max-height) 적용 — 적을 땐 스크롤바가 깜빡이지 않게.
  const scroll = hasMoreThanFolderNodes(roots, 15);
  return (
    <div title={state.render_path || state.root_path}>
      <FolderTreeView
        nodes={roots}
        selectedPath={selectedPath || ""}
        expanded={expanded}
        onToggle={onToggle}
        onSelect={onSelect}
        onDropFolder={onDropFolder}
        onDragFolder={onDragFolder}
        isDisabled={isDisabled}
        onRowKeyDown={onRowKeyDown}
        scroll={scroll}
        className="sidebar-folder-tree"
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
  armedFolder,
  onFilter,
  onViewDeleted,
  onArmFolder,
  onDropToFolder,
  onDropToUnassigned,
  enableFolderDrag = false,
}: {
  projects: Project[];
  unassignedCount: number;
  archivedCount: number;
  activeId?: string;
  tab?: "my" | "team"; // 폴더 개수 뱃지를 현재 라이브러리 탭 기준으로 조회
  deletedOnly: boolean;
  // 실제 생성 목적지(무장 폴더). 폴더 트리의 빨간 하이라이트를 이것에 연동 — 서버 selected_path 아님.
  armedFolder?: { projectId: string; path: string } | null;
  onFilter: (projectId?: string) => void;
  onViewDeleted: () => void;
  // 폴더 선택 시 무장(전역변수) — 그 프로젝트로 생성 시 folder_path 로 자동 라벨링
  onArmFolder?: (projectId: string, path: string) => void;
  // 카드를 폴더로 드래그해 담기 — 그 프로젝트+폴더로 귀속
  onDropToFolder?: (projectId: string, path: string, genId: string) => void;
  // 카드를 '미분류'로 드래그 — 귀속 해제
  onDropToUnassigned?: (genId: string) => void;
  // 캔버스에서만 폴더 → Set 드래그를 켠다. 일반 작업공간에서는 기존 클릭 UX 유지.
  enableFolderDrag?: boolean;
}) {
  const tr = useT();
  const disabledFolders = useDisabledFolders(); // 폴더 단위 비활성(생략) — d 로 토글, 회색 표시
  // 팀 탭 +N 배지 — 카드 클릭(확인)마다 스토어가 bump → 아래 fresh 재계산으로 배지가 하나씩 줄어든다.
  const teamSeenVer = useSyncExternalStore(subscribeTeamSeen, getTeamSeenVersion);
  const [order, setOrder] = useState<Project[]>(projects);
  useEffect(
    () => setOrder((previous) => reconcileArrayState(previous, projects)),
    [projects],
  );
  const [folders, setFolders] = useState<Record<string, ProjectFolderEntry>>(() =>
    cachedProjectFolderEntries(projects.map((project) => project.id)),
  );
  const [folderLoading, setFolderLoading] = useState<Record<string, boolean>>({});
  // 링크 목록과 실제 디스크 트리를 분리한다. 링크는 전 프로젝트를 가볍게 받고,
  // 트리는 현재 선택/고정된 프로젝트만 지연 로드한다.
  const [linkedFolderIds, setLinkedFolderIds] = useState<string[]>([]);
  const [folderCounts, setFolderCounts] = useState<Record<string, Record<string, number>>>({});
  // 팀 탭: 기준선 이후 공유된 항목 목록(서버) — 확인(클릭)분을 제외하고 +N 을 만든다.
  const [teamFreshItems, setTeamFreshItems] = useState<
    {
      id: string;
      project_id: string | null;
      folder_path: string | null;
      shared_at: string | null;
      ack_key?: string | null;
    }[]
  >([]);
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
        [pid]: initialProjectFolderExpansion(
          visibleProjectFolderRoots(tree),
          state.selected_path || "",
        ),
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
        setLinkedFolderIds(linkedIds);
        setFolders((prev) => {
          const next: Record<string, ProjectFolderEntry> = {};
          for (const pid of linkedIds) {
            const current = prev[pid];
            const link = links[pid];
            // 현재 인스턴스가 가진 트리가 캐시보다 최신일 수도 있다(폴더 선택 직후 등).
            if (current) rememberProjectFolderEntry(current);
            next[pid] = rememberProjectFolderLink(link);
          }
          return next;
        });
      })
      .catch(() => {
        if (alive) setLinkedFolderIds([]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey]);

  // 실제 재귀 트리는 화면에 필요한 활성 프로젝트와 고정핀 프로젝트만 읽는다.
  useEffect(() => {
    let alive = true;
    const linked = new Set(linkedFolderIds);
    const ids = new Set<string>();
    pinned.forEach((pid) => {
      if (linked.has(pid)) ids.add(pid);
    });
    if (activeId && activeId !== "none" && linked.has(activeId)) ids.add(activeId);
    ids.forEach((pid) => {
      setFolderLoading((prev) => ({ ...prev, [pid]: true }));
      api
        .projectFolder(pid)
        .then((state) => {
          if (!alive) return;
          seedProjectExpansion(pid, state);
          rememberProjectFolderEntry(state);
          setFolders((prev) => ({ ...prev, [pid]: state }));
        })
        .catch(() => {
          if (!alive) return;
          setFolders((prev) => {
            const failed = {
              ...prev[pid],
              error: "폴더 정보를 불러오지 못했습니다",
            } as ProjectFolderEntry;
            rememberProjectFolderEntry(failed);
            return { ...prev, [pid]: failed };
          });
        })
        .finally(() => {
          if (alive) setFolderLoading((prev) => ({ ...prev, [pid]: false }));
        });
    });
    return () => {
      alive = false;
    };
    // pinned 는 토글할 때 새 Set 으로 교체되므로 안전한 의존성이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, pinned, linkedFolderIds]);

  // 활성 + 고정핀 프로젝트의 폴더별 생성물 개수 로드(트리 뱃지). state 카운터를 먼저 올리지
  // 않고 요청을 직접 시작해, 데이터가 도착하기 전의 ProjectSection 선렌더를 없앤다.
  const countRequestSeqRef = useRef(0);
  const refreshCountsRef = useRef<() => void>(() => {});
  const refreshCounts = () => {
    const requestSeq = ++countRequestSeqRef.current;
    const isLatest = () => requestSeq === countRequestSeqRef.current;
    const ids = new Set<string>(pinned);
    if (activeId && activeId !== "none") ids.add(activeId);
    const wanted = [...ids];
    if (wanted.length) {
      api
        .projectFolderCountsBatch(wanted, tab)
        .then((r) => {
          if (!isLatest()) return;
          setFolderCounts((prev) => {
            const next = { ...prev };
            for (const pid of wanted) next[pid] = r.counts?.[pid] || {};
            return reconcileRecordState(prev, next);
          });
        })
        .catch(() => {});
    }
    // 팀 탭: 기준선 이후 공유된 항목 목록(+N 원천)도 갱신 — 폴더뿐 아니라 미분류·프로젝트 행에도 배지.
    // 구버전 서버(라우트 없음 404)는 빈 목록 폴백 = 배지만 숨김.
    const since = tab === "team" ? getTeamBase() : null;
    if (since) {
      api
        .teamFreshAll(since, isLatest)
        .then((items) => {
          if (isLatest()) {
            setTeamFreshItems((previous) => reconcileArrayState(previous, items));
          }
        })
        .catch(() => {
          if (isLatest()) {
            setTeamFreshItems((previous) => reconcileArrayState(previous, []));
          }
        });
    }
  };
  refreshCountsRef.current = refreshCounts;

  // 생성물 변경 브로드캐스트(담기/폴더이동/미분류/생성)를 구독한다. 캔버스 탭에서는
  // 프로젝트 목록 reload가 생략되므로 이 채널이 폴더 배지를 즉시 최신화한다.
  useEffect(() => onLibraryChanged(() => refreshCountsRef.current()), []); // 다른 창의 변경
  useCustomEvent(APP_EVENTS.libraryChanged, () => refreshCountsRef.current()); // 같은 창의 변경

  useEffect(() => {
    refreshCountsRef.current();
    return () => {
      // 의존값 변경·언마운트 뒤 도착한 이전 응답은 현재 탭/프로젝트 상태에 반영하지 않는다.
      countRequestSeqRef.current += 1;
    };
    // 프로젝트 구성·탭·핀·활성 프로젝트가 바뀌면 조회 범위가 달라진다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, projectKey, pinned, tab]);

  // +N 계산 — 서버 신규 목록(teamFreshItems)에서 '확인(클릭)한 항목'을 제외해 폴더/프로젝트/미분류별 집계.
  // teamSeenVer 의존 — 카드 클릭 순간 스토어가 bump 되어 배지가 즉시 하나 줄어든다.
  const fresh = useMemo(() => {
    if (tab !== "team" || !teamFreshItems.length) return null;
    void teamSeenVer;
    const byProject: Record<string, number> = {};
    const folderByProject: Record<string, Record<string, number>> = {};
    let unassigned = 0;
    for (const it of teamFreshItems) {
      // 앵커 키(job_id 우선)로 대조 — 작업 공간(로컬 id)에서 클릭한 확인도 맞는다. 구서버는 id 폴백.
      if (isAckedFor(it.ack_key || it.id, it.shared_at)) continue; // 재공유(더 새 shared_at)면 다시 센다
      if (!it.project_id) {
        unassigned += 1;
        continue;
      }
      byProject[it.project_id] = (byProject[it.project_id] || 0) + 1;
      if (it.folder_path) {
        const m = (folderByProject[it.project_id] ||= {});
        m[it.folder_path] = (m[it.folder_path] || 0) + 1;
      }
    }
    return { byProject, folderByProject, unassigned };
  }, [tab, teamFreshItems, teamSeenVer]);

  const selectFolder = async (pid: string, path: string) => {
    const cur = folders[pid];
    if (!cur?.root_path) return;
    onFilter(pid);
    onArmFolder?.(pid, path); // 무장: 이 폴더로 생성하면 folder_path 자동 라벨링
    const selected = rememberProjectFolderEntry({ ...cur, selected_path: path });
    setFolders((prev) => ({ ...prev, [pid]: selected }));
    try {
      const link = await api.setProjectFolderSelection(pid, path);
      setFolders((prev) => {
        const state = rememberProjectFolderEntry({ ...(prev[pid] ?? cur), ...link });
        return { ...prev, [pid]: state };
      });
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
            className={
              "proj-row" + (!activeId && !deletedOnly ? " on sel-target" : "")
            }
            onClick={() => onFilter(undefined)}
          >
            <span className="proj-name">{tr("라이브러리")}</span>
          </button>
          <button
            className={
              "proj-row proj-unassigned" +
              (activeId === "none" && !deletedOnly ? " on sel-target" : "") +
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
                    // 복수 드래그(genlist, 쉼표구분)를 우선 — 없으면 단일(generation).
                    const genId =
                      e.dataTransfer.getData(DRAG_TYPES.generationList) ||
                      e.dataTransfer.getData(DRAG_TYPES.generation);
                    if (genId) onDropToUnassigned(genId);
                  }
                : undefined
            }
          >
            <span className="proj-name">{tr("미분류")}</span>
            {(fresh?.unassigned || 0) > 0 && (
              <span className="proj-newcount" title="마지막 확인 이후 새로 공유됨">
                +{fresh!.unassigned}
              </span>
            )}
            <span className="proj-count">{unassignedCount}</span>
          </button>
          <button
            className={"proj-row proj-trash" + (deletedOnly ? " on sel-target" : "")}
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
                    // 이 프로젝트가 활성이면서 그 안의 폴더를 무장하지 않았을 때만 프로젝트 행이 빨강
                    // (=프로젝트 루트가 목적지). 폴더 무장 중이면 빨강은 그 폴더에만.
                    (projectActive && armedFolder?.projectId !== project.id ? " sel-target" : "") +
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
                  {(fresh?.byProject[project.id] || 0) > 0 && (
                    <span className="proj-newcount" title="마지막 확인 이후 새로 공유됨">
                      +{fresh!.byProject[project.id]}
                    </span>
                  )}
                  <span className="proj-count">{project.count}</span>
                </div>
                {showTree && (
                  <SidebarFolderTree
                    state={folders[project.id]}
                    loading={folderLoading[project.id]}
                    counts={folderCounts[project.id]}
                    newCounts={fresh?.folderByProject[project.id]}
                    // 무장 폴더가 이 프로젝트일 때만 빨간 하이라이트. 아니면 없음(=기본 라이브러리로 생성).
                    selectedPath={
                      armedFolder?.projectId === project.id ? armedFolder.path : ""
                    }
                    expanded={expandedFolders[project.id] || new Set()}
                    onToggle={(path) => toggleProjectFolderNode(project.id, path)}
                    onSelect={(path) => selectFolder(project.id, path)}
                    onDropFolder={
                      onDropToFolder
                        ? (path, e) => {
                            // 복수 드래그(genlist, 쉼표구분)를 우선 — 없으면 단일(generation).
                            const genId =
                              e.dataTransfer.getData(DRAG_TYPES.generationList) ||
                              e.dataTransfer.getData(DRAG_TYPES.generation);
                            if (genId) onDropToFolder(project.id, path, genId);
                          }
                        : undefined
                    }
                    onDragFolder={
                      enableFolderDrag
                        ? (path, e) => {
                            const payload = encodeSceneFolderDrag({
                              projectId: project.id,
                              projectName: project.name,
                              path,
                            });
                            if (!payload) return;
                            e.dataTransfer.setData(DRAG_TYPES.folder, payload);
                            e.dataTransfer.effectAllowed = "copy";
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
                    className={"proj-row archived" + (activeId === project.id ? " on sel-target" : "")}
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
