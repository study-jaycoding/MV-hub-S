import { api } from "../api";
import { postLibraryChanged } from "./libraryBroadcast";
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
  canFinalize: (g: Generation) => boolean;
}

export function useGenerationShareActions({
  bumpBoard,
  clearSelect,
  flash,
  generations,
  reload,
  selected,
  canFinalize,
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

  const bulkPublish = async () => {
    const ids = shareableGenerationIds(generations, selected);
    if (!ids.length) {
      flash("공유할 항목이 없습니다(완료·미공유만).");
      clearSelect();
      return;
    }
    if (!window.confirm(`선택한 ${ids.length}개를 팀에 공유할까요?`)) return;
    try {
      await pushShare(ids);
    } catch (e) {
      flash("공유 실패: " + String(e));
    }
    clearSelect();
    await reload();
  };

  // 선택한 생성물(카드)들을 최종(골드) 확정 — 완료·미확정·권한 있는 것만. 시퀀스당 여러 최종 허용.
  // finalize 는 미공유면 함께 발행되므로, 최종 확정 = 팀 공유 + 골드 지정이 한 번에 된다.
  const bulkFinalize = async () => {
    const targets = generations.filter(
      (g) => selected.has(g.id) && g.status === "done" && !g.is_final && canFinalize(g),
    );
    if (!targets.length) {
      flash("최종 확정할 항목이 없습니다(완료·미확정만).");
      clearSelect();
      return;
    }
    if (!window.confirm(`선택한 ${targets.length}개를 최종 확정할까요?`)) return;
    let ok = 0;
    for (const g of targets) {
      try {
        await api.finalize(g.id);
        ok += 1;
      } catch {
        /* 권한·상태 문제로 실패한 건 건너뛴다(부분 성공 허용) */
      }
    }
    flash(`${ok}개 최종 확정.`);
    if (ok) postLibraryChanged(); // 관리탭 즉시 재조회(최종→완료 상태 반영)
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

  return { boardShare, bulkPublish, bulkFinalize, onPublish };
}
