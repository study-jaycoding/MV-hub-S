// 대시보드 '워크스페이스 사용 현황' 패널 안, 고리·통계 격자 바로 아래의 크레딧 풀 구역(Jay 2026-09-10).
// 매니저: 풀 카드(월 충전·이번 달 사용·현재 잔액·월초 잔액) → 그룹별 한도 표 → 잔액 추이(관측값).
// 일반 멤버: '내 그룹' 카드 하나(그룹 합계는 보이되 팀원 개인 내역은 없음).
// 힉스필드가 한도를 강제하므로 여기서는 보여주고 경고만 한다. 구서버(라우트 없음)·권한 없음이면 조용히 숨긴다.
import { useEffect, useState } from "react";
import { isHttpStatus, isRouteMissing } from "../../lib/http";
import { manageApi } from "../../lib/manageApi";
import { formatCredits } from "../../lib/formatCredits";
import {
  autoShareLabel,
  cycleLabel,
  limitTotal,
  niceCeil,
  overrideBody,
  periodSuffix,
  periodUsageLabel,
  projectDepletion,
  remainingTone,
  topupSteps,
  usagePercent,
  type BalancePoint,
  type CreditGroupSummary,
  type CreditPlanView,
  type CreditTopup,
} from "../../lib/creditPlan";

function n(value: number | null | undefined): string {
  return formatCredits(value);
}

function cr(value: number | null | undefined): string {
  return value == null ? "—" : `${n(value)} cr`;
}

function seenText(iso: string | null): string {
  if (!iso) return "보고 없음";
  return `마지막 동기화 ${iso.replace("T", " ").slice(5, 16)}`;
}

function monthLabel(month: string): string {
  const [, m] = month.split("-");
  return `${Number(m)}월`;
}

