import { useEffect, useMemo, useRef, useState } from "react";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function dateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function monthStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function calendarDays(month: Date): Date[] {
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
  return Array.from({ length: 42 }, (_, index) => (
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
  ));
}

function CalendarIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M5 3v3m10-3v3M3 8h14M4 5h12v12H4z" />
    </svg>
  );
}

export function ProjectDateRangePicker({
  startDate,
  dueDate,
  onChange,
}: {
  startDate?: string | null;
  dueDate?: string | null;
  onChange: (startDate: string, dueDate: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"start" | "end">("start");
  const [viewMonth, setViewMonth] = useState(() => monthStart(parseDate(startDate) || new Date()));
  const days = useMemo(() => calendarDays(viewMonth), [viewMonth]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);

  const openCalendar = (nextPhase: "start" | "end") => {
    const focusDate = parseDate(nextPhase === "end" ? dueDate : startDate)
      || parseDate(startDate)
      || new Date();
    setViewMonth(monthStart(focusDate));
    setPhase(nextPhase);
    setOpen(true);
  };

  const selectDate = (selected: string) => {
    if (phase === "start") {
      onChange(selected, dueDate && dueDate >= selected ? dueDate : "");
      setPhase("end");
      return;
    }
    if (!startDate || selected < startDate) {
      onChange(selected, "");
      setPhase("end");
      return;
    }
    onChange(startDate, selected);
    setOpen(false);
  };

  return (
    <div className="project-date-range" ref={rootRef}>
      <label className="manage-field">
        <span>시작일</span>
        <button
          type="button"
          className={`manage-date-button${open && phase === "start" ? " on" : ""}`}
          onClick={() => openCalendar("start")}
        >
          <span>{startDate || "연도-월-일"}</span><CalendarIcon />
        </button>
      </label>
      <label className="manage-field">
        <span>마감일</span>
        <button
          type="button"
          className={`manage-date-button${open && phase === "end" ? " on" : ""}`}
          onClick={() => openCalendar("end")}
        >
          <span>{dueDate || "연도-월-일"}</span><CalendarIcon />
        </button>
      </label>
      {open && (
        <div className="project-range-popover" role="dialog" aria-label="프로젝트 시작일과 마감일 선택">
          <header>
            <button type="button" aria-label="이전 달" onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}>‹</button>
            <strong>{viewMonth.getFullYear()}년 {viewMonth.getMonth() + 1}월</strong>
            <button type="button" aria-label="다음 달" onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}>›</button>
          </header>
          <p>{phase === "start" ? "시작일을 선택하세요" : "마감일을 선택하세요"}</p>
          <div className="project-range-weekdays">
            {WEEKDAYS.map((weekday) => <span key={weekday}>{weekday}</span>)}
          </div>
          <div className="project-range-days">
            {days.map((date) => {
              const key = dateKey(date);
              const classes = [
                date.getMonth() !== viewMonth.getMonth() ? "outside" : "",
                startDate && dueDate && key >= startDate && key <= dueDate ? "in-range" : "",
                key === startDate ? "range-start" : "",
                key === dueDate ? "range-end" : "",
              ].filter(Boolean).join(" ");
              return (
                <button
                  type="button"
                  key={key}
                  className={classes}
                  aria-label={`${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`}
                  onClick={() => selectDate(key)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <footer>
            <span>{startDate || "시작일"} → {dueDate || "마감일"}</span>
            <button type="button" onClick={() => { onChange("", ""); setPhase("start"); }}>일정 지우기</button>
          </footer>
        </div>
      )}
    </div>
  );
}
