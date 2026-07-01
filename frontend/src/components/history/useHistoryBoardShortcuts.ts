import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { toggleDisabledGen } from "../../lib/deactivated";
import { matchShortcut } from "../../lib/shortcuts";
import type { XY } from "../../lib/historyGraphLayout";

export function useHistoryBoardShortcuts({
  focusId,
  selectedRef,
  setManualPos,
}: {
  focusId: string | null;
  selectedRef: MutableRefObject<Set<string>>;
  setManualPos: Dispatch<SetStateAction<Record<string, XY>>>;
}) {
  useEffect(() => {
    if (!focusId) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (matchShortcut(event, "boardDisable")) {
        const ids = [...selectedRef.current];
        if (!ids.length) return;
        event.preventDefault();
        toggleDisabledGen(ids);
      } else if (matchShortcut(event, "boardArrange")) {
        event.preventDefault();
        setManualPos((prev) => {
          const ids = [...selectedRef.current];
          if (!ids.length) return {};
          const next = { ...prev };
          ids.forEach((id) => delete next[id]);
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusId, selectedRef, setManualPos]);
}
