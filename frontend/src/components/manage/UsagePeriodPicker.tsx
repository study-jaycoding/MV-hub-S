import { useEffect, useMemo, useRef, useState } from "react";
import {
  getUsagePeriodRange,
  type UsagePeriodUnit,
  usageDateKey,
} from "../../lib/usagePeriod";

const PERIOD_UNITS: { key: UsagePeriodUnit; label: string }[] = [
  { key: "hour", label: "시간" },
  { key: "day", label: "일" },
  { key: "week", label: "주" },
  { key: "month", label: "월" },
];

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const MONTHS = Array.from({ length: 12 }, (_, index) => `${index + 1}월`);

function monthStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function calendarDays(month: Date): Date[] {
  const first = monthStart(month);
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => (
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
  ));
}

function withAnchorTime(date: Date, anchor: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), anchor.getHours());
}

function CalendarIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M5 3v3m10-3v3M3 8h14M4 5h12v12H4z" />
    </svg>
  );
}

export function UsagePeriodPicker({
  unit,
  anchorDate,
  onUnitChange,
  onDateChange,
}: {
  unit: UsagePeriodUnit;
  anchorDate: Date;
  onUnitChange: (unit: UsagePeriodUnit) => void;
  onDateChange: (date: Date) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => monthStart(anchorDate));
  const range = useMemo(() => getUsagePeriodRange(unit, anchorDate), [anchorDate, unit]);
  const days = useMemo(() => calendarDays(viewMonth), [viewMonth]);
  const rangeStart = usageDateKey(range.start);
  const rangeEnd = usageDateKey(range.end);
  const selectedKey = usageDateKey(anchorDate);
  const today = new Date();
  const todayKey = usageDateKey(today);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="usage-period-picker" ref={rootRef}>
      <button
        type="button"
        className="usage-period-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setViewMonth(monthStart(anchorDate));
          setOpen((current) => !current);
        }}
      >
        <CalendarIcon /><span>{range.label}</span><b>⌄</b>
      </button>
      {open && (
        <div className={`usage-period-popover${unit === "hour" ? " with-hours" : ""}`} role="dialog" aria-label="사용량 기간 선택">
          <nav className="usage-period-units" aria-label="기간 단위">
            {PERIOD_UNITS.map((item) => (
              <button
                type="button"
                key={item.key}
                className={unit === item.key ? "on" : ""}
                onClick={() => onUnitChange(item.key)}
              >
                {item.label}<span>{unit === item.key ? "✓" : "›"}</span>
              </button>
            ))}
          </nav>
          {unit === "month" ? (
            <section className="usage-month-picker">
              <header>
                <button type="button" aria-label="이전 연도" onClick={() => setViewMonth(new Date(viewMonth.getFullYear() - 1, viewMonth.getMonth(), 1))}>‹</button>
                <strong>{viewMonth.getFullYear()}년</strong>
                <button type="button" aria-label="다음 연도" onClick={() => setViewMonth(new Date(viewMonth.getFullYear() + 1, viewMonth.getMonth(), 1))}>›</button>
              </header>
              <div className="usage-month-grid">
                {MONTHS.map((label, month) => {
                  const isSelected = anchorDate.getFullYear() === viewMonth.getFullYear() && anchorDate.getMonth() === month;
                  const isFuture = new Date(viewMonth.getFullYear(), month, 1) > new Date(today.getFullYear(), today.getMonth(), 1);
                  return (
                    <button
                      type="button"
                      key={label}
                      className={isSelected ? "selected" : ""}
                      disabled={isFuture}
                      onClick={() => {
                        onDateChange(new Date(viewMonth.getFullYear(), month, 1, anchorDate.getHours()));
                        setViewMonth(new Date(viewMonth.getFullYear(), month, 1));
                        setOpen(false);
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : (
            <section className="usage-calendar">
              <header>
                <button type="button" aria-label="이전 달" onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}>‹</button>
                <strong>{viewMonth.getFullYear()}년 {viewMonth.getMonth() + 1}월</strong>
                <button type="button" aria-label="다음 달" onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}>›</button>
              </header>
              <div className="usage-calendar-weekdays">
                {WEEKDAYS.map((weekday) => <span key={weekday}>{weekday}</span>)}
              </div>
              <div className="usage-calendar-days">
                {days.map((date) => {
                  const key = usageDateKey(date);
                  const isFuture = date > new Date(today.getFullYear(), today.getMonth(), today.getDate());
                  const classes = [
                    date.getMonth() !== viewMonth.getMonth() ? "outside" : "",
                    key >= rangeStart && key <= rangeEnd ? "in-range" : "",
                    key === rangeStart ? "range-start" : "",
                    key === rangeEnd ? "range-end" : "",
                    key === selectedKey ? "selected" : "",
                    key === todayKey ? "today" : "",
                    isFuture ? "future" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <button
                      type="button"
                      key={key}
                      className={classes}
                      disabled={isFuture}
                      aria-label={`${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`}
                      onClick={() => {
                        const nextDate = withAnchorTime(date, anchorDate);
                        onDateChange(nextDate);
                        setViewMonth(monthStart(date));
                        if (unit !== "hour") setOpen(false);
                      }}
                    >
                      {date.getDate()}
                    </button>
                  );
                })}
              </div>
            </section>
          )}
          {unit === "hour" && (
            <aside className="usage-hour-list" aria-label="시간 선택">
              {Array.from({ length: 24 }, (_, hour) => (
                <button
                  type="button"
                  key={hour}
                  className={anchorDate.getHours() === hour ? "selected" : ""}
                  onClick={() => {
                    onDateChange(new Date(
                      anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate(), hour,
                    ));
                    setOpen(false);
                  }}
                >
                  {String(hour).padStart(2, "0")}:00
                </button>
              ))}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
