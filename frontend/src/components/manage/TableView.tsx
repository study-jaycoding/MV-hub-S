// 테이블 뷰 — Notion 데이터베이스식. 시퀀스·마감·설명만 인라인 편집, 컷 셀은 생성물 드롭 타깃.
// 행 체크박스로 다중선택(하단 선택바에서 삭제), 드래그 핸들(⠿)로 순서 변경. 격자선으로 표 가독성.
// 생성자는 실제 생성자(연결 컷 파생)만 — 수동 담당 배정 개념은 폐기됨(2026-08-21).
import { Fragment, useState } from "react";
import { useT } from "../../lib/i18n";
import { ColorTag } from "./ColorTag";
import { CutThumbs } from "./CutThumbs";
import { taskModelUsage } from "./personalWork";
import { HoverMetric } from "./WorkspaceUsageDashboard";
import {
  GEN_MIME,
  statusColor,
  statusLabel,
  taskIsReadOnly,
  workActivityStatusLabel,
  type Task,
  type WorkViewProps,
} from "./types";

const ROW_MIME = "application/x-work-row"; // 행 순서변경 드래그 키(생성물 드롭과 구분)

// 생성시간(제작 소요) — 1d2h10s 식으로 0인 단위는 생략해 압축 표기.
function fmtDur(sec?: number): string {
  if (!sec || sec <= 0) return "—";
  let rest = Math.floor(sec);
  const d = Math.floor(rest / 86400);
  rest %= 86400;
  const h = Math.floor(rest / 3600);
  rest %= 3600;
  const m = Math.floor(rest / 60);
  const s = rest % 60;
  let out = "";
  if (d) out += `${d}d`;
  if (h) out += `${h}h`;
  if (m) out += `${m}m`;
  if (s || !out) out += `${s}s`;
  return out;
}

