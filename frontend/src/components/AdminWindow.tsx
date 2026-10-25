// 관리자 창 — 로드맵 §4-5. 좌측 상단 "Content Hub" 클릭으로 열림.
// 멤버 전역 역할(복수) 관리 + 프로젝트 역할 관리. ⚠️ enforcement off 면 '식별·표시'까지만 —
// 실제 접근 차단은 CONTENT_HUB_AUTH=1 일 때. 지금은 누구나 열 수 있다(2겹 차단은 나중).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { accountAtRequest, globalRoleSaves, rebaseRoles, sameRoles } from "../lib/saveQueue";
import { ApprovalTab, type AdminConfirmState } from "./admin/ApprovalTab";
import { AssetRegistryTab } from "./admin/AssetRegistryTab";
import { MemberRolesTab } from "./admin/MemberRolesTab";
import { UpdateNoticesSection } from "./admin/UpdateNoticesSection";
import { ProjectManagerPanel } from "./manage/ProjectManagerPanel";
import {
  systemMemberUids,
  viewerGlobalRoles,
  visibleAdminAccounts,
  visibleAdminMembers,
} from "../lib/accountIdentity";
import { isTypingTarget, useModalFocus } from "../lib/keyGate";
import { useEscapeClose, useWindowEscape } from "../lib/useEscapeClose";
import { useManageCaps } from "../lib/useManageCaps";
import { hasGlobalCap } from "../types";
import type { Account, Member } from "../types";
import { CloseIcon } from "./common/ViewIcons";

type AdminTab = "approve" | "roles" | "update" | "projects" | "registry";

