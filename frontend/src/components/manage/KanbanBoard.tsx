// 보드 뷰 — 상태별 칸반. Notion식 카드 드래그로 상태 이동, 생성물(컷) 드롭 연결.
// 데이터·핸들러는 WorkBoard 가 주입(WorkViewProps). 프레젠테이션 전용.
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { ColorTag } from "./ColorTag";
import { CutThumbs } from "./CutThumbs";
import {
  GEN_MIME,
  groupLabel,
  HIDDEN_STATUSES,
  STATUS_GROUPS,
  STATUSES,
  statusText,
  TASK_MIME,
  type WorkViewProps,
} from "./types";

export function BoardView(props: WorkViewProps) {
  const { tasks, seqOptions, thumb, disabled, colorMap, onPatch, onLinkGen, onUnlinkGen } = props;
  useT(); // 언어 변경 시 상태·그룹 라벨 리렌더
  const [dragOver, setDragOver] = useState<string | null>(null);

  const renderColumn = (col: (typeof STATUSES)[number]) => {
    const items = tasks.filter((t) => t.status === col.v);
    return (
          <div
            key={col.v}
            className={"kanban-col" + (dragOver === col.v ? " drop" : "")}
            style={{ "--status-color": col.color } as React.CSSProperties}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(TASK_MIME)) {
                e.preventDefault();
                setDragOver(col.v);
              }
            }}
            onDragLeave={() => setDragOver((c) => (c === col.v ? null : c))}
            onDrop={(e) => {
              setDragOver(null);
              const tid = e.dataTransfer.getData(TASK_MIME);
              if (tid) onPatch(tid, { status: col.v });
            }}
          >
            <div className="kanban-col-head">
              <span className="status-dot" style={{ background: col.color }} />
              {statusText(col)} <span className="kanban-count">{items.length}</span>
            </div>
            {items.map((t) => (
              <div
                key={t.id}
                className="kanban-card work-card"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(TASK_MIME, t.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
              >
                {/* 프로젝트(윗줄) · 에피소드+시퀀스(아랫줄), X 없음 */}
                <div className="work-card-top">
                  {(t.project_name || !!t.creators?.length) && (
                    <div className="kanban-card-projline">
                      {t.project_name ? (
                        <ColorTag field="project" value={t.project_name} colorMap={colorMap} />
                      ) : (
                        <span />
                      )}
                      {!!t.creators?.length && (
                        <span className="work-creators" title="생성자">
                          👤{" "}
                          {t.creators.map((c, i) => (
                            <span key={c}>
                              {i > 0 && " "}
                              <ColorTag field="creator" value={c} colorMap={colorMap} />
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  )}
                  <span className="kanban-card-name" title={t.folder_path || t.name}>
                    <ColorTag field="episode" value={t.name} colorMap={colorMap} />
                    {t.folder_path ? (
                      <ColorTag
                        field="sequence"
                        value={t.sequence || t.name}
                        colorMap={colorMap}
                        plainClass="work-seq work-seq-static"
                        title={t.folder_path}
                      />
                    ) : (
                      <select
                        className="work-seq"
                        value={t.sequence || ""}
                        onChange={(e) => onPatch(t.id, { sequence: e.target.value })}
                        title="시퀀스(전역 태그)"
                      >
                        <option value="">시퀀스</option>
                        {seqOptions.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    )}
                  </span>
                </div>

                <div
                  className="work-cut-drop"
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(GEN_MIME)) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    const gid = e.dataTransfer.getData(GEN_MIME);
                    if (gid) onLinkGen(t.id, gid);
                  }}
                >
                  <CutThumbs task={t} thumb={thumb} disabled={disabled} onUnlinkGen={onUnlinkGen} />
                </div>

                <div className="work-card-meta">
                  {!!t.credits && <span title="크레딧">◆ {t.credits.toLocaleString()}</span>}
                  {!!t.comment_count && <span title="코멘트">💬 {t.comment_count}</span>}
                  {t.due_date && <span title="마감">📅 {t.due_date}</span>}
                </div>

                {t.description && <div className="work-card-desc">{t.description}</div>}
              </div>
            ))}
          </div>
    );
  };

  return (
    <div className="kanban kanban-grouped">
      {STATUS_GROUPS.map((group) => {
        const cols = STATUSES.filter(
          (s) => s.group === group && !HIDDEN_STATUSES.has(s.v),
        );
        if (!cols.length) return null; // 시작 전만 있던 '할 일' 그룹 등은 통째로 숨김
        const total = tasks.filter((t) => cols.some((c) => c.v === t.status)).length;
        return (
          // 그룹 폭을 컬럼 수에 비례시켜 모든 컬럼이 균등 폭으로 화면에 한 번에 들어오게 한다.
          <div key={group} className="kanban-group" style={{ flexGrow: cols.length, flexBasis: 0 }}>
            <div className="kanban-group-head">
              {groupLabel(group)} <span className="kanban-count">{total}</span>
            </div>
            <div className="kanban-group-cols">{cols.map(renderColumn)}</div>
          </div>
        );
      })}
    </div>
  );
}
