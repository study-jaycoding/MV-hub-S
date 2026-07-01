import type { MutableRefObject } from "react";
import { api } from "../api";
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
      const where = projectId
        ? folderPath
          ? `폴더(${folderPath})에 담음`
          : "프로젝트에 담음"
        : "미분류로 뺌";
      flash(`${r.updated}개를 ${where}`);
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

  const createAndAssign = async (name: string) => {
    try {
      const p = await api.createProject(name);
      await assignSelectedToProject(p.id);
    } catch (e) {
      flash("프로젝트 생성 실패: " + String(e));
    }
  };

  const boardAssign = async (sel: Generation[], projectId: string | null) => {
    await assignIdsToProject(sel.map((g) => g.id), projectId, true);
  };

  const boardCreateAssign = async (sel: Generation[], name: string) => {
    try {
      const p = await api.createProject(name);
      await boardAssign(sel, p.id);
    } catch (e) {
      flash("프로젝트 생성 실패: " + String(e));
    }
  };

  // 카드를 사이드바 폴더로 드래그해 담기. 드래그한 카드가 현재 선택에 포함되면 선택 전체를,
  // 아니면 그 카드 1개만 그 프로젝트+폴더로 귀속한다.
  const dropOnFolder = async (genId: string, projectId: string, folderPath: string) => {
    const sel = selectedRef.current;
    const ids = sel.has(genId) ? [...sel] : [genId];
    await assignIdsToProject(ids, projectId, false, folderPath);
  };

  // 카드를 '미분류'로 드래그 — 프로젝트+폴더 귀속 해제(project_id=null → 폴더도 함께 해제).
  const dropUnassign = async (genId: string) => {
    const sel = selectedRef.current;
    const ids = sel.has(genId) ? [...sel] : [genId];
    await assignIdsToProject(ids, null, false);
  };

  return {
    assignSelectedToProject,
    boardAssign,
    boardCreateAssign,
    createAndAssign,
    dropOnFolder,
    dropUnassign,
  };
}