export function AdminWindow({
  account,
  localHub,
  onClose,
}: {
  account?: Account | null;
  // ★로컬 허브 판별은 auth_enabled 기준(코덱스 P1) — account 존재 여부로 판별하면
  // 로컬 허브도 팀 서버 로그인 뒤 account 가 생겨 공유 서버 탭·열쇠가 사라지는 회귀.
  localHub: boolean;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showHidden, setShowHidden] = useState(false); // '숨긴 계정 보기' 토글
  const [confirm, setConfirm] = useState<AdminConfirmState>(null);
  const [actMsg, setActMsg] = useState("");
  const [memberQuery, setMemberQuery] = useState(""); // 멤버 탭 검색어
  const [loading, setLoading] = useState(true);

  // 공유 서버 상태(관리자 여부·슈퍼 관리자) — 업데이트 탭과 🔑 가 쓴다. 서버 이름·주소·팀에 공지·백업 복사 위치는
  //  서버 관리 창 [주소]·[DB·백업](2026-10-23 2단계)으로 옮겼고, PC 마다 붙을 주소는 로그인 화면의 '서버 주소 변경'에서 바꾼다.
  const [shared, setShared] = useState<{
    url: string | null;
    server_name: string;
    is_admin: boolean;
    elevated: boolean;
    elevated_as: string | null;
    super_admin_expires_at: number | null;
  } | null>(null);
  // 공유 서버 본체(auth on)에서는 서버 연결 설정·elevation 이 '로컬 PC 전용' API
  // (R7 0-A loopback 가드)라 LAN 접속 브라우저에선 403 — 호출을 생략하고 관련 UI
  // (열쇠)를 숨긴다. 로컬 허브(auth off — 팀 서버 로그인 여부 무관)는
  // 기존 동작 그대로(코덱스 P1: account 기준 판별은 로컬 허브 회귀였다).
  const localOnlyServerControls = localHub;
  const refreshShared = () => {
    if (!localOnlyServerControls) {
      setShared({
        url: null,
        server_name: "",
        is_admin: false,
        elevated: false,
        elevated_as: null,
        super_admin_expires_at: null,
      });
      return Promise.resolve();
    }
    return api
      .sharedServerStatus()
      .then((s) => {
        setShared({
          url: s.url,
          server_name: s.server_name || "",
          is_admin: s.is_admin,
          elevated: s.elevated,
          elevated_as: s.elevated_as,
          super_admin_expires_at: s.super_admin_expires_at,
        });
      })
      .catch(() =>
        setShared({
          url: null,
          server_name: "",
          is_admin: false,
          elevated: false,
          elevated_as: null,
          super_admin_expires_at: null,
        }),
      );
  };
  useEffect(() => {
    refreshShared();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 슈퍼 관리자(열쇠) — 현재 로그인한 영구 admin이 자기 비밀번호로 10분만 획득한다.
  const [elevOpen, setElevOpen] = useState(false);
  const [elevPw, setElevPw] = useState("");
  const [elevMsg, setElevMsg] = useState("");
  const [elevBusy, setElevBusy] = useState(false);
  const doElevate = async () => {
    setElevMsg("");
    setElevBusy(true);
    try {
      await api.sharedServerElevate(elevPw);
      setElevOpen(false);
      setElevPw("");
      await refreshShared();
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
      // 해제를 확인하지 못했으면 열쇠를 켜진 채 두고 알린다(조작 규칙 41). 전엔 실패를 삼키고 상태를 다시 읽었는데, 그 조회도 실패하면
      //  '해제됨'으로 그려졌다 — 요청은 닿지 않았는데 화면만 꺼진다.
      alert("슈퍼 관리자 해제를 확인하지 못했습니다 — 다시 눌러 주세요.");
      return;
    }
    await refreshShared();
  };
  const elevated = !!shared?.elevated;
  const [elevRemaining, setElevRemaining] = useState(0);
  useEffect(() => {
    const update = () => {
      const remaining = Math.max(
        0,
        Number(shared?.super_admin_expires_at || 0) - Math.floor(Date.now() / 1000),
      );
      setElevRemaining(remaining);
      if (!remaining && shared?.elevated) {
        setShared((current) =>
          current
            ? { ...current, elevated: false, elevated_as: null, super_admin_expires_at: null }
            : current,
        );
      }
    };
    update();
    if (!shared?.elevated) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [shared?.elevated, shared?.super_admin_expires_at]);
  const remainingLabel = `${Math.floor(elevRemaining / 60)}:${String(elevRemaining % 60).padStart(2, "0")}`;

  // 현재 사용자의 전역 역할(복수) 판정.
  // ⚠️ 서버 직결(프록시) 모드에선 멤버 목록의 is_mine 은 '서버 PC 신원'이라 내가 아니다 —
  //    그래서 로그인 계정(account)의 email/creator_uid 로 내 멤버 행을 직접 찾는다(없으면 is_mine 폴백).
  const viewerRoles = viewerGlobalRoles(account, members);
  const isPermanentAdmin = hasGlobalCap(viewerRoles, "system");
  // 프로젝트 탭 — 예전 대시보드 '+ 프로젝트' 단추와 같은 훅·같은 기준(관리자 + PM 역할, Jay 2026-09-30). 관리자는 슈퍼유저가
  // 아니라 생성 권한도 있어야 서버가 받는다. 안쪽 단추(생성·역할 부여)도 같은 훅으로 가린다(ProjectManagerPanel).
  const caps = useManageCaps();
  const canManageProjects = caps.system && (caps.createProject || caps.grantRole);
  // 프로젝트 대화상자가 열린 동안은 Esc·바깥 클릭에 관리자 창을 닫지 않는다 — 대화상자만 닫히게(입력 보존).
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);

  // 시스템 부트스트랩 계정(admin@millionvolt.com) — 관리 UI 어디에도 노출하지 않는다.
  // (열쇠 임시권한 로그인엔 여전히 admin 으로 인증 가능 — 목록에서만 가린다.)
  // 이메일이 없는 곳(프로젝트 멤버)에서도 가리려면 admin 의 uid 가 필요 → 멤버 목록에서 역추적.
  const systemUids = systemMemberUids(members);
  const visibleMembers = visibleAdminMembers(members, systemUids);
  const visibleAccounts = visibleAdminAccounts(accounts);
  // 역량에 따라 보이는 탭이 다르다(로드맵 §1): 승인·전역역할=admin, 프로젝트=product_manager.
  // 순서는 Jay 2026-10-03 — 승인 · 멤버 · 프로젝트 · 에셋 리스트 · 업데이트('공유 서버' 탭은 2026-10-23 서버 관리 창으로 옮겨 없앰 —
  //  백엔드 라우트는 옛 앱·되돌리기용으로 둔다).
  const tabDefs: { key: AdminTab; label: string; visible: boolean }[] = [
    { key: "approve", label: "승인", visible: hasGlobalCap(viewerRoles, "approve_signup") },
    { key: "roles", label: "멤버 · 전역 역할", visible: hasGlobalCap(viewerRoles, "grant_global") },
    // 프로젝트 관리(2026-10-02 대시보드 오버레이에서 옮김) — 위 canManageProjects 기준.
    { key: "projects", label: "프로젝트", visible: canManageProjects },
    // 에셋 리스트(옛 이름 '에셋 대장', 2026-09-30) — 공유 서버 운영(system) 권한만. 훑기는 NAS 를 오래 읽는다.
    { key: "registry", label: "에셋 리스트", visible: isPermanentAdmin },
    // 업데이트 — 관리자만. 2단계(2026-10-23)부터 [이 PC에 먼저 설치]만(팀 배포는 서버 관리 창 [릴리스]).
    { key: "update", label: "업데이트", visible: !!shared?.is_admin },
  ];
  const visibleTabs = tabDefs.filter((t) => t.visible);
  const [tab, setTab] = useState<AdminTab>("approve");
  // 선택 탭이 권한 변화로 사라지면 첫 가용 탭으로 폴백(빈 화면 방지).
  const activeTab = visibleTabs.some((t) => t.key === tab) ? tab : visibleTabs[0]?.key;

  // 가장 나중에 보낸 조회의 응답만 받는다(조작 규칙 40) — '숨긴 계정 보기'를 켰다 바로 끄면 두 조회가 나가고, 늦게 온 쪽이 이겨
  //  체크는 꺼졌는데 숨긴 계정이 보였다(반대도). 승인·숨김을 바꾼 뒤의 재조회는 **지금의** 체크로 묻는다(요청을 보낼 때의 체크가 아니라).
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;
  const accountsSeqRef = useRef(0);
  const loadAccounts = (hidden = showHiddenRef.current) => {
    const seq = ++accountsSeqRef.current;
    return api.listAccounts(undefined, hidden)
      .then((list) => { if (seq === accountsSeqRef.current) setAccounts(list); })
      .catch(() => { if (seq === accountsSeqRef.current) setAccounts([]); });
  };

  useEffect(() => {
    Promise.all([
      api.members().then(setMembers).catch(() => {}),
      loadAccounts(),
    ]).finally(() => setLoading(false));
  }, []);

  // '숨긴 계정 보기' 토글 시 목록 재조회. 첫 실행은 건너뛴다 — 마운트 이펙트가 이미 같은 목록을
  //  받고 있어, 안 건너뛰면 창을 열 때마다 /api/accounts 가 2번 나간다.
  const showHiddenFirstRef = useRef(true);
  useEffect(() => {
    if (showHiddenFirstRef.current) {
      showHiddenFirstRef.current = false;
      return;
    }
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
        loadAccounts();
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
  // 안쪽 확인창이 열려 있으면 Esc 는 그것만 닫는다 — 창 전체를 닫으면 입력하던 비밀번호가 사라진다.
  const closeTopmost = useCallback(() => {
    if (confirm) setConfirm(null);
    else if (projectDialogOpen) return; // 안쪽 대화상자는 그 패널이 같은 Esc 로 닫는다
    else {
      // 창 안의 글 칸(멤버 검색 등)에서 난 Esc 는 칸을 벗어나기만 한다 — 창까지 닫으면 적던 글이 사라진다.
      //  한 번 더 누르면 닫힌다(폴더 창의 글 칸과 같은 순서).
      const field = document.activeElement as HTMLElement | null;
      if (field?.closest(".admin-window") && isTypingTarget(field)) field.blur();
      else onClose();
    }
  }, [confirm, projectDialogOpen, onClose]);
  // 창의 겹 — 앱의 틀(LazyModalShell) 안이면 틀이 연 순간에 쥔 겹을 쓴다(이 코드가 늦게 와도 그 틈에 연 창보다 위가 되지 않는다).
  useWindowEscape(closeTopmost);
  // 🔑 확인 창은 따로 겹이다 — 머리의 단추라 프로젝트 탭의 👥 멤버 칸(겹)이 열린 채로도 뜬다. 위 겹 안에서 닫으면 멤버 칸이 더 위라
  //  Esc 가 뒤의 멤버 칸부터 닫는다. 나중에 켜지는 겹이 위다(lib/useEscapeClose).
  //  승인 확인 창이 같이 떠 있으면 그것부터 닫는다 — 🔑 창과 같은 층(z-index)이고 문서에서 뒤라 화면에서는 🔑 창 **위에** 보인다.
  //  이 겹이 🔑 만 닫으면 앞의 확인 창을 두고 뒤의 창이 닫혔다(2026-10-11 Codex 리뷰).
  useEscapeClose(() => (confirm ? setConfirm(null) : setElevOpen(false)), elevOpen);
  // 안쪽 확인 창들(막이 있다)도 모달 영역이다(lib/keyGate '모달의 초점') — 떠 있는 동안 Tab 이 그 안에서만 돈다. 전엔 🔑 를 연 채
  //  Tab 으로 뒤의 단추에 닿아 다른 확인 창을 겹쳐 띄울 수 있었다. 창 자체의 영역은 앱의 틀(LazyModalShell)이 올린다.
  const windowRef = useRef<HTMLDivElement>(null);
  const elevRef = useRef<HTMLDivElement>(null);
  useModalFocus(elevRef, elevOpen);
  useModalFocus(() => [windowRef.current?.querySelector<HTMLElement>(".admin-confirm:not(.admin-elev)")], !!confirm);

  // 전역 역할 저장은 역할 목록 전체를 덮어쓴다 — 칩을 연타하면 낡은 value 로 만든 목록이 뒤에 도착해 먼저 준 역할을 지웠다.
  // 그래서 한 줄로 세우고(lib/saveQueue — 줄은 모듈 값이라 이 창을 닫았다 열어도 이어진다), 차례가 왔을 때 서버의 지금 값을 읽어
  // 화면에서 **바꾼 것만** 얹는다(조작 규칙 39). 줄이 도는 동안 **모든 멤버의** 칩을 잠그는 것은 그 위의 안내다 — 전에는 저장 중인 멤버만
  // 잠가서, 다른 멤버를 누르는 순간 잠금이 그쪽으로 옮겨 가 앞 멤버가 풀렸다.
  const roleBusy = useSyncExternalStore(globalRoleSaves.subscribe, globalRoleSaves.busy);
  const changeMemberGlobalRoles = (uid: string, roles: string[]) => {
    const shown = members.find((member) => member.uid === uid)?.global_roles ?? []; // 누른 순간 화면에 보이던 역할 — 무엇을 바꿨는지의 기준
    const sameAccount = accountAtRequest(); // 줄을 서 있거나 지금 값을 읽는 사이에 계정이 바뀌었으면 보내지 않는다
    return globalRoleSaves.run(async () => {
      try {
        const fresh = await api.members();
        if (!sameAccount()) return; // 읽기는 해롭지 않다 — 쓰기 직전에 본다
        const current = fresh.find((member) => member.uid === uid);
        if (!current) {
          setMembers(fresh); // 그사이 목록에서 사라진 멤버 — 화면만 맞춘다
          return;
        }
        const next = rebaseRoles(current.global_roles, shown, roles);
        setMembers(sameRoles(next, current.global_roles) ? fresh : await api.setMemberGlobalRoles(uid, next));
      } catch (e) {
        alert("전역 역할 변경 실패: " + String(e));
      }
    });
  };

  const shortUid = (uid: string) => uid.replace("user_", "").slice(0, 10);

  return (
    <>
      <div className="admin-backdrop" onMouseDown={() => { if (!projectDialogOpen) onClose(); }} />
      {/* 프로젝트 탭은 옛 프로젝트 관리 창 폭(760px)으로 넓힌다 — 👥 멤버 칸이 열리면 CSS 가 더 넓힌다 */}
      <div ref={windowRef} className={"admin-window" + (activeTab === "projects" ? " wide" : "")} role="dialog" aria-label="관리자">
        <header className="admin-head">
          <span className="admin-title">⬡ 관리자</span>
          {localOnlyServerControls && isPermanentAdmin && (
          <button
            className={"admin-key" + (elevated ? " on" : "")}
            onClick={() => (elevated ? deElevate() : setElevOpen(true))}
            title={
              elevated
                ? `슈퍼 관리자 ${remainingLabel} 남음 — 클릭해 해제`
                : "슈퍼 관리자 — 내 비밀번호로 10분 권한 요청"
            }
          >
            🔑
          </button>
          )}
          <button className="assets-x" onClick={onClose} title="닫기">
            <CloseIcon />
          </button>
        </header>

        {elevOpen && (
          <div className="admin-confirm-backdrop" onMouseDown={() => setElevOpen(false)}>
            <div
              ref={elevRef}
              className="admin-confirm admin-elev"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <p className="admin-confirm-q">
                슈퍼 관리자 — 다른 사람의 생성물 워크스페이스를 옮기려면
                <br />
                현재 로그인한 내 계정으로 다시 인증하세요.
                <br />
                <span className="admin-note-sub">
                  권한은 서버 기준 10분 뒤 자동 만료되며 작성자 정보는 바뀌지 않습니다.
                </span>
              </p>
              <input
                className="settings-input"
                type="password"
                placeholder="현재 계정 비밀번호"
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

              {activeTab === "update" && <UpdateNoticesSection />}

              {activeTab === "projects" && <ProjectManagerPanel onDialogOpenChange={setProjectDialogOpen} />}

              {activeTab === "registry" && <AssetRegistryTab />}

              {activeTab === "roles" && (
                <MemberRolesTab
                  members={visibleMembers}
                  memberQuery={memberQuery}
                  setMemberQuery={setMemberQuery}
                  shortUid={shortUid}
                  onChangeRoles={changeMemberGlobalRoles}
                  busy={roleBusy}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
