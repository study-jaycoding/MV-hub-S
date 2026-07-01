// 테이블 뷰 — Notion 데이터베이스식. 셀 인라인 편집(상태·시퀀스·작업명·마감·설명),
// 컷 셀은 생성물 드롭 타깃, 생성자·크레딧·시간·코멘트는 읽기전용(파생).
import { useT } from "../../lib/i18n";
import { CutThumbs } from "./CutThumbs";
import {
  GEN_MIME,
  STATUSES,
  statusColor,
  statusText,
  type Task,
  type WorkViewProps,
} from "./types";

function fmtDur(sec?: number): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m ? `${m}분 ${s}초` : `${s}초`;
}

export function TableView(props: WorkViewProps) {
  const { tasks, seqOptions, thumb, onPatch, onDelete, onLinkGen, onUnlinkGen } = props;
  useT(); // 언어 토글 시 상태 라벨 리렌더

  const commitText = (t: Task, key: "name" | "description", value: string) => {
    if ((t[key] || "") !== value) onPatch(t.id, { [key]: value } as Partial<Task>);
  };

  return (
    <div className="manage-table-wrap">
      <table className="manage-table work-table">
        <thead>
          <tr>
            <th>시퀀스</th>
            <th>생성물</th>
            <th>작업명</th>
            <th>상태</th>
            <th>생성자</th>
            <th>마감일</th>
            <th>크레딧</th>
            <th>제작시간</th>
            <th>설명</th>
            <th>코멘트</th>
            <th>삭제</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>
                {t.folder_path ? (
                  // 폴더 자동 작업 — 시퀀스는 폴더명(2단계). 읽기전용.
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
                <CutThumbs task={t} thumb={thumb} onUnlinkGen={onUnlinkGen} />
              </td>
              <td>
                <input
                  className="work-cell-in"
                  defaultValue={t.name}
                  onBlur={(e) => commitText(t, "name", e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              </td>
              <td>
                <span className="work-status-cell">
                  <span className="status-dot" style={{ background: statusColor(t.status) }} />
                  <select
                    className="work-cell-sel"
                    value={t.status}
                    onChange={(e) => onPatch(t.id, { status: e.target.value })}
                  >
                    {STATUSES.map((s) => (
                      <option key={s.v} value={s.v}>
                        {statusText(s)}
                      </option>
                    ))}
                  </select>
                </span>
              </td>
              <td className="work-creators">{t.creators?.join(", ") || "—"}</td>
              <td>
                <input
                  className="work-cell-in"
                  type="date"
                  value={t.due_date || ""}
                  onChange={(e) => onPatch(t.id, { due_date: e.target.value })}
                />
              </td>
              <td>{t.credits ? t.credits.toLocaleString() : "—"}</td>
              <td>{fmtDur(t.elapsed)}</td>
              <td>
                <input
                  className="work-cell-in"
                  defaultValue={t.description || ""}
                  placeholder="설명"
                  onBlur={(e) => commitText(t, "description", e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              </td>
              <td>{t.comment_count ? `💬 ${t.comment_count}` : "—"}</td>
              <td>
                <button className="kanban-del" title="삭제" onClick={() => onDelete(t.id)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
