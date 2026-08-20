import { api } from "../api";
import { postLibraryChanged } from "./libraryBroadcast";
import type { Generation } from "../types";
import { shareableGenerations } from "./generationDisplay";
import { withMirrorPendingNotice } from "./shareMirrorPending";

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
      // mirror_pending은 서버 반영 성공이다. 로컬 published 수가 0이어도 blocked가 아닌 대상은
      // 성공으로 세고, 이어지는 reload/reconciler가 카드 미러를 채우게 둔다.
      const succeeded = r.mirror_pending
        ? Math.max(0, ids.length - (r.blocked ?? 0))
        : r.published;
      // 서버가 반영하지 않은(blocked) 항목은 조용히 넘기지 않고 사유를 보여준다 —
      // 무음 유실이면 사용자는 "공유됨"으로 믿는다.
      const message = r.message
        ? `${succeeded}개 팀에 공유. ${r.message}`
        : `${succeeded}개 팀에 공유.`;
      flash(withMirrorPendingNotice(message, r));
      if (succeeded) postLibraryChanged(); // 관리탭 즉시 재조회(공유→게시 상태 반영)
      return succeeded;
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
