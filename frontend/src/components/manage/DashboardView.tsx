// 통합 대시보드 — 상단 프로젝트 전체 요약, 하단 실제 폴더 기준 에피소드·시퀀스 사용량 구조.
// 프로젝트 클릭 → 에피소드 합계와 하위 시퀀스의 생성·최종·크레딧·시간·기간을 표시한다.
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { isHttpStatus } from "../../lib/http";
import { manageApi } from "../../lib/manageApi";
import { projectApi } from "../../lib/projectApi";
import { budgetPeriodLabel } from "../../lib/projectPlanning";
import { paginateUsageItems, USAGE_PAGE_SIZES } from "../../lib/usagePagination";
import {
  reconcileMapState,
  reconcileValueState,
} from "../../lib/stateReconciliation";
import type { ManageCaps } from "../../lib/useManageCaps";
import { PROJECT_ROLE_LABEL, type ProjectMember } from "../../types";
import { ProjectManagerPanel } from "./ProjectManagerPanel";
import { PROJECT_STATUS_OPTIONS } from "./ProjectPlanningDialog";
import {
  buildProjectUsageHierarchy,
  type ProjectEpisodeUsage,
  type ProjectSequenceUsage,
} from "./projectUsageHierarchy";
import { HoverMetric, WorkspaceUsageDashboard } from "./WorkspaceUsageDashboard";
import type { ManageProject, ProjectFolderUsage } from "./types";

function fmtDur(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const wholeSeconds = Math.floor(sec);
  const h = Math.floor(wholeSeconds / 3600);
  const m = Math.floor((wholeSeconds % 3600) / 60);
  const s = wholeSeconds % 60;
  if (h) return `${h}h${m ? `${m}m` : ""}`;
  if (m) return `${m}m${s ? `${s}s` : ""}`;
  return `${s}s`;
}
function fmtBudgetCr(n: number): string {
  return Math.round(n || 0).toLocaleString();
}
function statusLabel(s?: string | null): string {
  return PROJECT_STATUS_OPTIONS.find((option) => option.value === s)?.label ?? "—";
}

