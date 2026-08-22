import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  manageApi,
  type TeamModelRow,
  type TeamOverview,
  type TeamProjectRow,
  type TeamWorkerRow,
} from "../../lib/manageApi";
import { modelDisplayName as modelLabel, useModelDisplayName } from "../../lib/modelCatalog";
import {
  buildHfUsageCsv,
  groupOutputCredits,
  groupOutputModels,
  HF_USAGE_REPORT_FILENAME,
  inferOutputModels,
  splitUsageFolderPath,
  type OutputCreditCategory,
  type OutputModelUsage,
} from "../../lib/usageReport";
import { paginateUsageItems, USAGE_PAGE_SIZES } from "../../lib/usagePagination";
import { groupModelRows } from "../../lib/usageModelIndex";
import { reconcileArrayState, reconcileValueState } from "../../lib/stateReconciliation";
import { workspaceCommandLabels } from "../../lib/workspaceCommand";
import {
  fillUsageTrendBuckets,
  formatUsageTrendBucket,
  getUsagePeriodRange,
  showUsageTrendLabel,
  type UsagePeriodUnit,
} from "../../lib/usagePeriod";
import type { WorkspaceOption } from "../../types";
import { UsagePeriodPicker } from "./UsagePeriodPicker";

type Metric = "credits" | "count";
type TooltipMetric = Metric | "both" | "final" | "yield";
type ModelTooltipRow = Pick<TeamModelRow, "model" | "count" | "credits"> & {
  final_count?: number;
};

function n(value: number): string {
  return Math.round(value || 0).toLocaleString();
}

function credits(value: number): string {
  const rounded = Math.round((value || 0) * 100) / 100;
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function chartScaleMax(value: number): number {
  if (value <= 0) return 0;
  const rawStep = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const niceStep = normalized <= 1 ? 1
    : normalized <= 2 ? 2
      : normalized <= 2.5 ? 2.5
        : normalized <= 5 ? 5
          : 10;
  return niceStep * magnitude * 4;
}

function shortName(value: string | null | undefined, fallback: string): string {
  return (value || "").trim() || fallback;
}

function ModelTooltip({
  id,
  rows,
  metric,
  triggerRect,
  title,
}: {
  id: string;
  rows: ModelTooltipRow[];
  metric: TooltipMetric;
  triggerRect: DOMRect;
  title?: string;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const bounds = tooltip.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(
      margin,
      Math.min(triggerRect.right - bounds.width, window.innerWidth - bounds.width - margin),
    );
    const above = triggerRect.top - bounds.height - margin;
    const top = above >= margin
      ? above
      : Math.min(triggerRect.bottom + margin, window.innerHeight - bounds.height - margin);
    setPosition({ left, top: Math.max(margin, top), ready: true });
  }, [rows.length, triggerRect]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      className="usage-tooltip usage-tooltip-portal"
      role="tooltip"
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      {title && <strong className="usage-tooltip-title">{title}</strong>}
      {rows.length ? rows.map((row) => (
        <span key={row.model}>
          <b>{modelLabel(row.model)}</b>
          <em>
            {metric === "both"
              ? `${n(row.count)}개 · ${credits(row.credits)} cr`
              : metric === "credits"
                ? `${credits(row.credits)} cr`
                : metric === "final"
                  ? `${n(row.final_count || 0)}개`
                  : metric === "yield"
                    ? `${n(row.final_count || 0)} / ${n(row.count)} · ${row.count ? (((row.final_count || 0) / row.count) * 100).toFixed(1) : "0.0"}%`
                    : `${n(row.count)}개`}
          </em>
        </span>
      )) : <span>모델 세부정보 없음</span>}
    </div>,
    document.body,
  );
}

