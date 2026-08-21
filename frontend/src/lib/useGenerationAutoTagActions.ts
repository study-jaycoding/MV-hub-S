import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import { cachedWorkspaceOptions, fetchWorkspaceOptions } from "./workspaceOptionsCache";
import { toggleSetValue, withoutSetValue } from "./setUtils";
import type { WorkspaceChip } from "./useLibraryFilters";
import type { WorkspaceContext } from "../types";

type AskPrompt = (
  title: string,
  initial?: string,
  placeholder?: string,
  opts?: { workspaceSuggest?: boolean },
) => Promise<string | null>;

interface UseGenerationAutoTagActionsArgs {
  askPrompt: AskPrompt;
  flash: (message: string) => void;
  reload: () => Promise<void>;
  setArmedAutoTags: Dispatch<SetStateAction<Set<string>>>;
  // 워크스페이스 침(옵트인 필터) 등록 — 같은 + 모달에서 `#+` 로 등록한다.
  workspaceContext: WorkspaceContext;
  setWorkspaceChips: Dispatch<SetStateAction<WorkspaceChip[]>>;
}

export function useGenerationAutoTagActions({
  askPrompt,
  flash,
  reload,
  setArmedAutoTags,
  workspaceContext,
  setWorkspaceChips,
}: UseGenerationAutoTagActionsArgs) {
  const toggleArmedAutoTag = (tag: string) => {
    setArmedAutoTags((prev) => toggleSetValue(prev, tag));
  };

  // `#+@id` = 피커 버튼 선택(유일), `#+` = 현재 선택 워크스페이스,
  // `#+이름` = 이름으로 찾기(정확 일치 우선, 없으면 유일 부분일치).
  const addWorkspaceChip = async (query: string) => {
    try {
      let target: WorkspaceChip | null = null;
      if (query.startsWith("@")) {
        const id = query.slice(1).trim();
        const options = cachedWorkspaceOptions() ?? (await fetchWorkspaceOptions());
        const found = options.find((w) => w.id === id);
        if (!found) {
          flash("워크스페이스를 찾지 못했습니다 — 목록을 다시 열어 선택하세요");
          return;
        }
        target = found;
      } else if (!query) {
        if (workspaceContext.scope === "team" && workspaceContext.id) {
          target = { id: workspaceContext.id, name: workspaceContext.name || workspaceContext.id };
        } else {
          flash("#+ 단독 등록은 팀 워크스페이스 선택 중일 때만 — 아래 목록에서 고르세요");
          return;
        }
      } else {
        const workspaces = await fetchWorkspaceOptions();
        const exact = workspaces.filter((w) => w.name === query);
        const matches = exact.length
          ? exact
          : workspaces.filter((w) => w.name.toLowerCase().includes(query.toLowerCase()));
        if (matches.length === 1) target = matches[0];
        else if (matches.length > 1) {
          flash("여러 워크스페이스와 일치: " + matches.map((w) => w.name).join(", "));
          return;
        } else {
          flash(`일치하는 워크스페이스 없음: ${query}`);
          return;
        }
      }
      const chip = target;
      setWorkspaceChips((prev) =>
        prev.some((c) => c.id === chip.id) ? prev : [...prev, chip],
      );
      flash(`워크스페이스 필터 등록: ${chip.name} — 침을 누르면 그 공간 작업물만 봅니다`);
    } catch (e) {
      flash("워크스페이스 필터 등록 실패: " + String(e));
    }
  };

  const addAutoTag = async () => {
    const name = (
      await askPrompt("전역 태그 이름", "", "태그 이름 입력 후 Enter · #+ = 워크스페이스 필터 등록", {
        workspaceSuggest: true,
      })
    )?.trim();
    if (!name) return;
    if (name.startsWith("#+")) {
      await addWorkspaceChip(name.slice(2).trim());
      return;
    }
    try {
      await api.createAutoTag(name);
      await reload();
    } catch (e) {
      flash("전역 태그 추가 실패: " + String(e));
    }
  };

  const removeAutoTag = async (tag: string) => {
    if (!window.confirm(`전역 태그 "${tag}" 를 삭제할까요?`)) return;
    try {
      await api.deleteAutoTag(tag);
      setArmedAutoTags((prev) => withoutSetValue(prev, tag));
      await reload();
    } catch (e) {
      flash("전역 태그 삭제 실패: " + String(e));
    }
  };

  return { addAutoTag, removeAutoTag, toggleArmedAutoTag };
}
