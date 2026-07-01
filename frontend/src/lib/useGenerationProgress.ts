import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api, connectProgress } from "../api";
import type { Generation } from "../types";

interface UseGenerationProgressArgs {
  gensRef: MutableRefObject<Generation[]>;
  setGens: Dispatch<SetStateAction<Generation[]>>;
  reload: (silent?: boolean, light?: boolean) => void | Promise<void>;
  bumpBoard: () => void;
  setSyncTick: Dispatch<SetStateAction<number>>;
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
