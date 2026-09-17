import type { MutableRefObject } from "react";
import { api } from "../api";
import { postLibraryChanged } from "./libraryBroadcast";
import { HttpError } from "./http";
import { t } from "./i18n";
import type { Filters, Generation } from "../types";

function normalizeAssignResult(value: unknown): { updated: number; teamSyncFailed: boolean } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if ("ok" in result && result.ok !== true) return null;
  const updated = result.updated;
  if (typeof updated !== "number" || !Number.isSafeInteger(updated) || updated < 0) return null;
  return { updated, teamSyncFailed: result.team_synced === false };
}

function assignFailureMessage(error: unknown): string {
  let message = "옮기지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.";
  if (error instanceof HttpError) {
    if (error.status === 400) message = "담을 수 없는 대상입니다. 프로젝트와 워크스페이스를 확인한 뒤 다시 시도해 주세요.";
    else if (error.status === 401 || error.status === 403) message = "이동할 권한이 없습니다. 로그인 상태와 권한을 확인해 주세요.";
    else if (error.status === 404) message = "대상을 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.";
    else if (error.status === 409) message = "다른 곳에서 먼저 바뀌었습니다. 새로고침한 뒤 다시 시도해 주세요.";
  }
  return t(message);
}

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
    let result: Awaited<ReturnType<typeof api.assignProject>>;
    try {
      result = await api.assignProject(
        ids,
        projectId,
        filtersRef.current.tab === "team" ? "team" : "my",
        folderPath,
        // 자동 동기화가 아닌 사용자의 명시적 폴더 담기: 같은 폴더라도 보관 작업을 재개한다.
        !!projectId && !!folderPath?.trim(),
      );
    } catch (error) {
      flash(assignFailureMessage(error));
      return;
    }
    // 재조회 전에 응답을 한 번만 읽는다. 결과 불명도 실패로 단정하거나 자동 재실행하지 않는다.
    const confirmed = normalizeAssignResult(result);
    let reloadFailed = false;
    try {
      await reload();
    } catch {
      reloadFailed = true;
    }
    if (refreshBoard) bumpBoard();
    postLibraryChanged(); // 관리탭(별도 창)이 즉시 재조회 — 담기/폴더이동/미분류 반영
    const message = projectId
      ? folderPath
        ? t("{count}개를 '{folder}' 폴더에 담았습니다.").replace("{folder}", () => folderPath)
        : t("{count}개를 프로젝트에 담았습니다.")
      : t("{count}개를 미분류로 옮겼습니다.");
    const notices = [confirmed
      ? message.replace("{count}", String(confirmed.updated))
      : t("이동 결과를 확인할 수 없습니다. 다시 이동하기 전에 목록을 확인해 주세요.")];
    if (confirmed?.teamSyncFailed) notices.push(t("⚠ 팀 공유 반영 실패(서버 미연결) — 재동기 필요"));
    if (reloadFailed) notices.push(t(confirmed
      ? "이동은 완료했지만 화면을 새로고침하지 못했습니다. 다시 불러와 주세요."
      : "화면을 새로고침하지 못했습니다. 다시 불러와 주세요."));
    flash(notices.join(" · "));
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
