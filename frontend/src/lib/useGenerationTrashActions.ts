import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import { postLibraryChanged } from "./libraryBroadcast";
import type { Generation } from "../types";
import {
  bulkResultText,
  purgeConfirmText,
  runGenerationBulk,
  trashConfirmText,
} from "./bulkGenerationActions";

interface UseGenerationTrashActionsArgs {
  bumpBoard: () => void;
  clearSelect: () => void;
  failedCount: number;
  flash: (message: string) => void;
  reload: () => Promise<void>;
  selected: Set<string>;
  setBoardSelected: Dispatch<SetStateAction<Generation[]>>;
}

export function useGenerationTrashActions({
  bumpBoard,
  clearSelect,
  failedCount,
  flash,
  reload,
  selected,
  setBoardSelected,
}: UseGenerationTrashActionsArgs) {
  const clearFailed = async () => {
    if (
      !window.confirm(
        `실패·차단된 생성물 ${failedCount}건을 모두 휴지통으로 보낼까요?\n` +
          `(실패·NSFW 차단 등 — 화면에서 치워지되 '휴지통 보기'에서 복원 가능, 힉스필드 원본엔 영향 없음)`,
      )
    ) {
      return;
    }
    try {
      const r = await api.clearFailed();
      flash(`${r.removed}건을 휴지통으로 보냈습니다.`);
      await reload();
    } catch (e) {
      flash("정리 오류: " + String(e));
    }
  };

  const boardDelete = async (sel: Generation[]) => {
    const ids = sel.map((g) => g.id);
    if (!ids.length) return;
    if (!window.confirm(trashConfirmText(ids.length, false))) return;
    try {
      const failed = await runGenerationBulk(ids, (id) => api.deleteGeneration(id));
      setBoardSelected([]);
      await reload();
      bumpBoard();
      postLibraryChanged();
      flash(bulkResultText(ids.length, failed, "휴지통으로 보냈습니다.", "휴지통 이동"));
    } catch (e) {
      flash("삭제 실패: " + String(e));
    }
  };

  const bulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(trashConfirmText(ids.length, true))) return;
    const failed = await runGenerationBulk(ids, (id) => api.deleteGeneration(id));
    clearSelect();
    await reload();
    postLibraryChanged();
    flash(bulkResultText(ids.length, failed, "휴지통으로 보냈습니다.", "휴지통 이동"));
  };

  const bulkRestore = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    const failed = await runGenerationBulk(ids, (id) => api.restoreGeneration(id));
    clearSelect();
    await reload();
    postLibraryChanged();
    flash(bulkResultText(ids.length, failed, "복구했습니다.", "복구"));
  };

  const bulkPurge = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(purgeConfirmText(ids.length))) return;
    const failed = await runGenerationBulk(ids, (id) => api.purgeTrashed(id));
    clearSelect();
    await reload();
    flash(bulkResultText(ids.length, failed, "영구 삭제했습니다.", "영구 삭제"));
  };

  const onRestore = async (g: Generation) => {
    try {
      await api.restoreGeneration(g.id);
      await reload();
      postLibraryChanged();
      flash("복구했습니다.");
    } catch (e) {
      flash("복구 실패: " + String(e));
    }
  };

  return { boardDelete, bulkDelete, bulkPurge, bulkRestore, clearFailed, onRestore };
}
