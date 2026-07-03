// 월간 작업 캘린더 — 일반 달력(주=행, 일~토 7칸)에 작업 기간(시작~마감)을 막대로 표시.
// 기간이 여러 주에 걸치면 주 단위로 잘라 그린다(주마다 겹치는 작업만 레인에 배치).
// 시작/마감은 PM 입력값 우선, 없으면 파생값(연결 생성물 생성일 범위). 날짜 없는 작업은 표시 안 함.
import { useMemo } from "react";
import { statusColor, statusLabel, type Task } from "./types";

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

function parseYMD(s?: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// 작업의 실효 기간(PM값 ?? 파생값). 둘 다 없으면 null(달력에 안 올림).
function taskSpan(t: Task): { start: Date; end: Date; label: string } | null {
  const start = parseYMD(t.start_date || t.derived_start);
  const end = parseYMD(t.due_date || t.derived_due) || start;
  if (!start || !end) return null;
  const s = start <= end ? start : end;
  const e = start <= end ? end : start;
  const seq = [t.name, t.sequence].filter(Boolean).join(" ");
  return { start: s, end: e, label: seq || t.name || "작업" };
}

export function MonthlyTaskCalendar({
  anchor,
  tasks,
}: {
  anchor: { y: number; m: number };
  tasks: Task[];
}) {
  const today = new Date();
  const todayStr = ymd(today);

  // 이 달을 감싸는 주 격자(직전 달 말 ~ 다음 달 초 포함) — 일요일 시작.
  const weeks = useMemo(() => {
    const first = new Date(anchor.y, anchor.m, 1);
    const daysInMonth = new Date(anchor.y, anchor.m + 1, 0).getDate();
    const gridStart = addDays(first, -first.getDay()); // 그 주의 일요일
    const nWeeks = Math.ceil((first.getDay() + daysInMonth) / 7); // 필요한 주 수(4~6)
    const rows: Date[][] = [];
    let cur = gridStart;
    for (let w = 0; w < nWeeks; w++) {
      const row: Date[] = [];
      for (let i = 0; i < 7; i++) {
        row.push(cur);
        cur = addDays(cur, 1);
      }
      rows.push(row);
    }
    return rows;
  }, [anchor.y, anchor.m]);

  const spans = useMemo(
    () => tasks.map((t) => ({ t, span: taskSpan(t) })).filter((x) => x.span) as {
      t: Task;
      span: { start: Date; end: Date; label: string };
    }[],
    [tasks],
  );

  // 한 주(7일)에서 각 작업이 차지하는 [시작칸, 끝칸]을 계산하고, 겹치지 않게 레인(위→아래)에 쌓는다.
  const weekBars = (week: Date[]) => {
    const wkStart = week[0];
    const wkEnd = week[6];
    const bars = spans
      .filter((x) => x.span.end >= wkStart && x.span.start <= wkEnd)
      .map((x) => {
        const s = x.span.start < wkStart ? wkStart : x.span.start;
        const e = x.span.end > wkEnd ? wkEnd : x.span.end;
        const col = Math.round((s.getTime() - wkStart.getTime()) / 86400000);
        const endCol = Math.round((e.getTime() - wkStart.getTime()) / 86400000);
        return { t: x.t, col, span: endCol - col + 1, label: x.span.label };
      })
      .sort((a, b) => a.col - b.col || b.span - a.span);
    // 레인 배정 — 각 레인의 마지막 점유 칸을 추적해 겹치면 다음 레인.
    const laneEnd: number[] = [];
    const placed = bars.map((b) => {
      let lane = 0;
      while (lane < laneEnd.length && laneEnd[lane] >= b.col) lane++;
      laneEnd[lane] = b.col + b.span - 1;
      return { ...b, lane };
    });
    return { placed, lanes: laneEnd.length };
  };

  return (
    <div className="mcal">
      <div className="mcal-dow">
        {DOW.map((d, i) => (
          <div key={d} className={"mcal-dowcell" + (i === 0 || i === 6 ? " weekend" : "")}>
            {d}
          </div>
        ))}
      </div>
      <div className="mcal-grid">
        {weeks.map((week, wi) => {
          const { placed, lanes } = weekBars(week);
          return (
            <div key={wi} className="mcal-week" style={{ minHeight: 64 + lanes * 20 }}>
              {/* 날짜 셀(배경) */}
              <div className="mcal-daycells">
                {week.map((d) => {
                  const inMonth = d.getMonth() === anchor.m;
                  const isToday = ymd(d) === todayStr;
                  const wknd = d.getDay() === 0 || d.getDay() === 6;
                  return (
                    <div
                      key={d.getTime()}
                      className={
                        "mcal-day" +
                        (inMonth ? "" : " out") +
                        (isToday ? " today" : "") +
                        (wknd ? " weekend" : "")
                      }
                    >
                      <span className="mcal-daynum">{d.getDate()}</span>
                    </div>
                  );
                })}
              </div>
              {/* 작업 막대(레인) */}
              <div className="mcal-bars">
                {placed.map((b) => (
                  <div
                    key={b.t.id}
                    className="mcal-bar"
                    style={{
                      left: `calc(${(b.col / 7) * 100}% + 2px)`,
                      width: `calc(${(b.span / 7) * 100}% - 4px)`,
                      top: 22 + b.lane * 20,
                      background: statusColor(b.t.status) + "33",
                      borderLeft: `3px solid ${statusColor(b.t.status)}`,
                    }}
                    title={`${b.label} · ${statusLabel(b.t.status)}`}
                  >
                    <span className="mcal-bar-txt">{b.label}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {!spans.length && <div className="manage-empty">기간이 있는 작업이 없습니다.</div>}
    </div>
  );
}
