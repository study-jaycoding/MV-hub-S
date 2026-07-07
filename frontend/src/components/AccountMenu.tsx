// 계정·워크스페이스 통합 메뉴 — 힉스필드 사이트의 계정 드롭다운처럼.
// 워크스페이스 전환 + 표시이름 변경 + 로그인 정보/로그아웃을 한 곳에서 관리. Assets 버튼 옆.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  accountDisplayName,
  accountRoleText,
  type ProviderIdentity,
} from "../lib/accountIdentity";
import { useT } from "../lib/i18n";
import { useOutsideMouseDown } from "../lib/useOutsideMouseDown";
import { ManageAccount } from "./ManageAccount";
import { SettingsPanel } from "./SettingsPanel";
import type { Account, ReportedHfStatus, Workspace } from "../types";

export function AccountMenu({
  provider,
  account,
  onProviderUpdated,
  onLogout,
  onWorkspaceSwitched,
  onImported,
  localHub,
}: {
  provider: ProviderIdentity | null;
  account?: Account | null;
  onProviderUpdated: (p: ProviderIdentity) => void;
  onLogout?: () => void;
  onWorkspaceSwitched: () => void;
  onImported?: (msg: string) => void; // 라이브러리 변경 후 리로드+안내(휴지통 이동 등)
  localHub?: boolean; // 로컬 허브(MV_agent, AUTH off) = 내 CLI 가 이 PC 에 있음 → 워크스페이스 전환 가능
}) {
  const [list, setList] = useState<Workspace[]>([]);
  const [reported, setReported] = useState<ReportedHfStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  const closeMenu = useCallback(() => setOpen(false), []);

  // 워크스페이스 라이브(클릭 전환 가능) 조건 = 이 PC 에 내 CLI 가 있을 때.
  //  · 비로그인(AUTH off, 로컬 개발): 원래부터 라이브.
  //  · 로컬 허브(localHub: MV_agent, AUTH off)에서 팀서버 로그인한 경우도 CLI 가 이 PC 에 있으니
  //    라이브 — /api/workspaces(목록·select)가 로컬 CLI 를 직접 호출하므로 클릭 전환이 그대로 작동.
  //  · 공유 서버 본체(AUTH on): CLI 가 내 것이 아닐 수 있어 읽기전용(에이전트 보고값 표시).
  const liveMode = !account || !!localHub;
  useEffect(() => {
    if (liveMode) api.workspaces().then(setList).catch(() => {});
    else api.accountHf().then(setReported).catch(() => setReported(null));
  }, [liveMode]);
  useOutsideMouseDown(ref, closeMenu, open);
  // 메뉴를 열 때마다 워크스페이스/보고값을 새로고침 — 에이전트 동기화·계정상태 보고가 나중에
  // 끝나도 즉시 반영된다(예전엔 마운트 때 한 번만 받아 '미연결'이 옛 상태로 박혀 있었다).
  useEffect(() => {
    if (!open) return;
    if (liveMode) api.workspaces().then(setList).catch(() => {});
    else api.accountHf().then(setReported).catch(() => {});
  }, [open, liveMode]);

  // 표시할 워크스페이스 목록 — 하우스=라이브, 그 외=에이전트 보고값.
  const wsList = liveMode ? list : reported?.workspaces || [];
  const current = wsList.find((w) => w.is_selected);
  // 활성 워크스페이스 = 선택된 팀, 없으면 개인(name=null). 잔여 크레딧 표시용.
  const activeWs = current || wsList.find((w) => !w.name);
  // 크레딧 — 하우스는 활성 워크스페이스 잔액, 비-하우스는 에이전트가 보고한 내 잔액.
  const activeCredits = liveMode ? activeWs?.credits ?? null : reported?.credits ?? null;
  // 로그인 계정이면 그 계정 이름이 우선(가입 시 설정한 표시이름). 비로그인이면 제공자 이름.
  const displayName = accountDisplayName(account, provider);
  const roleText = accountRoleText(account);
  const initial = (displayName[0] || "?").toUpperCase();

  const switchTo = async (id: string | null) => {
    setBusy(true);
    try {
      const r = id ? await api.selectWorkspace(id) : await api.unselectWorkspace();
      setList(r.workspaces);
      onWorkspaceSwitched();
    } catch (e) {
      alert("워크스페이스 전환 실패: " + String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="acct-menu" ref={ref}>
      <button
        className="acct-avatar"
        onClick={() => setOpen((v) => !v)}
        title={`${displayName}${account && roleText ? ` · ${roleText}` : ""}\n워크스페이스·계정 관리`}
      >
        {initial}
      </button>

      {open && (
        <div className="acct-pop">
          <div className="acct-head">
            <div className="acct-av-lg">{initial}</div>
            <div className="acct-id">
              <div className="acct-name">{displayName}</div>
              {/* 이메일은 한 줄(잘림 OK), 역할은 별도 줄에 여러 줄 허용 → "Admin/Product Manager" 안 잘림 */}
              <div className="acct-sub">
                {account
                  ? account.email
                  : current
                    ? `${current.plan_type} workspace`
                    : provider?.email || "로컬 계정"}
              </div>
              {account && roleText && (
                <div className="acct-role">{roleText}</div>
              )}
            </div>
          </div>

          {/* 워크스페이스 — 로그인 계정은 내 에이전트가 보고한 검증된 값(읽기전용),
              비로그인(AUTH off)만 서버 CLI 라이브·전환 가능. 전환은 각자 자기 로컬 CLI에서. */}
          <div className="acct-sec-label">{t("워크스페이스")}</div>
          {!liveMode && reported && !reported.reported ? (
            <div className="acct-hint">
              내 힉스필드 미연결 — 내 PC에서 에이전트(<code>push_agent --watch</code>)를 실행하면 표시됩니다.
            </div>
          ) : (
            wsList.map((w) => {
              // 이름 없는(name=null) 워크스페이스 = 개인 워크스페이스(힉스필드는 사용자 이름으로 표시).
              const isPersonal = !w.name;
              const selected = w.is_selected || (isPersonal && !current);
              const inner = (
                <span className="acct-item-main">
                  <span className="acct-item-name">
                    {isPersonal ? displayName : w.name}
                  </span>
                  <span className="acct-item-meta">
                    {isPersonal ? t("개인 · ") : ""}
                    {w.plan_type} · {Math.round(w.credits)} cr · {w.user_role}
                  </span>
                </span>
              );
              // 비로그인(라이브)만 클릭 전환. 로그인 계정은 읽기전용 — 전환은 자기 로컬 CLI에서.
              return liveMode ? (
                <button
                  key={w.id}
                  className={"acct-item" + (selected ? " on" : "")}
                  // 개인 워크스페이스도 실제 id 로 select 한다(CLI 1.x). 예전엔 개인=unselect 였는데,
                  // 1.x 는 unset 이면 account status 실패=생성 꺼짐 → 개인 id 로 set 해야 생성 유지.
                  onClick={() => switchTo(w.id)}
                  disabled={busy}
                >
                  {inner}
                  {selected && <span className="acct-check">✓</span>}
                </button>
              ) : (
                <div key={w.id} className={"acct-item readonly" + (selected ? " on" : "")}>
                  {inner}
                  {selected && <span className="acct-check">✓</span>}
                </div>
              );
            })
          )}

          {/* 잔여 크레딧 — 로그인 계정=내 에이전트 보고값(검증), 비로그인=라이브 활성 워크스페이스 */}
          {activeCredits != null && (
            <div className="acct-credits">
              <span className="acct-credits-label">Credits</span>
              <span className="acct-credits-val">
                {Math.round(activeCredits).toLocaleString()} left
              </span>
            </div>
          )}
          {!liveMode && reported?.reported && (
            <div className="acct-hint acct-hint-sm">마지막 동기화 기준 · 전환은 내 로컬 CLI에서</div>
          )}

          {/* '외부 생성물 올리기'·'힉스필드 삭제물 검토'는 설정 패널로 이동(중복 제거). */}
          <div className="acct-sep" />
          <button
            className="acct-action"
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true);
            }}
          >
            {t("⚙ 설정")}
          </button>
          <button
            className="acct-action"
            onClick={() => {
              setOpen(false);
              setManageOpen(true);
            }}
          >
            ⚙ Manage Account
          </button>
          {onLogout && (
            <button
              className="acct-action acct-signout"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
            >
              ⏏ Sign Out
            </button>
          )}
        </div>
      )}

      {manageOpen && (
        <ManageAccount
          provider={provider}
          account={account}
          onClose={() => setManageOpen(false)}
          onProviderUpdated={onProviderUpdated}
          plan={activeWs?.plan_type ?? null}
          credits={activeCredits}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onImported={onImported}
        />
      )}
    </div>
  );
}
