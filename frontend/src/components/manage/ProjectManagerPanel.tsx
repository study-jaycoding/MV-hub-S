// 프로젝트 관리 패널 — 관리자 창의 '프로젝트' 탭을 이식한 오버레이. 프로젝트 생성/편집·렌더 폴더
// 라벨링·멤버 프로젝트 역할 부여·보관/삭제·순서변경. 권한(create_project/grant_project_role)은
// 백엔드가 강제하며 여기선 UI 노출만 게이팅한다. 대시보드 상단의 '+ 프로젝트'로 연다.
import { Fragment, useEffect, useState } from "react";
import { api } from "../../api";
import { manageApi } from "../../lib/manageApi";
import {
  projectRoleCounts,
  systemMemberUids,
  visibleAdminMembers,
} from "../../lib/accountIdentity";
import {
  rememberProjectFolderEntry,
  rememberProjectFolderLink,
  type ProjectFolderEntry,
} from "../../lib/projectFolderTree";
import {
  planningBudgetInput,
  validateProjectPlanning,
} from "../../lib/projectPlanning";
import { loadJSON, saveJSON } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useManageCaps } from "../../lib/useManageCaps";
import { ProjectRenderTree } from "../admin/ProjectRenderTree";
import { ProjectMembersPanel } from "./ProjectMembersPanel";
import { ProjectPlanningFields } from "./ProjectPlanningDialog";
import type { Planning } from "./types";
import { defaultProjectRoles } from "../../types";
import type {
  Member,
  Project,
  ProjectFolderState,
  ProjectMember,
  WorkspaceMemberCandidate,
  WorkspaceOption,
} from "../../types";

type ProjectDialogState =
  | {
      mode: "create";
      name: string;
      rootPath: string;
      workspaceId: string;
      planning: Planning;
      budgetInput: string;
      busy?: boolean;
      error?: string;
    }
  | {
      mode: "rename";
      project: Project;
      name: string;
      rootPath: string;
      workspaceId: string;
      planning: Planning;
      budgetInput: string;
      busy?: boolean;
      error?: string;
    };

