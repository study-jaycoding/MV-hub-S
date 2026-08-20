import { api } from "../api";
import { postLibraryChanged } from "./libraryBroadcast";
import { isGenerationWorkspaceReady } from "./workspaceContext";
import type { Filters, Generation, WorkspaceContext } from "../types";
import type { CanvasGenerationLink } from "./canvasGenerationRecovery";
import { withMirrorPendingNotice } from "./shareMirrorPending";

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
  workspace: WorkspaceContext;
}

export function useGenerationCardActions({
  armedAutoTags,
  askPrompt,
  bumpBoard,
  flash,
  navTab,
  reload,
  workspace,
}: UseGenerationCardActionsArgs) {
  // 새로 만든 재생성 placeholder 를 반환한다(캔버스에서 그 카드에 변형으로 append 하려고). 실패 시 null.
  const onRegenerate = async (
    g: Generation,
    canvasLink?: CanvasGenerationLink,
    onDefinitiveReject?: () => void,
  ): Promise<Generation | null> => {
    if (g.execution_phase === "recovery_required") {
      flash("외부 제출 여부를 먼저 확인해야 합니다. 생성 정보에서 복구 확인을 진행하세요.");
      return null;
    }
    if (!isGenerationWorkspaceReady(workspace)) {
      flash("워크스페이스 정보를 확인하는 중입니다. 잠시 후 다시 시도하세요.");
      return null;
    }
    try {
      // API 경계에서 구버전 PromptPart[] 문자열은 읽을 수 있는 prompt로 복원돼 있다. prompt를 명시해
      // 보내야 백엔드가 DB에 남은 옛 JSON 원문으로 다시 생성하지 않는다(정상 생성은 같은 값이라 무해).
      const submit = api.prepareRegenerate(
        g.id,
        {
          prompt: g.prompt,
          auto_tags: [...armedAutoTags],
        },
        workspace,
        canvasLink,
      );
      const ng = await submit();
      flash("재생성 잡을 큐에 등록했습니다.");
      await reload();
      bumpBoard();
      postLibraryChanged();
      return ng;
    } catch (e) {
      const status = Number((e as { status?: number })?.status);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        onDefinitiveReject?.();
      }
      flash("재생성 실패: " + String(e));
      return null;
    }
  };

  const onRecoveryRequeue = async (g: Generation): Promise<boolean> => {
    if (g.execution_phase !== "recovery_required") return false;
    if (
      !window.confirm(
        "Higgsfield에서 이 요청의 작업이 생성되지 않은 것을 직접 확인했습니까?\n\n" +
          "확인을 누르면 기존 요청을 다시 실행하며 크레딧이 사용될 수 있습니다.",
      )
    ) {
      return false;
    }
    try {
      await api.confirmGenerationNotSubmitted(g.id);
      flash("미제출 확인을 기록하고 기존 요청을 다시 대기열에 넣었습니다.");
      await reload();
      bumpBoard();
      postLibraryChanged();
      return true;
    } catch (e) {
      flash("복구 요청 실패: " + String(e));
      return false;
    }
  };

  const onUnpublish = async (g: Generation) => {
    try {
      const result = await api.unpublish(g.id);
      flash(withMirrorPendingNotice("팀 공유를 해제했습니다.", result));
      await reload();
      bumpBoard();
      postLibraryChanged();
    } catch (e) {
      flash("공유 해제 실패: " + String(e));
    }
  };

  const onFinalize = async (g: Generation) => {
    try {
      const result = await api.finalize(g.id);
      flash(withMirrorPendingNotice("최종(골드)으로 지정했습니다.", result));
      await reload();
      postLibraryChanged();
    } catch (e) {
      flash("최종 지정 실패: " + String(e));
    }
  };

  const onUnfinalize = async (g: Generation) => {
    try {
      const result = await api.unfinalize(g.id);
      flash(withMirrorPendingNotice("최종 지정을 해제했습니다.", result));
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
    onRecoveryRequeue,
    onRegenerate,
    onSetSource,
    onTags,
    onUnfinalize,
    onUnpublish,
  };
}
