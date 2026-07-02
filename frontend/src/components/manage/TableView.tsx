// 테이블 뷰 — Notion 데이터베이스식. 시퀀스·마감·설명만 인라인 편집, 컷 셀은 생성물 드롭 타깃.
// 행 체크박스로 다중선택(하단 선택바에서 삭제), 드래그 핸들(⠿)로 순서 변경. 격자선으로 표 가독성.
import { useT } from "../../lib/i18n";
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

export function TableView(props: WorkViewProps) {
  const {
    tasks,
    seqOptions,
    thumb,
    disabled,
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
            <th>상태</th>
            <th>생성물</th>
            <th>생성자</th>
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
                  <span className="work-proj-static">{t.project_name || "—"}</span>
                </td>
                <td>
                  {/* 에피소드(작업명) — 폴더 구조에서 받아온 정보라 읽기전용. */}
                  <span className="work-name-static" title={t.folder_path || t.name}>
                    {t.name}
                  </span>
                </td>
                <td>
                  {t.folder_path ? (
                    <span className="work-seq-static" title={t.folder_path}>
                      📁 {t.sequence || t.name}
                    </span>
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
                <td>
                  {/* 상태 — 컷에서 파생되므로 표시 전용. 색 원은 크게. */}
                  <span className="work-status-cell" title={statusLabel(t.status)}>
                    <span className="status-dot lg" style={{ background: statusColor(t.status) }} />
                    {statusLabel(t.status)}
                  </span>
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
                <td className="work-creators">{t.creators?.join(", ") || "—"}</td>
                <td>{t.credits ? t.credits.toLocaleString() : "—"}</td>
                <td>{fmtDur(t.elapsed)}</td>
                <td>
                  <input
                    className="work-cell-in"
                    type="date"
                    value={t.due_date || ""}
                    onChange={(e) => onPatch(t.id, { due_date: e.target.value })}
                  />
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
