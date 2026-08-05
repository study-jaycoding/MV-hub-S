import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api } from "../api";
import { KEY_COLORS } from "./appConstants";
import { toggleDisabledGen } from "./deactivated";
import { applyGenerationColor, nextGenerationSelectionColor } from "./generationColorState";
import { createMutationQueue } from "./mutationQueue";
import { matchShortcut } from "./shortcuts";
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

class ColorSaveError extends Error {
  constructor(readonly failed: number) {
    super("generation color save failed");
  }
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
  const latestCallbacksRef = useRef({
    flash,
    reload: null as typeof reload | null,
  });
  latestCallbacksRef.current = { flash, reload };
  const colorQueueRef = useRef<ReturnType<typeof createMutationQueue> | null>(null);
  if (!colorQueueRef.current) {
    colorQueueRef.current = createMutationQueue(async (errors) => {
      const latest = latestCallbacksRef.current;
      await latest.reload?.(false, true);
      const failed = errors.reduce<number>(
        (sum, error) => sum + (error instanceof ColorSaveError ? error.failed : 1),
        0,
      );
      latest.flash(`컬러 적용 ${failed}건 실패 — 서버 상태로 되돌렸습니다`);
    });
  }

  const colorSelected = useCallback(
    async (ids: string[], color: string) => {
      const next = nextGenerationSelectionColor(gensRef.current, ids, color);
      gensRef.current = applyGenerationColor(gensRef.current, ids, next);
      setGens((prev) => {
        const updated = applyGenerationColor(prev, ids, next);
        gensRef.current = updated;
        return updated;
      });
      void colorQueueRef.current?.enqueue(async () => {
        try {
          const failed = (await api.setColorsBatch(ids, next)).failed.length;
          if (failed) throw new ColorSaveError(failed);
        } catch (error) {
          if (error instanceof ColorSaveError) throw error;
          throw new ColorSaveError(ids.length);
        }
      });
    },
    [gensRef, setGens],
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
      // 구성(compose=계보/씬)에선 색·비활성을 보드/씬이 자체 처리 — 라이브러리 선택 잔재로 이중 실행 방지.
      if (filtersRef.current.tab === "compose") return;
      if (matchShortcut(e, "colorRed")) {
        e.preventDefault();
        void colorSelected(ids, KEY_COLORS.r);
      } else if (matchShortcut(e, "colorGreen")) {
        e.preventDefault();
        void colorSelected(ids, KEY_COLORS.g);
      } else if (matchShortcut(e, "colorBlue")) {
        e.preventDefault();
        void colorSelected(ids, KEY_COLORS.b);
      } else if (matchShortcut(e, "boardDisable")) {
        e.preventDefault();
        toggleDisabledGen(ids);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelect, colorSelected, filtersRef, selectedRef]);
}
