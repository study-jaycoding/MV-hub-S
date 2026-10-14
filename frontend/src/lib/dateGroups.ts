export interface DayInfo {
  key: string;
  label: string;
}

// 파일·항목마다 toLocaleDateString 이 포맷터를 새로 만들던 비용 제거 — 모듈 1회 생성해 재사용
// (출력 문자열은 toLocaleDateString("en-US", 같은 옵션)과 동일).
const DAY_LABEL_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

function localDayInfo(d: Date, fallback: string): DayInfo {
  if (isNaN(d.getTime())) return { key: fallback, label: fallback };
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const label = DAY_LABEL_FORMAT.format(d);
  return { key, label };
}

// created_at(UTC, "YYYY-MM-DD HH:MM:SS") -> local date group.
export function dayInfoFromUtcString(iso: string): DayInfo {
  return localDayInfo(new Date(iso.replace(" ", "T") + "Z"), iso.slice(0, 10));
}

const KST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });

// 서버 시각(UTC — 'YYYY-MM-DD HH:MM:SS' 또는 '…T…Z')을 한국 날짜 'YYYY-MM-DD' 로. 브라우저 시간대에 기대지 않는다.
//  앞 10글자를 그대로 쓰면 새벽(KST 00~09시)에 만든 컷이 전날 칸에 놓였다(작업 달력 — 서버셋 설계 ②).
export function kstDay(ts?: string | null): string | null {
  if (!ts) return null;
  const s = ts.trim().replace(" ", "T");
  const date = new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(date.getTime()) ? ts.slice(0, 10) : KST_DAY.format(date);
}

// file mtime(epoch seconds) -> local date group.
export function dayInfoFromEpochSeconds(mtime?: number | null): DayInfo {
  if (!mtime) return { key: "none", label: "날짜 없음" };
  const info = localDayInfo(new Date(mtime * 1000), "날짜 없음");
  return info.key === "날짜 없음" ? { key: "none", label: "날짜 없음" } : info;
}
