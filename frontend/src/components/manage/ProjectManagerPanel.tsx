// 프로젝트 관리 패널 — 관리자 창의 '프로젝트' 탭을 이식한 오버레이. 프로젝트 생성/편집·렌더 폴더
// 라벨링·멤버 프로젝트 역할 부여·보관/삭제·순서변경. 권한(create_project/grant_project_role)은
// 백엔드가 강제하며 여기선 UI 노출만 게이팅한다. 프로젝트 관리(요약) 창에서 '＋ 프로젝트'로 연다.
import { Fragment, useEffect, useState } from "react";
import { api } from "../../api";
import {
  adminMemberDisplayName,
  projectRoleCounts,
  systemMemberUids,
  visibleAdminMembers,
} from "../../lib/accountIdentity";
import type { ProjectFolderEntry } from "../../lib/projectFolderTree";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useManageCaps } from "../../lib/useManageCaps";
import { ProjectRenderTree } from "../admin/ProjectRenderTree";
import { ProjectRolePicker, memberRoleRank } from "../admin/RolePickers";
import { defaultProjectRoles } from "../../types";
import type { Member, Project, ProjectFolderState, ProjectMember } from "../../types";

type ProjectDialogState =
  | { mode: "create"; name: string; rootPath: string; busy?: boolean; error?: string }
  | { mode: "rename"; project: Project; name: string; rootPath: string; busy?: boolean; error?: string };

