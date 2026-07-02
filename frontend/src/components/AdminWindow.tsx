// 관리자 창 — 로드맵 §4-5. 좌측 상단 "Content Hub" 클릭으로 열림.
// 멤버 전역 역할(복수) 관리 + 프로젝트 역할 관리. ⚠️ enforcement off 면 '식별·표시'까지만 —
// 실제 접근 차단은 CONTENT_HUB_AUTH=1 일 때. 지금은 누구나 열 수 있다(2겹 차단은 나중).
import { useEffect, useState } from "react";
import { api } from "../api";
import { ApprovalTab, type AdminConfirmState } from "./admin/ApprovalTab";
import { MemberRolesTab } from "./admin/MemberRolesTab";
import {
  systemMemberUids,
  viewerGlobalRoles,
  visibleAdminAccounts,
  visibleAdminMembers,
} from "../lib/accountIdentity";
import { useEscapeClose } from "../lib/useEscapeClose";
import { hasGlobalCap } from "../types";
import type { Account, Member } from "../types";

type AdminTab = "approve" | "roles" | "server";

export function AdminWindow({
  account,
  onClose,
}: {
  account?: Account | null;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showHidden, setShowHidden] = useState(false); // '숨긴 계정 보기' 토글
  const [confirm, setConfirm] = useState<AdminConfirmState>(null);
  const [actMsg, setActMsg] = useState("");
  const [memberQuery, setMemberQuery] = useState(""); // 멤버 탭 검색어
  const [loading, setLoading] = useState(true);

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
    // 공유 서버 주소 — 로그인한 공유 서버 계정이 admin 일 때만(로컬 허브 설정값).
    { key: "server", label: "공유 서버", visible: !!shared?.is_admin },
  ];
  const visibleTabs = tabDefs.filter((t) => t.visible);
  const [tab, setTab] = useState<AdminTab>("approve");
  // 선택 탭이 권한 변화로 사라지면 첫 가용 탭으로 폴백(빈 화면 방지).
  const activeTab = visibleTabs.some((t) => t.key === tab) ? tab : visibleTabs[0]?.key;

  const loadAccounts = (hidden = showHidden) =>
    api.listAccounts(undefined, hidden).then(setAccounts).catch(() => setAccounts([]));

  useEffect(() => {
    Promise.all([
      api.members().then(setMembers).catch(() => {}),
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
            </>
          )}
        </div>
      </div>
    </>
  );
}
