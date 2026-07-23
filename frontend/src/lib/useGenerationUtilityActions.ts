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
      openRecipe(g, history);
    } catch (e) {
      flash("히스토리 조회 실패: " + String(e));
    }
  };

  return { bulkDownload, onShowHistory, openAssetsWindow, openManageWindow };
}
