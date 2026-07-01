// 관리자 창 — 로드맵 §4-5. 좌측 상단 "Content Hub" 클릭으로 열림.
// 멤버 전역 역할(복수) 관리 + 프로젝트 역할 관리. ⚠️ enforcement off 면 '식별·표시'까지만 —
// 실제 접근 차단은 CONTENT_HUB_AUTH=1 일 때. 지금은 누구나 열 수 있다(2겹 차단은 나중).
import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import { ApprovalTab, type AdminConfirmState } from "./admin/ApprovalTab";
import { MemberRolesTab } from "./admin/MemberRolesTab";
import {
  adminMemberDisplayName,
  projectRoleCounts,
  systemMemberUids,
  viewerGlobalRoles,
  visibleAdminAccounts,
  visibleAdminMembers,
} from "../lib/accountIdentity";
import { useEscapeClose } from "../lib/useEscapeClose";
import type { ProjectFolderEntry } from "../lib/projectFolderTree";
import { ProjectRenderTree } from "./admin/ProjectRenderTree";
import {
  ProjectRolePicker,
  memberRoleRank,
} from "./admin/RolePickers";
import { hasGlobalCap } from "../types";
import type {
  Account,
  Member,
  Project,
  ProjectFolderState,
  ProjectMember,
} from "../types";

type AdminTab = "approve" | "roles" | "projects" | "server";
type ProjectDialogState =
  | { mode: "create"; name: string; rootPath: string; busy?: boolean; error?: string }
  | {
      mode: "rename";
      project: Project;
      name: string;
      rootPath: string;
      busy?: boolean;
      error?: string;
    };

