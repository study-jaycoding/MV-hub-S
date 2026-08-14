import type { MutableRefObject } from "react";
import { api } from "../api";
import { postLibraryChanged } from "./libraryBroadcast";
import type { Filters, Generation } from "../types";

interface UseGenerationProjectActionsArgs {
  bumpBoard: () => void;
  filtersRef: MutableRefObject<Filters>;
  flash: (message: string) => void;
  reload: () => Promise<void>;
  selectedRef: MutableRefObject<Set<string>>;
}

export function useGenerationProjectActions({
  bumpBoard,
  filtersRef,
  flash,
  reload,
  selectedRef,
}: UseGenerationProjectActionsArgs) {
  const assignIdsToProject = async (
    ids: string[],
    projectId: string | null,
    refreshBoard: boolean,
    folderPath?: string | null,
  ) => {
    if (!ids.length) return;
    try {
      const r = await api.assignProject(
        ids,
        projectId,
        filtersRef.current.tab === "team" ? "team" : "my",
        folderPath,
      );
      await reload();
      if (refreshBoard) bumpBoard();
      postLibraryChanged(); // 관리탭(별도 창)이 즉시 재조회 — 담기/폴더이동/미분류 반영
      const where = projectId
        ? folderPath
          ? `폴더(${folderPath})에 담음`
          : "프로젝트에 담음"
        : "미분류로 뺌";
      // 공유물 이동이 서버(팀 공유)에 반영 실패하면 경고 — 로컬만 바뀌고 팀 뷰는 stale.
      flash(
        `${r.updated}개를 ${where}` +
          (r.team_synced === false ? " · ⚠ 팀 공유 반영 실패(서버 미연결) — 재동기 필요" : ""),
      );
    } catch (e) {
      flash("귀속 실패: " + String(e));
    }
  };

  const assignSelectedToProject = async (
    projectId: string | null,
    folderPath?: string | null,
  ) => {
    await assignIdsToProject([...selectedRef.current], projectId, false, folderPath);
  };

  const boardAssign = async (
    sel: Generation[],
    projectId: string | null,
    folderPath?: string | null,
  ) => {
    await assignIdsToProject(sel.map((g) => g.id), projectId, true, folderPath);
  };

  // 드래그 페이로드 → 담을 id 목록. 복수 드래그(쉼표구분 genlist)면 그 목록 그대로,
  // 단일이면 라이브러리 선택(selectedRef)에 포함될 때 선택 전체로 확장(기존 동작).
  const dropIds = (genId: string): string[] => {
    const dragged = genId.split(",").filter(Boolean);
    if (dragged.length > 1) return dragged;
    const sel = selectedRef.current;
    return dragged[0] && sel.has(dragged[0]) ? [...sel] : dragged;
  };

  // 카드를 사이드바 폴더로 드래그해 담기.
  const dropOnFolder = async (genId: string, projectId: string, folderPath: string) => {
    await assignIdsToProject(dropIds(genId), projectId, false, folderPath);
  };

  // 카드를 '미분류'로 드래그 — 프로젝트+폴더 귀속 해제(project_id=null → 폴더도 함께 해제).
  const dropUnassign = async (genId: string) => {
    await assignIdsToProject(dropIds(genId), null, false);
  };

  return {
    assignSelectedToProject,
    boardAssign,
    dropOnFolder,
    dropUnassign,
  };
}
