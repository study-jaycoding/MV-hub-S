import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api } from "../api";
import type { Generation } from "../types";
import { singleOrClearSet, toggleSetValue, withoutSetValue } from "./setUtils";

interface UseGenerationFilterActionsArgs {
  flash: (message: string) => void;
  gensRef: MutableRefObject<Generation[]>;
  reload: () => Promise<void>;
  setColorFilter: Dispatch<SetStateAction<Set<string>>>;
  setTagFilter: Dispatch<SetStateAction<Set<string>>>;
  setTagPanelOpen: Dispatch<SetStateAction<boolean>>;
}

export function useGenerationFilterActions({
  flash,
  gensRef,
  reload,
  setColorFilter,
  setTagFilter,
  setTagPanelOpen,
}: UseGenerationFilterActionsArgs) {
  const toggleColorFilter = (hex: string) => {
    setColorFilter((prev) => toggleSetValue(prev, hex));
  };

  const selectTagFilter = (tag: string, additive: boolean) => {
    setTagFilter((prev) => {
      if (additive) return toggleSetValue(prev, tag);
      return singleOrClearSet(prev, tag);
    });
  };

  const clearTagFilter = () => {
    setTagFilter(new Set());
  };

  const deleteTagEverywhere = async (tag: string) => {
    const affected = gensRef.current.filter((g) => g.tags.includes(tag)).length;
    if (!window.confirm(`태그 "#${tag}" 를 ${affected}건에서 삭제할까요?`)) return;
    try {
      await api.deleteTag(tag);
      setTagFilter((prev) => withoutSetValue(prev, tag));
      await reload();
    } catch (e) {
      flash("태그 삭제 실패: " + String(e));
    }
  };

  const toggleTagPanel = () => {
    setTagPanelOpen((open) => {
      if (open) setTagFilter(new Set());
      return !open;
    });
  };

  return {
    clearTagFilter,
    deleteTagEverywhere,
    selectTagFilter,
    toggleColorFilter,
    toggleTagPanel,
  };
}
