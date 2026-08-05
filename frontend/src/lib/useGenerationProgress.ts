import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api, connectProgress } from "../api";
import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { postAssetsUpdated } from "./assetBroadcast";
import {
  decideLibrarySync,
  trackBareSyncedForReload,
  trackOwnSyncedForReload,
  type LibraryMutationOrigin,
} from "./librarySync";
import { isKnownGen, observeStatus } from "./sceneRecentDoneStore";
import type { Generation } from "../types";

interface UseGenerationProgressArgs {
  gensRef: MutableRefObject<Generation[]>;
  setGens: Dispatch<SetStateAction<Generation[]>>;
  reload: (silent?: boolean, light?: boolean) => void | Promise<void>;
  bumpBoard: () => void;
  setSyncTick: Dispatch<SetStateAction<number>>;
}

const ACTIVE_PROGRESS_STATUSES = new Set(["pending", "queued", "running", "processing"]);
const SYNC_DEBOUNCE_MS = 400;
const SYNC_WAIT_POLL_MS = 100;
const SYNC_WAIT_MAX_MS = 5000;

export function shouldObserveProgressStatus(
  generationId: string | null | undefined,
  status: string | null | undefined,
  known: (id: string) => boolean = isKnownGen,
): boolean {
  return Boolean(
    generationId && status && (ACTIVE_PROGRESS_STATUSES.has(status) || known(generationId)),
  );
}

export function useGenerationProgress({
  gensRef,
  setGens,
  reload,
  bumpBoard,
  setSyncTick,
}: UseGenerationProgressArgs) {
  useEffect(() => {
    let syncedTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingSyncOrigins: LibraryMutationOrigin[] | undefined;
    let forceFullSync = false;
    let pendingSyncSince = 0;

    const flushSynced = () => {
      syncedTimer = null;
      if (pendingSyncOrigins === undefined) return;
      const wasBareSync = forceFullSync;
      const decision = decideLibrarySync(wasBareSync ? undefined : pendingSyncOrigins);
      // 내 변경을 포함한 목록 요청이 아직 진행 중이면 끝날 때까지 짧게 기다린다. 실패하면 inflight
      // 표식이 사라져 reload로 전환한다. 비정상적으로 오래 걸리면 5초 뒤 안전하게 한 번 더 읽는다.
      if (decision === "wait" && Date.now() - pendingSyncSince < SYNC_WAIT_MAX_MS) {
        syncedTimer = setTimeout(flushSynced, SYNC_WAIT_POLL_MS);
        return;
      }
      const flushedOrigins = pendingSyncOrigins;
      pendingSyncOrigins = undefined;
      forceFullSync = false;
      pendingSyncSince = 0;
      if (decision !== "skip") {
        if (wasBareSync) trackBareSyncedForReload();
        // bare와 요청 출처가 같은 debounce 묶음에 섞여도, HTTP 응답보다 먼저 온 내 mutation id를
        // 곧 시작할 reload가 함께 덮도록 별도로 추적한다. 순수 bare에서는 빈 배열이라 no-op이다.
        trackOwnSyncedForReload(flushedOrigins);
        void reload(true);
        // 외부 기기·다른 창 변경은 현재 SceneBoard의 완료 카드 데이터와 사이드바 카운트도
        // 갱신해야 한다. 전체 목록 reload만으로는 compose 탭의 useSceneGenData가 깨어나지 않는다.
        dispatchAppEvent(APP_EVENTS.libraryChanged);
      }
      // 목록 reload를 생략해도 열린 코멘트와 히스토리 보드는 가벼운 자기 갱신 신호를 받는다.
      bumpBoard();
      setSyncTick((t) => t + 1);
    };

    const queueSynced = (origins: LibraryMutationOrigin[] | undefined) => {
      if (pendingSyncOrigins === undefined) {
        pendingSyncOrigins = [];
        pendingSyncSince = Date.now();
      }
      if (!origins?.length) forceFullSync = true;
      else pendingSyncOrigins.push(...origins);
      if (syncedTimer) clearTimeout(syncedTimer);
      syncedTimer = setTimeout(flushSynced, SYNC_DEBOUNCE_MS);
    };

    const off = connectProgress(
      (m) => {
        if (m.type === "assets_changed") {
          // 어셋 파일 실시간 변경(watchdog) → BroadcastChannel 로 재전파해 어셋 창·캔버스가 각자 갱신.
          postAssetsUpdated(Array.isArray(m.projects) ? m.projects : [], m.origins);
          return;
        }
        if (m.type === "synced") {
          queueSynced(m.origins);
          return;
        }
        if (!m.status) return;
        // 서버가 확정 상태를 push한 즉시 캔버스 glow 전환도 반영한다. 다만 create 응답(seedPending)보다
        // 초고속 done이 먼저 온 미확정 id를 settled로 박으면 glow를 잃으므로, active이거나 이미 아는 id만.
        // 배치 폴링은 WS 누락·재연결의 안전망으로 남는다.
        if (m.generation_id && shouldObserveProgressStatus(m.generation_id, m.status)) {
          observeStatus(m.generation_id, m.status);
        }
        setGens((prev) =>
          prev.map((g) =>
            g.id === m.generation_id ? { ...g, status: m.status! } : g,
          ),
        );
        if (m.status === "done" && m.generation_id) {
          const doneId = m.generation_id;
          api
            .getGeneration(doneId)
            .then((fresh) => {
              if (gensRef.current.some((g) => g.id === fresh.id)) {
                setGens((prev) => prev.map((g) => (g.id === fresh.id ? fresh : g)));
              } else {
                void reload(true, true);
              }
            })
            .catch(() => void reload(true, true));
          bumpBoard();
        }
      },
      () => void reload(true),
    );
    return () => {
      if (syncedTimer) clearTimeout(syncedTimer);
      off();
    };
  }, [bumpBoard, gensRef, reload, setGens, setSyncTick]);
}
