// 공유&리뷰(team) 탭 '마지막으로 본 시각' — 새로 들어온 생성물 표시(카드 글로우·사이드바 라임 배지)의 기준선.
//  · 계정별 네임스페이스(씬과 동일 규칙) — 한 브라우저를 여러 계정이 써도 안 섞인다.
//  · 값 형식은 서버 share.shared_at 과 동일한 UTC "YYYY-MM-DD HH:MM:SS" —
//    서버 folder-counts?since= 비교와 클라이언트 문자열 비교(사전순=시간순)에 공용.
//  · 갱신 시점은 '팀 탭을 떠날 때'(App 이 호출) — 탭에 머무는 동안은 입장 전 기준선이 유지돼
//    보고 있는 중에도 글로우가 꺼지지 않는다. 최초 방문(기준선 없음)은 아무것도 새것 취급 안 함.
import { loadJSON, loadString, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

const ns = () => {
  const acct = loadString(STORAGE_KEYS.activeAccount);
  return acct ? `acct:${acct}` : "local";
};

export function utcNowSql(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export function getTeamLastSeen(): string | null {
  const map = loadJSON<Record<string, string>>(STORAGE_KEYS.teamSeen) || {};
  return map[ns()] || null;
}

export function markTeamSeenNow(): void {
  const map = loadJSON<Record<string, string>>(STORAGE_KEYS.teamSeen) || {};
  map[ns()] = utcNowSql();
  saveJSON(STORAGE_KEYS.teamSeen, map);
}

// shared_at 이 기준선 이후인가 — 같은 UTC 고정폭 형식이라 문자열 비교가 시간 비교와 일치.
export function isSharedAfter(
  sharedAt: string | null | undefined,
  baseline: string | null | undefined,
): boolean {
  return !!sharedAt && !!baseline && sharedAt > baseline;
}
