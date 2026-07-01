import { api } from "../api";
import type { Generation } from "../types";
import {
  shareableGenerationIds,
  shareableGenerations,
} from "./generationDisplay";

interface UseGenerationShareActionsArgs {
  bumpBoard: () => void;
  clearSelect: () => void;
  flash: (message: string) => void;
  generations: Generation[];
  reload: () => Promise<void>;
  selected: Set<string>;
}

export function useGenerationShareActions({
  bumpBoard,
  clearSelect,
  flash,
  generations,
  reload,
  selected,
}: UseGenerationShareActionsArgs) {
  const pushShare = async (ids: string[]): Promise<number> => {
    if (!ids.length) return 0;
    try {
      const r = await api.publishToShared(ids);
      flash(`${r.published}개 팀에 공유.`);
      return r.published;
    } catch (e) {
      flash("공유 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
      return 0;
    }
  };

  const bulkPublish = async () => {
    const ids = shareableGenerationIds(generations, selected);
    if (!ids.length) {
      flash("공유할 항목이 없습니다(완료·미공유만).");
      clearSelect();
      return;
    }
    try {
      await pushShare(ids);
    } catch (e) {
      flash("공유 실패: " + String(e));
    }
    clearSelect();
    await reload();
  };

  const onPublish = async (g: Generation) => {
    try {
      await pushShare([g.id]);
      await reload();
      bumpBoard();
    } catch (e) {
      flash("공유 실패: " + String(e));
    }
  };

  const boardShare = async (sel: Generation[]) => {
    const targets = shareableGenerations(sel);
    if (!targets.length) {
      flash("공유할 항목이 없습니다(내 완료·미공유만).");
      return;
    }
    try {
      await pushShare(targets.map((g) => g.id));
      await reload();
      bumpBoard();
    } catch (e) {
      flash("공유 실패: " + String(e));
    }
  };

  return { boardShare, bulkPublish, onPublish };
}
