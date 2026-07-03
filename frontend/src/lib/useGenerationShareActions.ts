import { api } from "../api";
import { postLibraryChanged } from "./libraryBroadcast";
import type { Generation } from "../types";
import { shareableGenerations } from "./generationDisplay";

interface UseGenerationShareActionsArgs {
  bumpBoard: () => void;
  flash: (message: string) => void;
  reload: () => Promise<void>;
}

export function useGenerationShareActions({
  bumpBoard,
  flash,
  reload,
}: UseGenerationShareActionsArgs) {
  const pushShare = async (ids: string[]): Promise<number> => {
    if (!ids.length) return 0;
    try {
      const r = await api.publishToShared(ids);
      flash(`${r.published}개 팀에 공유.`);
      if (r.published) postLibraryChanged(); // 관리탭 즉시 재조회(공유→게시 상태 반영)
      return r.published;
    } catch (e) {
      flash("공유 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
      return 0;
    }
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

  return { boardShare, onPublish };
}
