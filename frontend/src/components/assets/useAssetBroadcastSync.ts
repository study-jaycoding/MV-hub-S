import { useEffect, useRef } from "react";
import { ASSET_CHANNEL_MESSAGES } from "../../lib/appEvents";
import { openAssetBroadcast } from "../../lib/assetBroadcast";

interface UseAssetBroadcastSyncArgs {
  dir: string;
  project: string;
  refreshProjectData: (project: string) => Promise<void> | void;
  reloadProjects: (keepCurrent?: boolean) => void;
}

export function useAssetBroadcastSync({
  dir,
  project,
  refreshProjectData,
  reloadProjects,
}: UseAssetBroadcastSyncArgs) {
  const assetBcRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    const bc = openAssetBroadcast();
    if (!bc) return;
    assetBcRef.current = bc;
    bc.onmessage = (event) => {
      if (event.data?.type === ASSET_CHANNEL_MESSAGES.sessionReset) window.location.reload();
      if (event.data?.type === ASSET_CHANNEL_MESSAGES.assetsUpdated) {
        const projects = Array.isArray(event.data.projects) ? event.data.projects : [];
        reloadProjects(true);
        if (!project || (projects.length && !projects.includes(project))) return;
        void refreshProjectData(project);
      }
    };
    return () => {
      if (assetBcRef.current === bc) assetBcRef.current = null;
      bc.close();
    };
  }, [project, refreshProjectData, reloadProjects]);

  useEffect(() => {
    assetBcRef.current?.postMessage({ project, dir });
  }, [project, dir]);
}
