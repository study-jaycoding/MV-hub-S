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

/** Bare syncer/legacy signals use the periodic safety refresh; browser-origin writes are immediate. */
export function shouldRefreshManageForLibrarySync(
  origins: readonly unknown[] | null | undefined,
): boolean {
  return Boolean(origins?.length);
}
