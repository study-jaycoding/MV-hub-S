// 관리자 창 — 로드맵 §4-5. 좌측 상단 "Content Hub" 클릭으로 열림.
// 멤버 전역 역할(복수) 관리 + 프로젝트 역할 관리. ⚠️ enforcement off 면 '식별·표시'까지만 —
// 실제 접근 차단은 CONTENT_HUB_AUTH=1 일 때. 지금은 누구나 열 수 있다(2겹 차단은 나중).
import { useEffect, useRef, useState } from "react";
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
import { getLatestReleaseMetadata, type LatestReleaseMetadata } from "../lib/releaseUpdate";
import { updateNoticeApi, type UpdateNotice } from "../lib/updateNotices";
import { hasGlobalCap } from "../types";
import type { Account, Member } from "../types";

type AdminTab = "approve" | "roles" | "server";

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

  // 공유 서버 주소 관리(admin 전용) — 로컬 허브가 어느 서버로 발행·로그인하는지.
  const [shared, setShared] = useState<{
    url: string | null;
    server_name: string;
    is_admin: boolean;
    elevated: boolean;
    elevated_as: string | null;
    super_admin_expires_at: number | null;
  } | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  // 작업자 화면에 주소 대신 보일 서버 이름 — 주소와 한 번에 저장한다.
  const [nameDraft, setNameDraft] = useState("");
  const [urlMsg, setUrlMsg] = useState("");
  // 공유 서버 본체(auth on)에서는 서버 연결 설정·elevation 이 '로컬 PC 전용' API
  // (R7 0-A loopback 가드)라 LAN 접속 브라우저에선 403 — 호출을 생략하고 관련 UI
  // (공유 서버 탭·열쇠)를 숨긴다. 로컬 허브(auth off — 팀 서버 로그인 여부 무관)는
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
        setUrlDraft(s.url || "");
        setNameDraft(s.server_name || "");
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
      /* ignore */
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
  // 팀에 공지 — 지금 '저장된' 이름·주소를 릴리스 폴더의 공지 파일로 내보낸다. 작업자 PC 는
  // 1분 안에 알림을 받고, 알림을 누르면 그 주소로 전환된다. 팀 전체에 영향을 주는 행위라
  // 확인 한 번을 거친다(입력창의 미저장 초안이 아니라 저장된 값이 나간다는 점도 여기서 알린다).
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishMsg, setPublishMsg] = useState("");
  const [latestRelease, setLatestRelease] = useState<LatestReleaseMetadata | null>(null);
  const [updateNotices, setUpdateNotices] = useState<UpdateNotice[]>([]);
  const [updateNoticeBusy, setUpdateNoticeBusy] = useState("");
  const [updateNoticeMsg, setUpdateNoticeMsg] = useState("");
  const savedUrl = (shared?.url || "").trim();
  const savedName = (shared?.server_name || "").trim();
  const publishDirty = urlDraft.trim() !== savedUrl || nameDraft.trim() !== savedName;
  const doPublish = async () => {
    setPublishBusy(true);
    setPublishMsg("");
    try {
      const r = await api.publishServerRelocation();
      setPublishOpen(false);
      setPublishMsg(
        `팀에 공지했습니다 (${r.revision}번째). 작업자 PC 는 1분 안에 알림을 받습니다.`,
      );
    } catch (e) {
      setPublishMsg("공지 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
      setPublishOpen(false);
    } finally {
      setPublishBusy(false);
    }
  };
  const saveUrl = async () => {
    setUrlMsg("");
    setPublishMsg(""); // 주소가 바뀌었으면 직전 공지 결과 문구는 더 이상 지금 상태가 아니다
    try {
      const r = await api.setSharedServerUrl(urlDraft.trim(), nameDraft.trim());
      setShared((p) => ({
        url: r.url,
        server_name: r.server_name || "",
        is_admin: p?.is_admin ?? false,
        elevated: p?.elevated ?? false,
        elevated_as: p?.elevated_as ?? null,
        super_admin_expires_at: p?.super_admin_expires_at ?? null,
      }));
      setNameDraft(r.server_name || "");
      setUrlMsg("저장됐습니다. 다음 로그인부터 이 주소를 씁니다.");
    } catch (e) {
      setUrlMsg("저장 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
    }
  };

  // 현재 사용자의 전역 역할(복수) 판정.
  // ⚠️ 서버 직결(프록시) 모드에선 멤버 목록의 is_mine 은 '서버 PC 신원'이라 내가 아니다 —
  //    그래서 로그인 계정(account)의 email/creator_uid 로 내 멤버 행을 직접 찾는다(없으면 is_mine 폴백).
  const viewerRoles = viewerGlobalRoles(account, members);
  const isPermanentAdmin = hasGlobalCap(viewerRoles, "system");

  // 시스템 부트스트랩 계정(admin@millionvolt.com) — 관리 UI 어디에도 노출하지 않는다.
  // (열쇠 임시권한 로그인엔 여전히 admin 으로 인증 가능 — 목록에서만 가린다.)
  // 이메일이 없는 곳(프로젝트 멤버)에서도 가리려면 admin 의 uid 가 필요 → 멤버 목록에서 역추적.
  const systemUids = systemMemberUids(members);
  const visibleMembers = visibleAdminMembers(members, systemUids);
  const visibleAccounts = visibleAdminAccounts(accounts);
  // 역량에 따라 보이는 탭이 다르다(로드맵 §1): 승인·전역역할=admin, 프로젝트=product_director.
  const tabDefs: { key: AdminTab; label: string; visible: boolean }[] = [
    { key: "approve", label: "승인", visible: hasGlobalCap(viewerRoles, "approve_signup") },
    { key: "roles", label: "멤버 · 전역 역할", visible: hasGlobalCap(viewerRoles, "grant_global") },
    // 공유 서버 주소 — 로그인한 공유 서버 계정이 admin 일 때만(로컬 허브 설정값).
    { key: "server", label: "공유 서버", visible: !!shared?.is_admin },
  ];
  const visibleTabs = tabDefs.filter((t) => t.visible);
  const [tab, setTab] = useState<AdminTab>("approve");
  // 선택 탭이 권한 변화로 사라지면 첫 가용 탭으로 폴백(빈 화면 방지).
  const activeTab = visibleTabs.some((t) => t.key === tab) ? tab : visibleTabs[0]?.key;

  const loadUpdateManagement = async () => {
    const [items, latest] = await Promise.all([
      updateNoticeApi.adminList().catch(() => [] as UpdateNotice[]),
      getLatestReleaseMetadata().catch(() => null),
    ]);
    setUpdateNotices(items);
    setLatestRelease(latest);
  };
  useEffect(() => {
    if (activeTab === "server" && shared?.is_admin) void loadUpdateManagement();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, shared?.is_admin]);

  const registerLatestRelease = async () => {
    if (!latestRelease) return;
    setUpdateNoticeBusy("register");
    setUpdateNoticeMsg("");
    try {
      const result = await updateNoticeApi.register(latestRelease);
      setUpdateNoticeMsg(result.created ? "최신 업데이트를 목록에 등록했습니다." : "이미 등록된 업데이트입니다.");
      setUpdateNotices(await updateNoticeApi.adminList());
    } catch (error) {
      setUpdateNoticeMsg("등록 실패: " + String(error).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setUpdateNoticeBusy("");
    }
  };

  const toggleUpdatePin = async (item: UpdateNotice) => {
    setUpdateNoticeBusy(`pin:${item.id}`);
    setUpdateNoticeMsg("");
    try {
      await updateNoticeApi.pin(item.id, !item.pinned);
      setUpdateNotices(await updateNoticeApi.adminList());
    } catch (error) {
      setUpdateNoticeMsg("고정 변경 실패: " + String(error).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setUpdateNoticeBusy("");
    }
  };

  const announceUpdate = async (item: UpdateNotice) => {
    setUpdateNoticeBusy(`announce:${item.id}`);
    setUpdateNoticeMsg("");
    try {
      const result = await updateNoticeApi.announce(item.id);
      setUpdateNoticeMsg(
        `v${item.version} 업데이트를 공지했습니다 (${result.item.announcement_revision}번째).`,
      );
      setUpdateNotices(await updateNoticeApi.adminList());
    } catch (error) {
      setUpdateNoticeMsg("공지 실패: " + String(error).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setUpdateNoticeBusy("");
    }
  };

  const loadAccounts = (hidden = showHidden) =>
    api.listAccounts(undefined, hidden).then(setAccounts).catch(() => setAccounts([]));

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

  // 저장 중인 멤버 — 칩을 연타하면 낡은 value 로 만든 목록이 뒤에 도착해 먼저 준 역할을
  // 지운다(PUT 이 전체 목록을 덮어쓰는 계약) → 응답이 올 때까지 그 멤버 칩을 잠근다.
  const [roleBusyUid, setRoleBusyUid] = useState("");
  const changeMemberGlobalRoles = async (uid: string, roles: string[]) => {
    setRoleBusyUid(uid);
    try {
      setMembers(await api.setMemberGlobalRoles(uid, roles));
    } catch (e) {
      alert("전역 역할 변경 실패: " + String(e));
    } finally {
      setRoleBusyUid("");
    }
  };

  const shortUid = (uid: string) => uid.replace("user_", "").slice(0, 10);

  return (
    <>
      <div className="admin-backdrop" onMouseDown={onClose} />
      <div className="admin-window" role="dialog" aria-label="관리자">
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

              {activeTab === "server" && (
              <>
              <section className="admin-section">
                <h4>공유 서버 이름·주소</h4>
                <div className="admin-note-sub">
                  작업자가 로그인·발행할 공유 서버입니다. 작업자 화면에는 <b>이름만</b> 보이고
                  주소는 여기서만 바꿉니다(이 PC 로컬 허브 설정). 바꾸면 다음 로그인부터
                  적용됩니다. 이름을 비우면 주소가 그대로 보입니다.
                </div>
                <input
                  className="settings-input"
                  placeholder="서버 이름 (예: MV 팀 서버)"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  maxLength={64}
                  style={{ maxWidth: 420 }}
                />
                <input
                  className="settings-input"
                  placeholder="예: http://192.168.0.10:8010"
                  value={urlDraft}
                  onChange={(e) => setUrlDraft(e.target.value)}
                  style={{ maxWidth: 420, marginTop: 8 }}
                />
                <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                  <button className="settings-action" style={{ width: "auto" }} onClick={saveUrl}>
                    저장
                  </button>
                  <button
                    className="settings-action"
                    style={{ width: "auto" }}
                    onClick={() => setPublishOpen(true)}
                    disabled={publishBusy || !savedUrl}
                    title="저장된 이름·주소를 팀 전체에 공지합니다"
                  >
                    {publishBusy ? "공지 중…" : "팀에 공지"}
                  </button>
                </div>
                {urlMsg && (
                  <p style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>{urlMsg}</p>
                )}
                {publishMsg && (
                  <p style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>{publishMsg}</p>
                )}
                <div className="admin-note-sub" style={{ marginTop: 10 }}>
                  ⓘ <b>팀에 공지</b>는 릴리스 폴더(작업자 설치 원본)에 이사 공지 파일을 남깁니다.
                  작업 중인 사람에게 알림이 뜨고, 누르면 이 주소로 전환됩니다. 릴리스 폴더에
                  쓰기 권한이 있는 관리자 PC 에서만 됩니다.
                </div>
              </section>

              <section className="admin-section">
                <h4>업데이트 관리</h4>
                <div className="admin-note-sub">
                  최근 업데이트를 최대 5개 표시합니다. 고정한 항목은 새 업데이트가 생겨도 목록에
                  남고(최대 4개), 공지를 누르면 팀원의 알림 센터에 표시됩니다.
                </div>
                {latestRelease && !updateNotices.some(
                  (item) => item.sha256 && item.sha256 === latestRelease.sha256,
                ) && (
                  <button
                    className="settings-action"
                    style={{ width: "auto", marginBottom: 10 }}
                    onClick={registerLatestRelease}
                    disabled={!!updateNoticeBusy}
                  >
                    {updateNoticeBusy === "register"
                      ? "등록 중…"
                      : `최신 업데이트 v${latestRelease.version} 등록`}
                  </button>
                )}
                <div className="admin-update-list">
                  {updateNotices.length ? updateNotices.map((item) => (
                    <div className="admin-update-row" key={item.id}>
                      <label className="admin-update-pin" title="이 업데이트를 최근 5개 목록에 고정">
                        <input
                          type="checkbox"
                          checked={item.pinned}
                          disabled={!!updateNoticeBusy}
                          onChange={() => void toggleUpdatePin(item)}
                        />
                        고정
                      </label>
                      <span className="admin-update-file" title={item.file}>
                        <b>v{item.version}</b>
                        <small>{item.file}</small>
                      </span>
                      <button
                        className="settings-action"
                        style={{ width: "auto" }}
                        disabled={!!updateNoticeBusy}
                        onClick={() => void announceUpdate(item)}
                      >
                        {updateNoticeBusy === `announce:${item.id}`
                          ? "공지 중…"
                          : item.announcement_revision > 0 ? "재공지" : "공지"}
                      </button>
                    </div>
                  )) : (
                    <div className="admin-note-sub">등록된 업데이트가 없습니다.</div>
                  )}
                </div>
                {updateNoticeMsg && (
                  <p style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
                    {updateNoticeMsg}
                  </p>
                )}
              </section>

              {publishOpen && (
                <div className="admin-confirm-backdrop" onMouseDown={() => setPublishOpen(false)}>
                  <div className="admin-confirm" onMouseDown={(e) => e.stopPropagation()}>
                    <p className="admin-confirm-q">
                      팀 전체에 서버 전환 안내가 발송됩니다.
                      <br />
                      <span className="admin-note-sub">
                        공지 내용: <b>{savedName || "(이름 없음)"}</b> · {savedUrl}
                      </span>
                      {publishDirty && (
                        <>
                          <br />
                          <span className="admin-note-sub">
                            ⚠ 입력창에 저장하지 않은 변경이 있습니다 — 공지는 <b>저장된 값</b>으로
                            나갑니다.
                          </span>
                        </>
                      )}
                    </p>
                    <div className="admin-confirm-actions">
                      <button
                        className="admin-confirm-yes"
                        onClick={doPublish}
                        disabled={publishBusy}
                      >
                        {publishBusy ? "공지 중…" : "공지 발송"}
                      </button>
                      <button className="admin-confirm-no" onClick={() => setPublishOpen(false)}>
                        취소
                      </button>
                    </div>
                  </div>
                </div>
              )}
              </>
              )}

              {activeTab === "roles" && (
                <MemberRolesTab
                  members={visibleMembers}
                  memberQuery={memberQuery}
                  setMemberQuery={setMemberQuery}
                  shortUid={shortUid}
                  onChangeRoles={changeMemberGlobalRoles}
                  busyUid={roleBusyUid}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