export function HoverMetric({
  value,
  rows,
  metric,
  title,
  suffix = "",
}: {
  value: number;
  rows: ModelTooltipRow[];
  metric: TooltipMetric;
  title?: string;
  suffix?: string;
}) {
  const tooltipId = useId();
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const showTooltip = (element: HTMLElement) => setTriggerRect(element.getBoundingClientRect());
  const formattedValue = metric === "credits" || metric === "both"
    ? credits(value)
    : metric === "yield"
      ? `${value.toFixed(1)}%`
      : n(value);
  const displayValue = `${formattedValue}${suffix}`;
  if (!rows.length) {
    return <span className="usage-hover-metric no-detail">{displayValue}</span>;
  }
  return (
    <span
      className="usage-hover-metric"
      tabIndex={0}
      aria-describedby={triggerRect ? tooltipId : undefined}
      onMouseEnter={(event) => showTooltip(event.currentTarget)}
      onMouseLeave={() => setTriggerRect(null)}
      onFocus={(event) => showTooltip(event.currentTarget)}
      onBlur={() => setTriggerRect(null)}
    >
      {displayValue}
      {triggerRect && (
        <ModelTooltip id={tooltipId} rows={rows} metric={metric} triggerRect={triggerRect} title={title} />
      )}
    </span>
  );
}

function OutputLegendButton({
  row,
  models,
  ringActive,
}: {
  row: OutputCreditCategory;
  models: OutputModelUsage[];
  ringActive: boolean;
}) {
  const tooltipId = useId();
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const showTooltip = (element: HTMLElement) => setTriggerRect(element.getBoundingClientRect());

  return (
    <button
      type="button"
      className={`${ringActive || triggerRect ? "on" : ""}${row.count === 0 ? " empty" : ""}`}
      aria-label={`${row.label} 모델별 상세 · 총 ${n(row.count)}개 · ${credits(row.credits)} 크레딧`}
      aria-describedby={triggerRect ? tooltipId : undefined}
      onMouseEnter={(event) => showTooltip(event.currentTarget)}
      onMouseLeave={() => setTriggerRect(null)}
      onFocus={(event) => showTooltip(event.currentTarget)}
      onBlur={() => setTriggerRect(null)}
    >
      <i style={{ background: row.color }} />{row.label}
      {triggerRect && (
        <ModelTooltip
          id={tooltipId}
          rows={models}
          metric="both"
          triggerRect={triggerRect}
          title={`${row.label} 모델`}
        />
      )}
    </button>
  );
}

function UsageCreditRing({
  rows,
  outputModels,
  fallbackModels,
  totalCredits,
}: {
  rows: TeamOverview["by_output_type"];
  outputModels: TeamOverview["output_models"];
  fallbackModels: TeamOverview["by_model"];
  totalCredits: number;
}) {
  const [activeKey, setActiveKey] = useState<OutputCreditCategory["key"] | null>(null);
  const categories = useMemo(() => groupOutputCredits(rows || []), [rows]);
  const modelsByCategory = useMemo(
    () => groupOutputModels(outputModels?.length ? outputModels : inferOutputModels(fallbackModels || [])),
    [fallbackModels, outputModels],
  );
  const creditTotal = categories.reduce((sum, row) => sum + row.credits, 0);
  const countTotal = categories.reduce((sum, row) => sum + row.count, 0);
  const basisTotal = creditTotal || countTotal || 1;
  const active = categories.find((row) => row.key === activeKey) || null;
  const activeShare = active
    ? ((creditTotal ? active.credits : active.count) / basisTotal) * 100
    : 0;
  const radius = 58;
  const circumference = 2 * Math.PI * radius;
  let cursor = 0;
  const segments = categories.map((row) => {
    const basis = creditTotal ? row.credits : row.count;
    const share = basis / basisTotal;
    const start = cursor;
    cursor += share;
    return { row, share, start };
  });

  return (
    <div className="usage-credit-ring">
      <div className="usage-ring-visual">
        <svg viewBox="0 0 160 160" aria-label="결과 유형별 크레딧 비율">
          <circle className="usage-ring-track" cx="80" cy="80" r={radius} />
          {segments.filter((segment) => segment.share > 0).map(({ row, share, start }) => {
            const length = Math.max(0, share * circumference - 3);
            return (
              <circle
                key={row.key}
                className={`usage-ring-segment${activeKey && activeKey !== row.key ? " dim" : ""}`}
                cx="80"
                cy="80"
                r={radius}
                stroke={row.color}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-start * circumference}
                transform="rotate(-90 80 80)"
                tabIndex={0}
                aria-label={`${row.label} ${credits(row.credits)} 크레딧 ${(share * 100).toFixed(1)} 퍼센트`}
                onMouseEnter={() => setActiveKey(row.key)}
                onMouseLeave={() => setActiveKey(null)}
                onFocus={() => setActiveKey(row.key)}
                onBlur={() => setActiveKey(null)}
              />
            );
          })}
        </svg>
        <div className="usage-ring-center">
          <strong>{credits(active ? active.credits : totalCredits)}</strong>
          <span className={active ? "active" : ""}>{active ? `${activeShare.toFixed(1)}%` : "Credits spent"}</span>
        </div>
      </div>
      <div className="usage-type-legend">
        {categories.map((row) => (
          <OutputLegendButton
            key={row.key}
            row={row}
            models={modelsByCategory[row.key]}
            ringActive={activeKey === row.key}
          />
        ))}
      </div>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M10 3v8m0 0 3-3m-3 3L7 8M4 13v3h12v-3" />
    </svg>
  );
}

