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
  ) => {
    if (!ids.length) return;
    try {
      const r = await api.assignProject(
        ids,
        projectId,
        filtersRef.current.tab === "team" ? "team" : "my",
      );
      await reload();
      if (refreshBoard) bumpBoard();
      flash(`${r.updated}개를 ${projectId ? "프로젝트에 담음" : "미분류로 뺌"}`);
    } catch (e) {
      flash("귀속 실패: " + String(e));
    }
  };

  const assignSelectedToProject = async (projectId: string | null) => {
    await assignIdsToProject([...selectedRef.current], projectId, false);
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

  return { assignSelectedToProject, boardAssign, boardCreateAssign, createAndAssign };
}
