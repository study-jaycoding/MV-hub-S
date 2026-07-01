// 캘린더(타임라인) 뷰 — Notion 타임라인식. 왼쪽 작업명 + 가로 날짜축, 작업의
// start_date~due_date 를 상태색 막대로 표시. 날짜 없는 작업은 날짜 칸 클릭으로 바로 배치(due_date).
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { statusColor, statusLabel, type Task, type WorkViewProps } from "./types";

const CELL = 36; // 하루 칸 너비(px)

function parseYMD(s?: string | null): { y: number; m: number; d: number } | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function CalendarView({ tasks, onPatch }: WorkViewProps) {
  useT();
  const today = new Date();
  const [anchor, setAnchor] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const daysInMonth = new Date(anchor.y, anchor.m + 1, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const isToday = (d: number) =>
    today.getFullYear() === anchor.y && today.getMonth() === anchor.m && today.getDate() === d;
  const dow = (d: number) => new Date(anchor.y, anchor.m, d).getDay(); // 0=일 6=토

  const prev = () => setAnchor((a) => (a.m === 0 ? { y: a.y - 1, m: 11 } : { y: a.y, m: a.m - 1 }));
  const next = () => setAnchor((a) => (a.m === 11 ? { y: a.y + 1, m: 0 } : { y: a.y, m: a.m + 1 }));
  const goToday = () => setAnchor({ y: today.getFullYear(), m: today.getMonth() });

  // 작업의 막대 위치(anchor 월과 교차하는 구간만). 날짜 없으면 null.
  const barFor = (t: Task): { left: number; width: number } | null => {
    const due = parseYMD(t.due_date);
    const start = parseYMD(t.start_date) || due;
    const s = start || due;
    const e = due || start;
    if (!s || !e) return null;
    const monthStart = new Date(anchor.y, anchor.m, 1).getTime();
    const monthEnd = new Date(anchor.y, anchor.m, daysInMonth).getTime();
    const sT = new Date(s.y, s.m, s.d).getTime();
    const eT = new Date(e.y, e.m, e.d).getTime();
    if (eT < monthStart || sT > monthEnd) return null; // 이 달과 안 겹침
    const startDay = sT < monthStart ? 1 : s.d;
    const endDay = eT > monthEnd ? daysInMonth : e.d;
    return { left: (startDay - 1) * CELL, width: (endDay - startDay + 1) * CELL };
  };

  // 날짜 칸 클릭 → 그 날을 due_date 로(빠른 배치)
  const setDay = (t: Task, d: number) =>
    onPatch(t.id, { due_date: `${anchor.y}-${pad(anchor.m + 1)}-${pad(d)}` });

  const trackWidth = daysInMonth * CELL;

  return (
    <div className="work-cal">
      <header className="work-cal-head">
        <span className="work-cal-month">
          {anchor.y}년 {anchor.m + 1}월
        </span>
        <div className="work-cal-nav">
          <button onClick={goToday}>오늘</button>
          <button onClick={prev} title="이전 달">
            ‹
          </button>
          <button onClick={next} title="다음 달">
            ›
          </button>
        </div>
      </header>

      <div className="work-cal-scroll">
        <div className="work-cal-table">
          {/* 날짜 헤더 행 */}
          <div className="work-cal-row work-cal-headrow">
            <div className="work-cal-name work-cal-namehead">Name</div>
            <div className="work-cal-track" style={{ width: trackWidth }}>
              {days.map((d) => (
                <div
                  key={d}
                  className={
                    "work-cal-daycell" +
                    (isToday(d) ? " today" : "") +
                    (dow(d) === 0 || dow(d) === 6 ? " weekend" : "")
                  }
                  style={{ width: CELL }}
                >
                  {d}
                </div>
              ))}
            </div>
          </div>

          {/* 작업 행 */}
          {tasks.map((t) => {
            const bar = barFor(t);
            return (
              <div key={t.id} className="work-cal-row">
                <div className="work-cal-name" title={t.name}>
                  <span className="status-dot" style={{ background: statusColor(t.status) }} />
                  <span className="work-cal-name-txt">{t.name}</span>
                </div>
                <div className="work-cal-track" style={{ width: trackWidth }}>
                  {days.map((d) => (
                    <button
                      key={d}
                      className={
                        "work-cal-slot" +
                        (isToday(d) ? " today" : "") +
                        (dow(d) === 0 || dow(d) === 6 ? " weekend" : "")
                      }
                      style={{ width: CELL }}
                      title={`${anchor.m + 1}/${d} 로 마감 지정`}
                      onClick={() => setDay(t, d)}
                    />
                  ))}
                  {bar && (
                    <div
                      className="work-cal-bar"
                      style={{
                        left: bar.left,
                        width: bar.width,
                        background: statusColor(t.status),
                      }}
                      title={`${t.name} · ${statusLabel(t.status)}`}
                    >
                      <span className="work-cal-bar-txt">{t.name}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {!tasks.length && <div className="manage-empty">작업이 없습니다.</div>}
        </div>
      </div>
      <div className="work-cal-hint">날짜 칸을 클릭하면 그 작업의 마감일이 지정됩니다.</div>
    </div>
  );
}
