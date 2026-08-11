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
import { useEscapeClose } from "../lib/useEscapeClose";
import { useOutsideMouseDown } from "../lib/useOutsideMouseDown";
import { useSyncStatus } from "../lib/useSyncStatus";
import {
  reconcileReportedWorkspaceContext,
  sameWorkspace,
  selectedWorkspaceContext,
  workspaceContextOf,
} from "../lib/workspaceContext";
import { ManageAccount } from "./ManageAccount";
import { SettingsPanel } from "./SettingsPanel";
import type { Account, ReportedHfStatus, Workspace, WorkspaceContext } from "../types";

// 힉스필드 팀 플랜 월 크레딧 한도(게이지 분모). CLI 가 총 한도를 안 주므로(account status·
// workspace list·transactions 모두 잔액/차감만) 힉스필드 웹처럼 비율 게이지를 그리려면
// 총량이 필요 → Jay 지정 상수. 팀 플랜 기준이며, 바꾸려면 이 값만 고치면 된다.
const MONTHLY_CREDIT_MAX = 200010;
// 점 세그먼트 게이지(힉스필드 스타일)의 총 칸 수.
const DOT_COUNT = 20;

export function AccountMenu({
  provider,
  account,
  onProviderUpdated,
  onLogout,
  onWorkspaceSwitched,
  workspaceContext,
  onWorkspaceContextChange,
  onImported,
  localHub,
}: {
  provider: ProviderIdentity | null;
  account?: Account | null;
  onProviderUpdated: (p: ProviderIdentity) => void;
  onLogout?: () => void;
  onWorkspaceSwitched: () => void;
  workspaceContext: WorkspaceContext;
  onWorkspaceContextChange: (context: WorkspaceContext) => void;
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
  const avatarRef = useRef<HTMLButtonElement>(null);
  // 계정 상태 요청이 진행되는 동안 사용자가 공간을 바꿔도 오래된 응답이 선택을 되돌리지 않게
  // 비동기 콜백은 항상 가장 최신 컨텍스트를 읽는다.
  const workspaceContextRef = useRef(workspaceContext);
  workspaceContextRef.current = workspaceContext;
  const t = useT();
  const closeMenu = useCallback(() => setOpen(false), []);
  const closeMenuOnEscape = useCallback(() => {
    setOpen(false);
    avatarRef.current?.focus();
  }, []);
  const sync = useSyncStatus(); // 로컬 텔레메트리 push 실패 관측(failed>0 때만 경고)

  // 워크스페이스 라이브(클릭 전환 가능) 조건 = 이 PC 에 내 CLI 가 있을 때.
  //  · 비로그인(AUTH off, 로컬 개발): 원래부터 라이브.
  //  · 로컬 허브(localHub: MV_agent, AUTH off)에서 팀서버 로그인한 경우도 CLI 가 이 PC 에 있으니
  //    라이브 — /api/workspaces(목록·select)가 로컬 CLI 를 직접 호출하므로 클릭 전환이 그대로 작동.
  //  · 공유 서버 본체(AUTH on): CLI 가 내 것이 아닐 수 있어 읽기전용(에이전트 보고값 표시).
  const liveMode = !account || !!localHub;
  const acceptLiveWorkspaces = useCallback((items: Workspace[]) => {
    setList(items);
    const next = selectedWorkspaceContext(items);
    const currentContext = workspaceContextRef.current;
    if (!sameWorkspace(currentContext, next) || currentContext.name !== next.name) {
      onWorkspaceContextChange(next);
    }
  }, [onWorkspaceContextChange]);
  const acceptReportedStatus = useCallback((status: ReportedHfStatus) => {
    setReported(status);
    // 공유 서버에서는 메뉴 선택이 "조회/생성 대상"이다. 최초 진입 때만 에이전트가 보고한
    // 현재 CLI 공간을 기본값으로 삼는다. 저장 필터에서 id만 복원된 팀 컨텍스트는 같은 id의
    // 보고값으로 이름까지 보완하되, 이후 사용자가 고른 다른 공간은 새 보고가 와도 유지한다.
    const currentContext = workspaceContextRef.current;
    const next = reconcileReportedWorkspaceContext(currentContext, status.workspaces || []);
    if (!sameWorkspace(currentContext, next) || currentContext.name !== next.name) {
      onWorkspaceContextChange(next);
    }
  }, [onWorkspaceContextChange]);
  useEffect(() => {
    if (liveMode) api.workspaces().then(acceptLiveWorkspaces).catch(() => {});
    else api.accountHf().then(acceptReportedStatus).catch(() => setReported(null));
  }, [acceptLiveWorkspaces, acceptReportedStatus, liveMode]);
  useOutsideMouseDown(ref, closeMenu, open);
  // 캡처 단계에서 Esc 를 소비해 뒤의 라이브러리 전역 Esc(선택 해제)까지 전달되지 않게 한다.
  useEscapeClose(closeMenuOnEscape, open, true, true);
  // 메뉴를 열 때마다 워크스페이스/보고값을 새로고침 — 에이전트 동기화·계정상태 보고가 나중에
  // 끝나도 즉시 반영된다(예전엔 마운트 때 한 번만 받아 '미연결'이 옛 상태로 박혀 있었다).
  useEffect(() => {
    if (!open) return;
    if (liveMode) api.workspaces().then(acceptLiveWorkspaces).catch(() => {});
    else api.accountHf().then(acceptReportedStatus).catch(() => {});
  }, [acceptLiveWorkspaces, acceptReportedStatus, open, liveMode]);

  // 표시할 워크스페이스 목록 — 하우스=라이브, 그 외=에이전트 보고값.
  const wsList = liveMode ? list : reported?.workspaces || [];
  const current = wsList.find((w) => w.is_selected);
  // 활성 워크스페이스 = 선택된 팀, 없으면 개인(name=null). 잔여 크레딧 표시용.
  const activeWs =
    workspaceContext.scope === "team"
      ? wsList.find((w) => w.id === workspaceContext.id)
      : workspaceContext.scope === "personal"
        ? wsList.find((w) => !w.name)
        : current || wsList.find((w) => !w.name);
  // 크레딧 — 하우스는 활성 워크스페이스 잔액, 비-하우스는 에이전트가 보고한 내 잔액.
  // 숫자로 정규화 — CLI 가 문자열/누락/이상값을 줘도 NaN·Infinity 로 링/aria/CSS 가 깨지지 않게 한다.
  const rawCredits = activeWs?.credits ?? (liveMode ? null : reported?.credits);
  const parsedCredits =
    rawCredits == null ? null : typeof rawCredits === "number" ? rawCredits : Number(rawCredits);
  const activeCredits =
    parsedCredits != null && Number.isFinite(parsedCredits) ? parsedCredits : null;
  const gaugeCredits = activeCredits != null ? Math.max(0, activeCredits) : null; // 음수는 0으로(빈 게이지)
  // 게이지 채움 비율 = 남은 크레딧 / 월 한도(0~100% 클램프 — 탑업으로 한도 초과해도 안 넘침).
  const creditPct =
    gaugeCredits != null && MONTHLY_CREDIT_MAX > 0
      ? Math.max(0, Math.min(100, (gaugeCredits / MONTHLY_CREDIT_MAX) * 100))
      : null;
  // 켜진 점 개수 = 비율×칸수. 크레딧이 조금이라도 남았으면 최소 1칸은 켠다.
  const litDots =
    creditPct != null
      ? Math.min(
          DOT_COUNT,
          Math.max(gaugeCredits && gaugeCredits > 0 ? 1 : 0, Math.round((creditPct / 100) * DOT_COUNT)),
        )
      : 0;
  // 아바타 링 배경 — conic 라임 호가 남은 비율(상단바·드롭다운 두 아바타에 공용).
  const ringStyle =
    creditPct != null
      ? { background: `conic-gradient(var(--accent) ${creditPct * 3.6}deg, rgba(255,255,255,0.12) 0)` }
      : undefined;
  const ringOn = creditPct != null ? " on" : "";
  // 로그인 계정이면 그 계정 이름이 우선(가입 시 설정한 표시이름). 비로그인이면 제공자 이름.
  const displayName = accountDisplayName(account, provider);
  const roleText = accountRoleText(account);
  const initial = (displayName[0] || "?").toUpperCase();

  const switchTo = async (id: string | null) => {
    setBusy(true);
    try {
      const r = id ? await api.selectWorkspace(id) : await api.unselectWorkspace();
      acceptLiveWorkspaces(r.workspaces);
      onWorkspaceSwitched();
    } catch (e) {
      alert("워크스페이스 전환 실패: " + String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="acct-menu" ref={ref}>
      {/* 아바타 링 = 남은 크레딧 비율(힉스필드처럼 테두리로 표시). 크레딧 없으면 링 없이 아바타만. */}
      <button
        ref={avatarRef}
        type="button"
        className="acct-avatar-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          `${displayName}${account && roleText ? ` · ${roleText}` : ""}` +
          (activeCredits != null
            ? `\nCredits ${Math.round(activeCredits).toLocaleString()} left`
            : "") +
          "\n워크스페이스·계정 관리"
        }
      >
        <span className={"acct-ring" + ringOn} style={ringStyle}>
          <span className="acct-avatar">{initial}</span>
        </span>
      </button>

      {open && (
        <div className="acct-pop">
          <div className="acct-head">
            <span className={"acct-ring acct-ring-lg" + ringOn} style={ringStyle}>
              <span className="acct-av-lg">{initial}</span>
            </span>
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

          {/* 매니징 push 실패 경고 — 조용히 묻히던 텔레메트리 push 실패를 노출(failed>0 때만). pending 은 정상 backlog. */}
          {sync && sync.failed > 0 && (
            <div className="acct-sync-warn" title={sync.last_error || undefined}>
              ⚠ 매니징 동기화 {sync.failed}건 실패 — 다음 동기화 때 재시도{sync.pending > sync.failed ? ` (대기 ${sync.pending})` : ""}
            </div>
          )}

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
              const itemContext = workspaceContextOf(w);
              const selected = sameWorkspace(workspaceContext, itemContext);
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
              // 로컬 허브는 실제 CLI까지 전환한다. 공유 서버에서는 내 에이전트가 생성 직전에
              // 이 선택값으로 CLI를 전환하므로, 여기서는 라이브러리/생성 대상만 바꾼다.
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
                <button
                  key={w.id}
                  type="button"
                  className={"acct-item" + (selected ? " on" : "")}
                  onClick={() => {
                    onWorkspaceContextChange(itemContext);
                    onWorkspaceSwitched();
                  }}
                >
                  {inner}
                  {selected && <span className="acct-check">✓</span>}
                </button>
              );
            })
          )}

          {/* 잔여 크레딧(힉스필드 스타일) — "Credits  N left" + 점 세그먼트 게이지(남은 비율).
              로그인 계정=내 에이전트 보고값(검증), 비로그인=라이브 활성 워크스페이스 */}
          {activeCredits != null && creditPct != null && (
            <div className="acct-credits">
              <div className="acct-credits-top">
                <span className="acct-credits-label">Credits</span>
                <span className="acct-credits-left">
                  {Math.round(activeCredits).toLocaleString()} left
                </span>
              </div>
              <div
                className="acct-dots"
                role="meter"
                aria-label="Credits remaining"
                aria-valuemin={0}
                aria-valuemax={MONTHLY_CREDIT_MAX}
                aria-valuenow={Math.round(gaugeCredits ?? 0)}
              >
                {Array.from({ length: DOT_COUNT }, (_, i) => (
                  <span key={i} className={"acct-dot" + (i < litDots ? " on" : "")} />
                ))}
              </div>
            </div>
          )}
          {!liveMode && reported?.reported && (
            <div className="acct-hint acct-hint-sm">마지막 동기화 기준 · 생성 직전에 에이전트가 선택 공간을 확인</div>
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
