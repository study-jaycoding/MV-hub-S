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
    // 확인창의 수는 지금 목록에서 센 것일 뿐이다(조작 규칙 42) — 삭제는 태그 이름으로 나가, 다른 폴더·아직 불러오지 않은 쪽의 카드에서도
    //  지운다. 전엔 "N건에서 삭제할까요?"라고만 물어 보이는 N건만 지우는 줄 알았다. 끝나면 서버가 실제로 지운 수를 알린다.
    const shown = gensRef.current.filter((g) => g.tags.includes(tag)).length;
    if (!window.confirm(
      `태그 "#${tag}" 를 모든 카드에서 삭제할까요?\n` +
        `지금 목록에 보이는 것은 ${shown}건이지만, 다른 폴더·아직 불러오지 않은 카드에 붙은 것도 함께 지워집니다.`,
    )) return;
    try {
      const { removed } = await api.deleteTag(tag);
      setTagFilter((prev) => withoutSetValue(prev, tag));
      await reload();
      flash(`태그 "#${tag}" 를 ${removed}건에서 삭제했습니다.`);
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
