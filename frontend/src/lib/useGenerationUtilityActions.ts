import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import type { Generation, History } from "../types";
import { downloadItemsForGenerations, downloadMany } from "./download";
import { EMBED_MODES, openEmbedWindow } from "./popupWindows";

interface UseGenerationUtilityActionsArgs {
  flash: (message: string) => void;
  openOverlay: (overlay: "history", payload: History) => void;
  reload: () => Promise<void>;
  setCaching: Dispatch<SetStateAction<boolean>>;
}

export function useGenerationUtilityActions({
  flash,
  openOverlay,
  reload,
  setCaching,
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

  const onCache = async () => {
    setCaching(true);
    try {
      const r = await api.cacheAll();
      flash(`로컬 보관 완료: ${r.cached}개 파일 (${r.generations}개 생성물)${r.failed ? ` · 실패 ${r.failed}` : ""}`);
      await reload();
    } catch (e) {
      flash("보관 실패: " + String(e));
    } finally {
      setCaching(false);
    }
  };

  const onShowHistory = async (g: Generation) => {
    try {
      const history = await api.history(g.id);
      openOverlay("history", history);
    } catch (e) {
      flash("가계 조회 실패: " + String(e));
    }
  };

  return { bulkDownload, onCache, onShowHistory, openAssetsWindow, openManageWindow };
}