export function ProjectManagerPanel({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose);
  const caps = useManageCaps();
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceOption[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<Record<string, WorkspaceMemberCandidate[]>>({});
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState | null>(null);
  const [projFolders, setProjFolders] = useState<Record<string, ProjectFolderEntry>>({});
  // 렌더폴더 트리를 펼친 프로젝트 — 이전에 펼쳐둔 상태를 기억(매번 전체 펼침 금지).
  const [openFolderTrees, setOpenFolderTrees] = useState<Set<string>>(
    () => new Set(loadJSON<string[]>(STORAGE_KEYS.manageFolderTrees) || []),
  );
  const [folderLoading, setFolderLoading] = useState<Record<string, boolean>>({});
  const [activeMembersProjectId, setActiveMembersProjectId] = useState("");
  const [projMembersMap, setProjMembersMap] = useState<Record<string, ProjectMember[]>>({});
  const [actMsg, setActMsg] = useState("");
  const systemUids = systemMemberUids(members);
  const visibleMembers = visibleAdminMembers(members, systemUids);

  const loadProjectFolderTree = async (pid: string) => {
    setFolderLoading((prev) => ({ ...prev, [pid]: true }));
    try {
      const state = await api.projectFolder(pid);
      rememberProjectFolderEntry(state);
      setProjFolders((prev) => {
        const next = { ...prev };
        if (state.root_path) next[pid] = state;
        else delete next[pid];
        return next;
      });
      return state;
    } catch {
      return null;
    } finally {
      setFolderLoading((prev) => ({ ...prev, [pid]: false }));
    }
  };

  const loadProjects = () =>
    api
      .projects("team", true)
      .then((r) => {
        setProjects(r.projects);
        api.allProjectMembers().then(setProjMembersMap).catch(() => {});
        api
          .projectFolderLinks()
          .then((res) => {
            const next: Record<string, ProjectFolderEntry> = {};
            for (const [pid, link] of Object.entries(res.links || {})) {
              next[pid] = rememberProjectFolderLink(link);
            }
            setProjFolders(next);
            const linkedIds = Object.keys(res.links || {}).filter(
              (pid) => !!res.links[pid]?.root_path,
            );
            // 이전에 펼쳐둔 프로젝트만 복원(linked 인 것만 유효). 폴더 없는 건 자동 제외.
            const linkedSet = new Set(linkedIds);
            const saved = (loadJSON<string[]>(STORAGE_KEYS.manageFolderTrees) || []).filter(
              (pid) => linkedSet.has(pid),
            );
            setOpenFolderTrees(new Set(saved));
            saved.forEach((pid) => {
              if (!next[pid]?.tree) loadProjectFolderTree(pid);
            });
          })
          .catch(() => {});
      })
      .catch(() => setProjects([]));
  useEffect(() => {
    api.members().then(setMembers).catch(() => {});
    api.workspaceOptions().then((r) => setWorkspaceOptions(r.workspaces || [])).catch(() => {});
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadWorkspaceMembers = async (workspaceId: string) => {
    if (!workspaceId) return [];
    if (workspaceMembers[workspaceId]) return workspaceMembers[workspaceId];
    try {
      const response = await api.workspaceMembers(workspaceId);
      const items = response.members || [];
      setWorkspaceMembers((previous) => ({ ...previous, [workspaceId]: items }));
      return items;
    } catch {
      setWorkspaceMembers((previous) => ({ ...previous, [workspaceId]: [] }));
      return [];
    }
  };

  const setPM = (pid: string, list: ProjectMember[]) =>
    setProjMembersMap((prev) => ({ ...prev, [pid]: list }));
  const toggleProjectMembers = async (pid: string) => {
    if (activeMembersProjectId === pid) {
      setActiveMembersProjectId("");
      return;
    }
    setActiveMembersProjectId(pid);
    try {
      const project = projects.find((item) => item.id === pid);
      if (project?.workspace_id) void loadWorkspaceMembers(project.workspace_id);
      setPM(pid, await api.projectMembers(pid));
    } catch {
      setPM(pid, []);
    }
  };
  const changeProjRoles = async (pid: string, uid: string, roles: string[]) => {
    try {
      setPM(pid, await api.setProjectRoles(pid, uid, roles));
    } catch (e) {
      alert("프로젝트 역할 변경 실패: " + String(e));
    }
  };
  const addProjectMembers = async (pid: string, uids: string[]) => {
    for (const uid of uids) {
      const globalRoles =
        members.find((member) => member.uid === uid)?.global_roles ||
        Object.values(workspaceMembers).flat().find((member) => member.uid === uid)?.global_roles;
      const roles = defaultProjectRoles(globalRoles);
      setPM(pid, await api.setProjectRoles(pid, uid, roles.length ? roles : ["creator"]));
    }
  };
  const removeProjMember = async (pid: string, uid: string) => {
    try {
      setPM(pid, await api.removeProjectMember(pid, uid));
    } catch (e) {
      alert("멤버 제거 실패: " + String(e));
    }
  };
  const projRoleCounts = (pid: string) => projectRoleCounts(projMembersMap[pid] || [], systemUids);

  const createProject = () => {
    const workspaceId = workspaceOptions[0]?.id || "";
    setProjectDialog({
      mode: "create",
      name: "",
      rootPath: "",
      workspaceId,
      planning: { status: "active", budget_period: "month" },
      budgetInput: "",
    });
    if (workspaceId) void loadWorkspaceMembers(workspaceId);
  };
  const renameProject = async (p: Project) => {
    try {
      const [loadedFolder, planning] = await Promise.all([
        projFolders[p.id]
          ? Promise.resolve(projFolders[p.id])
          : loadProjectFolderTree(p.id),
        manageApi.getPlanning(p.id),
      ]);
      const folder: ProjectFolderEntry | ProjectFolderState | null = loadedFolder;
      const workspaceId = p.workspace_id || workspaceOptions[0]?.id || "";
      setProjectDialog({
        mode: "rename",
        project: p,
        name: p.name,
        rootPath: folder?.root_path || "",
        workspaceId,
        planning: { status: "active", ...planning },
        budgetInput: planningBudgetInput(planning),
      });
      if (workspaceId) void loadWorkspaceMembers(workspaceId);
    } catch (reason) {
      setActMsg(`프로젝트 설정을 불러오지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
    }
  };
  const saveProjectFolderLink = async (pid: string, rootPath: string, selectedPath: string) => {
    try {
      const state = await api.setProjectFolder(pid, {
        root_path: rootPath,
        selected_path: rootPath ? selectedPath : "",
      });
      rememberProjectFolderEntry(state);
      setProjFolders((cur) => {
        const next = { ...cur };
        if (state.root_path) next[pid] = state;
        else delete next[pid];
        return next;
      });
      setOpenFolderTrees((prevSet) => {
        const next = new Set(prevSet);
        if (state.root_path) next.add(pid);
        else next.delete(pid);
        return next;
      });
      return state;
    } catch (e) {
      setActMsg(
        `프로젝트는 저장됐지만 렌더 폴더 경로는 저장하지 못했습니다. ${String(e).replace(/^Error:\s*/, "")}`,
      );
      return null;
    }
  };
  const saveProjectDialog = async () => {
    if (!projectDialog || projectDialog.busy) return;
    const name = projectDialog.name.trim();
    const rootPath = projectDialog.rootPath.trim();
    if (!name) {
      setProjectDialog({ ...projectDialog, error: "프로젝트 이름을 입력하세요." });
      return;
    }
    const planningResult = validateProjectPlanning(
      projectDialog.planning,
      projectDialog.budgetInput,
    );
    if (!planningResult.planning) {
      setProjectDialog({ ...projectDialog, error: planningResult.error });
      return;
    }
    const workspace = workspaceOptions.find((item) => item.id === projectDialog.workspaceId);
    if (!workspace) {
      setProjectDialog({
        ...projectDialog,
        error: workspaceOptions.length
          ? "워크스페이스를 선택하세요."
          : "에이전트 동기화 후 확인된 워크스페이스가 있어야 프로젝트를 만들 수 있습니다.",
      });
      return;
    }
    const workspaceContext = { scope: "team" as const, id: workspace.id, name: workspace.name };
    setProjectDialog({ ...projectDialog, busy: true, error: "" });
    let createdProjectId = "";
    let folderSaveFailed = false;
    try {
      if (projectDialog.mode === "create") {
        const created = await api.createProject(name, "team", workspaceContext);
        createdProjectId = created.id;
        await manageApi.setPlanning(created.id, planningResult.planning);
        if (rootPath) folderSaveFailed = !(await saveProjectFolderLink(created.id, rootPath, ""));
      } else {
        await api.updateProject(projectDialog.project.id, { name, workspace: workspaceContext });
        await manageApi.setPlanning(projectDialog.project.id, planningResult.planning);
        const prev = projFolders[projectDialog.project.id];
        if (rootPath || prev?.root_path) {
          folderSaveFailed = !(await saveProjectFolderLink(
            projectDialog.project.id,
            rootPath,
            rootPath ? prev?.selected_path || "" : "",
          ));
        }
      }
      setProjectDialog(null);
      if (!folderSaveFailed) setActMsg(`${name} 프로젝트 설정을 저장했습니다.`);
      loadProjects();
    } catch (e) {
      if (createdProjectId) {
        setProjectDialog(null);
        setActMsg(
          `${name} 프로젝트는 생성됐지만 일정·예산 저장에 실패했습니다. 연필 수정에서 다시 저장하세요.`,
        );
        loadProjects();
        return;
      }
      setProjectDialog({ ...projectDialog, busy: false, error: String(e).replace(/^Error:\s*/, "") });
    }
  };
  // 펼침 상태를 기억 — 다음에 열 때 그대로 복원.
  useEffect(() => {
    saveJSON(STORAGE_KEYS.manageFolderTrees, [...openFolderTrees]);
  }, [openFolderTrees]);

  const toggleFolderTree = (pid: string) => {
    if (openFolderTrees.has(pid)) {
      setOpenFolderTrees((prev) => {
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
      return;
    }
    setOpenFolderTrees((prev) => new Set(prev).add(pid));
    if (!projFolders[pid]?.tree) loadProjectFolderTree(pid);
  };
  const selectProjectFolder = async (pid: string, path: string) => {
    const cur = projFolders[pid];
    if (!cur?.root_path) return;
    setProjFolders((prev) => ({ ...prev, [pid]: { ...cur, selected_path: path } }));
    try {
      const link = await api.setProjectFolderSelection(pid, path);
      setProjFolders((prev) => {
        const state = rememberProjectFolderEntry({ ...(prev[pid] ?? cur), ...link });
        return { ...prev, [pid]: state };
      });
    } catch {
      loadProjectFolderTree(pid);
    }
  };
  const toggleArchive = async (p: Project) => {
    await api.updateProject(p.id, { archived: !p.archived });
    loadProjects();
  };
  const [dragArmed, setDragArmed] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const dropProjectAt = async (toIdx: number) => {
    const from = dragIdx;
    setDragArmed(false);
    setDragIdx(null);
    setOverIdx(null);
    if (from === null || from === toIdx) return;
    const next = projects.slice();
    const [moved] = next.splice(from, 1);
    next.splice(toIdx, 0, moved);
    setProjects(next);
    try {
      await api.reorderProjects(next.map((x) => x.id));
    } catch {
      loadProjects();
    }
  };
  const deleteProject = async (p: Project) => {
    if (!window.confirm(`프로젝트 '${p.name}' 삭제? 결과물은 미분류로 돌아갑니다.`)) return;
    await api.deleteProject(p.id);
    if (activeMembersProjectId === p.id) setActiveMembersProjectId("");
    loadProjects();
  };

  const activeMembersProject = projects.find((project) => project.id === activeMembersProjectId);
  const activeMemberCandidates = activeMembersProject
    ? activeMembersProject.workspace_id
      ? workspaceMembers[activeMembersProject.workspace_id]
      : visibleMembers
    : undefined;

  return (
    <div className="manage-proj-overlay" onMouseDown={onClose}>
      <div
        className={`manage-proj-modal${activeMembersProject ? " members-open" : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="manage-proj-head">
          <h2>프로젝트 관리</h2>
          <button className="manage-proj-close" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

        <div className={`project-admin-layout${activeMembersProject ? " members-open" : ""}`}>
          <div className="project-admin-list">
            <section className="admin-section">
          <h4 className="admin-sec-head">
            프로젝트 생성
            {caps.createProject && (
              <button className="admin-add" onClick={createProject}>
                + 새 프로젝트
              </button>
            )}
          </h4>
          <div className="admin-note-sub">
            프로젝트를 만들고, 👥 로 멤버에게 프로젝트 역할(작업·검수)을 부여합니다 (Product Manager 전용).
          </div>
          {actMsg && <div className="admin-note-sub">{actMsg}</div>}
          {projects.length === 0 && <div className="admin-empty">없음</div>}
          <table className="admin-table">
            <tbody>
              {projects.map((p, idx) => (
                <Fragment key={p.id}>
                  <tr
                    className={
                      (p.archived ? "archived" : "") +
                      (dragIdx === idx ? " row-dragging" : "") +
                      (overIdx === idx && dragIdx !== idx ? " row-dragover" : "")
                    }
                    draggable={dragArmed}
                    onDragStart={(e) => {
                      setDragIdx(idx);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      if (dragIdx === null) return;
                      e.preventDefault();
                      if (overIdx !== idx) setOverIdx(idx);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      dropProjectAt(idx);
                    }}
                    onDragEnd={() => {
                      setDragArmed(false);
                      setDragIdx(null);
                      setOverIdx(null);
                    }}
                  >
                    <td className="admin-pname">
                      {caps.createProject && (
                        <span
                          className="proj-drag-handle"
                          title="드래그해서 순서 변경"
                          onMouseDown={() => setDragArmed(true)}
                          onMouseUp={() => setDragArmed(false)}
                        >
                          ⠿
                        </span>
                      )}
                      <span className="admin-pname-text">{p.name}</span>
                      <span className="admin-badge proj-workspace-badge">
                        {p.workspace_name || "워크스페이스 미지정"}
                      </span>
                      {p.archived && <span className="admin-badge">보관됨</span>}
                      {projFolders[p.id]?.root_path && (
                        <span className="proj-folder-path" title={projFolders[p.id]?.root_path}>
                          {projFolders[p.id]?.root_path}
                        </span>
                      )}
                    </td>
                    <td className="admin-count proj-count-cell">
                      <span className="proj-gencount" title="생성물 수(프로젝트 전체)">
                        {p.total ?? p.count}
                      </span>
                      <span className="proj-rolecount" title="멤버 역할 인원(복수 역할은 각각 셈)">
                        {(() => {
                          const rc = projRoleCounts(p.id);
                          return `PM ${rc.project_manager} · Sup ${rc.supervisor} · Creator ${rc.creator}`;
                        })()}
                      </span>
                    </td>
                    <td className="admin-pactions">
                      {caps.grantRole && (
                        <button
                          className={activeMembersProjectId === p.id ? "on" : ""}
                          onClick={() => void toggleProjectMembers(p.id)}
                          title="멤버 역할 부여(작업·검수)"
                        >
                          👥
                        </button>
                      )}
                      <button
                        className={openFolderTrees.has(p.id) ? "on" : ""}
                        onClick={() => toggleFolderTree(p.id)}
                        disabled={!projFolders[p.id]?.root_path}
                        title={
                          projFolders[p.id]?.root_path
                            ? "Render 폴더 구조 보기"
                            : "이름 변경에서 렌더 폴더 경로를 먼저 지정하세요"
                        }
                      >
                        🗂
                      </button>
                      {caps.createProject && (
                        <>
                          <button onClick={() => renameProject(p)} title="프로젝트 설정">
                            ✎
                          </button>
                          <button
                            className="admin-pact-archive"
                            onClick={() => toggleArchive(p)}
                            title={p.archived ? "보관 해제 — 메인으로 되돌림" : "보관 — 메인에서 숨김(데이터 보존)"}
                          >
                            {p.archived ? "📂" : "📦"}
                          </button>
                          <button onClick={() => deleteProject(p)} title="삭제">
                            ✕
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {openFolderTrees.has(p.id) && projFolders[p.id]?.root_path && (
                    <tr className="proj-folder-row">
                      <td colSpan={3}>
                        <ProjectRenderTree
                          state={projFolders[p.id]}
                          loading={folderLoading[p.id]}
                          onSelect={(path) => selectProjectFolder(p.id, path)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
            </section>
          </div>
          {activeMembersProject && (
            <ProjectMembersPanel
              key={activeMembersProject.id}
              project={activeMembersProject}
              projectMembers={projMembersMap[activeMembersProject.id]}
              candidates={activeMemberCandidates}
              systemUids={systemUids}
              onClose={() => setActiveMembersProjectId("")}
              onRolesChange={(uid, roles) => changeProjRoles(activeMembersProject.id, uid, roles)}
              onRemove={(uid) => removeProjMember(activeMembersProject.id, uid)}
              onAddMembers={(uids) => addProjectMembers(activeMembersProject.id, uids)}
            />
          )}
        </div>

        {projectDialog && (
          <div className="admin-confirm-backdrop" onMouseDown={() => setProjectDialog(null)}>
            <div className="admin-confirm admin-project-dialog" onMouseDown={(e) => e.stopPropagation()}>
              <p className="admin-confirm-q">
                {projectDialog.mode === "create" ? "새 프로젝트" : "프로젝트 설정"}
              </p>
              <label className="admin-field">
                <span>프로젝트 이름</span>
                <input
                  className="settings-input"
                  placeholder="프로젝트 이름"
                  value={projectDialog.name}
                  onChange={(e) => setProjectDialog({ ...projectDialog, name: e.target.value, error: "" })}
                  onKeyDown={(e) => e.key === "Enter" && saveProjectDialog()}
                  autoFocus
                />
              </label>
              <label className="admin-field">
                <span>워크스페이스</span>
                <select
                  className="settings-input"
                  value={projectDialog.workspaceId}
                  onChange={(e) => {
                    const workspaceId = e.target.value;
                    setProjectDialog({
                      ...projectDialog,
                      workspaceId,
                      error: "",
                    });
                    void loadWorkspaceMembers(workspaceId);
                  }}
                >
                  {workspaceOptions.length === 0 && <option value="">확인된 워크스페이스 없음</option>}
                  {workspaceOptions.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name} · 멤버 {workspace.member_count}명
                    </option>
                  ))}
                </select>
              </label>
              <label className="admin-field">
                <span>렌더 폴더 경로</span>
                <input
                  className="settings-input"
                  placeholder="예: D:\\Project\\Act_01"
                  value={projectDialog.rootPath}
                  onChange={(e) => setProjectDialog({ ...projectDialog, rootPath: e.target.value, error: "" })}
                  onKeyDown={(e) => e.key === "Enter" && saveProjectDialog()}
                />
              </label>
              <div className="admin-note-sub">
                경로를 넣으면 그 안의 Render 폴더 구조가 프로젝트 아래에 표시됩니다.
              </div>
              {projectDialog.mode === "create" && projectDialog.workspaceId && (
                <div className="project-member-picker">
                  <div className="project-member-picker-head">
                    <strong>워크스페이스 멤버 자동 추가</strong>
                    <span>
                      {(() => {
                        const connected = workspaceMembers[projectDialog.workspaceId]?.length || 0;
                        const reported = workspaceOptions.find(
                          (workspace) => workspace.id === projectDialog.workspaceId,
                        )?.member_count || 0;
                        const waiting = Math.max(0, reported - connected);
                        return `${connected}명 자동 추가${waiting ? ` · 연결 대기 ${waiting}명` : ""}`;
                      })()}
                    </span>
                  </div>
                  <div className="project-member-picker-list">
                    {(workspaceMembers[projectDialog.workspaceId] || [])
                      .map((member) => {
                        return (
                          <div key={member.uid} className="project-member-pick auto on">
                            <span className="admin-dot" />
                            <span>
                              <strong>{member.name || member.email?.split("@")[0] || "팀원"}</strong>
                              <small>{member.email || member.workspace_role || "워크스페이스 멤버"}</small>
                            </span>
                          </div>
                        );
                      })}
                    {workspaceMembers[projectDialog.workspaceId] === undefined && (
                      <div className="admin-empty">멤버 불러오는 중…</div>
                    )}
                    {workspaceMembers[projectDialog.workspaceId]?.length === 0 && (
                      <div className="admin-empty">이 워크스페이스에서 확인된 멤버가 없습니다.</div>
                    )}
                  </div>
                  <div className="admin-note-sub project-auto-member-note">
                    프로젝트를 저장하면 계정 연결이 끝난 워크스페이스 멤버가 기본 역할로 자동 등록됩니다. 역할은 생성 후 👥에서 조정할 수 있습니다.
                  </div>
                </div>
              )}
              <section className="project-settings-section">
                <h5>일정·예산</h5>
                <ProjectPlanningFields
                  form={projectDialog.planning}
                  budgetInput={projectDialog.budgetInput}
                  onFormChange={(planning) => setProjectDialog({
                    ...projectDialog,
                    planning,
                    error: "",
                  })}
                  onBudgetInputChange={(budgetInput) => setProjectDialog({
                    ...projectDialog,
                    budgetInput,
                    error: "",
                  })}
                />
              </section>
              {projectDialog.error && <div className="login-error">{projectDialog.error}</div>}
              <div className="admin-confirm-actions">
                <button className="admin-confirm-yes" onClick={saveProjectDialog} disabled={projectDialog.busy}>
                  {projectDialog.busy ? "저장 중…" : "확인"}
                </button>
                <button className="admin-confirm-no" onClick={() => setProjectDialog(null)}>
                  취소
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
