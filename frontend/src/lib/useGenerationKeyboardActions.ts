import { useCallback, useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api } from "../api";
import { KEY_COLORS } from "./appConstants";
import { toggleDisabledGen } from "./deactivated";
import { matchShortcut } from "./shortcuts";
import { useDebouncedCallback } from "./useDebouncedCallback";
import type { Filters, Generation } from "../types";

interface UseGenerationKeyboardActionsArgs {
  clearSelect: () => void;
  filtersRef: MutableRefObject<Filters>;
  flash: (message: string) => void;
  gensRef: MutableRefObject<Generation[]>;
  reload: (silent?: boolean, light?: boolean) => void | Promise<void>;
  selectedRef: MutableRefObject<Set<string>>;
  setGens: Dispatch<SetStateAction<Generation[]>>;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!(
    element &&
    (element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA" ||
      element.tagName === "SELECT" ||
      element.isContentEditable)
  );
}

export function useGenerationKeyboardActions({
  clearSelect,
  filtersRef,
  flash,
  gensRef,
  reload,
  selectedRef,
  setGens,
}: UseGenerationKeyboardActionsArgs) {
  const { run: scheduleColorReload, cancel: cancelColorReload } = useDebouncedCallback(
    () => void reload(false, true),
    350,
  );

  const colorSelected = useCallback(
    async (ids: string[], color: string) => {
      const idSet = new Set(ids);
      const sel = gensRef.current.filter((g) => idSet.has(g.id));
      const allSame = sel.length > 0 && sel.every((g) => g.color === color);
      const next = allSame ? null : color;
      setGens((prev) => prev.map((g) => (idSet.has(g.id) ? { ...g, color: next } : g)));
      const results = await Promise.allSettled(ids.map((id) => api.setColor(id, next)));
      const failed = results.filter((r) => r.status === "rejected").length;
      cancelColorReload();
      if (failed) {
        await reload(false, true);
        flash(`컬러 적용 ${failed}/${ids.length}건 실패`);
        return;
      }
      scheduleColorReload();
    },
    [cancelColorReload, flash, gensRef, reload, scheduleColorReload, setGens],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const ids = [...selectedRef.current];
      if (e.key === "Escape") {
        clearSelect();
        return;
      }
      if (ids.length === 0) return;
      if (matchShortcut(e, "colorRed")) {
        e.preventDefault();
        void colorSelected(ids, KEY_COLORS.r);
      } else if (matchShortcut(e, "colorGreen")) {
        e.preventDefault();
        void colorSelected(ids, KEY_COLORS.g);
      } else if (matchShortcut(e, "colorBlue")) {
        e.preventDefault();
        void colorSelected(ids, KEY_COLORS.b);
      } else if (matchShortcut(e, "boardDisable") && filtersRef.current.tab !== "compose") {
        e.preventDefault();
        toggleDisabledGen(ids);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelect, colorSelected, filtersRef, selectedRef]);
}
