export type UsagePeriodUnit = "hour" | "day" | "week" | "month";
export type UsageTrendBucket = "minute" | "hour" | "day";

export interface UsagePeriodRange {
  unit: UsagePeriodUnit;
  bucket: UsageTrendBucket;
  start: Date;
  end: Date;
  dateFrom: string;
  dateTo: string;
  timeFrom?: string;
  timeTo?: string;
  label: string;
}

export interface UsageTrendRowLike {
  bucket: string;
  count: number;
  credits: number;
  elapsed_seconds?: number;
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, amount: number): Date {
  const next = startOfDay(value);
  next.setDate(next.getDate() + amount);
  return next;
}

export function usageDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shortDate(value: Date): string {
  return `${String(value.getMonth() + 1).padStart(2, "0")}.${String(value.getDate()).padStart(2, "0")}`;
}

export function getUsagePeriodRange(unit: UsagePeriodUnit, anchor: Date): UsagePeriodRange {
  const selected = startOfDay(anchor);
  let start = selected;
  let end = selected;
  let bucket: UsageTrendBucket = "day";

  let timeFrom: string | undefined;
  let timeTo: string | undefined;
  if (unit === "hour") {
    bucket = "minute";
    start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), anchor.getHours(), 0, 0);
    end = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), anchor.getHours(), 59, 59);
    const hour = String(anchor.getHours()).padStart(2, "0");
    timeFrom = `${usageDateKey(selected)}T${hour}:00:00`;
    timeTo = `${usageDateKey(selected)}T${hour}:59:59`;
  } else if (unit === "day") {
    bucket = "hour";
  } else if (unit === "week") {
    const distanceFromMonday = (selected.getDay() + 6) % 7;
    start = addDays(selected, -distanceFromMonday);
    end = addDays(start, 6);
  } else if (unit === "month") {
    start = new Date(selected.getFullYear(), selected.getMonth(), 1);
    end = new Date(selected.getFullYear(), selected.getMonth() + 1, 0);
  }

  const unitLabel = { hour: "시간", day: "일", week: "주", month: "월" }[unit];
  const label = unit === "hour"
    ? `${unitLabel}: ${String(anchor.getHours()).padStart(2, "0")}:00 ~ ${String(anchor.getHours()).padStart(2, "0")}:59 · ${shortDate(selected)}.${selected.getFullYear()}`
    : unit === "month"
    ? `${unitLabel}: ${selected.getFullYear()}.${String(selected.getMonth() + 1).padStart(2, "0")}`
    : start.getTime() === end.getTime()
      ? `${unitLabel}: ${shortDate(start)}.${start.getFullYear()}`
      : `${unitLabel}: ${shortDate(start)} ~ ${shortDate(end)}.${end.getFullYear()}`;

  return {
    unit,
    bucket,
    start,
    end,
    dateFrom: usageDateKey(start),
    dateTo: usageDateKey(end),
    timeFrom,
    timeTo,
    label,
  };
}

export function fillUsageTrendBuckets(
  rows: UsageTrendRowLike[],
  range: UsagePeriodRange,
): UsageTrendRowLike[] {
  if (range.bucket !== "day" && rows.some((row) => !row.bucket.includes("T"))) {
    // 재시작 전 구백엔드는 minute/hour 요청을 day로 돌려준다. 값 자체는 숨기지 않는다.
    return rows;
  }

  const rowByBucket = new Map(rows.map((row) => [row.bucket, row]));
  const keys: string[] = [];
  if (range.bucket === "minute") {
    const hour = String(range.start.getHours()).padStart(2, "0");
    const prefix = `${usageDateKey(range.start)}T${hour}`;
    for (let minute = 0; minute < 60; minute += 1) {
      keys.push(`${prefix}:${String(minute).padStart(2, "0")}`);
    }
  } else if (range.bucket === "hour") {
    const day = usageDateKey(range.start);
    for (let hour = 0; hour < 24; hour += 1) {
      keys.push(`${day}T${String(hour).padStart(2, "0")}:00`);
    }
  } else {
    for (let cursor = range.start; cursor <= range.end; cursor = addDays(cursor, 1)) {
      keys.push(usageDateKey(cursor));
    }
  }

  return keys.map((bucket) => rowByBucket.get(bucket) || {
    bucket,
    count: 0,
    credits: 0,
    elapsed_seconds: 0,
  });
}

export function formatUsageTrendBucket(bucket: string, unit?: UsagePeriodUnit): string {
  if (bucket.includes("T")) return bucket.slice(11, 16);
  const month = Number(bucket.slice(5, 7));
  const day = Number(bucket.slice(8, 10));
  if (unit === "month") return String(day);
  if (unit === "week") return `${month}.${day}`;
  return bucket.slice(5);
}

export function showUsageTrendLabel(unit: UsagePeriodUnit, index: number, total: number): boolean {
  if (unit === "hour") {
    const lastLabelIndex = Math.max(0, total - 2);
    return Array.from({ length: 9 }, (_, tick) => (
      Math.round((lastLabelIndex * tick) / 8)
    )).includes(index);
  }
  if (unit === "day") return index % 3 === 0;
  if (unit === "month") return index % 4 === 0;
  return true;
}
