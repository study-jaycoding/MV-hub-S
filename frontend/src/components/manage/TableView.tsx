// 테이블 뷰 — Notion 데이터베이스식. 시퀀스·마감·설명만 인라인 편집, 컷 셀은 생성물 드롭 타깃.
// 행 체크박스로 다중선택(하단 선택바에서 삭제), 드래그 핸들(⠿)로 순서 변경. 격자선으로 표 가독성.
// 생성자는 실제 생성자(연결 컷 파생)만 — 수동 담당 배정 개념은 폐기됨(2026-08-21).
import { Fragment, useEffect, useRef, useState } from "react";
import { fmtElapsed } from "../../lib/format";
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

  const commitText = (t: Task, value: string) => onPatch(t.id, { description: value }); // 보낼지 말지는 칸(DescCell)이 정한다

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
                    myUid={props.myUid}
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
                    <span className="work-readonly-badge work-archived-badge" title="보관 처리된 작업 — 보관 기록에서만 표시됩니다">
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
                <td>{fmtElapsed(t.elapsed)}</td>
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
                  <DescCell task={t} disabled={locked} onCommit={commitText} />
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
                        <b>{fmtElapsed(t.elapsed)}</b>
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
                        <DescCell task={t} disabled={locked} onCommit={commitText} />
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

// 설명 칸 — 치는 동안의 글은 이 칸의 초안이다. 칸을 벗어나면 저장하고(Enter), Esc 는 고치던 것을 버린다(같은 Esc 가 관리 창까지
//  닫지 않게 여기서 멈춘다). 서버에서 그 작업을 다시 받으면(저장 성공·남의 변경) **이 칸에서 고친 것이 없을 때만** 서버 값으로 맞춘다 —
//  치는 중인 글은 건드리지 않는다(전엔 칸을 통째로 다시 만들어 친 글자가 사라졌다). 기준은 '초점'이 아니라 '고쳤나'다: 초점만 두고
//  안 고친 칸이 옛 글을 쥐고 있으면, 벗어날 때 그 옛 글이 저장돼 그사이 남이 바꾼 값을 되돌린다(Codex 코드 리뷰).
//  저장이 실패하면 친 글을 남기고 '저장 안 됨'을 표시한다(Jay 결정 2026-10-10) — 전엔 실패 알림이 사라지면 저장된 글과 구별이 안 됐고
//  새로 고침하면 사라졌다. 표시가 붙은 칸은 다시 벗어나거나 [다시 저장]을 누르면 한 번 더 저장한다. Esc 는 그 글을 버린다.
function DescCell({ task, disabled, onCommit }: {
  task: Task;
  disabled: boolean;
  onCommit: (task: Task, value: string) => Promise<boolean> | boolean | void;
}) {
  const [draft, setDraft] = useState(task.description || "");
  const [unsaved, setUnsaved] = useState(false); // 서버에 없는 글을 보이고 있다(저장 실패)
  // 이 칸에 서버로 못 간 글이 있나 — 치기 시작한 때부터 그 글의 저장이 **성공할 때까지** 참이다. 저장 응답을 기다리는 동안에도
  //  참이라, 그사이 목록이 새로 와도 친 글을 덮지 않는다(Codex 코드 리뷰: 대기 중에 서버 값으로 덮인 뒤 실패가 오면 '저장 안 됨'이
  //  서버 글에 붙었다). 실패한 글도 계속 쥐고 있어 다시 벗어나면 또 저장한다.
  const dirty = useRef(false);
  const edit = useRef(0); // 편집 번호 — 글을 치거나 버릴 때마다 오른다. 늦게 온 옛 저장의 결과가 지금 글에 적용되지 않게 가려낸다
  const sent = useRef(-1); // 응답을 기다리는 저장의 편집 번호(-1 = 없다) — 같은 글을 두 번 보내지 않는다
  // 목록의 값(task.description)을 '서버에 있는 글'로 믿어도 되나. 이 칸이 저장을 보낸 뒤에는 **가는 중인 저장이 없는 채로 목록이 새로
  //  올 때까지** 믿지 않는다 — 저장이 가는 중이거나 막 성공한 틈의 목록 값은 옛 글이라, 그 옛 글로 되돌린 것을 '고친 것 없음'으로 보고
  //  안 보내면 마지막에 친 글이 앞 저장에 덮인다(Codex 코드 리뷰). 못 믿는 동안은 같아 보여도 보낸다(같은 값을 한 번 더 보낼 뿐이다).
  //  '서버에 간 글'을 따로 적어 두지는 않는다 — 늦게 온 성공 응답이 더 새 목록 값을 덮는 길이 생긴다(한 번 그렇게 했다가 뺐다).
  const trust = useRef(true);
  useEffect(() => {
    if (sent.current === -1) trust.current = true;
    if (!dirty.current) setDraft(task.description || "");
  }, [task]);
  const save = () => {
    if (!dirty.current || sent.current === edit.current) return; // 고친 것이 없다 · 같은 글의 저장이 이미 가는 중이다
    // 목록 값과 같으면 보내지 않는다(고쳤다가 되돌린 글이 그사이 남이 바꾼 값을 되돌리지 않게) — 목록 값을 믿을 수 있을 때만.
    //  같은 작업의 저장은 줄을 서서 보낸 순서대로 간다(WorkBoard 의 taskPatchQueue).
    const skip = trust.current && draft === (task.description || "");
    if (!skip) trust.current = false;
    const mine = edit.current;
    sent.current = mine;
    void Promise.resolve(skip ? true : onCommit(task, draft)).then((ok) => {
      if (sent.current === mine) sent.current = -1;
      if (mine !== edit.current) return; // 그사이 다시 고쳤거나 Esc 로 버렸다 — 이 결과는 옛 글의 것이다
      dirty.current = ok === false;
      setUnsaved(ok === false);
    });
  };
  return (
    <span className={"work-desc" + (unsaved ? " unsaved" : "")}>
      <input
        className="work-cell-in"
        value={draft}
        disabled={disabled}
        placeholder="설명"
        onChange={(e) => {
          edit.current += 1;
          dirty.current = true;
          setDraft(e.target.value);
        }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            e.stopPropagation();
            edit.current += 1; // 가는 중인 저장의 결과도 이 칸에 적용하지 않는다
            dirty.current = false;
            setUnsaved(false);
            setDraft(task.description || "");
            e.currentTarget.blur();
          }
        }}
      />
      {unsaved && (
        <>
          <span className="work-desc-chip" title="서버에 저장되지 않았습니다 — 새로 고침하면 사라집니다">저장 안 됨</span>
          <button type="button" className="work-desc-retry" disabled={disabled} onClick={save}>다시 저장</button>
        </>
      )}
    </span>
  );
}
