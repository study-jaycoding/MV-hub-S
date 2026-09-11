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
import { workspaceCommandLabels } from "../lib/workspaceCommand";
import { canAdoptWorkspaceList } from "../lib/workspaceSwitchPlan";
import {
  formatTelemetryLastSuccess,
  latestSyncSuccess,
  syncFailedCount,
  syncPendingCount,
  useSyncStatus,
} from "../lib/useSyncStatus";
import {
  activeWorkspaceOf,
  reconcileReportedWorkspaceContext,
  sameWorkspace,
  selectedWorkspaceContext,
  workspaceContextOf,
} from "../lib/workspaceContext";
import { ManageAccount } from "./ManageAccount";
import { SettingsPanel } from "./SettingsPanel";
import { manageApi } from "../lib/manageApi";
import type { Account, ReportedHfStatus, Workspace, WorkspaceContext } from "../types";

// 게이지 분모 규칙(Jay 지정): MILLIONVOLT(본사 공용 워크스페이스)는 고정 200,000.
// 그 외 워크스페이스는 배정된 프로젝트들의 '예산 한도' 합(관리창 프로젝트 설정)을 분모로
// 쓰고, 예산 미설정·조회 실패일 때만 이 상수로 폴백한다. (CLI 는 총 한도를 안 줌 —
// account status·workspace list·transactions 모두 잔액/차감만.)
const MONTHLY_CREDIT_MAX = 200000;
const FIXED_MAX_WORKSPACE = "MILLIONVOLT";
// 점 세그먼트 게이지(힉스필드 스타일)의 총 칸 수.
const DOT_COUNT = 20;