// YYYY-MM-DD → M/D(월/일). 기간 표시용 짧은 포맷.
function fmtMD(d?: string | null): string {
  if (!d) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${+m[2]}/${+m[3]}` : d;
}

export function TableView(props: WorkViewProps) {
  const {
    tasks,
    seqOptions,
    thumb,
    disabled,
    colorMap,
    readOnly,
    selected,
    onToggleSelect,
    onToggleSelectAll,
    onReorder,
    onPatch,
    onLinkGen,
    onUnlinkGen,
  } = props;
  useT(); // 언어 토글 시 상태 라벨 리렌더
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const commitText = (t: Task, value: string) => {
    if ((t.description || "") !== value) onPatch(t.id, { description: value });
  };

  const allIds = tasks.filter((task) => !taskIsReadOnly(task, readOnly)).map((t) => t.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected?.has(id));
  const toggleDetails = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="manage-table-wrap" tabIndex={0}>
      <table className="manage-table work-table work-table-grid">
        <thead>
          <tr>
            <th className="work-sel-col">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={!allIds.length}
                onChange={(e) => onToggleSelectAll?.(allIds, e.target.checked)}
                title="전체 선택"
              />
            </th>
            <th>프로젝트</th>
            <th>에피소드</th>
            <th>시퀀스</th>
            <th>생성물</th>
            <th>생성자</th>
            <th>상태</th>
            <th>크레딧</th>
            <th>생성시간</th>
            <th>생성기간</th>
            <th>설명</th>
            <th>코멘트</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const isSel = !!selected?.has(t.id);
            const modelUsage = taskModelUsage(t);
            const stateColor = statusColor(t.status);
            const detailsOpen = expanded.has(t.id);
            const locked = taskIsReadOnly(t, readOnly);
            const detailId = `work-detail-${t.id}`;
            return (
              <Fragment key={t.id}>
              <tr
                className={(isSel ? "work-row-sel" : "") + (t.archived ? " work-row-archived" : "")}
                onDragOver={(e) => {
                  if (!locked && e.dataTransfer.types.includes(ROW_MIME)) e.preventDefault();
                }}
                onDrop={(e) => {
                  if (locked) return;
                  if (!e.dataTransfer.types.includes(ROW_MIME)) return;
                  const src = e.dataTransfer.getData(ROW_MIME);
                  if (src && src !== t.id) onReorder?.(src, t.id);
                }}
              >
                <td className="work-sel-col">
                  <span
                    className="work-row-handle"
                    draggable={!locked}
                    title={locked ? "읽기 전용 작업" : "드래그해 순서 변경"}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(ROW_MIME, t.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                  >
                    ⠿
                  </span>
                  <input
                    type="checkbox"
                    checked={isSel}
                    disabled={locked}
                    onChange={() => onToggleSelect?.(t.id)}
                  />
                  <button
                    type="button"
                    className="work-mobile-detail-btn"
                    aria-expanded={detailsOpen}
                    aria-controls={detailId}
                    aria-label={`${t.project_name || "프로젝트"} ${t.name} ${t.sequence || ""} 상세`}
                    title={detailsOpen ? "상세 접기" : "상세 펼치기"}
                    onClick={() => toggleDetails(t.id)}
                  >
                    {detailsOpen ? "▴" : "▾"}
                  </button>
                </td>
                <td>
                  <ColorTag field="project" value={t.project_name} colorMap={colorMap} plainClass="work-proj-static" />
                </td>
                <td>
                  {/* 에피소드(작업명) — 폴더 구조에서 받아온 정보라 읽기전용. */}
                  <ColorTag
                    field="episode"
                    value={t.name}
                    colorMap={colorMap}
                    plainClass="work-name-static"
                    title={t.folder_path || t.name}
                  />
                </td>
                <td>
                  {t.folder_path ? (
                    // 시퀀스도 프로젝트/에피소드처럼 평문(색 지정 시 색 라벨).
                    <ColorTag
                      field="sequence"
                      value={t.sequence || t.name}
                      colorMap={colorMap}
                      plainClass="work-seq-plain"
                      title={t.folder_path}
                    />
                  ) : (
                    <select
                      className="work-cell-sel"
                      value={t.sequence || ""}
                      disabled={locked}
                      onChange={(e) => onPatch(t.id, { sequence: e.target.value })}
                    >
                      <option value="">—</option>
                      {seqOptions.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td
                  className="work-cut-cell"
                  onDragOver={(e) => {
                    if (!locked && e.dataTransfer.types.includes(GEN_MIME)) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    if (locked) return;
                    const gid = e.dataTransfer.getData(GEN_MIME);
                    if (gid) onLinkGen(t.id, gid);
                  }}
                >
                  <CutThumbs
                    task={t}
                    thumb={thumb}
                    disabled={disabled}
                    readOnly={locked}
                    onUnlinkGen={onUnlinkGen}
                  />
                </td>
                <td className="work-creators">
                  {/* 실제 생성자(연결 컷 파생)만. */}
                  {t.creators?.length
                    ? t.creators.map((c, i) => (
                        <span key={c}>
                          {i > 0 && " "}
                          <ColorTag field="creator" value={c} colorMap={colorMap} />
                        </span>
                      ))
                    : "—"}
                </td>
                <td>
                  {/* 상태 — 기존 색을 유지한 텍스트 배지. 자동 폴더 작업은 생성·공유·완료로 읽는다. */}
                  <span
                    className="work-status-badge"
                    title={statusLabel(t.status)}
                    style={{ color: stateColor, backgroundColor: `${stateColor}22` }}
                  >
                    {workActivityStatusLabel(t.status)}
                  </span>
                  {t.workspace_unresolved && (
                    <span className="work-readonly-badge" title="기존 기록의 워크스페이스를 확인해야 합니다">
                      귀속 확인 필요
                    </span>
                  )}
                  {t.workspace_historical && (
                    <span className="work-readonly-badge" title="과거 워크스페이스 기록">
                      읽기 전용
                    </span>
                  )}
                  {!!t.archived && (
                    <span className="work-readonly-badge work-archived-badge" title="보관 처리된 작업 — 과거 기록에서만 표시됩니다">
                      보관됨
                    </span>
                  )}
                </td>
                <td className="work-credit-cell">
                  <HoverMetric
                    value={t.credits || 0}
                    rows={modelUsage}
                    metric="both"
                    title="모델별 생성·크레딧"
                    suffix=" cr"
                  />
                </td>
                <td>{fmtDur(t.elapsed)}</td>
                <td>
                  {/* 마감일 — PM 입력값 우선, 없으면 연결 생성물의 최종 생성일 자동 표시.
                      아래에 시작~끝(생성일 범위) 기간을 함께 보여 시퀀스 진행 폭을 파악. */}
                  <input
                    className="work-cell-in"
                    type="date"
                    value={t.due_date || t.derived_due || ""}
                    disabled={locked}
                    onChange={(e) => onPatch(t.id, { due_date: e.target.value })}
                  />
                  {t.derived_start && t.derived_due && (
                    <div className="work-period" title="연결 생성물의 생성일 범위">
                      {fmtMD(t.derived_start)}
                      {t.derived_start !== t.derived_due ? ` ~ ${fmtMD(t.derived_due)}` : ""}
                    </div>
                  )}
                </td>
                <td>
                  <input
                    className="work-cell-in"
                    defaultValue={t.description || ""}
                    disabled={locked}
                    placeholder="설명"
                    onBlur={(e) => commitText(t, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                </td>
                <td>{t.comment_count ? `💬 ${t.comment_count}` : "—"}</td>
              </tr>
              {detailsOpen && (
                <tr
                  id={detailId}
                  className={"work-mobile-detail-row" + (t.archived ? " work-row-archived" : "")}
                >
                  <td colSpan={12}>
                    <div className="work-mobile-detail-grid">
                      <div>
                        <span className="work-mobile-detail-label">생성시간</span>
                        <b>{fmtDur(t.elapsed)}</b>
                      </div>
                      <div>
                        <span className="work-mobile-detail-label">생성기간</span>
                        <input
                          className="work-cell-in"
                          type="date"
                          value={t.due_date || t.derived_due || ""}
                          disabled={locked}
                          onChange={(e) => onPatch(t.id, { due_date: e.target.value })}
                        />
                        {t.derived_start && t.derived_due && (
                          <div className="work-period" title="연결 생성물의 생성일 범위">
                            {fmtMD(t.derived_start)}
                            {t.derived_start !== t.derived_due
                              ? ` ~ ${fmtMD(t.derived_due)}`
                              : ""}
                          </div>
                        )}
                      </div>
                      <label className="work-mobile-detail-wide">
                        <span className="work-mobile-detail-label">설명</span>
                        <input
                          className="work-cell-in"
                          defaultValue={t.description || ""}
                          disabled={locked}
                          placeholder="설명"
                          onBlur={(e) => commitText(t, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          }}
                        />
                      </label>
                      <div>
                        <span className="work-mobile-detail-label">코멘트</span>
                        <b>{t.comment_count ? `${t.comment_count}개` : "없음"}</b>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
