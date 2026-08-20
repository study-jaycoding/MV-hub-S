// 공용 포맷 헬퍼 — 여러 컴포넌트에 똑같이 복붙돼 있던 것을 한곳으로 통합.

// SQLite datetime('now') 형태("YYYY-MM-DD HH:MM:SS", UTC)를 한글 로캘 월/일 시:분으로.
export function timestampMs(s: string): number {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : iso + "Z";
  return new Date(normalized).getTime();
}

export function fmtWhen(s: string): string {
  const d = new Date(timestampMs(s));
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtRelativeWhen(s: string, now = Date.now()): string {
  const d = new Date(timestampMs(s));
  if (isNaN(d.getTime())) return s;
  const seconds = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (seconds < 60) return "방금 전";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}일 전` : fmtWhen(s);
}