interface PaginationState {
  page: number;
  pageSize: number;
  scope: string;
}

function useUsagePagination<T>(items: T[], scope: string) {
  const [state, setState] = useState<PaginationState>({
    page: 1,
    pageSize: USAGE_PAGE_SIZES[0],
    scope,
  });
  const requestedPage = state.scope === scope ? state.page : 1;
  const result = paginateUsageItems(items, requestedPage, state.pageSize);

  return {
    ...result,
    setPage: (page: number) => setState((current) => ({ ...current, page, scope })),
    setPageSize: (pageSize: number) => setState({ page: 1, pageSize, scope }),
  };
}

function UsagePagination({
  label,
  page,
  pageSize,
  totalPages,
  onPageChange,
  onPageSizeChange,
}: {
  label: string;
  page: number;
  pageSize: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  return (
    <footer className="usage-pagination">
      <label>
        <span>Show</span>
        <select
          aria-label={`${label} 표시 개수`}
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          {USAGE_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      <span className="usage-page-status">Page {page} of {totalPages}</span>
      <div className="usage-page-buttons">
        <button
          type="button"
          aria-label={`${label} 이전 페이지`}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >‹</button>
        <button
          type="button"
          aria-label={`${label} 다음 페이지`}
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >›</button>
      </div>
    </footer>
  );
}

function DrillLabel({
  project,
  worker,
  onClear,
}: {
  project: TeamProjectRow | null;
  worker: TeamWorkerRow | null;
  onClear: () => void;
}) {
  if (!project && !worker) return <span className="usage-chart-scope">워크스페이스 전체</span>;
  return (
    <button type="button" className="usage-drill-chip" onClick={onClear} title="전체로 돌아가기">
      {worker
        ? `인원 · ${shortName(worker.creator_name, "이름 없는 멤버")}`
        : `프로젝트 · ${shortName(project?.project_name, "미분류")}`}
      <span>×</span>
    </button>
  );
}

export function WorkspaceUsageDashboard({
  reloadSignal = 0,
  canCreateProject = false,
  onCreateProject,
  workspaceId = "",
  onWorkspaceIdChange,
}: {
  reloadSignal?: number;
  canCreateProject?: boolean;
  onCreateProject?: () => void;
  workspaceId?: string;
  onWorkspaceIdChange?: (workspaceId?: string) => void;
}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [chartPeriodUnit, setChartPeriodUnit] = useState<UsagePeriodUnit>("week");
  const [chartAnchorDate, setChartAnchorDate] = useState(() => new Date());
  const [chartMetric, setChartMetric] = useState<Metric>("credits");
  const [chartModel, setChartModel] = useState("");
  const [overview, setOverview] = useState<TeamOverview | null>(null);
  const [drillSnapshot, setDrillSnapshot] = useState<{ key: string; data: TeamOverview } | null>(null);
  const [drillErrorKey, setDrillErrorKey] = useState("");
  const [trend, setTrend] = useState<{ bucket: string; count: number; credits: number }[]>([]);
  const [selectedWorker, setSelectedWorker] = useState<TeamWorkerRow | null>(null);
  const [selectedProject, setSelectedProject] = useState<TeamProjectRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const modelDisplayName = useModelDisplayName();

  const chartRange = useMemo(
    () => getUsagePeriodRange(chartPeriodUnit, chartAnchorDate),
    [chartAnchorDate, chartPeriodUnit],
  );
  const selectedCreatorFilter = selectedWorker
    ? selectedWorker.creator_uid || "__none__"
    : undefined;
  const selectedProjectFilter = selectedProject
    ? selectedProject.project_id || "__none__"
    : undefined;
  // 표시·페이지네이션 scope 에는 reloadSignal 을 넣지 않는다 — 30초 안전망 갱신마다
  // 페이지가 1로 튕기고 드릴 스냅샷이 무효화되던 문제. 조회(fetch) effect 만 reloadSignal 로 재실행.
  const baseScopeKey = `${workspaceId}`;
  const drillTargetKey = selectedWorker
    ? `worker:${selectedCreatorFilter}`
    : selectedProject
      ? `project:${selectedProjectFilter}`
      : "";
  const drillDisplayKey = drillTargetKey ? `${baseScopeKey}:${drillTargetKey}` : "";

  useEffect(() => {
    let active = true;
    manageApi.workspaces()
      .then((response) => {
        if (!active) return;
        const items = response.workspaces || [];
        // 30초 안전망 재조회의 동일 응답이 참조만 새로 와도 하위 트리를 다시 그리지 않게
        // 구조 동일이면 이전 상태를 유지한다(실측 hotspot — 하위 렌더 40% 낭비 차단).
        setWorkspaces((prev) => reconcileArrayState(prev, items));
      })
      .catch((reason) => active && setError(`사용량을 불러오지 못했습니다. ${String(reason)}`));
    // loading 은 overview 조회만 소유한다 — 가벼운 workspaces 응답이 먼저 와서 로딩을 끄면
    // 아직 수치가 없는 빈 패널("팀 워크스페이스 없음")이 잠깐 떠 오안내가 된다.
    return () => { active = false; };
  }, [reloadSignal]);

  // 워크스페이스가 실제로 바뀔 때만 이전 공간 수치를 비운다 — 헤더는 새 공간인데 표는
  // 이전 공간이던 오표시 방지. 첫 마운트·30초 주기 재조회는 유지해 깜빡이지 않게.
  const overviewScopeRef = useRef(workspaceId);
  useEffect(() => {
    let active = true;
    if (overviewScopeRef.current !== workspaceId) {
      overviewScopeRef.current = workspaceId;
      setOverview(null);
    }
    setLoading(true);
    setError("");
    manageApi.teamOverview({ workspaceId: workspaceId || undefined })
      .then((nextOverview) => {
        if (!active) return;
        setOverview((prev) => reconcileValueState(prev, nextOverview));
      })
      .catch((reason) => active && setError(`사용량을 불러오지 못했습니다. ${String(reason)}`))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [reloadSignal, workspaceId]);

  useEffect(() => {
    if (!drillTargetKey) {
      setDrillSnapshot(null);
      setDrillErrorKey("");
      return;
    }
    let active = true;
    setDrillErrorKey("");
    manageApi.teamOverview({
      workspaceId: workspaceId || undefined,
      creatorUid: selectedCreatorFilter,
      projectId: selectedProjectFilter,
    })
      .then((response) => {
        if (active) setDrillSnapshot({ key: drillDisplayKey, data: response });
      })
      .catch(() => {
        if (active) setDrillErrorKey(drillDisplayKey);
      });
    return () => { active = false; };
    // reloadSignal: 같은 드릴 대상을 주기 재조회 — 성공 시 같은 표시 키로 교체되므로
    // 재조회 중에도 이전 스냅샷이 계속 표시된다(깜빡임 없음).
  }, [drillDisplayKey, drillTargetKey, reloadSignal, selectedCreatorFilter, selectedProjectFilter, workspaceId]);

  // 기간·필터·워크스페이스가 바뀌면 이전 차트가 잘못된 데이터라 비우고 다시 그린다.
  // 반면 reloadSignal(30초 안전망)만 바뀐 재조회는 이전 데이터를 유지한 채 성공 시 교체 —
  // 매 주기 공백→재표시로 깜빡이던 문제 방지. 실패 시에도 이전 데이터 유지.
  const trendDisplayKey = [
    workspaceId, chartModel, chartRange.bucket, chartRange.dateFrom, chartRange.dateTo,
    chartRange.timeFrom, chartRange.timeTo, selectedCreatorFilter, selectedProjectFilter,
  ].join("|");
  const trendKeyRef = useRef("");
  useEffect(() => {
    if (trendKeyRef.current !== trendDisplayKey) {
      trendKeyRef.current = trendDisplayKey;
      setTrend([]);
    }
    let active = true;
    manageApi.teamTimeseries(chartRange.bucket, {
      workspaceId: workspaceId || undefined,
      dateFrom: chartRange.dateFrom,
      dateTo: chartRange.dateTo,
      timeFrom: chartRange.timeFrom,
      timeTo: chartRange.timeTo,
      model: chartModel || undefined,
      creatorUid: selectedCreatorFilter,
      projectId: selectedProjectFilter,
    })
      .then((response) =>
        active && setTrend((prev) => reconcileArrayState(prev, response.buckets || [])))
      .catch(() => {});
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal, trendDisplayKey]);

  const workerModelIndex = useMemo(
    () => groupModelRows(overview?.worker_models, (row) => row.creator_uid),
    [overview?.worker_models],
  );
  const projectModelIndex = useMemo(
    () => groupModelRows(overview?.project_models, (row) => row.project_id),
    [overview?.project_models],
  );
  const workerModels = (uid: string | null) => workerModelIndex.get(uid) || [];
  const projectModels = (pid: string | null) => projectModelIndex.get(pid) || [];
  const displayedTrend = useMemo(
    () => fillUsageTrendBuckets(trend, chartRange),
    [chartRange, trend],
  );
  const maxTrend = Math.max(0, ...displayedTrend.map((row) => row[chartMetric] || 0));
  const trendScaleMax = chartScaleMax(maxTrend);
  const trendScaleTicks = Array.from({ length: 5 }, (_, index) => (
    (trendScaleMax * (4 - index)) / 4
  ));
  const scopedOverview = !drillTargetKey
    ? overview
    : drillSnapshot?.key === drillDisplayKey
      ? drillSnapshot.data
      : null;
  // 데이터가 이미 있으면 주기 재조회 실패를 실패 화면으로 승격하지 않는다(이전 데이터 유지).
  const drillFailed = Boolean(drillTargetKey && drillErrorKey === drillDisplayKey && !scopedOverview);
  const drillPending = Boolean(drillTargetKey && !scopedOverview && !drillFailed);
  const scopedModels = scopedOverview?.by_model || [];
  const scopedFolders = scopedOverview?.folder_efficiency || [];
  const maxModelCredits = Math.max(1, ...scopedModels.map((row) => row.credits));
  const totals = overview?.totals;
  const selectedWorkspace = workspaces.find((item) => item.id === workspaceId);
  const workspaceLabels = workspaceCommandLabels(workspaces);
  const paginationScope = baseScopeKey;
  const detailPaginationScope = drillDisplayKey || baseScopeKey;
  const memberPage = useUsagePagination(overview?.by_worker || [], paginationScope);
  const projectPage = useUsagePagination(overview?.by_project || [], paginationScope);
  const modelPage = useUsagePagination(scopedModels, detailPaginationScope);
  const folderPage = useUsagePagination(scopedFolders, detailPaginationScope);

  const clearDrill = () => {
    setSelectedWorker(null);
    setSelectedProject(null);
  };

  const exportCsv = async () => {
    if (!overview || exporting) return;
    setExporting(true);
    setError("");
    try {
      const response = await manageApi.usageExport({
        workspaceId: workspaceId || undefined,
      });
      const csv = buildHfUsageCsv(response.rows || [], modelDisplayName);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = HF_USAGE_REPORT_FILENAME;
      anchor.style.display = "none";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setError(`사용량 보고서를 만들지 못했습니다. ${String(reason)}`);
    } finally {
      setExporting(false);
    }
  };

  const projectCreateButton = canCreateProject && onCreateProject ? (
    <button
      type="button"
      className="usage-project-button"
      onClick={onCreateProject}
      title="프로젝트 생성·멤버·역할 관리"
    >
      + 프로젝트
    </button>
  ) : null;

  if (!loading && !workspaces.length && !overview) {
    return (
      <section className="usage-dashboard usage-empty">
        <header className="usage-head">
          <h2>워크스페이스 사용 현황</h2>
          <div className="usage-actions">{projectCreateButton}</div>
        </header>
        {error ? (
          // 조회 실패(권한·구버전 서버 404 등)를 "워크스페이스 없음"으로 위장하지 않는다.
          <p className="usage-error">{error}</p>
        ) : (
          <p>아직 에이전트가 보고한 팀 워크스페이스가 없습니다. 멤버가 에이전트를 한 번 동기화하면 표시됩니다.</p>
        )}
      </section>
    );
  }

  return (
    <section className="usage-dashboard">
      <header className="usage-head">
        <div className="usage-title">
          <span className="usage-avatar">{(selectedWorkspace?.name || "전체").slice(0, 1).toUpperCase()}</span>
          <div>
            <select
              aria-label="워크스페이스 선택"
              value={workspaceId}
              onChange={(event) => {
                onWorkspaceIdChange?.(event.target.value || undefined);
                setChartModel("");
                clearDrill();
              }}
            >
              <option value="">개인 · 전체 워크스페이스</option>
              {workspaceId && !workspaces.some((workspace) => workspace.id === workspaceId) ? (
                <option value={workspaceId}>선택 워크스페이스 ({workspaceId.slice(0, 8)})</option>
              ) : null}
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspaceLabels.get(workspace.id) ?? workspace.name}
                </option>
              ))}
            </select>
            <p>{selectedWorkspace?.member_count ?? totals?.workers ?? 0} members · 전체 기간</p>
            <p className="work-source-label">
              출처 · 에이전트 자동 보고(팀 텔레메트리 집계)
              {totals?.estimated_count ? (
                <span title="실제 차감액이 확인되지 않은 생성물 수 — 견적값이 있으면 그 값으로 합산됩니다">
                  {` · 실제 크레딧 미매칭 ${n(totals.estimated_count)}건`}
                </span>
              ) : null}
            </p>
          </div>
        </div>
        <div className="usage-actions">
          {projectCreateButton}
          <button
            type="button"
            className="usage-export-button"
            onClick={exportCsv}
            disabled={!overview || exporting}
          >
            <DownloadIcon />{exporting ? "Exporting…" : "Export usage report"}
          </button>
        </div>
      </header>

      {error && <div className="usage-error">{error}</div>}
      {loading && !overview ? <div className="usage-loading">사용량 계산 중…</div> : null}
      {overview && totals ? (
        <>
          <div className="usage-overview">
            <UsageCreditRing
              rows={overview.by_output_type || []}
              outputModels={overview.output_models || []}
              fallbackModels={overview.by_model || []}
              totalCredits={totals.credits}
            />
            <div className="usage-stat-grid">
              <div><span>총 생성</span><strong>{n(totals.count)}</strong></div>
              <div><span>멤버</span><strong>{n(totals.workers)}</strong></div>
              <div><span>사용 모델</span><strong>{n(totals.models)}</strong></div>
              <div><span>최종 선택</span><strong>{n(totals.final_count)}</strong></div>
              <div><span>인원당 평균 생성</span><strong>{totals.workers ? n(totals.count / totals.workers) : "0"}</strong></div>
              <div><span>생성당 평균 크레딧</span><strong>{totals.count ? credits(totals.credits / totals.count) : "0"}</strong></div>
            </div>
          </div>

          <div className="usage-two-columns">
            <div className="usage-card">
              <div className="usage-card-head"><h3>멤버 사용량</h3><span>{overview.by_worker.length}명</span></div>
              <div className="usage-table-scroll">
                <table className="usage-table">
                  <thead><tr><th>멤버</th><th>생성 수</th><th>크레딧</th><th>최종</th></tr></thead>
                  <tbody>{memberPage.items.map((row) => (
                    <tr key={row.creator_uid || "unknown"} onClick={() => { setSelectedWorker(row); setSelectedProject(null); }}>
                      <td>{shortName(row.creator_name, "이름 없는 멤버")}</td>
                      <td><HoverMetric value={row.count} rows={workerModels(row.creator_uid)} metric="count" /></td>
                      <td><HoverMetric value={row.credits} rows={workerModels(row.creator_uid)} metric="credits" /></td>
                      <td>{n(row.final_count)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <UsagePagination
                label="멤버 사용량"
                page={memberPage.page}
                pageSize={memberPage.pageSize}
                totalPages={memberPage.totalPages}
                onPageChange={memberPage.setPage}
                onPageSizeChange={memberPage.setPageSize}
              />
            </div>
            <div className="usage-card">
              <div className="usage-card-head">
                <div><h3>모델 크레딧</h3><DrillLabel project={selectedProject} worker={selectedWorker} onClear={clearDrill} /></div>
              </div>
              <div className="usage-model-list">
                {drillPending && <div className="usage-inline-state">선택한 사용량 계산 중…</div>}
                {drillFailed && <div className="usage-inline-state error">선택한 사용량을 불러오지 못했습니다.</div>}
                {!drillPending && !drillFailed && modelPage.items.map((row) => (
                  <div key={row.model} title={`${row.model} · ${n(row.count)}개 · ${credits(row.credits)} cr`}>
                    <span>{modelDisplayName(row.model)}</span><i><b style={{ width: `${(row.credits / maxModelCredits) * 100}%` }} /></i><em>{credits(row.credits)} cr</em>
                  </div>
                ))}
                {!drillPending && !drillFailed && !modelPage.items.length && (
                  <div className="usage-inline-state">표시할 모델 사용량이 없습니다.</div>
                )}
              </div>
              <UsagePagination
                label="모델 크레딧"
                page={modelPage.page}
                pageSize={modelPage.pageSize}
                totalPages={modelPage.totalPages}
                onPageChange={modelPage.setPage}
                onPageSizeChange={modelPage.setPageSize}
              />
            </div>
          </div>

          <div className="usage-two-columns">
            <div className="usage-card">
              <div className="usage-card-head"><h3>프로젝트 사용량</h3><span>{overview.by_project.length}개</span></div>
              <div className="usage-table-scroll">
                <table className="usage-table">
                  <thead><tr><th>프로젝트</th><th>생성 수</th><th>크레딧</th><th>최종</th></tr></thead>
                  <tbody>{projectPage.items.map((row) => (
                    <tr key={row.project_id || "none"} onClick={() => { setSelectedProject(row); setSelectedWorker(null); }}>
                      <td>{shortName(row.project_name, "미분류")}</td>
                      <td><HoverMetric value={row.count} rows={projectModels(row.project_id)} metric="count" /></td>
                      <td><HoverMetric value={row.credits} rows={projectModels(row.project_id)} metric="credits" /></td>
                      <td>{n(row.final_count)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <UsagePagination
                label="프로젝트 사용량"
                page={projectPage.page}
                pageSize={projectPage.pageSize}
                totalPages={projectPage.totalPages}
                onPageChange={projectPage.setPage}
                onPageSizeChange={projectPage.setPageSize}
              />
            </div>
            <div className="usage-card">
              <div className="usage-card-head">
                <div><h3>Yield</h3><DrillLabel project={selectedProject} worker={selectedWorker} onClear={clearDrill} /></div>
              </div>
              <div className="usage-table-scroll">
                <table className="usage-table usage-folder-table">
                  <thead><tr><th>프로젝트</th><th>에피소드</th><th>씬</th><th>생성/최종</th><th>Yield</th></tr></thead>
                  <tbody>
                    {drillPending && <tr><td colSpan={5} className="usage-inline-state">선택한 사용량 계산 중…</td></tr>}
                    {drillFailed && <tr><td colSpan={5} className="usage-inline-state error">선택한 사용량을 불러오지 못했습니다.</td></tr>}
                    {!drillPending && !drillFailed && folderPage.items.map((row) => {
                      const levels = splitUsageFolderPath(row.folder_path);
                      return (
                        <tr key={`${row.project_id || "none"}:${row.folder_path}`}>
                          <td>{shortName(row.project_name, "미분류")}</td>
                          <td>{shortName(row.episode, levels.episode)}</td>
                          <td>{shortName(row.scene, levels.scene)}</td>
                          <td>{n(row.count)} / {n(row.final_count)}</td>
                          <td><span className="usage-score">{(row.yield_percent ?? row.final_rate_tenths * 10).toFixed(1)}%</span></td>
                        </tr>
                      );
                    })}
                    {!drillPending && !drillFailed && !folderPage.items.length && (
                      <tr><td colSpan={5} className="usage-inline-state">표시할 Yield 데이터가 없습니다.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <UsagePagination
                label="Yield"
                page={folderPage.page}
                pageSize={folderPage.pageSize}
                totalPages={folderPage.totalPages}
                onPageChange={folderPage.setPage}
                onPageSizeChange={folderPage.setPageSize}
              />
            </div>
          </div>

          <div className="usage-card usage-chart-card">
            <div className="usage-card-head">
              <div><h3>기간별 사용량</h3><DrillLabel project={selectedProject} worker={selectedWorker} onClear={clearDrill} /></div>
              <div className="usage-chart-filters">
                <UsagePeriodPicker
                  unit={chartPeriodUnit}
                  anchorDate={chartAnchorDate}
                  onUnitChange={setChartPeriodUnit}
                  onDateChange={setChartAnchorDate}
                />
                <select value={chartModel} onChange={(event) => setChartModel(event.target.value)} aria-label="그래프 모델 필터">
                  <option value="">모든 모델</option>
                  {(overview.by_model || []).filter((row) => row.model !== "알 수 없음").map((row) => (
                    <option key={row.model} value={row.model}>{modelDisplayName(row.model)}</option>
                  ))}
                </select>
                <div className="usage-segmented">
                  <button className={chartMetric === "credits" ? "on" : ""} onClick={() => setChartMetric("credits")}>크레딧</button>
                  <button className={chartMetric === "count" ? "on" : ""} onClick={() => setChartMetric("count")}>생성 수</button>
                </div>
              </div>
            </div>
            <div className={`usage-chart unit-${chartPeriodUnit}`}>
              <div className="usage-chart-scale" aria-hidden="true">
                {trendScaleTicks.map((tick, index) => (
                  <div key={`${index}-${tick}`}>
                    <span>{trendScaleMax
                      ? (chartMetric === "credits" ? credits(tick) : n(tick))
                      : index === trendScaleTicks.length - 1 ? "0" : ""}</span>
                    <i />
                  </div>
                ))}
              </div>
              <div className="usage-chart-bars">
                {displayedTrend.map((row, index) => {
                  const value = row[chartMetric] || 0;
                  return (
                    <div className="usage-chart-col" key={row.bucket} title={`${row.bucket} · ${chartMetric === "credits" ? `${credits(value)} cr` : `${n(value)}개`}`}>
                      <span>{value ? (chartMetric === "credits" ? credits(value) : n(value)) : ""}</span>
                      <i style={{ height: `${trendScaleMax ? Math.max(value ? 3 : 0, (value / trendScaleMax) * 100) : 0}%` }} />
                      <em>{showUsageTrendLabel(chartPeriodUnit, index, displayedTrend.length) ? formatUsageTrendBucket(row.bucket, chartPeriodUnit) : ""}</em>
                    </div>
                  );
                })}
                {!trend.length && <div className="usage-no-data">선택 기간에 사용 기록이 없습니다.</div>}
              </div>
            </div>
          </div>

        </>
      ) : null}
    </section>
  );
}
