import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api, connectProgress } from "../api";
import { postAssetsUpdated } from "./assetBroadcast";
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
    const off = connectProgress(
      (m) => {
        if (m.type === "assets_changed") {
          // 어셋 파일 실시간 변경(watchdog) → BroadcastChannel 로 재전파해 어셋 창·캔버스가 각자 갱신.
          postAssetsUpdated(Array.isArray(m.projects) ? m.projects : []);
          return;
        }
        if (m.type === "synced") {
          if (syncedTimer) clearTimeout(syncedTimer);
          syncedTimer = setTimeout(() => {
            syncedTimer = null;
            void reload(true);
            bumpBoard();
            setSyncTick((t) => t + 1);
          }, 400);
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
