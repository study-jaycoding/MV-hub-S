// 공용 포맷 헬퍼 — 여러 컴포넌트에 똑같이 복붙돼 있던 것을 한곳으로 통합.

// SQLite datetime('now') 형태("YYYY-MM-DD HH:MM:SS", UTC)를 한글 로캘 월/일 시:분으로.
export function timestampMs(s: string): number {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : iso + "Z";
  return new Date(normalized).getTime();
}

// 소요시간(초) → "1d2h3m4s". 0인 단위는 생략하되 **초를 버리지 않는다**(Jay 2026-09-18 "초까지 보이게").
// PM 창의 대시보드·사용량·칸반·캘린더·표가 이 함수 하나를 쓴다 — 예전엔 5벌이 갈려 같은 작업의
// 3661초가 어디선 "1h1m", 어디선 "1h1m1s" 로 보였다.
export function fmtElapsed(sec?: number | null): string {
  if (!sec || sec <= 0) return "—";
  let rest = Math.floor(sec);
  const d = Math.floor(rest / 86400);
  rest %= 86400;
  const h = Math.floor(rest / 3600);
  rest %= 3600;
  const m = Math.floor(rest / 60);
  const s = rest % 60;
  return `${d ? `${d}d` : ""}${h ? `${h}h` : ""}${m ? `${m}m` : ""}${s || !(d || h || m) ? `${s}s` : ""}`;
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
