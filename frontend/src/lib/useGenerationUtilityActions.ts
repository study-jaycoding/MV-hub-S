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
  const bulkDownload = async (list: Generation[]) => {
    const items = downloadItemsForGenerations(list);
    if (!items.length) {
      flash("다운로드할 미디어가 없습니다(생성중/실패 제외).");
      return;
    }
    flash(`${items.length}개 다운로드 시작…`);
    const { ok, failed } = await downloadMany(items);
    if (failed) flash(`다운로드 완료 ${ok}개 · 직접 저장 실패 ${failed}개(새 탭)`);
  };

  const openAssetsWindow = () => {
    openEmbedWindow(EMBED_MODES.assets);
  };

  const openManageWindow = () => {
    openEmbedWindow(EMBED_MODES.manage);
  };

  const onShowHistory = async (g: Generation) => {
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
    }
  };

  return { bulkDownload, onShowHistory, openAssetsWindow, openManageWindow };
}
