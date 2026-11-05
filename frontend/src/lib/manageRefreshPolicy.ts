interface ManageFallbackRefreshState {
  hidden: boolean;
  lastRefreshAt: number;
  now: number;
  minIntervalMs?: number;
}

/** 숨겨진 창은 건너뛰고, 방금 실시간 갱신한 창에는 안전망 요청을 연달아 붙이지 않는다. */
export function shouldRunManageFallbackRefresh({
  hidden,
  lastRefreshAt,
  now,
  minIntervalMs = 5_000,
}: ManageFallbackRefreshState): boolean {
  return !hidden && now - lastRefreshAt >= minIntervalMs;
}

interface ManageRefreshDelayState {
  originless: boolean;
  lastRefreshAt: number;
  now: number;
  debounceMs?: number;
  minIntervalMs?: number;
}

/** 출처 없는 manage 신호(다른 작업자 PC 의 생성 기록 등)는 몰려와도 마지막 재조회 뒤 최소 간격을 둔다.
 *  신호마다 열린 관리 창 전부가 서버의 작업표 계산을 다시 시켰다(2026-11-05). 사람의 편집(출처 있음)은 바로. */
export function manageRefreshDelay({
  originless,
  lastRefreshAt,
  now,
  debounceMs = 180,
  minIntervalMs = 10_000,
}: ManageRefreshDelayState): number {
  return originless ? Math.max(debounceMs, lastRefreshAt + minIntervalMs - now) : debounceMs;
}

/** Bare syncer/legacy signals use the periodic safety refresh; browser-origin writes are immediate. */
export function shouldRefreshManageForLibrarySync(
  origins: readonly unknown[] | null | undefined,
): boolean {
  return Boolean(origins?.length);
}
