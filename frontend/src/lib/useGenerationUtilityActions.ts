import { useRef } from "react";
import { api } from "../api";
import type { Generation, History } from "../types";
import { downloadItemsForGenerations, downloadMany } from "./download";
import { EMBED_MODES, openEmbedWindow } from "./popupWindows";

interface UseGenerationUtilityActionsArgs {
  flash: (message: string) => void;
  // 히스토리 버튼 → 그 생성물의 recipe(어떻게 만들었나)를 노드로. App 이 새 씬 탭으로 연다.
  openRecipe: (g: Generation, history: History) => void;
}

export function useGenerationUtilityActions({
  flash,
  openRecipe,
}: UseGenerationUtilityActionsArgs) {
  // 처리 중인 일은 다시 받지 않는다(조작 규칙 39) — 일괄 다운로드가 도는 동안 다시 누르면 두 묶음이 번갈아 돌며 같은 파일의 사본을 만들고,
  //  히스토리 조회가 끝나기 전에 다시 누르면 응답마다 가계 씬 탭이 하나씩 새로 생긴다.
  const bulkBusyRef = useRef(false);
  const historyInFlightRef = useRef(new Set<string>());
  const bulkDownload = async (list: Generation[]) => {
    const items = downloadItemsForGenerations(list);
    if (!items.length) {
      flash("다운로드할 미디어가 없습니다(생성중/실패 제외).");
      return;
    }
    if (bulkBusyRef.current) {
      flash("다운로드가 진행 중입니다 — 끝난 뒤에 다시 누르세요.");
      return;
    }
    bulkBusyRef.current = true;
    try {
      flash(`${items.length}개 다운로드 시작…`);
      const { ok, failed } = await downloadMany(items);
      if (failed) flash(`다운로드 완료 ${ok}개 · 직접 저장 실패 ${failed}개(새 탭)`);
    } finally {
      bulkBusyRef.current = false;
    }
  };

  const openAssetsWindow = () => {
    openEmbedWindow(EMBED_MODES.assets);
  };

  const openManageWindow = () => {
    openEmbedWindow(EMBED_MODES.manage);
  };

  // 여러 카드의 히스토리를 잇달아 열면 **누른 순서대로** 연다(조작 규칙 40). 조회를 한꺼번에 보내면 응답이 뒤바뀌었을 때 먼저 누른 카드의
  //  씬이 나중에 열려, 마지막으로 누른 카드의 씬에서 화면을 가져갔다. 앞의 조회가 끝난 뒤에 다음 조회를 보낸다 — 둘 다 열리고,
  //  마지막에 누른 것이 마지막에 열린다.
  const historyChainRef = useRef<Promise<void>>(Promise.resolve());
  const onShowHistory = (g: Generation): Promise<void> => {
    if (historyInFlightRef.current.has(g.id)) return Promise.resolve(); // 조회 중 — 응답이 온 뒤의 다시 누름은 전처럼 새 탭이다
    historyInFlightRef.current.add(g.id);
    const open = async () => {
      try {
        const history = await api.history(g.id);
        // ★레시피 옵션은 **히스토리 응답의 온전한 params** 로 만든다(2026-09-12, C-1).
        //  목록 행의 `params` 는 프롬프트가 빠진 축약본일 수 있다 — 목록은 같은 값을 `prompt`
        //  필드로 이미 싣고 있어 서버가 중복분을 뺀다(실측 목록의 26.3%·896KB).
        //  히스토리는 이미 받고 있으므로 **추가 요청이 없다**. `?? g.params` 같은 대체는 넣지 않는다 —
        //  `null` 도 유효한 원본 값이라 대체하면 없던 값을 만들어 낸다(코덱스 조건).
        openRecipe({ ...g, params: history.target.params }, history);
      } catch (e) {
        flash("히스토리 조회 실패: " + String(e));
      } finally {
        historyInFlightRef.current.delete(g.id);
      }
    };
    historyChainRef.current = historyChainRef.current.then(open);
    return historyChainRef.current;
  };

  return { bulkDownload, onShowHistory, openAssetsWindow, openManageWindow };
}
