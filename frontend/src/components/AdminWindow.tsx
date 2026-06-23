// 관리자 창 — 로드맵 §4-5. 좌측 상단 "Content Hub" 클릭으로 열림.
// 멤버 전역 역할(복수) 관리 + 프로젝트 역할 관리. ⚠️ enforcement off 면 '식별·표시'까지만 —
// 실제 접근 차단은 CONTENT_HUB_AUTH=1 일 때. 지금은 누구나 열 수 있다(2겹 차단은 나중).
import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import { useAskPrompt } from "../lib/prompt";
import {
  GLOBAL_ROLE_LABEL,
  GLOBAL_ROLES,
  PROJECT_ROLE_LABEL,
  PROJECT_ROLES,
  hasGlobalCap,
} from "../types";
import type { Account, Member, Project, ProjectMember } from "../types";

type AdminTab = "approve" | "roles" | "projects" | "server";

// 전역 역할 우선순위(작을수록 위) — admin > product_director > production_director > member.
// 멤버는 복수 역할 가능 → 가장 높은(작은) 순위로 정렬한다.
function memberRoleRank(roles: string[] | undefined): number {
  const ranks = (roles || []).map((r) => GLOBAL_ROLES.indexOf(r as never));
  const valid = ranks.filter((i) => i >= 0);
  return valid.length ? Math.min(...valid) : GLOBAL_ROLES.length;
}

// 전역 역할 복수 선택 — 4역할을 토글 칩으로. 한 사람이 여러 역할 동시 보유 가능.
function GlobalRolePicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (roles: string[]) => void;
}) {
  const has = (r: string) => value.includes(r);
  const toggle = (r: string) =>
    onChange(has(r) ? value.filter((x) => x !== r) : [...value, r]);
  return (
    <div className="role-chips">
      {GLOBAL_ROLES.map((r) => (
        <button
          key={r}
          type="button"
          className={"role-chip role-" + r + (has(r) ? " on" : "")}
          title={GLOBAL_ROLE_LABEL[r]}
          onClick={() => toggle(r)}
        >
          {GLOBAL_ROLE_LABEL[r].split(" · ")[0]}
        </button>
      ))}
    </div>
  );
}

