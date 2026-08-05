import { useEffect, useRef } from "react";
import { ASSET_CHANNEL_MESSAGES } from "../../lib/appEvents";
import { openAssetBroadcast } from "../../lib/assetBroadcast";
import { INTERNAL_COMBINED_PROJECT, INTERNAL_FOLDERS } from "./assetsViewModel";

interface UseAssetBroadcastSyncArgs {
  dir: string;
  project: string;
  refreshProjectData: (project: string, fresh?: boolean) => Promise<void> | void;
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
        if (!project) return;
        // 합본(imp/cap)을 보고 있으면 captures/imports 변경도 내 화면 변경으로 취급(실시간 반영).
        const relevant =
          projects.includes(project) ||
          (project === INTERNAL_COMBINED_PROJECT &&
            projects.some((p: string) => INTERNAL_FOLDERS.includes(p)));
        if (projects.length && !relevant) return;
        // 백엔드 watcher/파일 변경 API가 캐시를 이미 무효화하므로 일반 조회로 동시 요청을 합친다.
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
