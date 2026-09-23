// 공용 포맷 헬퍼 — 여러 컴포넌트에 똑같이 복붙돼 있던 것을 한곳으로 통합.

// SQLite datetime('now') 형태("YYYY-MM-DD HH:MM:SS", UTC)를 한글 로캘 월/일 시:분으로.
export function timestampMs(s: string): number {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : iso + "Z";
  return new Date(normalized).getTime();
}

// 소요시간(초) → "1d2h3m4s". 0인 단위는 생략하되 **초를 버리지 않고**, 하루 이상은 "1d1h" 로 쓴다
// (Jay 2026-09-18 확정). PM 창의 대시보드·사용량·칸반·캘린더·표와 정보 팝업의 '생성 시간'이 이 함수
// 하나를 쓴다 — 예전엔 6벌이 갈려 같은 3661초가 "1h1m"·"1h1m1s"·"61분 1초" 로 보였다.
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

// 백업·동기화 시각 — 서버가 주는 ISO(`created_at`)가 있으면 그것, 없으면 파일 시각(`mtime`, 초)으로.
// ★일부러 `fmtWhen` 을 쓰지 않는다: 이 자리는 **연·월·일·시·분·초를 다 보여야** 하고(어느 백업인지 고르는 화면),
// `fmtWhen` 은 월/일·시:분만 낸다. 기존 네이티브 표기를 그대로 보존하려고 `toLocaleString()` 을 그냥 부른다.
export function fmtBackupWhen(createdAt?: string | null, mtimeSeconds?: number | null): string {
  return new Date(createdAt || (mtimeSeconds ?? 0) * 1000).toLocaleString();
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