export function ProjectManagerPanel({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose);
  const caps = useManageCaps();
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState | null>(null);
  const [projFolders, setProjFolders] = useState<Record<string, ProjectFolderEntry>>({});
  const [openFolderTrees, setOpenFolderTrees] = useState<Set<string>>(new Set());
  const [folderLoading, setFolderLoading] = useState<Record<string, boolean>>({});
  const [openProjs, setOpenProjs] = useState<Set<string>>(new Set());
  const [projMembersMap, setProjMembersMap] = useState<Record<string, ProjectMember[]>>({});
  const [addQuery, setAddQuery] = useState<Record<string, string>>({});
  const [actMsg, setActMsg] = useState("");
  const systemUids = systemMemberUids(members);
  const visibleMembers = visibleAdminMembers(members, systemUids);

  const loadProjectFolderTree = async (pid: string) => {
    setFolderLoading((prev) => ({ ...prev, [pid]: true }));
    try {
      const state = await api.projectFolder(pid);
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
        api
          .projectFolderLinks()
          .then((res) => {
            setProjFolders((prev) => {
              const next: Record<string, ProjectFolderEntry> = {};
              for (const [pid, link] of Object.entries(res.links || {})) {
                next[pid] = { ...prev[pid], ...link };
              }
              return next;
            });
            const linkedIds = Object.keys(res.links || {}).filter(
              (pid) => !!res.links[pid]?.root_path,
            );
            setOpenFolderTrees(new Set(linkedIds));
            linkedIds.forEach((pid) => loadProjectFolderTree(pid));
          })
          .catch(() => {});
      })
      .catch(() => setProjects([]));
  useEffect(() => {
    api.members().then(setMembers).catch(() => {});
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setPM = (pid: string, list: ProjectMember[]) =>
    setProjMembersMap((prev) => ({ ...prev, [pid]: list }));
  const toggleProjRoles = async (pid: string) => {
    if (openProjs.has(pid)) {
      setOpenProjs((prev) => {
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
      return;
    }
    setOpenProjs((prev) => new Set(prev).add(pid));
    try {
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
  const addProjMember = async (pid: string, uid: string) => {
    try {
      // 배치 시 전역 역할 기반 기본 프로젝트 역할 자동 부여(이후 아래 역할 칩으로 수동 조정 가능).
      const gRoles = members.find((m) => m.uid === uid)?.global_roles;
      const roles = defaultProjectRoles(gRoles);
      setPM(pid, await api.setProjectRoles(pid, uid, roles.length ? roles : ["creator"]));
      setAddQuery((qq) => ({ ...qq, [pid]: "" }));
    } catch (e) {
      alert("멤버 추가 실패: " + String(e));
    }
  };
  const removeProjMember = async (pid: string, uid: string) => {
    try {
      setPM(pid, await api.removeProjectMember(pid, uid));
    } catch (e) {
      alert("멤버 제거 실패: " + String(e));
    }
  };
  const projRolesOf = (pid: string, uid: string) =>
    (projMembersMap[pid] || []).find((m) => m.uid === uid)?.roles || [];
  const projRoleCounts = (pid: string) => projectRoleCounts(projMembersMap[pid] || [], systemUids);
  const memberName = (uid: string) => adminMemberDisplayName(members, uid);

  const createProject = () => setProjectDialog({ mode: "create", name: "", rootPath: "" });
  const renameProject = async (p: Project) => {
    let folder: ProjectFolderEntry | ProjectFolderState | undefined = projFolders[p.id];
    if (!folder) {
      const loaded = await loadProjectFolderTree(p.id);
      folder = loaded || undefined;
    }
    setProjectDialog({ mode: "rename", project: p, name: p.name, rootPath: folder?.root_path || "" });
  };
  const saveProjectFolderLink = async (pid: string, rootPath: string, selectedPath: string) => {
    try {
      const state = await api.setProjectFolder(pid, {
        root_path: rootPath,
        selected_path: rootPath ? selectedPath : "",
      });
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
    setProjectDialog({ ...projectDialog, busy: true, error: "" });
    try {
      if (projectDialog.mode === "create") {
        const created = await api.createProject(name);
        if (rootPath) await saveProjectFolderLink(created.id, rootPath, "");
      } else {
        await api.updateProject(projectDialog.project.id, { name });
        const prev = projFolders[projectDialog.project.id];
        if (rootPath || prev?.root_path) {
          await saveProjectFolderLink(
            projectDialog.project.id,
            rootPath,
            rootPath ? prev?.selected_path || "" : "",
          );
        }
      }
      setProjectDialog(null);
      loadProjects();
    } catch (e) {
      setProjectDialog({ ...projectDialog, busy: false, error: String(e).replace(/^Error:\s*/, "") });
    }
  };
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
      const state = await api.setProjectFolder(pid, { root_path: cur.root_path, selected_path: path });
      setProjFolders((prev) => ({ ...prev, [pid]: state }));
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
    loadProjects();
  };

  return (
    <div className="manage-proj-overlay" onMouseDown={onClose}>
      <div className="manage-proj-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="manage-proj-head">
          <h2>프로젝트 관리</h2>
          <button className="manage-proj-close" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

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
                          className={openProjs.has(p.id) ? "on" : ""}
                          onClick={() => toggleProjRoles(p.id)}
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
                  {openProjs.has(p.id) && (
                    <tr className="proj-roles-row">
                      <td colSpan={3}>
                        <div className="proj-roles">
                          {projMembersMap[p.id] === undefined && (
                            <div className="admin-empty">불러오는 중…</div>
                          )}
                          {projMembersMap[p.id] !== undefined &&
                            (projMembersMap[p.id] || []).filter((m) => !systemUids.has(m.uid)).length ===
                              0 && (
                              <div className="admin-empty">
                                아직 멤버가 없습니다. ‘+ 멤버 추가’로 넣으세요.
                              </div>
                            )}
                          {(projMembersMap[p.id] || [])
                            .filter((m) => !systemUids.has(m.uid))
                            .map((m) => (
                              <div key={m.uid} className="proj-role-line">
                                <span className="admin-dot" />
                                <span className="proj-role-name">{m.name || memberName(m.uid)}</span>
                                <ProjectRolePicker
                                  value={projRolesOf(p.id, m.uid)}
                                  onChange={(roles) => changeProjRoles(p.id, m.uid, roles)}
                                />
                                <button
                                  className="proj-role-x"
                                  title="프로젝트에서 제거"
                                  onClick={() => removeProjMember(p.id, m.uid)}
                                >
                                  ✕
                                </button>
                              </div>
                            ))}

                          <div className="proj-add">
                            <div className="proj-add-pick">
                              <div className="proj-add-search">
                                <span className="proj-add-search-icn">🔍</span>
                                <input
                                  value={addQuery[p.id] || ""}
                                  onChange={(e) =>
                                    setAddQuery((qq) => ({ ...qq, [p.id]: e.target.value }))
                                  }
                                  placeholder="멤버 검색해서 추가"
                                />
                              </div>
                              {(() => {
                                const q = (addQuery[p.id] || "").trim().toLowerCase();
                                const cur = projMembersMap[p.id] || [];
                                const avail = visibleMembers
                                  .filter((m) => !cur.some((pm) => pm.uid === m.uid))
                                  .filter((m) => {
                                    if (!q) return true;
                                    const nm = (m.is_mine ? "나" : m.name || "팀원").toLowerCase();
                                    return nm.includes(q) || m.uid.toLowerCase().includes(q);
                                  })
                                  .sort((a, b) => {
                                    const r = memberRoleRank(a.global_roles) - memberRoleRank(b.global_roles);
                                    if (r !== 0) return r;
                                    return (a.name || a.uid).localeCompare(b.name || b.uid);
                                  });
                                if (avail.length === 0)
                                  return (
                                    <div className="admin-empty">
                                      {q ? "검색 결과 없음" : "추가할 멤버 없음"}
                                    </div>
                                  );
                                return (
                                  <div className="proj-add-list">
                                    {avail.map((m) => (
                                      <button
                                        key={m.uid}
                                        className="proj-add-item"
                                        onClick={() => addProjMember(p.id, m.uid)}
                                      >
                                        <span className={"admin-dot" + (m.is_mine ? " mine" : "")} />
                                        {m.is_mine ? "나" : m.name || "팀원"}
                                      </button>
                                    ))}
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </section>

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