export function AdminWindow({
  account,
  onClose,
}: {
  account?: Account | null;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showHidden, setShowHidden] = useState(false); // '숨긴 계정 보기' 토글
  const [confirm, setConfirm] = useState<AdminConfirmState>(null);
  const [actMsg, setActMsg] = useState("");
  const [memberQuery, setMemberQuery] = useState(""); // 멤버 탭 검색어
  const [loading, setLoading] = useState(true);
  const [projectDialog, setProjectDialog] = useState<ProjectDialogState | null>(null);
  const [projFolders, setProjFolders] = useState<Record<string, ProjectFolderEntry>>({});
  const [openFolderTrees, setOpenFolderTrees] = useState<Set<string>>(new Set());
  const [folderLoading, setFolderLoading] = useState<Record<string, boolean>>({});
  const [manageEnabled, setManageEnabled] = useState(false);

  // 공유 서버 주소 관리(admin 전용) — 로컬 허브가 어느 서버로 발행·로그인하는지.
  const [shared, setShared] = useState<{
    url: string | null;
    is_admin: boolean;
    elevated: boolean;
    elevated_as: string | null;
  } | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [urlMsg, setUrlMsg] = useState("");
  const refreshShared = () =>
    api
      .sharedServerStatus()
      .then((s) => {
        setShared({ url: s.url, is_admin: s.is_admin, elevated: s.elevated, elevated_as: s.elevated_as });
        setUrlDraft(s.url || "");
      })
      .catch(() => setShared({ url: null, is_admin: false, elevated: false, elevated_as: null }));
  useEffect(() => {
    refreshShared();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    let alive = true;
    api
      .authConfig()
      .then((config) => {
        if (alive) setManageEnabled(!!config.manage_enabled);
      })
      .catch(() => {
        if (alive) setManageEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 임시 관리자 권한(열쇠) — 본인 계정 유지한 채 admin 비번으로 '승인 절차' 권한만 일시 획득.
  const [elevOpen, setElevOpen] = useState(false);
  // id 만 "admin" 으로 기본 채움(짧은 id 는 백엔드가 관리자 이메일로 매핑). 비밀번호는 보안상
  // 미리 채우지 않는다 — 매번 직접 입력.
  const [elevEmail, setElevEmail] = useState("admin");
  const [elevPw, setElevPw] = useState("");
  const [elevMsg, setElevMsg] = useState("");
  const [elevBusy, setElevBusy] = useState(false);
  const doElevate = async () => {
    setElevMsg("");
    setElevBusy(true);
    try {
      await api.sharedServerElevate(elevEmail.trim(), elevPw);
      setElevOpen(false);
      setElevPw("");
      await refreshShared();
      // 권한 획득 → 계정/멤버 목록 다시 조회(이제 서버가 admin 으로 응답).
      loadAccounts();
      api.members().then(setMembers).catch(() => {});
    } catch (e) {
      setElevMsg(String(e).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setElevBusy(false);
    }
  };
  const deElevate = async () => {
    try {
      await api.sharedServerDeElevate();
    } catch {
      /* ignore */
    }
    await refreshShared();
    loadAccounts();
  };
  const elevated = !!shared?.elevated;
  const saveUrl = async () => {
    setUrlMsg("");
    try {
      const r = await api.setSharedServerUrl(urlDraft.trim());
      setShared((p) => ({
        url: r.url,
        is_admin: p?.is_admin ?? false,
        elevated: p?.elevated ?? false,
        elevated_as: p?.elevated_as ?? null,
      }));
      setUrlMsg("저장됐습니다. 다음 로그인부터 이 주소를 씁니다.");
    } catch (e) {
      setUrlMsg("저장 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
    }
  };

  // 현재 사용자의 전역 역할(복수) 판정.
  // ⚠️ 서버 직결(프록시) 모드에선 멤버 목록의 is_mine 은 '서버 PC 신원'이라 내가 아니다 —
  //    그래서 로그인 계정(account)의 email/creator_uid 로 내 멤버 행을 직접 찾는다(없으면 is_mine 폴백).
  const viewerRoles = viewerGlobalRoles(account, members);

  // 시스템 부트스트랩 계정(admin@millionvolt.com) — 관리 UI 어디에도 노출하지 않는다.
  // (열쇠 임시권한 로그인엔 여전히 admin 으로 인증 가능 — 목록에서만 가린다.)
  // 이메일이 없는 곳(프로젝트 멤버)에서도 가리려면 admin 의 uid 가 필요 → 멤버 목록에서 역추적.
  const systemUids = systemMemberUids(members);
  const visibleMembers = visibleAdminMembers(members, systemUids);
  const visibleAccounts = visibleAdminAccounts(accounts);
  // 역량에 따라 보이는 탭이 다르다(로드맵 §1): 승인·전역역할=admin, 프로젝트=product_director.
  const tabDefs: { key: AdminTab; label: string; visible: boolean }[] = [
    { key: "approve", label: "승인", visible: hasGlobalCap(viewerRoles, "approve_signup") || elevated },
    { key: "roles", label: "멤버 · 전역 역할", visible: hasGlobalCap(viewerRoles, "grant_global") },
    {
      key: "projects",
      label: "프로젝트",
      visible:
        hasGlobalCap(viewerRoles, "create_project") ||
        hasGlobalCap(viewerRoles, "grant_project_role"),
    },
    // 공유 서버 주소 — 로그인한 공유 서버 계정이 admin 일 때만(로컬 허브 설정값).
    { key: "server", label: "공유 서버", visible: !!shared?.is_admin },
  ];
  const visibleTabs = tabDefs.filter((t) => t.visible);
  const [tab, setTab] = useState<AdminTab>("approve");
  // 선택 탭이 권한 변화로 사라지면 첫 가용 탭으로 폴백(빈 화면 방지).
  const activeTab = visibleTabs.some((t) => t.key === tab) ? tab : visibleTabs[0]?.key;

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
      .projects("my", true)
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
            linkedIds.forEach((pid) => {
              loadProjectFolderTree(pid);
            });
          })
          .catch(() => {});
        // 모든 프로젝트 멤버를 1회 일괄 prefetch → 펼칠 때 즉시 표시(요청 N→1).
        api
          .projectMembersAll()
          .then((all) => {
            const map: Record<string, ProjectMember[]> = {};
            r.projects.forEach((p) => (map[p.id] = all[p.id] || []));
            setProjMembersMap(map);
          })
          .catch(() => {});
      })
      .catch(() => {});
  const loadAccounts = (hidden = showHidden) =>
    api.listAccounts(undefined, hidden).then(setAccounts).catch(() => setAccounts([]));

  useEffect(() => {
    Promise.all([
      api.members().then(setMembers).catch(() => {}),
      loadProjects(),
      loadAccounts(),
    ]).finally(() => setLoading(false));
  }, []);

  // '숨긴 계정 보기' 토글 시 목록 재조회.
  useEffect(() => {
    loadAccounts(showHidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  // 비밀번호 초기화 / 계정 숨김 — 확인 플로팅 후 실행.
  const runConfirm = async () => {
    if (!confirm) return;
    const { kind, email } = confirm;
    setConfirm(null);
    try {
      if (kind === "reset") {
        await api.adminResetPassword(email);
        setActMsg(`${email} 비밀번호를 111111 로 초기화했습니다.`);
      } else {
        await api.adminSetHidden(email, kind === "hide");
        setActMsg(kind === "hide" ? `${email} 계정을 숨겼습니다.` : `${email} 숨김을 해제했습니다.`);
        loadAccounts(showHidden);
      }
    } catch (e) {
      setActMsg("실패: " + String(e));
    }
    window.setTimeout(() => setActMsg(""), 3000);
  };

  const approve = async (a: Account, status: string) => {
    try {
      await api.setAccountStatus(a.email, status);
      loadAccounts();
    } catch (e) {
      alert("처리 실패: " + String(e));
    }
  };
  useEscapeClose(onClose);

  const changeMemberGlobalRoles = async (uid: string, roles: string[]) => {
    try {
      setMembers(await api.setMemberGlobalRoles(uid, roles));
    } catch (e) {
      alert("전역 역할 변경 실패: " + String(e));
    }
  };

  // 프로젝트 멤버 편집기 — 여러 프로젝트를 동시에 펼칠 수 있다(프로젝트별 독립 상태).
  const [openProjs, setOpenProjs] = useState<Set<string>>(new Set());
  const [projMembersMap, setProjMembersMap] = useState<Record<string, ProjectMember[]>>({});
  const [addQuery, setAddQuery] = useState<Record<string, string>>({}); // 프로젝트별 멤버 검색어
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
  // 멤버의 프로젝트 역할(복수) 변경(빈 배열=역할만 비움, 멤버는 유지).
  const changeProjRoles = async (pid: string, uid: string, roles: string[]) => {
    try {
      setPM(pid, await api.setProjectRoles(pid, uid, roles));
    } catch (e) {
      alert("프로젝트 역할 변경 실패: " + String(e));
    }
  };
  // 프로젝트에 멤버 추가(기본 역할 creator) / 제거.
  const addProjMember = async (pid: string, uid: string) => {
    try {
      setPM(pid, await api.setProjectRoles(pid, uid, ["creator"]));
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
  // 프로젝트별 역할 인원 수(PM/Sup/Creator) — 한 사람이 복수 역할이면 각각 셈.
  const projRoleCounts = (pid: string) => projectRoleCounts(projMembersMap[pid] || [], systemUids);
  const memberName = (uid: string) => {
    // UI 는 절대 uid 를 보이지 않는다 — 표시이름이 없으면 '팀원'으로(식별자 노출 금지).
    return adminMemberDisplayName(members, uid);
  };

  const createProject = () => {
    setProjectDialog({ mode: "create", name: "", rootPath: "" });
  };
  const renameProject = async (p: Project) => {
    let folder: ProjectFolderEntry | ProjectFolderState | undefined = manageEnabled
      ? projFolders[p.id]
      : undefined;
    if (manageEnabled && !folder) {
      const loaded = await loadProjectFolderTree(p.id);
      folder = loaded || undefined;
    }
    setProjectDialog({
      mode: "rename",
      project: p,
      name: p.name,
      rootPath: folder?.root_path || "",
    });
  };
  const saveProjectFolderLink = async (
    pid: string,
    rootPath: string,
    selectedPath: string,
  ) => {
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
        if (manageEnabled && rootPath) {
          await saveProjectFolderLink(created.id, rootPath, "");
        }
      } else {
        await api.updateProject(projectDialog.project.id, { name });
        const prev = projFolders[projectDialog.project.id];
        if (manageEnabled && (rootPath || prev?.root_path)) {
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
      setProjectDialog({
        ...projectDialog,
        busy: false,
        error: String(e).replace(/^Error:\s*/, ""),
      });
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
    const optimistic = { ...cur, selected_path: path };
    setProjFolders((prev) => ({ ...prev, [pid]: optimistic }));
    try {
      const state = await api.setProjectFolder(pid, {
        root_path: cur.root_path,
        selected_path: path,
      });
      setProjFolders((prev) => ({ ...prev, [pid]: state }));
    } catch {
      loadProjectFolderTree(pid);
    }
  };
  const toggleArchive = async (p: Project) => {
    await api.updateProject(p.id, { archived: !p.archived });
    loadProjects();
  };
  // 프로젝트 표시 순서 — 그립(⠿)을 잡고 드래그해 바꾼다. 낙관적 반영 후 서버에 전체 순서 저장.
  const [dragArmed, setDragArmed] = useState(false); // 그립 누름 → 그때만 행 draggable
  const [dragIdx, setDragIdx] = useState<number | null>(null); // 집은 행
  const [overIdx, setOverIdx] = useState<number | null>(null); // 위에 끌고 있는 행(드롭 위치)
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
      loadProjects(); // 실패 시 서버 순서로 되돌림
    }
  };
  const deleteProject = async (p: Project) => {
    if (!window.confirm(`프로젝트 '${p.name}' 삭제? 결과물은 미분류로 돌아갑니다.`)) return;
    await api.deleteProject(p.id);
    loadProjects();
  };

  const shortUid = (uid: string) => uid.replace("user_", "").slice(0, 10);

  return (
    <>
      <div className="admin-backdrop" onMouseDown={onClose} />
      <div className="admin-window" role="dialog" aria-label="관리자">
        <header className="admin-head">
          <span className="admin-title">⬡ 관리자</span>
          <button
            className={"admin-key" + (elevated ? " on" : "")}
            onClick={() => (elevated ? deElevate() : setElevOpen(true))}
            title={
              elevated
                ? `임시 관리자 권한 ON (${shared?.elevated_as}) — 클릭해 해제`
                : "임시 관리자 권한 — admin 비번으로 승인 권한 획득"
            }
          >
            🔑
          </button>
          <button className="assets-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </header>

        {elevOpen && (
          <div className="admin-confirm-backdrop" onMouseDown={() => setElevOpen(false)}>
            <div
              className="admin-confirm admin-elev"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <p className="admin-confirm-q">
                임시 관리자 권한 — 승인 절차를 조정하려면 admin 계정으로 인증하세요.
                <br />
                <span className="admin-note-sub">로그아웃하거나 다른 사람이 로그인하면 해제됩니다.</span>
              </p>
              <input
                className="settings-input"
                type="email"
                placeholder="admin 이메일"
                value={elevEmail}
                onChange={(e) => setElevEmail(e.target.value)}
              />
              <input
                className="settings-input"
                type="password"
                placeholder="admin 비밀번호"
                value={elevPw}
                onChange={(e) => setElevPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doElevate()}
                autoFocus
              />
              {elevMsg && <div className="login-error">{elevMsg}</div>}
              <div className="admin-confirm-actions">
                <button className="admin-confirm-yes" onClick={doElevate} disabled={elevBusy}>
                  {elevBusy ? "확인 중…" : "권한 획득"}
                </button>
                <button className="admin-confirm-no" onClick={() => setElevOpen(false)}>
                  취소
                </button>
              </div>
            </div>
          </div>
        )}

        {projectDialog && (
          <div className="admin-confirm-backdrop" onMouseDown={() => setProjectDialog(null)}>
            <div
              className="admin-confirm admin-project-dialog"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <p className="admin-confirm-q">
                {projectDialog.mode === "create" ? "새 프로젝트" : "프로젝트 설정"}
              </p>
              <label className="admin-field">
                <span>프로젝트 이름</span>
                <input
                  className="settings-input"
                  placeholder="프로젝트 이름"
                  value={projectDialog.name}
                  onChange={(e) =>
                    setProjectDialog({ ...projectDialog, name: e.target.value, error: "" })
                  }
                  onKeyDown={(e) => e.key === "Enter" && saveProjectDialog()}
                  autoFocus
                />
              </label>
              {manageEnabled && (
                <>
                  <label className="admin-field">
                    <span>렌더 폴더 경로</span>
                    <input
                      className="settings-input"
                      placeholder="예: D:\\Project\\Act_01"
                      value={projectDialog.rootPath}
                      onChange={(e) =>
                        setProjectDialog({ ...projectDialog, rootPath: e.target.value, error: "" })
                      }
                      onKeyDown={(e) => e.key === "Enter" && saveProjectDialog()}
                    />
                  </label>
                  <div className="admin-note-sub">
                    경로를 넣으면 그 안의 Render 폴더 구조가 프로젝트 아래에 표시됩니다.
                  </div>
                </>
              )}
              {projectDialog.error && <div className="login-error">{projectDialog.error}</div>}
              <div className="admin-confirm-actions">
                <button
                  className="admin-confirm-yes"
                  onClick={saveProjectDialog}
                  disabled={projectDialog.busy}
                >
                  {projectDialog.busy ? "저장 중…" : "확인"}
                </button>
                <button className="admin-confirm-no" onClick={() => setProjectDialog(null)}>
                  취소
                </button>
              </div>
            </div>
          </div>
        )}

        {visibleTabs.length > 1 && (
          <div className="admin-tabs">
            {visibleTabs.map((tdef) => (
              <button
                key={tdef.key}
                className={"admin-tab" + (activeTab === tdef.key ? " on" : "")}
                onClick={() => setTab(tdef.key)}
              >
                {tdef.label}
              </button>
            ))}
          </div>
        )}

        <div className="admin-body">
          {loading ? (
            <div className="admin-loading">불러오는 중…</div>
          ) : visibleTabs.length === 0 ? (
            <div className="admin-note">
              ⓘ 관리 권한이 없습니다. 전역 역할(Admin·Product Manager)을 가진 사람만 관리 탭이
              보입니다.
            </div>
          ) : (
            <>
              {activeTab === "approve" && (
                <ApprovalTab
                  accounts={visibleAccounts}
                  showHidden={showHidden}
                  setShowHidden={setShowHidden}
                  actMsg={actMsg}
                  confirm={confirm}
                  setConfirm={setConfirm}
                  runConfirm={runConfirm}
                  approve={approve}
                />
              )}

              {activeTab === "server" && (
              <section className="admin-section">
                <h4>공유 서버 주소</h4>
                <div className="admin-note-sub">
                  작업자가 로그인·발행할 공유 서버 주소입니다. 작업자 로그인창에는 안 보이고
                  여기서만 바꿉니다(이 PC 로컬 허브 설정). 바꾸면 다음 로그인부터 적용됩니다.
                </div>
                <input
                  className="settings-input"
                  placeholder="예: http://192.168.0.10:8010"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  style={{ maxWidth: 420 }}
                />
                <div style={{ marginTop: 10 }}>
                  <button className="settings-action" style={{ width: "auto" }} onClick={saveUrl}>
                    저장
                  </button>
                </div>
                {urlMsg && (
                  <p style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>{urlMsg}</p>
                )}
              </section>
              )}

              {activeTab === "roles" && (
                <MemberRolesTab
                  members={visibleMembers}
                  memberQuery={memberQuery}
                  setMemberQuery={setMemberQuery}
                  shortUid={shortUid}
                  onChangeRoles={changeMemberGlobalRoles}
                />
              )}

              {activeTab === "projects" && (
              <section className="admin-section">
                <h4 className="admin-sec-head">
                  프로젝트 생성
                  <button className="admin-add" onClick={createProject}>
                    + 새 프로젝트
                  </button>
                </h4>
                <div className="admin-note-sub">
                  프로젝트를 만들고, 👥 로 멤버에게 프로젝트 역할(작업·검수)을 부여합니다
                  (Product Manager 전용).
                </div>
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
                            <span
                              className="proj-drag-handle"
                              title="드래그해서 순서 변경"
                              onMouseDown={() => setDragArmed(true)}
                              onMouseUp={() => setDragArmed(false)}
                            >
                              ⠿
                            </span>
                            <span className="admin-pname-text">{p.name}</span>
                            {p.archived && <span className="admin-badge">보관됨</span>}
                            {projFolders[p.id]?.root_path && (
                              <span className="proj-folder-path" title={projFolders[p.id]?.root_path}>
                                {projFolders[p.id]?.root_path}
                              </span>
                            )}
                          </td>
                          <td className="admin-count proj-count-cell">
                            <span className="proj-gencount" title="생성물 수(프로젝트 전체)">{p.total ?? p.count}</span>
                            <span
                              className="proj-rolecount"
                              title="멤버 역할 인원(복수 역할은 각각 셈)"
                            >
                              {(() => {
                                const rc = projRoleCounts(p.id);
                                return `PM ${rc.project_manager} · Sup ${rc.supervisor} · Creator ${rc.creator}`;
                              })()}
                            </span>
                          </td>
                          <td className="admin-pactions">
                            <button
                              className={openProjs.has(p.id) ? "on" : ""}
                              onClick={() => toggleProjRoles(p.id)}
                              title="멤버 역할 부여(작업·검수)"
                            >
                              👥
                            </button>
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
                            <button onClick={() => renameProject(p)} title="이름 변경">
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
                                  (projMembersMap[p.id] || []).filter(
                                    (m) => !systemUids.has(m.uid),
                                  ).length === 0 && (
                                    <div className="admin-empty">
                                      아직 멤버가 없습니다. ‘+ 멤버 추가’로 넣으세요.
                                    </div>
                                  )}
                                {(projMembersMap[p.id] || [])
                                  .filter((m) => !systemUids.has(m.uid))
                                  .map((m) => (
                                  <div key={m.uid} className="proj-role-line">
                                    <span className="admin-dot" />
                                    <span className="proj-role-name">
                                      {m.name || memberName(m.uid)}
                                    </span>
                                    <ProjectRolePicker
                                      value={projRolesOf(p.id, m.uid)}
                                      onChange={(roles) =>
                                        changeProjRoles(p.id, m.uid, roles)
                                      }
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

                                {/* 멤버 추가 — 검색박스 항상 노출(클릭 없이 바로 검색해서 추가) */}
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
                                          .filter(
                                            (m) => !cur.some((pm) => pm.uid === m.uid),
                                          )
                                          .filter((m) => {
                                            if (!q) return true;
                                            const nm = (
                                              m.is_mine ? "나" : m.name || "팀원"
                                            ).toLowerCase();
                                            return (
                                              nm.includes(q) ||
                                              m.uid.toLowerCase().includes(q)
                                            );
                                          })
                                          // 역할 순 정렬(admin→PD→ProdD→member), 동순위는 이름
                                          .sort((a, b) => {
                                            const r =
                                              memberRoleRank(a.global_roles) -
                                              memberRoleRank(b.global_roles);
                                            if (r !== 0) return r;
                                            return (a.name || a.uid).localeCompare(
                                              b.name || b.uid,
                                            );
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
                                                <span
                                                  className={
                                                    "admin-dot" +
                                                    (m.is_mine ? " mine" : "")
                                                  }
                                                />
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
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