function dayLabel(day: string): string {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

interface AdjustState {
  open: boolean;
  value: string;
  busy: boolean;
  error: string;
  onOpen: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function GroupRemaining({ group, adjust }: { group: CreditGroupSummary; adjust?: AdjustState }) {
  const tone = remainingTone(group.remaining, group.monthly_limit);
  const percent = usagePercent(group.used_period ?? group.used_month, group.monthly_limit);
  return (
    <>
      <td className="tnum" title="이월 포함">
        {group.remaining == null ? "—" : n(group.remaining)}
        {group.estimated && adjust && !adjust.open ? (
          <button
            type="button"
            className="credit-est-btn"
            title={`미상 ${group.unknown_since_base}건이 섞여 추정치 — 누르면 힉스필드 관리 창의 남은 양으로 맞춥니다`}
            onClick={adjust.onOpen}
          >
            추정
          </button>
        ) : group.estimated ? <span className="credit-est" title={`미상 ${group.unknown_since_base}건이 섞여 추정치`}> 추정</span> : null}
        {adjust?.open ? (
          <div className="credit-adjust" onClick={(event) => event.stopPropagation()}>
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              value={adjust.value}
              placeholder="힉스필드 남은 양"
              aria-label="힉스필드 남은 양"
              onChange={(event) => adjust.onChange(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") adjust.onSubmit(); if (event.key === "Escape") adjust.onCancel(); }}
            />
            <button type="button" disabled={adjust.busy} onClick={adjust.onSubmit}>{adjust.busy ? "저장 중…" : "맞추기"}</button>
            <button type="button" className="ghost" disabled={adjust.busy} onClick={adjust.onCancel}>취소</button>
            {adjust.error ? <span className="credit-est bad">{adjust.error}</span> : null}
          </div>
        ) : null}
      </td>
      <td>
        <span className={`credit-pct tone-${tone}`}>{percent == null ? "∞" : `${percent}%`}</span>
        {percent != null ? (
          <span className="credit-mini"><i className={`tone-${tone}`} style={{ width: `${Math.min(100, percent)}%` }} /></span>
        ) : null}
      </td>
    </>
  );
}

function BalanceChart({ history, month, cycleStart, topups }: {
  history: BalancePoint[];
  month: string;
  cycleStart?: string; // 이번 충전 달의 시작일(기준일 기준) — 없으면 옛 서버라 1일로 본다
  topups: CreditTopup[];
}) {
  if (history.length < 2) {
    return (
      <div className="credit-chart-empty">
        일별 관측이 쌓이는 중입니다 — 에이전트가 보고할 때마다 하루 한 점이 남습니다({history.length}일 기록).
      </div>
    );
  }
  const width = 1000;
  const height = 240;
  const pad = { l: 56, r: 24, t: 18, b: 28 };
  const projection = projectDepletion(history);
  const steps = topupSteps(history);
  const firstDay = history[0].day;
  const lastDay = projection ? projection.depleteDay : history[history.length - 1].day;
  const spanDays = Math.max(1, dayIndex(firstDay, lastDay));
  const maxValue = niceCeil(Math.max(...history.map((point) => point.credits)));
  const x = (day: string) => pad.l + (dayIndex(firstDay, day) / spanDays) * (width - pad.l - pad.r);
  const y = (value: number) => pad.t + (1 - Math.max(0, value) / maxValue) * (height - pad.t - pad.b);
  const points = history.map((point) => `${x(point.day).toFixed(1)},${y(point.credits).toFixed(1)}`);
  const last = history[history.length - 1];
  const area = `M${x(firstDay).toFixed(1)},${y(0).toFixed(1)} L${points.join(" L")} L${x(last.day).toFixed(1)},${y(0).toFixed(1)} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => maxValue * ratio);
  // ★세로선은 달력 1일이 아니라 **충전 기준일**에 긋는다(2026-09-23) — 기준일이 15일이면 9/15 가 달의 시작이다.
  const monthStartDay = cycleStart || `${month}-01`;
  return (
    <svg className="credit-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="워크스페이스 잔액 추이">
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={pad.l} x2={width - pad.r} y1={y(tick)} y2={y(tick)} className="grid" />
          <text x={pad.l - 8} y={y(tick) + 4} textAnchor="end">{n(tick)}</text>
        </g>
      ))}
      {dayIndex(firstDay, monthStartDay) > 0 && dayIndex(firstDay, monthStartDay) <= spanDays ? (
        <line x1={x(monthStartDay)} x2={x(monthStartDay)} y1={pad.t} y2={height - pad.b} className="month-line" />
      ) : null}
      <path d={area} className="area" />
      <polyline points={points.join(" ")} className="line" />
      {steps.map((step) => (
        <g key={step.day}>
          <circle cx={x(step.day)} cy={y(history.find((point) => point.day === step.day)!.credits)} r={4} className="dot" />
          <text x={x(step.day) + 6} y={y(history.find((point) => point.day === step.day)!.credits) - 6}>{`${dayLabel(step.day)} 충전 +${n(step.amount)}`}</text>
        </g>
      ))}
      {topups
        .filter((topup) => dayIndex(firstDay, topup.day) >= 0 && dayIndex(firstDay, topup.day) <= spanDays)
        .map((topup) => (
          <g key={`topup-${topup.id}`} className="topup-mark">
            <line x1={x(topup.day)} x2={x(topup.day)} y1={pad.t} y2={height - pad.b} />
            <text x={x(topup.day) + 4} y={pad.t + 12}>{`긴급 +${n(topup.credits)}`}</text>
          </g>
        ))}
      <circle cx={x(last.day)} cy={y(last.credits)} r={5} className="dot now" />
      <text x={Math.min(x(last.day) + 8, width - 130)} y={y(last.credits) - 8}>{`${dayLabel(last.day)} 잔액 ${n(last.credits)}`}</text>
      {projection ? (
        <>
          <line x1={x(last.day)} y1={y(last.credits)} x2={x(projection.depleteDay)} y2={y(0)} className="projection" />
          <text x={Math.min(x(projection.depleteDay), width - pad.r) - 4} y={y(0) - 6} textAnchor="end" className="warn">
            {`이 속도면 ${dayLabel(projection.depleteDay)} 소진 (하루 ${n(projection.perDay)} cr)`}
          </text>
        </>
      ) : null}
      <text x={x(firstDay)} y={height - 8}>{dayLabel(firstDay)}</text>
      <text x={x(last.day)} y={height - 8} textAnchor="middle">{dayLabel(last.day)}</text>
    </svg>
  );
}

function dayIndex(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export function CreditPoolSection({
  scope,
  workspaceId,
  reloadSignal = 0,
  canAdjust = false,
  focusMember = null,
}: {
  scope: "all" | "mine";
  workspaceId?: string;
  reloadSignal?: number;
  /** '추정' 맞추기 단추 — 저장(PUT credit-plan)은 전역 create_project 라 read_all 만 있는 열람자에겐 숨긴다(눌러도 403). */
  canAdjust?: boolean;
  /** 대시보드에서 멤버를 고른 상태 — 이 카드의 숫자는 **워크스페이스 전체**라는 것을 밝히려고 받는다
   *  (사람별 몫은 관리 표 '크레딧' 시트에 있다). 고른 사람에 맞춰 숫자를 바꾸지 않는다. */
  focusMember?: { uid: string | null; name: string | null } | null;
}) {
  const [view, setView] = useState<CreditPlanView | null>(null);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState(false);
  const [tick, setTick] = useState(0); // '추정 맞추기' 저장 뒤 다시 읽기
  const [adjust, setAdjust] = useState<{ id: string; value: string; busy: boolean; error: string } | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setView(null);
      return;
    }
    let active = true;
    manageApi.creditPlan(workspaceId)
      .then((next) => {
        if (!active) return;
        setView(next);
        setError("");
        setHidden(false);
      })
      .catch((reason) => {
        if (!active) return;
        // 구서버(라우트 없음)·소속 아님(403)은 구역 자체를 숨긴다 — 오류 배너로 대시보드를 어지럽히지 않는다.
        if (isRouteMissing(reason) || isHttpStatus(reason, 403)) {
          setHidden(true);
          return;
        }
        setError(`크레딧 풀을 불러오지 못했습니다. ${String(reason)}`);
      });
    return () => { active = false; };
  }, [workspaceId, reloadSignal, tick]);

  // '추정' → 힉스필드 관리 창의 남은 양을 적어 우리 계산을 그 값에 맞춘다(그룹 재기준화, 배정·다른 그룹은 그대로).
  const submitAdjust = async () => {
    if (!view || !adjust || !workspaceId || adjust.busy) return;
    const digits = adjust.value.replace(/[^\d-]/g, "");
    if (!digits || !Number.isInteger(Number(digits))) {
      setAdjust({ ...adjust, error: "정수로 입력" });
      return;
    }
    setAdjust({ ...adjust, busy: true, error: "" });
    try {
      await manageApi.saveCreditPlan(workspaceId, overrideBody(view, adjust.id, Number(digits)));
      setAdjust(null);
      setTick((value) => value + 1);
    } catch (reason) {
      setAdjust({
        ...adjust,
        busy: false,
        error: isHttpStatus(reason, 409) ? "설정이 바뀜 — 새로고침 뒤 다시" : `실패: ${String(reason).replace(/^Error:\s*/, "")}`,
      });
    }
  };
  const adjustFor = (groupId: string): AdjustState => ({
    open: adjust?.id === groupId,
    value: adjust?.id === groupId ? adjust.value : "",
    busy: adjust?.id === groupId ? adjust.busy : false,
    error: adjust?.id === groupId ? adjust.error : "",
    onOpen: () => setAdjust({ id: groupId, value: "", busy: false, error: "" }),
    onChange: (value) => setAdjust((current) => (current && current.id === groupId ? { ...current, value: value.replace(/[^\d-]/g, "").replace(/\B(?=(\d{3})+(?!\d))/g, ","), error: "" } : current)),
    onSubmit: () => { void submitAdjust(); },
    onCancel: () => setAdjust(null),
  });

  if (!workspaceId || hidden) return null;
  if (error) return <div className="usage-error">{error}</div>;
  if (!view) return null;

  if (scope === "mine") {
    const mine = view.my_group;
    // 구서버는 몫 계약을 모른다 — 키가 아예 없으면(undefined) '몫 없음(null)'과 구분해 안내한다.
    const quotaUnsupported = Boolean(mine) && mine!.my_quota_source === undefined;
    return (
      <div className="usage-card credit-card">
        <div className="usage-card-head">
          <div><h3>내 크레딧 · {monthLabel(view.month)}</h3></div>
          <span>내 몫은 이번 기간 기준 · 그룹 이월은 따로 표시</span>
        </div>
        {!mine ? (
          <div className="credit-scope-note">
            {view.configured ? "아직 그룹에 배정되지 않았습니다. 매니저에게 요청하세요." : "이 워크스페이스에는 아직 크레딧 그룹이 설정되지 않았습니다."}
          </div>
        ) : (
          <div className="credit-pool-grid mine">
            <div><span>그룹</span><strong>{mine.name}</strong><em>{mine.member_count}명</em></div>
            {/* 내 몫 = 그룹 한도를 사람 수로 나눈 값(매니저가 덮어썼으면 그 값). 이번 기간 기준이라
                그룹 이월은 섞지 않고 아래 '그룹 여유분'으로 따로 보여 준다. */}
            <div>
              <span>내 몫 {periodSuffix(mine.limit_period)}</span>
              {/* ★구서버(이 계약을 모르는 서버)는 `my_quota_source` 키 자체가 없다. 그때 null 을 '제한 없음'으로
                  읽으면 몫이 없는 것처럼 보인다 — 서버 업데이트가 필요하다고 밝힌다(Codex 코드 리뷰). */}
              <strong>
                {quotaUnsupported ? "—" : mine.my_quota == null ? "제한 없음" : cr(mine.my_quota)}
              </strong>
              <em>
                {quotaUnsupported
                  ? "서버 업데이트 뒤 표시됩니다"
                  : mine.my_quota_source === "manual"
                    ? "따로 정해진 몫"
                    : mine.my_quota_source === "auto"
                      ? `그룹 한도 ${mine.monthly_limit == null ? "∞" : cr(mine.monthly_limit)} ÷ ${mine.member_count}명`
                      : "그룹 한도 없음"}
              </em>
            </div>
            <div>
              <span>{periodUsageLabel(mine.limit_period)} 내 사용</span>
              <strong>{cr(mine.my_used_period ?? mine.my_used_month)}</strong>
              <em>
                그룹 전체 {cr(mine.used_period ?? mine.used_month)}
                {(mine.my_unknown_period ?? mine.my_unknown_month) ? ` · 미상 ${mine.my_unknown_period ?? mine.my_unknown_month}건` : ""}
              </em>
            </div>
            <div className={`left tone-${remainingTone(mine.my_remaining ?? null, mine.my_quota ?? null)}`}>
              <span>내 남은 몫</span>
              <strong>{quotaUnsupported ? "—" : mine.my_remaining == null ? "∞" : cr(mine.my_remaining)}</strong>
              <em>
                {mine.my_remaining != null && mine.my_remaining < 0
                  ? `내 몫보다 ${cr(Math.abs(mine.my_remaining))} 더 썼습니다`
                  : mine.group_carryover
                    ? `그룹 여유분 ${cr(mine.group_carryover)} 따로 있음`
                    : mine.estimated ? `미상 ${mine.unknown_since_base}건 섞임 · 추정` : "팀 기록 장부 기준"}
              </em>
            </div>
          </div>
        )}
      </div>
    );
  }

  const pool = view.pool;
  const groups = view.groups || [];
  const unassigned = view.unassigned;
  const total = limitTotal(groups);
  const topups = view.topups || [];
  const poolIn = pool ? (pool.monthly_topup ?? 0) + (pool.topups_month?.credits ?? 0) : 0;
  const overTopup = pool?.monthly_topup != null && total > poolIn;
  return (
    <>
      <div className="usage-card credit-card">
        <div className="usage-card-head">
          <div>
            <h3>크레딧 풀 · {cycleLabel(view, pool?.topup_day)}</h3>
            {focusMember ? (
              <span className="credit-scope-hint">
                {`인원 · ${focusMember.name || "이름 없는 멤버"} 을(를) 고른 중 — 이 카드는 워크스페이스 전체이고, 사람별 몫은 관리 표 '크레딧' 에 있습니다`}
              </span>
            ) : null}
          </div>
          <span>{view.configured ? `월 충전=예산 한도(매월 ${pool?.topup_day ?? 1}일 기준) · 잔액은 힉스필드 보고 · 사용은 팀 기록 장부` : "프로젝트 설정에서 예산 한도(매월)와 그룹을 적으면 채워집니다"}</span>
        </div>
        {pool ? (
          <div className="credit-pool-grid">
            <div>
              <span>월 충전 (예산 한도 · 매월 {pool.topup_day ?? 1}일)</span>
              <strong>{pool.monthly_topup == null ? "—" : cr(pool.monthly_topup)}</strong>
              <em>{pool.monthly_topup == null ? "매월 예산 한도 없음" : "프로젝트 예산 한도 합 · 이월됨"}</em>
            </div>
            <div className={pool.topups_month?.count ? "tone-warn" : ""}>
              <span>긴급 충전 ({cycleLabel(view, pool.topup_day)})</span>
              <strong>{pool.topups_month?.count ? `+${n(pool.topups_month.credits)} cr` : "없음"}</strong>
              <em>{pool.topups_month?.count ? `${pool.topups_month.count}회 · 아래 기록` : "정기 충전 밖 추가 충전"}</em>
            </div>
            <div>
              <span>{cycleLabel(view, pool.topup_day)} 사용 (팀 기록 장부)</span>
              <strong>{cr(pool.used_month)}</strong>
              <em>{pool.unknown_month ? `미상 ${pool.unknown_month}건 제외 · 미분류 포함` : "미분류 포함"}</em>
            </div>
            <div className="left">
              <span>현재 잔액 (힉스필드 보고)</span>
              <strong>{cr(pool.balance)}</strong>
              <em>{seenText(pool.balance_seen_at)}</em>
            </div>
            <div>
              <span>월초 잔액 (관측)</span>
              <strong>{cr(pool.month_start_balance)}</strong>
              <em>{pool.month_start_day ? `${dayLabel(pool.month_start_day)} 첫 관측값 · 지난달에서 넘어온 몫` : `${cycleLabel(view, pool.topup_day)} 관측 없음`}</em>
            </div>
          </div>
        ) : null}
        {topups.length ? (
          <div className="credit-topup-list">
            <span className="credit-topup-list-head">긴급 충전 기록 · 최근 3개월</span>
            {topups.map((topup) => (
              <span className="credit-topup-item" key={topup.id}>
                <b>{dayLabel(topup.day)}</b> +{n(topup.credits)} cr{topup.note ? <i> · {topup.note}</i> : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="usage-card credit-card">
        <div className="usage-card-head">
          <div><h3>그룹별 한도 · {cycleLabel(view, pool?.topup_day)}</h3></div>
          <span>
            {groups.length
              ? `${groups.length}그룹 · 한도 합 ${n(total)}${overTopup ? ` (충전 ${n(pool?.monthly_topup)} 초과 — 경고만)` : ""}`
              : "그룹 없음"}
          </span>
        </div>
        <div className="usage-table-scroll">
          <table className="usage-table credit-group-table">
            <thead>
              <tr><th>그룹</th><th>인원</th><th>한도</th><th>1인 몫</th><th>기간 사용</th><th>남음</th><th>사용률</th></tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.id}>
                  <td><b>{group.name}</b></td>
                  <td className="tnum">{group.member_count}</td>
                  <td className="tnum">{group.monthly_limit == null ? "∞" : `${n(group.monthly_limit)} ${periodSuffix(group.limit_period)}`}</td>
                  {/* 1인 몫 = (한도 − 직접 정한 몫들) ÷ 나머지 인원. 직접 정한 사람이 있으면 그 합도 알려 준다. */}
                  <td className="tnum">
                    {autoShareLabel(group.quota_auto)}
                    {group.quota_fixed ? (
                      <span className={`credit-est${group.quota_over ? " bad" : ""}`}>
                        {` · 직접 ${n(group.quota_fixed)}${group.quota_over ? " (한도 초과)" : ""}`}
                      </span>
                    ) : null}
                  </td>
                  <td className="tnum">
                    {n(group.used_period ?? group.used_month)}
                    <span className="credit-est"> {periodUsageLabel(group.limit_period)}{(group.unknown_period ?? group.unknown_month) ? ` · 미상 ${group.unknown_period ?? group.unknown_month}` : ""}</span>
                  </td>
                  <GroupRemaining group={group} adjust={canAdjust ? adjustFor(group.id) : undefined} />
                </tr>
              ))}
              {unassigned && (unassigned.member_count > 0 || unassigned.used_month > 0) ? (
                <tr className="credit-unassigned">
                  <td><b>그룹 없음</b> <span className="credit-est bad">배정 안 됨 — 힉스필드 그룹과 대조 필요</span></td>
                  <td className="tnum">{unassigned.member_count}</td>
                  <td className="tnum">—</td>
                  <td className="tnum">—</td>
                  <td className="tnum">{n(unassigned.used_month)}{unassigned.unknown_month ? <span className="credit-est"> · 미상 {unassigned.unknown_month}</span> : null}</td>
                  <td className="tnum">—</td>
                  <td><span className="credit-pct tone-bad">!</span></td>
                </tr>
              ) : null}
              {!groups.length && !(unassigned && (unassigned.member_count > 0 || unassigned.used_month > 0)) ? (
                <tr><td colSpan={7} className="usage-inline-state">프로젝트 설정 → 크레딧 풀 · 그룹에서 힉스필드 User Group 과 같은 이름으로 만드세요.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="credit-scope-note">사용량은 이 워크스페이스에서 쓴 전부(프로젝트 폴더 미배정 포함). 힉스필드가 한도를 강제하므로 여기서는 보여주고 경고만 합니다.</div>
      </div>

      <div className="usage-card credit-card usage-chart-card">
        <div className="usage-card-head">
          <div><h3>잔액 추이 · 최근 60일</h3></div>
          <span>{`관측 ${view.history?.length || 0}일 · 매달 1일 세로선 · 늘어난 곳=충전(관측) · 점선=최근 7일 속도 예상`}</span>
        </div>
        <BalanceChart history={view.history || []} month={view.month} cycleStart={view.cycle_start} topups={topups} />
      </div>
    </>
  );
}
