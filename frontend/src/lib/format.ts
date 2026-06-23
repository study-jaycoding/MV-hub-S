// 공용 포맷 헬퍼 — 여러 컴포넌트에 똑같이 복붙돼 있던 것을 한곳으로 통합.

// SQLite datetime('now') 형태("YYYY-MM-DD HH:MM:SS", UTC)를 한글 로캘 월/일 시:분으로.
export function fmtWhen(s: string): string {
  const d = new Date(s.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
