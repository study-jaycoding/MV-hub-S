import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api } from "../api";
import { KEY_COLORS } from "./appConstants";
import { toggleDisabledGen } from "./deactivated";
import { applyGenerationColor, ColorSaveError, nextGenerationSelectionColor, type ColorEditLedger } from "./generationColorState";
import { createMutationQueue } from "./mutationQueue";
import { backgroundKeysBlocked, isTypingTarget } from "./keyGate";
import { markKeyHandled } from "./keyHandled";
import { matchShortcut } from "./shortcuts";
import { backgroundEscapeAllowed } from "./useEscapeClose";
import type { Filters, Generation } from "../types";

interface UseGenerationKeyboardActionsArgs {
  clearSelect: () => void;
  filtersRef: MutableRefObject<Filters>;
  flash: (message: string) => void;
  gensRef: MutableRefObject<Generation[]>;
  reload: (silent?: boolean, light?: boolean) => void | Promise<void>;
  selectedRef: MutableRefObject<Set<string>>;
  setGens: Dispatch<SetStateAction<Generation[]>>;
  // compose 탭에서도 라이브러리 격자가 떠 있는 동안(캔버스 '폴더 보기' 창)은 색·비활성 단축키를 살린다.
  composeGridActiveRef?: MutableRefObject<boolean>;
  // 라이브러리 격자가 화면에 없는 동안(편집 탭) — Esc·색·비활성 키를 듣지 않는다(편집 키와 겹친다).
  inactiveRef?: MutableRefObject<boolean>;
  // 색 편집 장부(목록 훅의 것) — 재조회의 응답이 그사이 칠한 색을 덮지 않게 칠할 때·저장이 끝날 때 알린다.
  colorLedger?: ColorEditLedger;
}

export function useGenerationKeyboardActions({
  clearSelect,
  filtersRef,
  flash,
  gensRef,
  reload,
  selectedRef,
  setGens,
  composeGridActiveRef,
  inactiveRef,
  colorLedger,
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
      colorLedger?.begin(ids);
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
        } finally {
          colorLedger?.end(ids); // 실패의 복구 재조회(큐가 이 작업 뒤에 부른다)보다 먼저 — 그래야 서버 값으로 돌아간다
        }
      });
    },
    [gensRef, setGens, colorLedger],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 글자를 치는 자리만 양보한다 — 체크박스·슬라이더에 초점이 남아 있어도 색·비활성·Esc 는 먹는다(2026-10-10 실측).
      if (inactiveRef?.current || isTypingTarget(e.target)) return;
      const ids = [...selectedRef.current];
      if (e.key === "Escape") {
        // 뒤 화면의 Esc — 위에 창·메뉴가 떠 있거나 안쪽이 이미 쓴 Esc 면 손대지 않는다. 선택을 푼 Esc 는 '쓴 것'으로 표시한다.
        if (!backgroundEscapeAllowed(e)) return;
        if (ids.length) markKeyHandled(e);
        clearSelect();
        return;
      }
      // 위에 창·메뉴가 떠 있으면 키는 그쪽 것이다(lib/keyGate) — 뒤 카드에 색·비활성이 걸리지 않는다.
      if (ids.length === 0 || backgroundKeysBlocked()) return;
      // 구성(compose=계보/씬)에선 색·비활성을 보드/씬이 자체 처리 — 라이브러리 선택 잔재로 이중 실행 방지.
      //  단 '폴더 보기' 창이 떠 있고 키가 창 **안**에서 났으면 그 격자가 라이브러리라 살린다(씬 단축키는 창 안 키를
      //  무시한다). 창 밖(Tab 으로 옮긴 초점 등)에서 난 키는 씬 몫 — 둘 다 받으면 씬 노드와 격자 선택이 함께 바뀐다.
      if (filtersRef.current.tab === "compose") {
        const inPeek = !!(e.target as HTMLElement | null)?.closest?.(".folder-peek");
        if (!composeGridActiveRef?.current || !inPeek) return;
      }
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
  }, [clearSelect, colorSelected, filtersRef, selectedRef, composeGridActiveRef, inactiveRef]);
}
