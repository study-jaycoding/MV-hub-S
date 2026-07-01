import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import { toggleSetValue, withoutSetValue } from "./setUtils";

type AskPrompt = (
  title: string,
  initial?: string,
  placeholder?: string,
) => Promise<string | null>;

interface UseGenerationAutoTagActionsArgs {
  askPrompt: AskPrompt;
  flash: (message: string) => void;
  reload: () => Promise<void>;
  setArmedAutoTags: Dispatch<SetStateAction<Set<string>>>;
}

export function useGenerationAutoTagActions({
  askPrompt,
  flash,
  reload,
  setArmedAutoTags,
}: UseGenerationAutoTagActionsArgs) {
  const toggleArmedAutoTag = (tag: string) => {
    setArmedAutoTags((prev) => toggleSetValue(prev, tag));
  };

  const addAutoTag = async () => {
    const name = (await askPrompt("전역 태그 이름", "", "태그 이름 입력 후 Enter"))?.trim();
    if (!name) return;
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
