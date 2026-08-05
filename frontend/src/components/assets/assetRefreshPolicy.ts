export type AssetResumeRefreshAction = "none" | "flush" | "tree";

interface AssetResumeRefreshState {
  hidden: boolean;
  dirtyWhileHidden: boolean;
  refreshScheduled: boolean;
  elapsedMs: number;
  fallbackIntervalMs?: number;
}

/**
 * Pick exactly one refresh path when an Assets window becomes visible.
 * A real change signal has priority over the periodic tree-only safety check.
 */
export function assetResumeRefreshAction({
  hidden,
  dirtyWhileHidden,
  refreshScheduled,
  elapsedMs,
  fallbackIntervalMs = 30_000,
}: AssetResumeRefreshState): AssetResumeRefreshAction {
  if (hidden) return "none";
  if (dirtyWhileHidden) return "flush";
  if (refreshScheduled) return "none";
  return elapsedMs >= fallbackIntervalMs ? "tree" : "none";
}