// 프로젝트 역할 복수 선택 — 한 사람이 한 프로젝트에서 여러 역할(예: Supervisor + Creator) 보유 가능.
function ProjectRolePicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (roles: string[]) => void;
}) {
  const has = (r: string) => value.includes(r);
  const toggle = (r: string) =>
    onChange(has(r) ? value.filter((x) => x !== r) : [...value, r]);
  return (
    <div className="role-chips">
      {PROJECT_ROLES.map((r) => (
        <button
          key={r}
          type="button"
          className={"role-chip role-" + r + (has(r) ? " on" : "")}
          title={PROJECT_ROLE_LABEL[r]}
          onClick={() => toggle(r)}
        >
          {PROJECT_ROLE_LABEL[r].split(" · ")[0]}
        </button>
      ))}
    </div>
  );
}

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
  const [confirm, setConfirm] = useState<
    { kind: "reset" | "hide" | "unhide"; email: string; name: string } | null
  >(null);
  const [actMsg, setActMsg] = useState("");
  const [memberQuery, setMemberQuery] = useState(""); // 멤버 탭 검색어
  const [loading, setLoading] = useState(true);
  const askPrompt = useAskPrompt();

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
  const myMember =
    (account &&
      members.find(
        (m) =>
          (!!account.creator_uid && m.uid === account.creator_uid) ||
          (!!account.email &&
            !!m.email &&
            m.email.toLowerCase() === account.email.toLowerCase()),
      )) ||
    members.find((m) => m.is_mine);
  const viewerRoles =
    myMember?.global_roles && myMember.global_roles.length
      ? myMember.global_roles
      : account?.global_roles && account.global_roles.length
        ? account.global_roles
        : account
          ? ["member"] // 로그인됐는데 역할 정보가 비면 최소 권한(member) — admin 탭 노출 방지
          : ["admin"]; // 미로그인(AUTH off · 개인 모드)만 소유자=admin

  // 시스템 부트스트랩 계정(admin@millionvolt.com) — 관리 UI 어디에도 노출하지 않는다.
  // (열쇠 임시권한 로그인엔 여전히 admin 으로 인증 가능 — 목록에서만 가린다.)
  const SYSTEM_EMAILS = new Set(["admin@millionvolt.com"]);
  const isSystemEmail = (email?: string | null) =>
    !!email && SYSTEM_EMAILS.has(email.toLowerCase());
  // 이메일이 없는 곳(프로젝트 멤버)에서도 가리려면 admin 의 uid 가 필요 → 멤버 목록에서 역추적.
  const systemUids = new Set(
    members.filter((m) => isSystemEmail(m.email)).map((m) => m.uid),
  );
  const isSystemMember = (m: { uid: string; email?: string | null }) =>
    isSystemEmail(m.email) || systemUids.has(m.uid);
  const visibleMembers = members.filter((m) => !isSystemMember(m));
  const visibleAccounts = accounts.filter((a) => !isSystemEmail(a.email));
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

  const loadProjects = () =>
    api
      .projects(true)
      .then((r) => {
        setProjects(r.projects);
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
  const projRoleCounts = (pid: string) => {
    const c = { project_manager: 0, supervisor: 0, creator: 0 };
    (projMembersMap[pid] || [])
      .filter((m) => !systemUids.has(m.uid))
      .forEach((m) =>
        (m.roles || []).forEach((r) => {
          if (r in c) c[r as keyof typeof c] += 1;
        }),
      );
    return c;
  };
  const memberName = (uid: string) => {
    // UI 는 절대 uid 를 보이지 않는다 — 표시이름이 없으면 '팀원'으로(식별자 노출 금지).
    const m = members.find((x) => x.uid === uid);
    return m ? (m.is_mine ? "나" : m.name || "팀원") : "팀원";
  };

  const createProject = async () => {
    const name = (await askPrompt("새 프로젝트 이름", "", "프로젝트 이름 ⏎"))?.trim();
    if (!name) return;
    await api.createProject(name);
    loadProjects();
  };
  const renameProject = async (p: Project) => {
    const name = (await askPrompt("프로젝트 이름", p.name, "프로젝트 이름 ⏎"))?.trim();
    if (!name) return;
    await api.updateProject(p.id, { name });
    loadProjects();
  };
  const toggleArchive = async (p: Project) => {
    await api.updateProject(p.id, { archived: !p.archived });
    loadProjects();
  };
  // 프로젝트 표시 순서 위/아래 한 칸 이동 — 낙관적 반영 후 서버에 전체 순서 저장.
  const moveProject = async (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= projects.length) return;
    const next = projects.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
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
                <section className="admin-section">
                  <div className="admin-note-sub">
                    가입 신청을 승인/거부하고 로그인 계정의 전역 역할을 부여합니다(Admin 전용).
                  </div>
                  <h4>승인 절차</h4>
                  <label className="admin-hidden-toggle">
                    <input
                      type="checkbox"
                      checked={showHidden}
                      onChange={(e) => setShowHidden(e.target.checked)}
                    />
                    숨긴 계정 보기
                  </label>
                  {actMsg && <div className="admin-act-msg">{actMsg}</div>}
                  {visibleAccounts.length === 0 && <div className="admin-empty">계정 없음</div>}
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>계정</th>
                        <th className="th-center">상태 (클릭하여 변경)</th>
                        <th className="th-right">관리</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleAccounts.map((a) => (
                        <tr key={a.email} className={a.hidden ? "admin-row-hidden" : ""}>
                          <td>
                            <div className="admin-member">
                              <span className="admin-mname">{a.name || a.email}</span>
                              <span className="admin-muid" title={a.email}>
                                {a.email}
                              </span>
                            </div>
                          </td>
                          <td className="td-center">
                            <div className="acct-status-seg">
                              {(
                                [
                                  ["approved", "승인"],
                                  ["pending", "대기"],
                                  ["rejected", "차단"],
                                ] as const
                              ).map(([st, label]) => (
                                <button
                                  key={st}
                                  className={
                                    "acct-seg acct-seg-" +
                                    st +
                                    (a.status === st ? " on" : "")
                                  }
                                  onClick={() => a.status !== st && approve(a, st)}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </td>
                          <td className="td-right">
                            <div className="admin-acct-actions">
                              <button
                                className="admin-mini-btn"
                                onClick={() =>
                                  setConfirm({ kind: "reset", email: a.email, name: a.name || a.email })
                                }
                              >
                                비밀번호 초기화
                              </button>
                              <button
                                className="admin-mini-btn"
                                onClick={() =>
                                  setConfirm({
                                    kind: a.hidden ? "unhide" : "hide",
                                    email: a.email,
                                    name: a.name || a.email,
                                  })
                                }
                              >
                                {a.hidden ? "숨김 해제" : "숨기기"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="admin-note-sub">
                    전역 역할은 <b>멤버 · 전역 역할</b> 탭에서 부여합니다.
                  </div>

                  {confirm && (
                    <div
                      className="admin-confirm-backdrop"
                      onMouseDown={() => setConfirm(null)}
                    >
                      <div
                        className="admin-confirm"
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <p className="admin-confirm-q">
                          {confirm.kind === "reset"
                            ? `${confirm.name} 비밀번호를 111111 로 정말 초기화하시겠습니까?`
                            : confirm.kind === "hide"
                              ? `${confirm.name} 계정을 정말 숨기시겠습니까?`
                              : `${confirm.name} 숨김을 해제하시겠습니까?`}
                        </p>
                        <div className="admin-confirm-actions">
                          <button className="admin-confirm-yes" onClick={runConfirm}>
                            예
                          </button>
                          <button
                            className="admin-confirm-no"
                            onClick={() => setConfirm(null)}
                          >
                            아니오
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </section>
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
              <section className="admin-section">
                <h4>멤버 · 전역 역할 설정</h4>
                <div className="admin-note-sub">
                  전역 역할은 사람 단위 권한입니다(복수 가능). 프로젝트 안 역할(작업·검수)은
                  프로젝트 탭에서 부여하세요.
                </div>
                <div className="proj-add-search member-search">
                  <span className="proj-add-search-icn">🔍</span>
                  <input
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                    placeholder="멤버 검색"
                  />
                </div>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>멤버</th>
                      <th>생성물</th>
                      <th>전역 역할</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleMembers
                      .filter((m) => {
                        const q = memberQuery.trim().toLowerCase();
                        if (!q) return true;
                        const nm = (m.is_mine ? "나" : m.name || "팀원").toLowerCase();
                        return (
                          nm.includes(q) ||
                          m.uid.toLowerCase().includes(q) ||
                          (m.email || "").toLowerCase().includes(q)
                        );
                      })
                      .map((m) => (
                      <tr key={m.uid}>
                        <td>
                          <div className="admin-member">
                            <span className={"admin-dot" + (m.is_mine ? " mine" : "")} />
                            <span className="admin-mname">
                              {m.is_mine ? "나" : m.name || "팀원"}
                            </span>
                            <span className="admin-muid" title={m.uid}>
                              {m.email || shortUid(m.uid)}
                            </span>
                          </div>
                        </td>
                        <td className="admin-count">{m.count}</td>
                        <td>
                          <GlobalRolePicker
                            value={m.global_roles}
                            onChange={(roles) => changeMemberGlobalRoles(m.uid, roles)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
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
                        <tr className={p.archived ? "archived" : ""}>
                          <td className="admin-pname">
                            {p.name}
                            {p.archived && <span className="admin-badge">보관됨</span>}
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
                              className="admin-pact-move"
                              onClick={() => moveProject(idx, -1)}
                              disabled={idx === 0}
                              title="위로"
                            >
                              ↑
                            </button>
                            <button
                              className="admin-pact-move"
                              onClick={() => moveProject(idx, 1)}
                              disabled={idx === projects.length - 1}
                              title="아래로"
                            >
                              ↓
                            </button>
                            <button
                              className={openProjs.has(p.id) ? "on" : ""}
                              onClick={() => toggleProjRoles(p.id)}
                              title="멤버 역할 부여(작업·검수)"
                            >
                              👥
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
