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
    // 새 생성물은 내 로컬 카드다 — 공유 & 리뷰 목록에는 넣지 않는다(공유 전이라 그 목록의 것이 아니다). 제출해 놓고 응답이
    //  오기 전에 그 탭으로 가거나 편집 탭에서 폴더 창을 열면(목록은 공유 & 리뷰의 것), 로컬 카드가 팀 카드 사이에 끼어
    //  로컬 id 로 팀 요청(폴더 담기 등)이 나갈 수 있었다(Codex 코드 리뷰 2026-10-08). 아래 reload 가 제자리를 찾아 준다.
    if (created?.length && filtersRef.current.tab !== "team") {
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
