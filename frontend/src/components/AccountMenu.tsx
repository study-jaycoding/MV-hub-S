// 계정·워크스페이스 통합 메뉴 — 힉스필드 사이트의 계정 드롭다운처럼.
// 워크스페이스 전환 + 표시이름 변경 + 로그인 정보/로그아웃을 한 곳에서 관리. Assets 버튼 옆.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useT } from "../lib/i18n";
import { ManageAccount } from "./ManageAccount";
import { SettingsPanel } from "./SettingsPanel";
import { GLOBAL_ROLE_LABEL } from "../types";
import type { Account, ReportedHfStatus, Workspace } from "../types";

// 전역 역할(복수) → 짧은 라벨. 예: "Admin/Product Manager"
function roleText(account?: Account | null): string {
  const roles = account?.global_roles || [];
  return roles.map((r) => (GLOBAL_ROLE_LABEL[r] || r).split(" · ")[0]).join("/");
}

type Provider = { uid: string | null; name: string | null; email: string | null };

export function AccountMenu({
  provider,
  account,
  onProviderUpdated,
  onLogout,
  onWorkspaceSwitched,
  onFullSync,
}: {
  provider: Provider | null;
  account?: Account | null;
  onProviderUpdated: (p: Provider) => void;
  onLogout?: () => void;
  onWorkspaceSwitched: () => void;
  onFullSync?: () => Promise<void> | void; // 설정 → 전체 가져오기(= 지금 동기화)
}) {
  const [list, setList] = useState<Workspace[]>([]);
  const [reported, setReported] = useState<ReportedHfStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();

  // '외부 생성물 올리기' — 내 에이전트를 깨워 허브 밖에서 만든 결과물을 push. 연결 표시는
  // 생성 프롬프트 푸터로 통합(여기선 결과 메시지만).
  const syncMine = async () => {
    setSyncMsg("요청 보냄…");
    try {
      const r = await api.agentSync();
      setSyncMsg(r.connected ? "✓ 에이전트에 전달됨" : "에이전트가 꺼져 있어요");
    } catch {
      setSyncMsg("실패");
    }
    setTimeout(() => setSyncMsg(""), 2500);
  };

  // 로그인 계정(jay 포함 모두) → 그 계정 에이전트가 보고한 '검증된 내 힉스필드 신원'(읽기전용).
  // 검증된 이메일 기준이라 남의 크레딧과 안 겹친다. 비로그인(AUTH off, 로컬 개발)만 서버 CLI
  // 라이브(전환 가능). 브라우저는 남의 CLI 직접 접근 불가 → 보고값이 유일한 '내 데이터'.
  const liveMode = !account;
  useEffect(() => {
    if (liveMode) api.workspaces().then(setList).catch(() => {});
    else api.accountHf().then(setReported).catch(() => setReported(null));
  }, [liveMode]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // 표시할 워크스페이스 목록 — 하우스=라이브, 그 외=에이전트 보고값.
  const wsList = liveMode ? list : reported?.workspaces || [];
  const current = wsList.find((w) => w.is_selected);
  // 활성 워크스페이스 = 선택된 팀, 없으면 개인(name=null). 잔여 크레딧 표시용.
  const activeWs = current || wsList.find((w) => !w.name);
  // 크레딧 — 하우스는 활성 워크스페이스 잔액, 비-하우스는 에이전트가 보고한 내 잔액.
  const activeCredits = liveMode ? activeWs?.credits ?? null : reported?.credits ?? null;
  // 로그인 계정이면 그 계정 이름이 우선(가입 시 설정한 표시이름). 비로그인이면 제공자 이름.
  const displayName = account?.name || account?.email || provider?.name || "사용자";
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
        title={`${displayName}${account ? ` · ${roleText(account)}` : ""}\n워크스페이스·계정 관리`}
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
              {account && roleText(account) && (
                <div className="acct-role">{roleText(account)}</div>
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
                  onClick={() => switchTo(isPersonal ? null : w.id)}
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

          {/* 외부 생성물 올리기 — 허브 밖(Claude/웹/CLI)에서 만든 결과물을 지금 push.
              (허브 생성/재생성 결과는 자동 반영. 연결 표시는 생성 프롬프트 푸터로 통합됨.) */}
          {account && (
            <>
              <div className="acct-sep" />
              <button className="acct-action" onClick={syncMine} disabled={!!syncMsg}>
                📤 {syncMsg || "외부 생성물 올리기"}
              </button>
              <p className="acct-hint acct-hint-sm">허브 밖에서 만든 결과물을 올립니다(허브 생성물은 자동).</p>
            </>
          )}

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
        />
      )}

      {settingsOpen && (
        <SettingsPanel onClose={() => setSettingsOpen(false)} onFullSync={onFullSync} account={account} />
      )}
    </div>
  );
}
