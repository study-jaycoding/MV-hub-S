// 라이브러리가 통계(/api/generations-stats)를 마지막으로 받아 반영한 시각 — 벨 배지의 60초 폴링이 방금 받은 것을 다시 묻지 않게.
//  벨 숫자는 그 통계를 props 로 이미 받는다(TopBar → NotificationCenter). 70회차 격리 실측: 폴링이 라이브러리 요청 0.4~1.5초 뒤에 같은 것을 또 물었다.
let appliedAt = 0;

export function markLibraryStatsApplied(): void {
  appliedAt = Date.now();
}

export function libraryStatsFresh(maxAgeMs: number): boolean {
  const age = Date.now() - appliedAt;
  return appliedAt > 0 && age >= 0 && age < maxAgeMs; // 시계가 뒤로 갔으면(시각 맞춤) 새것으로 치지 않는다 — 묻는 쪽이 안전하다
}
