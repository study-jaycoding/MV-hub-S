export interface DayInfo {
  key: string;
  label: string;
}

function localDayInfo(d: Date, fallback: string): DayInfo {
  if (isNaN(d.getTime())) return { key: fallback, label: fallback };
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const label = d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return { key, label };
}

// created_at(UTC, "YYYY-MM-DD HH:MM:SS") -> local date group.
export function dayInfoFromUtcString(iso: string): DayInfo {
  return localDayInfo(new Date(iso.replace(" ", "T") + "Z"), iso.slice(0, 10));
}

// file mtime(epoch seconds) -> local date group.
export function dayInfoFromEpochSeconds(mtime?: number | null): DayInfo {
  if (!mtime) return { key: "none", label: "날짜 없음" };
  const info = localDayInfo(new Date(mtime * 1000), "날짜 없음");
  return info.key === "날짜 없음" ? { key: "none", label: "날짜 없음" } : info;
}

export function buildDateGroups<T, K>(
  items: T[],
  dayOf: (item: T) => DayInfo,
  keyOf: (item: T, index: number) => K,
): Map<string, { label: string; keys: K[] }> {
  const groups = new Map<string, { label: string; keys: K[] }>();
  items.forEach((item, index) => {
    const { key, label } = dayOf(item);
    let group = groups.get(key);
    if (!group) {
      group = { label, keys: [] };
      groups.set(key, group);
    }
    group.keys.push(keyOf(item, index));
  });
  return groups;
}
