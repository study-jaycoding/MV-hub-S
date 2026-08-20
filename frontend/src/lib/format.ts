// 공용 포맷 헬퍼 — 여러 컴포넌트에 똑같이 복붙돼 있던 것을 한곳으로 통합.

// SQLite datetime('now') 형태("YYYY-MM-DD HH:MM:SS", UTC)를 한글 로캘 월/일 시:분으로.
export function timestampMs(s: string): number {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : iso + "Z";
  return new Date(normalized).getTime();
}

export function fmtWhen(s: string, locale = "ko-KR"): string {
  const d = new Date(timestampMs(s));
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString(locale, {
    month: locale.startsWith("ko") ? "numeric" : "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
