import { ASSET_CHANNEL_MESSAGES, BROADCAST_CHANNELS } from "./appEvents";
import type { LibraryMutationOrigin } from "./librarySync";

export type AssetBroadcastMessage =
  | { type: typeof ASSET_CHANNEL_MESSAGES.sessionReset }
  | {
      type: typeof ASSET_CHANNEL_MESSAGES.assetsUpdated;
      projects?: string[];
      origins?: LibraryMutationOrigin[];
    };

export function openAssetBroadcast(): BroadcastChannel | null {
  try {
    if (!("BroadcastChannel" in window)) return null;
    return new BroadcastChannel(BROADCAST_CHANNELS.assets);
  } catch {
    return null;
  }
}

export function postAssetBroadcast(message: AssetBroadcastMessage): void {
  const bc = openAssetBroadcast();
  if (!bc) return;
  try {
    bc.postMessage(message);
  } finally {
    bc.close();
  }
}

export function postAssetSessionReset(): void {
  postAssetBroadcast({ type: ASSET_CHANNEL_MESSAGES.sessionReset });
}

export function postAssetsUpdated(
  projects: string[],
  origins?: LibraryMutationOrigin[],
): void {
  postAssetBroadcast({ type: ASSET_CHANNEL_MESSAGES.assetsUpdated, projects, origins });
}
