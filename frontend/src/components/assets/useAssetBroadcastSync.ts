import { useEffect, useRef } from "react";
import { ASSET_CHANNEL_MESSAGES } from "../../lib/appEvents";
import { openAssetBroadcast } from "../../lib/assetBroadcast";
import {
  consumeOwnDomainSync,
  type LibraryMutationOrigin,
} from "../../lib/librarySync";
import { connectProgress } from "../../lib/progressSocket";
import { INTERNAL_COMBINED_PROJECT, INTERNAL_FOLDERS } from "./assetsViewModel";

const ASSET_SYNC_DEBOUNCE_MS = 160;
const SEEN_EVENT_LIMIT = 128;

interface UseAssetBroadcastSyncArgs {
  project: string;
  refreshProjectData: (project: string, fresh?: boolean) => Promise<void> | void;
  reloadProjects: (keepCurrent?: boolean) => void;
  refreshComments?: () => Promise<void> | void;
}

function originEventKey(origins: readonly LibraryMutationOrigin[] | undefined): string | null {
  if (!origins?.length) return null;
  return origins
    .map((origin) => `${origin.client_id}:${origin.mutation_id}`)
    .sort()
    .join("|");
}

function isRelevantProject(current: string, projects: readonly string[]): boolean {
  if (!projects.length) return true;
  return (
    projects.includes(current) ||
    (current === INTERNAL_COMBINED_PROJECT &&
      projects.some((project) => INTERNAL_FOLDERS.includes(project)))
  );
}

export function useAssetBroadcastSync({
  project,
  refreshProjectData,
  reloadProjects,
  refreshComments,
}: UseAssetBroadcastSyncArgs) {
  const projectRef = useRef(project);
  const refreshProjectDataRef = useRef(refreshProjectData);
  const reloadProjectsRef = useRef(reloadProjects);
  const refreshCommentsRef = useRef(refreshComments);
  projectRef.current = project;
  refreshProjectDataRef.current = refreshProjectData;
  reloadProjectsRef.current = reloadProjects;
  refreshCommentsRef.current = refreshComments;

  useEffect(() => {
    const pendingProjects = new Set<string>();
    const seenEvents = new Set<string>();
    let allProjects = false;
    let timer: number | undefined;
    let dirtyWhileHidden = false;

    const flush = () => {
      timer = undefined;
      if (document.hidden) {
        dirtyWhileHidden = true;
        return;
      }
      dirtyWhileHidden = false;
      const changedProjects = allProjects ? [] : [...pendingProjects];
      allProjects = false;
      pendingProjects.clear();

      reloadProjectsRef.current(true);
      const current = projectRef.current;
      if (!current || !isRelevantProject(current, changedProjects)) return;
      void Promise.resolve(refreshProjectDataRef.current(current)).catch(() => {});
      void Promise.resolve(refreshCommentsRef.current?.()).catch(() => {});
    };

    const schedule = (
      projects: readonly string[],
      origins?: readonly LibraryMutationOrigin[],
    ) => {
      const eventKey = originEventKey(origins);
      // 메인 창의 WS→BroadcastChannel 전달과 Assets 창의 직접 WS가 같은 알림을 배달한다.
      // 요청 출처 조합을 한 번만 처리해 트리·메타 API를 두 번 읽지 않는다.
      if (eventKey) {
        if (seenEvents.has(eventKey)) return;
        seenEvents.add(eventKey);
        while (seenEvents.size > SEEN_EVENT_LIMIT) {
          const oldest = seenEvents.values().next().value as string | undefined;
          if (!oldest) break;
          seenEvents.delete(oldest);
        }
      }
      // 같은 Assets 창이 이미 낙관 반영/직접 재조회한 성공 요청은 서버 알림 재조회만 생략한다.
      if (consumeOwnDomainSync("assets", origins)) return;
      if (projects.length) projects.forEach((changed) => pendingProjects.add(changed));
      else allProjects = true;
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(flush, ASSET_SYNC_DEBOUNCE_MS);
    };

    const bc = openAssetBroadcast();
    if (bc) {
      bc.onmessage = (event) => {
        if (event.data?.type === ASSET_CHANNEL_MESSAGES.sessionReset) {
          window.location.reload();
          return;
        }
        if (event.data?.type !== ASSET_CHANNEL_MESSAGES.assetsUpdated) return;
        schedule(
          Array.isArray(event.data.projects) ? event.data.projects : [],
          Array.isArray(event.data.origins) ? event.data.origins : undefined,
        );
      };
    }

    const disconnect = connectProgress(
      (message) => {
        if (message.type !== "assets_changed") return;
        schedule(Array.isArray(message.projects) ? message.projects : [], message.origins);
      },
      () => schedule([]),
    );
    const onVisibility = () => {
      if (!document.hidden && dirtyWhileHidden) schedule([]);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      disconnect();
      bc?.close();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
