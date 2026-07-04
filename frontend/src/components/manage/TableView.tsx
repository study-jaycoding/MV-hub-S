// 테이블 뷰 — Notion 데이터베이스식. 시퀀스·마감·설명만 인라인 편집, 컷 셀은 생성물 드롭 타깃.
// 행 체크박스로 다중선택(하단 선택바에서 삭제), 드래그 핸들(⠿)로 순서 변경. 격자선으로 표 가독성.
import { useT } from "../../lib/i18n";
import { ColorTag } from "./ColorTag";
import { CutThumbs } from "./CutThumbs";
import {
  GEN_MIME,
  statusColor,
  statusLabel,
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
    selected,
    onToggleSelect,
    onToggleSelectAll,
    onReorder,
    onPatch,
    onLinkGen,
    onUnlinkGen,
  } = props;
  useT(); // 언어 토글 시 상태 라벨 리렌더

  const commitText = (t: Task, value: string) => {
    if ((t.description || "") !== value) onPatch(t.id, { description: value });
  };

  const allIds = tasks.map((t) => t.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected?.has(id));

  return (
    <div className="manage-table-wrap">
      <table className="manage-table work-table work-table-grid">
        <thead>
          <tr>
            <th className="work-sel-col">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(e) => onToggleSelectAll?.(allIds, e.target.checked)}
                title="전체 선택"
              />
            </th>
            <th>프로젝트</th>
            <th>에피소드</th>
            <th>시퀀스</th>
            <th>생성물</th>
            <th>담당</th>
            <th>생성자</th>
            <th>상태</th>
            <th>크레딧</th>
            <th>생성시간</th>
            <th>마감일</th>
            <th>설명</th>
            <th>코멘트</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const isSel = !!selected?.has(t.id);
            return (
              <tr
                key={t.id}
                className={isSel ? "work-row-sel" : ""}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(ROW_MIME)) e.preventDefault();
                }}
                onDrop={(e) => {
                  if (!e.dataTransfer.types.includes(ROW_MIME)) return;
                  const src = e.dataTransfer.getData(ROW_MIME);
                  if (src && src !== t.id) onReorder?.(src, t.id);
                }}
              >
                <td className="work-sel-col">
                  <span
                    className="work-row-handle"
                    draggable
                    title="드래그해 순서 변경"
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
                    onChange={() => onToggleSelect?.(t.id)}
                  />
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
                    if (e.dataTransfer.types.includes(GEN_MIME)) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    const gid = e.dataTransfer.getData(GEN_MIME);
                    if (gid) onLinkGen(t.id, gid);
                  }}
                >
                  <CutThumbs task={t} thumb={thumb} disabled={disabled} onUnlinkGen={onUnlinkGen} />
                </td>
                <td className="work-assignee">
                  {/* 담당(배정) — 프로젝트 멤버 중 선택. 생성자(누가 만듦)와 별개 축. */}
                  {props.assigneeOptions ? (
                    <select
                      className="work-cell-sel"
                      value={t.assignee_uid || ""}
                      onChange={(e) => onPatch(t.id, { assignee_uid: e.target.value || null })}
                    >
                      <option value="">담당 없음</option>
                      {(props.assigneeOptions[t.project_id] || []).map((m) => (
                        <option key={m.creator_uid} value={m.creator_uid}>
                          {m.name || m.creator_uid}
                        </option>
                      ))}
                    </select>
                  ) : (
                    t.assignee_name || "—"
                  )}
                </td>
                <td className="work-creators">
                  {/* 예정 생성자(수동 self-assign) — '예정' 파란 배지. 내 것은 × 로 해제. */}
                  {t.planned_creators?.map((pc) => (
                    <span key={pc.uid} className="planned-tag" title="예정 생성자(내가 할 작업)">
                      {pc.name || pc.uid}
                      {props.onRemovePlanned && pc.uid === props.myUid ? (
                        <button
                          className="planned-x"
                          title="예정에서 빼기"
                          onClick={() => props.onRemovePlanned!(t.id, pc.uid)}
                        >
                          ×
                        </button>
                      ) : null}
                    </span>
                  ))}
                  {/* 실제 생성자(연결 컷 파생) */}
                  {t.creators?.length
                    ? t.creators.map((c, i) => (
                        <span key={c}>
                          {i > 0 && " "}
                          <ColorTag field="creator" value={c} colorMap={colorMap} />
                        </span>
                      ))
                    : !t.planned_creators?.length && "—"}
                  {/* + 나 (self-assign) — 이미 예정에 있으면 숨김 */}
                  {props.onAddMePlanned &&
                  !t.planned_creators?.some((p) => p.uid === props.myUid) ? (
                    <button className="add-me" title="내가 할 작업으로 지정" onClick={() => props.onAddMePlanned!(t.id)}>
                      + 나
                    </button>
                  ) : null}
                  {/* 배정 ≠ 생성 신호 — 담당이 있는데 그 사람이 생성 목록에 없으면 표시(관리상 중요). */}
                  {t.assignee_name && t.creators?.length && !t.creators.includes(t.assignee_name) ? (
                    <span className="work-mismatch" title="담당과 실제 생성자가 다릅니다">↔</span>
                  ) : null}
                </td>
                <td>
                  {/* 상태 — 색 원만(글자 제거). hover 로 이름 확인. */}
                  <span className="work-status-cell" title={statusLabel(t.status)}>
                    <span className="status-dot lg" style={{ background: statusColor(t.status) }} />
                  </span>
                </td>
                <td>{t.credits ? t.credits.toLocaleString() : "—"}</td>
                <td>{fmtDur(t.elapsed)}</td>
                <td>
                  {/* 마감일 — PM 입력값 우선, 없으면 연결 생성물의 최종 생성일 자동 표시.
                      아래에 시작~끝(생성일 범위) 기간을 함께 보여 시퀀스 진행 폭을 파악. */}
                  <input
                    className="work-cell-in"
                    type="date"
                    value={t.due_date || t.derived_due || ""}
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
                    placeholder="설명"
                    onBlur={(e) => commitText(t, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                </td>
                <td>{t.comment_count ? `💬 ${t.comment_count}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
