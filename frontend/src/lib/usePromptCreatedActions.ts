import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api } from "../api";
import { postLibraryChanged } from "./libraryBroadcast";
import type { Filters, Generation } from "../types";

interface UsePromptCreatedActionsArgs {
  boardFocusIdRef: MutableRefObject<string | null>;
  boardSelectedRef: MutableRefObject<Generation[]>;
  bumpBoard: () => void;
  filtersRef: MutableRefObject<Filters>;
  flash: (message: string) => void;
  reload: () => Promise<void>;
  setGens: Dispatch<SetStateAction<Generation[]>>;
}

export function usePromptCreatedActions({
  boardFocusIdRef,
  boardSelectedRef,
  bumpBoard,
  filtersRef,
  flash,
  reload,
  setGens,
}: UsePromptCreatedActionsArgs) {
  const handlePromptCreated = async (
    created?: Generation[],
    dragParentId?: string | null,
  ) => {
    if (created?.length) {
      setGens((prev) => {
        const ids = new Set(prev.map((g) => g.id));
        const fresh = created.filter((g) => !ids.has(g.id));
        return fresh.length ? [...fresh, ...prev] : prev;
      });
    }
    flash("생성 잡을 시작했습니다.");

    const parents = new Set<string>();
    if (dragParentId) parents.add(dragParentId);
    if (filtersRef.current.tab === "compose") {
      const selIds = boardSelectedRef.current.map((g) => g.id);
      (selIds.length > 0
        ? selIds
        : boardFocusIdRef.current
          ? [boardFocusIdRef.current]
          : []
      ).forEach((parentId) => parents.add(parentId));
    }
    if (parents.size && created?.length) {
      await Promise.all(created.map((g) => api.deriveFrom(g.id, [...parents]).catch(() => {})));
    }
    void reload();
    bumpBoard();
    postLibraryChanged(); // 새 생성물(폴더 라벨 포함)이 관리탭 보드에 즉시 뜨게
  };

  return { handlePromptCreated };
}
