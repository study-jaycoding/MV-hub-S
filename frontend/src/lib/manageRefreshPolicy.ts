interface ManageFallbackRefreshState {
  loading: boolean;
  lastLoadAt: number;
  now: number;
  minIntervalMs?: number;
}

/** A polling/focus safety refresh must not trail a realtime refresh that just started. */
export function shouldRunManageFallbackRefresh({
  loading,
  lastLoadAt,
  now,
  minIntervalMs = 5_000,
}: ManageFallbackRefreshState): boolean {
  return !loading && now - lastLoadAt >= minIntervalMs;
}

/** Bare syncer/legacy signals use the periodic safety refresh; browser-origin writes are immediate. */
export function shouldRefreshManageForLibrarySync(
  origins: readonly unknown[] | null | undefined,
): boolean {
  return Boolean(origins?.length);
}
