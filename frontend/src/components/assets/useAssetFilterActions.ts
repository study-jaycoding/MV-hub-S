import type { Dispatch, SetStateAction } from "react";
import type { Store } from "../../lib/storage";
import { singleOrClearSet, toggleSetValue } from "../../lib/setUtils";

interface UseAssetFilterActionsArgs {
  muteOwn: boolean;
  setActiveColors: Dispatch<SetStateAction<Set<string>>>;
  setActiveTags: Dispatch<SetStateAction<Set<string>>>;
  setMuteOwn: Dispatch<SetStateAction<boolean>>;
  setTagPanelOpen: Dispatch<SetStateAction<boolean>>;
  store: Store;
  tagPanelOpen: boolean;
}

export function useAssetFilterActions({
  muteOwn,
  setActiveColors,
  setActiveTags,
  setMuteOwn,
  setTagPanelOpen,
  store,
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

  const toggleMuteOwn = () => {
    const next = !muteOwn;
    setMuteOwn(next);
    store.set("muteOwn", next ? "1" : "0");
  };

  return { selectActiveTag, toggleColor, toggleMuteOwn, toggleTagPanel };
}
