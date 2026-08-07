// 보드 뷰 — 상태별 칸반. Notion식 카드 드래그로 상태 이동, 생성물(컷) 드롭 연결.
// 데이터·핸들러는 WorkBoard 가 주입(WorkViewProps). 프레젠테이션 전용.
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { ColorTag } from "./ColorTag";
import { CutThumbs } from "./CutThumbs";
import {
  GEN_MIME,
  STATUSES,
  TASK_MIME,
  workActivityStatusLabel,
  type WorkViewProps,
} from "./types";

// 보드는 실제 생성 흐름만 보여준다. 계획용 '시작 전'과 비활성 처리인 '생략'은
// 테이블 필터에서 계속 확인할 수 있지만, 칸반 레이아웃에는 별도 열을 만들지 않는다.
export const BOARD_STATUS_VALUES = ["in_progress", "publish", "done"] as const;
const BOARD_COLUMNS = STATUSES.filter((status) =>
  BOARD_STATUS_VALUES.includes(status.v as (typeof BOARD_STATUS_VALUES)[number]),
);

function fmtDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "";
  let rest = Math.floor(seconds);
  const hours = Math.floor(rest / 3600);
  rest %= 3600;
  const minutes = Math.floor(rest / 60);
  const secs = rest % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", secs || (!hours && !minutes) ? `${secs}s` : ""]
    .filter(Boolean)
    .join("");
}

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
              {workActivityStatusLabel(col.v)} <span className="kanban-count">{items.length}</span>
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
                  {!!t.gen_count && <span title="생성 수">생성 {t.gen_count.toLocaleString()}개</span>}
                  {!!t.credits && <span title="사용 크레딧">{t.credits.toLocaleString()} cr</span>}
                  {!!t.elapsed && <span title="생성시간">⏱ {fmtDuration(t.elapsed)}</span>}
                  {!!t.comment_count && <span title="코멘트">💬 {t.comment_count}</span>}
                  {(t.due_date || t.derived_due) && (
                    <span title={t.due_date ? "마감" : "최근 생성일"}>📅 {t.due_date || t.derived_due}</span>
                  )}
                </div>

                {t.description && <div className="work-card-desc">{t.description}</div>}
              </div>
            ))}
          </div>
    );
  };

  return (
    <div className="kanban kanban-flow">
      {BOARD_COLUMNS.map(renderColumn)}
    </div>
  );
}