function DashboardPagination({
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
    <footer className="usage-pagination dash-pagination">
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

function generationPeriod(start?: string | null, end?: string | null): string {
  const first = start?.slice(0, 10);
  const last = end?.slice(0, 10);
  if (!first && !last) return "—";
  if (!first || !last || first === last) return first || last || "—";
  return `${first} ~ ${last}`;
}

function UsageMetricCells({ row }: { row: ProjectFolderUsage }) {
  const models = row.models || [];
  const yieldPercent = row.count ? (row.final_count / row.count) * 100 : 0;
  return (
    <>
      <td className="tnum">
        <HoverMetric value={row.count} rows={models} metric="count" title="모델별 생성" />
        <span className="dash-metric-divider"> / </span>
        <HoverMetric value={row.final_count} rows={models} metric="final" title="모델별 최종 선택" />
      </td>
      <td className="tnum">
        <span className="usage-score">
          <HoverMetric value={yieldPercent} rows={models} metric="yield" title="모델별 Yield" />
        </span>
      </td>
      <td className="tnum">
        <HoverMetric value={row.credits} rows={models} metric="credits" title="모델별 크레딧 사용" suffix=" cr" />
      </td>
      <td className="tnum">{fmtDur(row.elapsed_seconds)}</td>
      <td className="tnum dash-generation-period">{generationPeriod(row.created_start, row.created_end)}</td>
    </>
  );
}

function CreatorCell({ row }: { row: ProjectFolderUsage }) {
  const members = row.members || [];
  if (!members.length) return <td className="dash-creator-cell dim">—</td>;
  const names = [...new Set(members.map((member) => member.name || "팀원"))];
  const details = members
    .map((member) =>
      `${member.name || "팀원"} · 생성 ${member.count} · 최종 ${member.final_count} · ${Math.round(member.credits).toLocaleString()} cr`,
    )
    .join("\n");
  return (
    <td className="dash-creator-cell" title={details}>
      <span>{names.join(", ")}</span>
    </td>
  );
}

function EpisodeUsageRow({
  row,
  collapsed,
  onToggle,
}: {
  row: ProjectEpisodeUsage;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className="dash-episode-usage-row">
      <td className="l">
        <button
          type="button"
          className="dash-episode-toggle"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span className="dash-tree-arrow" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
          <span className="dash-folder-symbol episode" aria-hidden="true" />
          <span title={row.episode_name}>{row.episode_name}</span>
        </button>
      </td>
      <td className="dash-creator-cell dim">—</td>
      <UsageMetricCells row={row} />
    </tr>
  );
}

function SequenceUsageRow({ row }: { row: ProjectSequenceUsage }) {
  return (
    <tr className="dash-sequence-usage-row">
      <td className="l">
        <span className="dash-sequence-path" title={row.folder_path}>
          <span className="dash-tree-indent" aria-hidden="true" />
          <span className="dash-folder-symbol sequence" aria-hidden="true" />
          <span>{row.sequence_name}</span>
        </span>
      </td>
      <CreatorCell row={row} />
      <UsageMetricCells row={row} />
    </tr>
  );
}

// ── 선택 프로젝트: 실제 폴더·생성물 기준 에피소드 → 시퀀스 사용량
function ProjectDetail({
  summaryCard,
  pid,
  folders,
  projName,
}: {
  summaryCard: ReactNode;
  pid: string | null;
  folders: ProjectFolderUsage[];
  projName: string;
}) {
  const [sequencePage, setSequencePage] = useState(1);
  const [sequencePageSize, setSequencePageSize] = useState<number>(USAGE_PAGE_SIZES[0]);
  const [collapsedEpisodes, setCollapsedEpisodes] = useState<Set<string>>(() => new Set());
  const episodes = useMemo(() => buildProjectUsageHierarchy(folders), [folders]);
  const sequenceCount = episodes.reduce((total, episode) => total + episode.sequences.length, 0);
  useEffect(() => {
    setSequencePage(1);
    setCollapsedEpisodes(new Set());
  }, [pid]);
  const pagedEpisodes = paginateUsageItems(episodes, sequencePage, sequencePageSize);

  const toggleEpisode = (episodeName: string) => {
    setCollapsedEpisodes((current) => {
      const next = new Set(current);
      if (next.has(episodeName)) next.delete(episodeName);
      else next.add(episodeName);
      return next;
    });
  };

  return (
    <section className="dash-project-section">
      <div className="dash-project-overview">{summaryCard}</div>

      {!pid ? (
        <div className="dash-detail-empty">
          위 요약에서 <b>프로젝트를 클릭</b>하면 폴더별 생성 정보가 표시됩니다.
        </div>
      ) : (
        <div className="dash-tree-card dash-detail-card dash-sequence-card">
          <div className="hd">
            <div className="dash-detail-title">
              <h2>에피소드 · 시퀀스</h2>
              <span className="dash-scope-chip">프로젝트 · {projName}</span>
              {/* 프로젝트 요약과 같은 원천 — 폴더 파생 집계임을 명시(위 텔레메트리와 구분) */}
              <span className="work-source-label">출처 · 라이브러리 생성물 집계</span>
            </div>
            <span className="meta">에피소드 {episodes.length}개 · 시퀀스 {sequenceCount}개</span>
          </div>
          {folders.length ? (
            <div className="dash-tbl-scroll">
              <table className="dash-tree dash-sequence-table">
                <thead>
                  <tr>
                    <th className="l">이름</th>
                    <th className="dash-member-header">멤버</th>
                    <th>생성/최종</th>
                    <th>Yield</th>
                    <th>크레딧(사용)</th>
                    <th>생성시간</th>
                    <th>생성기간</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedEpisodes.items.map((episode) => {
                    const collapsed = collapsedEpisodes.has(episode.episode_name);
                    return (
                      <Fragment key={episode.episode_name}>
                        <EpisodeUsageRow
                          row={episode}
                          collapsed={collapsed}
                          onToggle={() => toggleEpisode(episode.episode_name)}
                        />
                        {!collapsed
                          ? episode.sequences.map((sequence) => (
                            <SequenceUsageRow key={sequence.folder_path} row={sequence} />
                          ))
                          : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="dash-part-empty">
              등록된 프로젝트 폴더나 폴더에 연결된 생성물이 없습니다.
            </div>
          )}
          {folders.length ? (
            <DashboardPagination
              label="에피소드"
              page={pagedEpisodes.page}
              pageSize={pagedEpisodes.pageSize}
              totalPages={pagedEpisodes.totalPages}
              onPageChange={setSequencePage}
              onPageSizeChange={(size) => {
                setSequencePageSize(size);
                setSequencePage(1);
              }}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

export function DashboardView({
  reloadSignal = 0,
  caps,
  workspaceId,
  onWorkspaceIdChange,
}: {
  reloadSignal?: number;
  caps: ManageCaps;
  workspaceId?: string;
  onWorkspaceIdChange?: (workspaceId?: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [selectedPid, setSelectedPid] = useState<string | null>(null); // 하단 상세 대상
  const [summary, setSummary] = useState<{ projects: ManageProject[] } | null>(null);
  const [members, setMembers] = useState<Map<string, ProjectMember[]>>(new Map());
  const [showPanel, setShowPanel] = useState(false); // 프로젝트 관리 오버레이(＋프로젝트)
  const [summaryPage, setSummaryPage] = useState(1);
  const [summaryPageSize, setSummaryPageSize] = useState<number>(USAGE_PAGE_SIZES[0]);
  const canManageProjects = caps.createProject || caps.grantRole;
  const canViewWorkspaceUsage = caps.authOff || caps.readAll;

  const reloadPromiseRef = useRef<Promise<void> | null>(null);
  const pendingReloadRef = useRef(false);
  // 워크스페이스 전환 경합 가드 — in-flight 응답이 끝난 뒤 화면은 이미 다른 워크스페이스일 수
  // 있다. 요청 시점 스코프와 현재 스코프가 다르면 반영하지 않는다(WorkBoard 의 scopeKey 와 동일).
  const scopeRef = useRef(workspaceId);
  scopeRef.current = workspaceId;

  // 프로젝트 요약과 멤버를 함께 갱신한다. 작업 롤업 KPI 제거 후 작업 목록은 읽지 않는다.
  const reload = () => {
    if (reloadPromiseRef.current) {
      pendingReloadRef.current = true;
      return reloadPromiseRef.current;
    }
    const scopeAtStart = workspaceId;
    const inScope = () => scopeRef.current === scopeAtStart;
    // 성공한 응답만 반영하고 실패는 이전 데이터를 유지한다 — 일시 장애 폴링 1회가
    // 잘 보이던 대시보드를 "프로젝트 없음"으로 초기화하지 않게(null 덮어쓰기 금지).
    // read_all 판정이 서버와 어긋나도(스테일 캐시 등) 대시보드가 통째로 죽지 않게 —
    // 403 이면 일반 멤버용 API(자기 프로젝트만)로 폴백한다.
    const summaryP = (canViewWorkspaceUsage
      ? manageApi.summary(workspaceId).catch((e) =>
          isHttpStatus(e, 403) ? manageApi.projectSummary(workspaceId) : Promise.reject(e),
        )
      : manageApi.projectSummary(workspaceId)
    )
      .then((d) => {
        if (inScope()) setSummary((previous) => reconcileValueState(previous, d));
        return null as string | null;
      })
      .catch((e) => String(e?.message || e) || "요약 조회 실패");
    const membersP = (canViewWorkspaceUsage
      ? projectApi.allProjectMembers().catch((e) =>
          isHttpStatus(e, 403) ? projectApi.visibleProjectMembers() : Promise.reject(e),
        )
      : projectApi.visibleProjectMembers())
      .then((membersByPid) => {
        if (inScope()) {
          setMembers((previous) =>
            reconcileMapState(previous, new Map(Object.entries(membersByPid))),
          );
        }
        return null as string | null;
      })
      .catch((e) => String(e?.message || e) || "멤버 조회 실패");
    const request = Promise.all([summaryP, membersP])
      .then(([summaryError, membersError]) => {
        if (inScope()) setErr(summaryError || membersError || "");
      })
      .finally(() => {
        setLoading(false);
        if (reloadPromiseRef.current === request) reloadPromiseRef.current = null;
        if (pendingReloadRef.current) {
          pendingReloadRef.current = false;
          // stale 클로저(옛 workspaceId)가 아니라 최신 렌더의 reload 를 호출해야
          // 전환 직후 대기 중이던 재조회가 새 워크스페이스로 나간다.
          void reloadRef.current();
        }
      });
    reloadPromiseRef.current = request;
    return request;
  };
  // 워크스페이스가 실제로 바뀔 때만 이전 공간 요약을 비운다 — 새 헤더 아래 이전 공간
  // 프로젝트·수치가 남던 오표시 방지. 첫 마운트·주기 재조회는 유지해 깜빡이지 않게.
  const summaryScopeRef = useRef(workspaceId);
  useEffect(() => {
    if (summaryScopeRef.current !== workspaceId) {
      summaryScopeRef.current = workspaceId;
      setSummary(null);
      setLoading(true);
    }
    setSelectedPid(null);
    setSummaryPage(1);
    void reload();
  }, [workspaceId]);
  const reloadRef = useRef(reload);
  const seenReloadSignalRef = useRef(reloadSignal);
  reloadRef.current = reload;
  useEffect(() => {
    if (seenReloadSignalRef.current === reloadSignal) return;
    seenReloadSignalRef.current = reloadSignal;
    reloadRef.current();
  }, [reloadSignal]);

  // 요약 행 = summary.projects(빈 프로젝트 포함) 기준 + 멤버(인원) 병합
  const rows = useMemo(() => {
    const list = summary?.projects || [];
    return list.map((p) => {
      const memberCount = p.pid ? members.get(p.pid)?.length || 0 : 0;
      return { p, memberCount };
    });
  }, [summary, members]);
  const pagedSummaryRows = paginateUsageItems(rows, summaryPage, summaryPageSize);

  const selProj = summary?.projects.find((p) => p.pid === selectedPid);
  const selName = selProj?.name || "";

  if (loading && !summary) return <div className="manage-empty">불러오는 중…</div>;
  // 표시할 데이터가 전혀 없을 때만 전체 오류 화면 — 데이터가 있으면 유지하고 배너로 알린다.
  if (err && !summary) return <div className="manage-empty">불러오기 실패: {err}</div>;
  const staleBanner = err ? (
    <div className="dash-stale-banner">갱신 실패: {err} — 마지막으로 성공한 데이터를 표시 중입니다</div>
  ) : null;

  const summaryCard = (
    <div className="dash-tree-card dash-detail-card dash-summary-card">
      <div className="hd">
        <div className="dash-detail-title">
          <h2>프로젝트 요약</h2>
          {/* 위 워크스페이스 사용 현황(텔레메트리)과 집계 원천이 달라 숫자가 어긋날 수 있다. */}
          <span className="work-source-label">출처 · 라이브러리 생성물 집계</span>
        </div>
        <span className="meta">전체 {rows.length}개</span>
      </div>
      <div className="dash-tbl-scroll">
        <table className="dash-tree dash-summary">
          <thead>
            <tr>
              <th className="l">프로젝트</th>
              <th>상태</th>
              <th>멤버</th>
              <th>크레딧(한도)</th>
              <th>크레딧(사용)</th>
              <th>생성</th>
              <th>최종</th>
              <th>Yield</th>
            </tr>
          </thead>
          <tbody>
            {pagedSummaryRows.items.map(({ p, memberCount }) => {
              const b = p.planning?.budget_credits ?? null;
              const used = p.credits || 0;
              const projectMembers = p.pid ? members.get(p.pid) || [] : [];
              const memberTitle = projectMembers.length
                ? projectMembers
                  .map((member) => {
                    const roles = member.roles
                      .map((role) => PROJECT_ROLE_LABEL[role] || role)
                      .join(", ");
                    return `${member.name || member.uid}${roles ? ` · ${roles}` : ""}`;
                  })
                  .join("\n")
                : "멤버 없음";
              const planningDetails = [
                p.planning?.start_date ? `시작일 ${p.planning.start_date}` : null,
                p.planning?.due_date ? `마감일 ${p.planning.due_date}` : null,
                p.planning?.note ? `메모 ${p.planning.note}` : null,
              ].filter(Boolean).join("\n") || "일정 정보 없음";
              const models = p.models || [];
              const generated = p.gen_count || 0;
              const finals = p.final_count || 0;
              const yieldPercent = generated ? (finals / generated) * 100 : 0;
              return (
                <tr
                  key={p.pid ?? "none"}
                  className={`dash-row${selectedPid === p.pid ? " sel" : ""}${p.pid ? " clickable" : ""}`}
                  onClick={() => p.pid && setSelectedPid((cur) => (cur === p.pid ? null : p.pid))}
                >
                  <td className="l" title="클릭하면 아래에서 프로젝트 상세를 확인합니다.">
                    <span className="dash-name">{p.name}</span>
                  </td>
                  <td>
                    <span className="dash-hover-text" title={planningDetails}>
                      {statusLabel(p.planning?.status)}
                    </span>
                  </td>
                  <td>
                    <span className="dash-hover-text tnum" title={memberTitle}>{memberCount || "—"}</span>
                  </td>
                  <td className="tnum">
                    <span
                      className={b != null ? "dash-hover-text" : "dim"}
                      title={b != null ? `${budgetPeriodLabel(p.planning)} 예산 한도 · ${fmtBudgetCr(b)} cr` : "예산 미설정"}
                    >
                      {b != null ? `${fmtBudgetCr(b)} cr` : "—"}
                    </span>
                  </td>
                  <td className="tnum">
                    <HoverMetric
                      value={used}
                      rows={models}
                      metric="credits"
                      title="프로젝트 전체 모델별 크레딧 사용"
                      suffix=" cr"
                    />
                  </td>
                  <td className="tnum">
                    <HoverMetric value={generated} rows={models} metric="count" title="모델별 생성" />
                  </td>
                  <td className="tnum">
                    <HoverMetric value={finals} rows={models} metric="final" title="모델별 최종 선택" />
                  </td>
                  <td className="tnum">
                    <span className="usage-score">
                      <HoverMetric value={yieldPercent} rows={models} metric="yield" title="모델별 Yield" />
                    </span>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={8} className="dash-part-empty">
                  {canViewWorkspaceUsage
                    ? `프로젝트가 없습니다. ${canManageProjects ? "＋ 프로젝트로 만드세요." : "관리자에게 생성을 요청하세요."}`
                    : "참여 중인 프로젝트가 없습니다."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="dash-legend">
        <span className="dim">행 클릭=아래 상세 · 한도=설정 예산 · 사용=프로젝트 전체 누적 크레딧</span>
      </div>
      <DashboardPagination
        label="프로젝트 요약"
        page={pagedSummaryRows.page}
        pageSize={pagedSummaryRows.pageSize}
        totalPages={pagedSummaryRows.totalPages}
        onPageChange={setSummaryPage}
        onPageSizeChange={(size) => {
          setSummaryPageSize(size);
          setSummaryPage(1);
        }}
      />
    </div>
  );

  return (
    <div className="dash-view">
      {staleBanner}
      {/* 워크스페이스 사용량을 가장 먼저 표시 — 선택 공간의 생성·크레딧·멤버·모델·폴더 효율. */}
      {canViewWorkspaceUsage && (
        <WorkspaceUsageDashboard
          reloadSignal={reloadSignal}
          canCreateProject={canManageProjects}
          onCreateProject={() => setShowPanel(true)}
          workspaceId={workspaceId}
          onWorkspaceIdChange={onWorkspaceIdChange}
        />
      )}

      {/* 하나의 외곽 패널 안에서 프로젝트 요약과 선택 프로젝트 시퀀스를 확인한다. */}
      <ProjectDetail
        summaryCard={summaryCard}
        pid={selectedPid}
        folders={selProj?.folders || []}
        projName={selName}
      />

      {/* 프로젝트 관리 오버레이 — 생성·보관·삭제·멤버 역할 */}
      {showPanel && (
        <ProjectManagerPanel
          onClose={() => {
            setShowPanel(false);
            reload();
          }}
        />
      )}

    </div>
  );
}