export function AccountMenu({
  provider,
  account,
  onProviderUpdated,
  onLogout,
  onWorkspaceSwitched,
  onWorkspaceSwitchFailed,
  workspaceContext,
  workspaceEpoch,
  workspaceSwitching,
  onWorkspaceContextChange,
  onImported,
  localHub,
  manageEnabled,
}: {
  provider: ProviderIdentity | null;
  account?: Account | null;
  onProviderUpdated: (p: ProviderIdentity) => void;
  onLogout?: () => void;
  onWorkspaceSwitched: (context: WorkspaceContext) => void; // 전환 완료 — 전환된 공간(토스트 표시용)
  onWorkspaceSwitchFailed: (context: WorkspaceContext, detail: string) => void; // CLI 전환 실패 — 그 공간 생성 차단
  workspaceContext: WorkspaceContext;
  workspaceEpoch: number; // 공간 변경 순번(App 소유) — 조회를 시작한 뒤 바뀌었으면 그 응답은 버린다
  workspaceSwitching?: boolean; // 씬 탭 전환이 진행 중 — 그동안의 조회 결과로 공간을 바꾸지 않는다
  onWorkspaceContextChange: (context: WorkspaceContext) => number; // 발급된 변경 순번을 돌려준다
  onImported?: (msg: string) => void; // 라이브러리 변경 후 리로드+안내(휴지통 이동 등)
  localHub?: boolean; // 로컬 허브(MV_agent, AUTH off) = 내 CLI 가 이 PC 에 있음 → 워크스페이스 전환 가능
  manageEnabled?: boolean; // PM 관리 기능 on — 꺼진 서버엔 예산(planning) 조회를 아예 안 보낸다
}) {
  const [list, setList] = useState<Workspace[]>([]);
  const [reported, setReported] = useState<ReportedHfStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [healthCliVersion, setHealthCliVersion] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLButtonElement>(null);
  // 계정 상태 요청이 진행되는 동안 사용자가 공간을 바꿔도 오래된 응답이 선택을 되돌리지 않게
  // 비동기 콜백은 항상 가장 최신 컨텍스트를 읽는다.
  const workspaceContextRef = useRef(workspaceContext);
  workspaceContextRef.current = workspaceContext;
  // 공간 변경 순번(App 소유) — 조회 응답이 도착했을 때 이 값이 그대로여야 반영한다.
  const workspaceEpochRef = useRef(workspaceEpoch);
  workspaceEpochRef.current = workspaceEpoch;
  const switchingRef = useRef(workspaceSwitching);
  switchingRef.current = workspaceSwitching;
  // ★이 메뉴가 건 전환이 도는 동안 = CLI 는 아직 옛 공간이다. 메뉴를 다시 열면 목록을 재조회하는데,
  //  그 응답으로 사용자의 방금 선택을 되돌리면 안 된다(코덱스 리뷰: 앱 A / CLI B 로 갈라지는 경로).
  //  씬 전환용 switchingRef 는 이 경우를 못 덮는다 — 계정 메뉴 전환은 App 의 switching 을 안 세운다.
  const selfSwitchingRef = useRef(false);
  // 전환이 **시작·종료할 때마다** 오르는 순번. '응답 시점에 전환 중인가' 만 보면, 전환 도중 시작된
  // 조회가 전환보다 **늦게** 도착했을 때 그대로 채택돼 선택이 되돌아간다(코덱스 재현).
  // 조회는 시작 순번을 들고 있다가 도착했을 때 맞대 본다.
  const switchGenRef = useRef(0);
  // 씬 탭 전환의 시작·종료도 같은 이유로 순번을 올린다(그동안 CLI 는 옛 공간이다).
  useEffect(() => {
    switchGenRef.current += 1;
  }, [workspaceSwitching]);
  const t = useT();
  const closeMenu = useCallback(() => setOpen(false), []);
  const closeMenuOnEscape = useCallback(() => {
    setOpen(false);
    avatarRef.current?.focus();
  }, []);
  // 이 상태는 이 PC의 로컬 outbox에만 의미가 있다. 공유 서버 화면에서는 불필요한 폴링을 하지 않는다.
  const sync = useSyncStatus(!!localHub);
  const syncPending = sync ? syncPendingCount(sync) : 0;
  const syncFailed = sync ? syncFailedCount(sync) : 0;
  const syncDead = Math.max(0, sync?.account_report_dead || 0);
  const syncError = sync?.account_report_last_error || sync?.last_error || undefined;
  const syncBreakdown = sync
    ? `생성정보 ${sync.pending || 0}건 · 계정/거래 ${sync.account_report_pending || 0}건 · 격리 ${syncDead}건`
    : undefined;

  // 워크스페이스 라이브(클릭 전환 가능) 조건 = 이 PC 에 내 CLI 가 있을 때.
  //  · 비로그인(AUTH off, 로컬 개발): 원래부터 라이브.
  //  · 로컬 허브(localHub: MV_agent, AUTH off)에서 팀서버 로그인한 경우도 CLI 가 이 PC 에 있으니
  //    라이브 — /api/workspaces(목록·select)가 로컬 CLI 를 직접 호출하므로 클릭 전환이 그대로 작동.
  //  · 공유 서버 본체(AUTH on): CLI 가 내 것이 아닐 수 있어 읽기전용(에이전트 보고값 표시).
  const liveMode = !account || !!localHub;
  //  startedAt 을 주면 '조회를 시작할 때의 변경 순번' 과 비교해, 그 사이 공간이 바뀌었으면(씬 탭 클릭·
  //  메뉴 선택·전환 완료) 늦게 도착한 옛 CLI 값으로 되돌리지 않는다(코덱스 P2). 값 비교로는 부족하다 —
  //  같은 값으로 되돌아온 뒤 도착한 옛 응답을 못 거른다. 전환 직후 호출(switchTo)에는 주지 않는다.
  const acceptLiveWorkspaces = useCallback(
    (
      items: Workspace[],
      startedAt?: number,
      startedSwitchGen?: number,
      startedWhileSwitching = false,
    ) => {
    setList(items);
    if (
      !canAdoptWorkspaceList({
        startedEpoch: startedAt,
        currentEpoch: workspaceEpochRef.current,
        startedSwitchGen: startedSwitchGen ?? switchGenRef.current,
        currentSwitchGen: switchGenRef.current,
        startedWhileSwitching,
        switchingNow: !!switchingRef.current || selfSwitchingRef.current,
      })
    ) {
      return;
    }
    const currentContext = workspaceContextRef.current;
    const next = selectedWorkspaceContext(items);
    if (!sameWorkspace(currentContext, next) || currentContext.name !== next.name) {
      onWorkspaceContextChange(next);
    }
  },
    [onWorkspaceContextChange],
  );
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
    if (liveMode) {
      const startedAt = workspaceEpochRef.current;
      const startedGen = switchGenRef.current;
      // 시작 시점에 전환이 돌고 있었는지도 함께 — 순번 effect 가 늦게 도는 틈을 안 믿는다.
      const startedSwitching = !!switchingRef.current || selfSwitchingRef.current;
      api
        .workspaces()
        .then((items) => acceptLiveWorkspaces(items, startedAt, startedGen, startedSwitching))
        .catch(() => {});
    } else api.accountHf().then(acceptReportedStatus).catch(() => setReported(null));
  }, [acceptLiveWorkspaces, acceptReportedStatus, liveMode]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then((response) => response.json())
      .then((health: { cli_version?: unknown }) => {
        const version =
          typeof health.cli_version === "string" ? health.cli_version.trim() : "";
        setHealthCliVersion(version || null);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setHealthCliVersion(null);
        }
      });
    return () => controller.abort();
  }, []);
  useOutsideMouseDown(ref, closeMenu, open);
  // 캡처 단계에서 Esc 를 소비해 뒤의 라이브러리 전역 Esc(선택 해제)까지 전달되지 않게 한다.
  useEscapeClose(closeMenuOnEscape, open, true, true);
  // 메뉴를 열 때마다 워크스페이스/보고값을 새로고침 — 에이전트 동기화·계정상태 보고가 나중에
  // 끝나도 즉시 반영된다(예전엔 마운트 때 한 번만 받아 '미연결'이 옛 상태로 박혀 있었다).
  useEffect(() => {
    if (!open) return;
    if (liveMode) {
      const startedAt = workspaceEpochRef.current;
      const startedGen = switchGenRef.current;
      // 시작 시점에 전환이 돌고 있었는지도 함께 — 순번 effect 가 늦게 도는 틈을 안 믿는다.
      const startedSwitching = !!switchingRef.current || selfSwitchingRef.current;
      api
        .workspaces()
        .then((items) => acceptLiveWorkspaces(items, startedAt, startedGen, startedSwitching))
        .catch(() => {});
    } else api.accountHf().then(acceptReportedStatus).catch(() => {});
  }, [acceptLiveWorkspaces, acceptReportedStatus, open, liveMode]);

  // 표시할 워크스페이스 목록 — 하우스=라이브, 그 외=에이전트 보고값.
  const wsList = liveMode ? list : reported?.workspaces || [];
  const workspaceLabels = workspaceCommandLabels(
    wsList.flatMap((workspace) => workspace.name
      ? [{ id: workspace.id, name: workspace.name }]
      : []),
  );
  const current = wsList.find((w) => w.is_selected); // CLI 가 실제로 물고 있는 공간(플랜 라벨용)
  // 활성 워크스페이스 = 선택된 팀, 없으면 개인(name=null). 잔여 크레딧 표시용.
  // 하단 상태줄(useAccountStatus)도 같은 규칙을 쓴다 — 두 곳의 숫자가 어긋나지 않게.
  const activeWs = activeWorkspaceOf(wsList, workspaceContext);
  // 게이지 분모 = 활성 워크스페이스에 배정된 프로젝트들의 '예산 한도' 합(관리창 프로젝트 설정).
  // 프로젝트마다 예산이 달라 워크스페이스별로 다른 분모가 적용된다. 메뉴를 열 때마다 재조회해
  // 예산 수정이 곧 반영되고, 미설정·실패면 null → 아래에서 상수 폴백.
  // MILLIONVOLT 는 고정 한도(상수) 사용 — 예산 조회를 건너뛴다.
  const [budgetMax, setBudgetMax] = useState<number | null>(null);
  const activeWsId = activeWs?.id || null;
  const fixedMaxWs = activeWs?.name === FIXED_MAX_WORKSPACE;
  // 예산 재조회 시점: 마운트·워크스페이스 변경·메뉴가 '열리는' 순간만. 닫히는 전이(true→false)
  // 에서 같은 워크스페이스를 다시 조회하던 것 제거. 관리창에서 바뀐 예산은 다음 열기 때 갱신.
  const budgetFetchedWsRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWsId || fixedMaxWs || manageEnabled === false) {
      // 관리 기능이 꺼진 서버엔 planning 라우트가 없다 — 프로젝트 수만큼 404 를 만들지 않는다.
      setBudgetMax(null);
      budgetFetchedWsRef.current = null;
      return;
    }
    if (!open && budgetFetchedWsRef.current === activeWsId) return; // 닫힘 전이 — 재조회 없음
    budgetFetchedWsRef.current = activeWsId;
    let alive = true;
    (async () => {
      try {
        const r = await api.projects("my", false, activeWsId);
        const plans = await Promise.all(
          (r.projects || []).map((p) => manageApi.getPlanning(p.id).catch(() => null)),
        );
        const sum = plans.reduce((acc, plan) => acc + (plan?.budget_credits ?? 0), 0);
        if (alive) setBudgetMax(sum > 0 ? sum : null);
      } catch {
        if (alive) setBudgetMax(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeWsId, fixedMaxWs, open, manageEnabled]);
  const gaugeMax = budgetMax ?? MONTHLY_CREDIT_MAX;

  // 크레딧 — 하우스는 활성 워크스페이스 잔액, 비-하우스는 에이전트가 보고한 내 잔액.
  // 숫자로 정규화 — CLI 가 문자열/누락/이상값을 줘도 NaN·Infinity 로 링/aria/CSS 가 깨지지 않게 한다.
  const rawCredits = activeWs?.credits ?? (liveMode ? null : reported?.credits);
  const parsedCredits =
    rawCredits == null ? null : typeof rawCredits === "number" ? rawCredits : Number(rawCredits);
  const activeCredits =
    parsedCredits != null && Number.isFinite(parsedCredits) ? parsedCredits : null;
  const gaugeCredits = activeCredits != null ? Math.max(0, activeCredits) : null; // 음수는 0으로(빈 게이지)
  // 게이지 채움 비율 = 남은 크레딧 / 예산 한도(0~100% 클램프 — 탑업으로 한도 초과해도 안 넘침).
  const creditPct =
    gaugeCredits != null && gaugeMax > 0
      ? Math.max(0, Math.min(100, (gaugeCredits / gaugeMax) * 100))
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

  // 전환은 낙관적으로 — 클릭하면 **바로** 메뉴를 닫고 앱 공간을 바꾼다. CLI 반영 확인(set+list
  // 실측 ≈1.4초)은 뒤에서 하고, 확인된 뒤에 알림이 뜬다(Jay: "확실하게 변경되어서").
  //  예전엔 확인이 끝날 때까지 목록 단추를 전부 잠그고, 거기서 또 라이브러리 재조회까지 기다린 뒤에야
  //  알림이 떠서 4초 가까이 얼어 있었다. 확인이 끝나기 전에 메뉴를 다시 열면 단추는 여전히 잠겨
  //  있으므로(busy), 겹친 전환 요청은 애초에 생기지 않는다.
  const switchTo = (id: string | null) => {
    const target = id ? wsList.find((w) => w.id === id) : null;
    const context = id
      ? workspaceContextOf(target)
      : ({ scope: "personal", id: null, name: null } as WorkspaceContext);
    closeMenu();
    // 발급된 순번을 받아 둔다 — prop 으로 오는 workspaceEpoch 는 렌더 뒤에야 갱신돼 지금 읽으면 옛 값이다.
    const epoch = onWorkspaceContextChange(context); // 이 뒤의 생성은 새 공간으로 나간다
    selfSwitchingRef.current = true;
    switchGenRef.current += 1;
    setBusy(true);
    void (id ? api.selectWorkspace(id) : api.unselectWorkspace())
      .then(
        (r) => ({ ok: true as const, workspaces: r.workspaces }),
        (error: unknown) => ({
          ok: false as const,
          detail: String(error).replace(/^Error:\s*/, ""),
        }),
      )
      .then((result) => {
        selfSwitchingRef.current = false;
        switchGenRef.current += 1; // 전환이 끝났다 — 그 전에 시작된 조회는 모두 옛 값이다
        setBusy(false);
        // 그 사이 다른 경로가 공간을 바꿨으면(씬 탭·다른 창) 이 응답은 늦게 온 옛 것이다.
        //  ★순번으로 가른다 — 값 비교로는 A→B→A 로 돌아온 뒤 도착한 옛 응답을 못 거른다.
        //   그러면 성공한 전환에 실패 표시를 씌우거나, 그 반대가 된다(코덱스 리뷰).
        if (epoch !== workspaceEpochRef.current) return;
        if (result.ok) {
          acceptLiveWorkspaces(result.workspaces);
          onWorkspaceSwitched(selectedWorkspaceContext(result.workspaces));
          return;
        }
        // 실패는 alert 로 흐름을 끊지 않는다 — 앱이 그 공간의 생성을 막고 토스트로 알린다.
        onWorkspaceSwitchFailed(context, result.detail);
      });
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

          {localHub && sync && (
            <div className="acct-sync-state" title={syncBreakdown}>
              <span>{formatTelemetryLastSuccess(latestSyncSuccess(sync))}</span>
              <span>{syncPending > 0 ? `대기 ${syncPending}건` : "대기 없음"}</span>
            </div>
          )}

          {/* 생성정보와 계정·거래 보고 실패를 합쳐 노출한다. 세부 대기 건수는 위 상태 title로 확인. */}
          {sync && syncFailed > 0 && (
            <div className="acct-sync-warn" title={syncError}>
              ⚠ 매니징 동기화 {syncFailed}건 실패{syncDead > 0 ? ` · ${syncDead}건 격리` : ""}{syncFailed > syncDead ? " — 다음 동기화 때 재시도" : ""}{syncPending > syncFailed ? ` (대기 ${syncPending})` : ""}
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
                    <span className="acct-item-name-txt">
                      {isPersonal ? displayName : workspaceLabels.get(w.id) ?? w.name}
                    </span>
                    {/* 선택 표시 = 배지 라임(✓ 대체). 크레딧은 오른쪽 끝(옛 ✓ 자리). */}
                    <span className={"acct-item-plan" + (selected ? " on" : "")}>
                      {isPersonal ? `${t("개인")}·${w.plan_type}` : w.plan_type}
                    </span>
                    <span className="acct-item-credits">
                      {Math.round(w.credits).toLocaleString()} cr
                    </span>
                  </span>
                  <span className="acct-item-meta">{w.user_role}</span>
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
                </button>
              ) : (
                <button
                  key={w.id}
                  type="button"
                  className={"acct-item" + (selected ? " on" : "")}
                  onClick={() => {
                    onWorkspaceContextChange(itemContext);
                    onWorkspaceSwitched(itemContext);
                  }}
                >
                  {inner}
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
                aria-valuemax={gaugeMax}
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

          {/* 'HF 생성물 체크'·'HF 삭제물 체크'는 설정 패널로 이동(중복 제거). */}
          <div className="acct-sep" />
          <button
            className="acct-action"
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true);
            }}
          >
            {t("⚙ Setting")}
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
          cliVersion={reported?.cli_version ?? healthCliVersion}
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
