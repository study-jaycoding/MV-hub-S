import type { Dispatch, SetStateAction } from "react";
import { singleOrClearSet, toggleSetValue } from "../../lib/setUtils";

interface UseAssetFilterActionsArgs {
  setActiveColors: Dispatch<SetStateAction<Set<string>>>;
  setActiveTags: Dispatch<SetStateAction<Set<string>>>;
  setTagPanelOpen: Dispatch<SetStateAction<boolean>>;
  tagPanelOpen: boolean;
}

export function useAssetFilterActions({
  setActiveColors,
  setActiveTags,
  setTagPanelOpen,
  tagPanelOpen,
}: UseAssetFilterActionsArgs) {
  const toggleTagPanel = () => {
    if (tagPanelOpen) {
      setTagPanelOpen(false);
      setActiveTags(new Set());
    } else {
      setTagPanelOpen(true);
    }
  };

  const selectActiveTag = (tag: string, additive: boolean) => {
    setActiveTags((prev) => (additive ? toggleSetValue(prev, tag) : singleOrClearSet(prev, tag)));
  };

  const toggleColor = (color: string) => {
    setActiveColors((prev) => toggleSetValue(prev, color));
  };

  return { selectActiveTag, toggleColor, toggleTagPanel };
}
