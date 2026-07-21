import { api } from "../api";
import { postLibraryChanged } from "./libraryBroadcast";
import type { Filters, Generation } from "../types";

type AskPrompt = (
  title: string,
  initial?: string,
  placeholder?: string,
) => Promise<string | null>;

interface UseGenerationCardActionsArgs {
  armedAutoTags: Set<string>;
  askPrompt: AskPrompt;
  bumpBoard: () => void;
  flash: (message: string) => void;
  navTab: (tab: Filters["tab"]) => void;
  reload: () => Promise<void>;
}

export function useGenerationCardActions({
  armedAutoTags,
  askPrompt,
  bumpBoard,
  flash,
  navTab,
  reload,
}: UseGenerationCardActionsArgs) {
  // 새로 만든 재생성 placeholder 를 반환한다(캔버스에서 그 카드에 변형으로 append 하려고). 실패 시 null.
  const onRegenerate = async (g: Generation): Promise<Generation | null> => {
    try {
      const ng = await api.regenerate(g.id, { auto_tags: [...armedAutoTags] });
      flash("재생성 잡을 큐에 등록했습니다.");
      await reload();
      bumpBoard();
      postLibraryChanged();
      return ng;
    } catch (e) {
      flash("재생성 실패: " + String(e));
      return null;
    }
  };

  const onUnpublish = async (g: Generation) => {
    try {
      await api.unpublish(g.id);
      flash("팀 공유를 해제했습니다.");
      await reload();
      bumpBoard();
      postLibraryChanged();
    } catch (e) {
      flash("공유 해제 실패: " + String(e));
    }
  };

  const onFinalize = async (g: Generation) => {
    try {
      await api.finalize(g.id);
      flash("최종(골드)으로 지정했습니다.");
      await reload();
      postLibraryChanged();
    } catch (e) {
      flash("최종 지정 실패: " + String(e));
    }
  };

  const onUnfinalize = async (g: Generation) => {
    try {
      await api.unfinalize(g.id);
      flash("최종 지정을 해제했습니다.");
      await reload();
      postLibraryChanged();
    } catch (e) {
      flash("최종 해제 실패: " + String(e));
    }
  };

  const onImport = async (g: Generation) => {
    try {
      await api.importToWorkspace(g.id);
      flash("내 워크스페이스로 가져왔습니다 (history 기록).");
      navTab("my");
      postLibraryChanged();
    } catch (e) {
      flash("가져오기 실패: " + String(e));
    }
  };

  const onColor = async (g: Generation, color: string | null) => {
    try {
      await api.setColor(g.id, color);
      await reload();
    } catch (e) {
      flash("컬러 변경 실패: " + String(e));
    }
  };

  const onTags = async (g: Generation) => {
    const input = await askPrompt("태그 (쉼표 구분)", g.tags.join(", "), "태그1, 태그2, …");
    if (input === null) return;
    const tags = input.split(",").map((t) => t.trim()).filter(Boolean);
    try {
      await api.setTags(g.id, tags);
      await reload();
    } catch (e) {
      flash("태그 변경 실패: " + String(e));
    }
  };

  const onSetSource = async (g: Generation, name: string | null, isSource: boolean) => {
    try {
      await api.setSource(g.id, name, isSource);
      void reload();
    } catch (e) {
      flash("소스 변경 실패: " + String(e));
    }
  };

  return {
    onColor,
    onFinalize,
    onImport,
    onRegenerate,
    onSetSource,
    onTags,
    onUnfinalize,
    onUnpublish,
  };
}
