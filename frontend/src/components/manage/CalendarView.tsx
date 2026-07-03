// 캘린더 — 두 모드를 토글한다(공통: 월 이동 상태·헤더).
//  · 생성자별: 왼쪽=생성자, 가로 날짜축. 그 생성자가 그날 만든 생성물(컷)을 미니 썸네일로.
//    "누가 언제 무엇을 만들었나" 뷰(작업 타임라인 아님).
//  · 월간: 일반 달력(주=행)에 작업 기간(시작~마감)을 막대로. "시퀀스가 언제 시작해 끝났나" 뷰.
import { useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { MediaThumbnail } from "../MediaThumbnail";
import { MonthlyTaskCalendar } from "./MonthlyTaskCalendar";
import type { Cut, WorkViewProps } from "./types";

const CELL = 40; // 하루 칸 너비(px)
type CalMode = "creator" | "month";

function parseYMD(s?: string | null): { y: number; m: number; d: number } | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
}

export function CalendarView({ tasks, thumb, disabled }: WorkViewProps) {
  useT();
  const today = new Date();
  const [anchor, setAnchor] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [mode, setMode] = useState<CalMode>("month");

  const prev = () => setAnchor((a) => (a.m === 0 ? { y: a.y - 1, m: 11 } : { y: a.y, m: a.m - 1 }));
  const next = () => setAnchor((a) => (a.m === 11 ? { y: a.y + 1, m: 0 } : { y: a.y, m: a.m + 1 }));
  const goToday = () => setAnchor({ y: today.getFullYear(), m: today.getMonth() });

  return (
    <div className="work-cal">
      <header className="work-cal-head">
        <span className="work-cal-month">
          {anchor.y}년 {anchor.m + 1}월
        </span>
        <div className="work-cal-modes">
          <button className={mode === "month" ? "on" : ""} onClick={() => setMode("month")}>
            월간
          </button>
          <button className={mode === "creator" ? "on" : ""} onClick={() => setMode("creator")}>
            생성자별
          </button>
        </div>
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

      {mode === "month" ? (
        <MonthlyTaskCalendar anchor={anchor} tasks={tasks} />
      ) : (
        <CreatorCalendarBody anchor={anchor} tasks={tasks} thumb={thumb} disabled={disabled} />
      )}
    </div>
  );
}

// 생성자별 활동 그리드(기존 뷰) — 헤더는 위 래퍼가 그리고, 여기선 본문만.
function CreatorCalendarBody({
  anchor,
  tasks,
  thumb,
  disabled,
}: {
  anchor: { y: number; m: number };
  tasks: WorkViewProps["tasks"];
  thumb: WorkViewProps["thumb"];
  disabled: WorkViewProps["disabled"];
}) {
  const today = new Date();
  const daysInMonth = new Date(anchor.y, anchor.m + 1, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const isToday = (d: number) =>
    today.getFullYear() === anchor.y && today.getMonth() === anchor.m && today.getDate() === d;
  const dow = (d: number) => new Date(anchor.y, anchor.m, d).getDay();

  // 모든 작업의 컷을 생성자별로 모은다(중복 컷 id 제거 — 여러 작업에 걸칠 수 있음).
  const creators = useMemo(() => {
    const map = new Map<string, { name: string; cuts: Cut[]; seen: Set<string> }>();
    for (const t of tasks) {
      for (const c of t.cuts || []) {
        const key = c.creator_uid || c.creator_name || "미상";
        let e = map.get(key);
        if (!e) {
          e = { name: c.creator_name || "미상", cuts: [], seen: new Set() };
          map.set(key, e);
        }
        if (!e.seen.has(c.id)) {
          e.seen.add(c.id);
          e.cuts.push(c);
        }
      }
    }
    return [...map.values()].map((e) => {
      const byDay: Record<number, Cut[]> = {};
      for (const c of e.cuts) {
        const d = parseYMD(c.created_at);
        if (!d || d.y !== anchor.y || d.m !== anchor.m) continue;
        (byDay[d.d] ||= []).push(c);
      }
      return { name: e.name, byDay, total: e.cuts.length };
    });
  }, [tasks, anchor.y, anchor.m]);

  const trackWidth = daysInMonth * CELL;

  return (
    <>
      <div className="work-cal-scroll">
        <div className="work-cal-table">
          <div className="work-cal-row work-cal-headrow">
            <div className="work-cal-name work-cal-namehead">생성자</div>
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

          {creators.map((cr) => (
            <div key={cr.name} className="work-cal-row">
              <div className="work-cal-name" title={cr.name}>
                <span className="work-cal-name-txt">👤 {cr.name}</span>
                <span className="work-cal-name-count">{cr.total}</span>
              </div>
              <div className="work-cal-track" style={{ width: trackWidth }}>
                {days.map((d) => {
                  const cuts = cr.byDay[d] || [];
                  const first = cuts[0];
                  const off = first ? disabled.has(first.id) : false;
                  const cls =
                    "work-cal-gencell" +
                    (isToday(d) ? " today" : "") +
                    (dow(d) === 0 || dow(d) === 6 ? " weekend" : "");
                  return (
                    <div key={d} className={cls} style={{ width: CELL }}>
                      {first && (
                        <span
                          className={
                            "work-cut" +
                            (first.is_final ? " final" : first.shared ? " shared" : "") +
                            (off ? " deactivated" : "")
                          }
                          title={`${cr.name} · ${anchor.m + 1}/${d} · ${cuts.length}개`}
                        >
                          <MediaThumbnail
                            thumb={thumb(first.thumb)}
                            isVideo={first.media_type === "video"}
                            src={first.media_type === "video" ? first.file_path ?? undefined : undefined}
                            fallback={<span className="work-cut-ph" />}
                          />
                          {cuts.length > 1 && (
                            <span className="work-cal-gen-more">+{cuts.length - 1}</span>
                          )}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {!creators.length && <div className="manage-empty">생성물이 없습니다.</div>}
        </div>
      </div>
      <div className="work-cal-hint">생성자별로 그날 만든 생성물이 표시됩니다(생성일 기준).</div>
    </>
  );
}
