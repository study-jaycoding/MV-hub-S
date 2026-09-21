import { useRef } from "react";
import { t } from "./i18n";
import { api } from "../api";
import { postLibraryChanged } from "./libraryBroadcast";
import { modelBlockMessage } from "./modelPolicy";
import { isGenerationWorkspaceReady } from "./workspaceContext";
import type { Filters, Generation, WorkspaceContext } from "../types";
import type { CanvasGenerationLink } from "./canvasGenerationRecovery";
import { withMirrorPendingNotice } from "./shareMirrorPending";
import { generationIssueFor } from "./generationDisplay";
import { reviewTargets, type ReviewAction } from "./generationReview";
import { armStateGlow } from "./stateGlow";

interface UseGenerationCardActionsArgs {
  armedAutoTags: Set<string>;
  bumpBoard: () => void;
  canFinalize: (generation: Generation) => boolean;
  flash: (message: string) => void;
  navTab: (tab: Filters["tab"]) => void;
  reload: () => Promise<void>;
  workspace: WorkspaceContext;
}

export function useGenerationCardActions({
  armedAutoTags,
  bumpBoard,
  canFinalize,
  flash,
  navTab,
  reload,
  workspace,
}: UseGenerationCardActionsArgs) {
  const reviewInFlightRef = useRef(new Set<string>());
  // 새로 만든 재생성 placeholder 를 반환한다(캔버스에서 그 카드에 변형으로 append 하려고). 실패 시 null.
  const onRegenerate = async (
    g: Generation,
    canvasLink?: CanvasGenerationLink,
    onDefinitiveReject?: () => void,
  ): Promise<Generation | null> => {
    if (g.execution_phase === "recovery_required") {
      const issue = generationIssueFor(g.status, g.error, g.execution_phase);
      const recoveryHint = t("외부 제출 여부를 먼저 확인해야 합니다. 생성 정보에서 제출 확인을 진행하세요.");
      flash(issue ? `${issue.title} — ${issue.action}\n${recoveryHint}` : recoveryHint);
      return null;
    }
    if (!isGenerationWorkspaceReady(workspace)) {
      flash("워크스페이스 정보를 확인하는 중입니다. 잠시 후 다시 시도하세요.");
      return null;
    }
    // 그룹 사용 모델 — 재생성은 원본 모델(g.model)로 나가므로 제출 전에 막는다(서버 미전송, pending 없음).
    const blocked = modelBlockMessage(g.model);
    if (blocked) {
      flash(blocked);
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
    // 복구 재실행은 **원 생성물의 워크스페이스**로 다시 나간다(gen_requests 의 실행 레시피) — 지금 고른 공간의
    // 설정을 씌우면 잘못 막는다. 같은 공간일 때만 검사한다(코덱스 P1).
    //  · 개인 공간 생성물은 workspace_id 가 null 이지만 '모름'이 아니라 '팀이 아님'이다 — 그룹 설정은 팀 공간에만
    //    있으므로 빈 문자열로 넘겨 현재 팀 정책이 걸리지 않게 한다.
    const originWorkspace = g.workspace_scope === "personal" ? "" : g.workspace_id;
    const blocked = modelBlockMessage(g.model, { forWorkspaceId: originWorkspace });
    if (blocked) {
      flash(blocked);
      return false;
    }
    const issue = generationIssueFor(g.status, g.error, g.execution_phase);
    if (
      !window.confirm(
        (issue ? `${issue.title} — ${issue.action}\n\n` : "") +
          t("Higgsfield에서 이 요청의 작업이 생성되지 않은 것을 직접 확인했습니까?") + "\n\n" +
          t("확인을 누르면 기존 요청을 다시 실행하며 크레딧이 사용될 수 있습니다."),
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
      flash(withMirrorPendingNotice(t("팀 공유를 해제했습니다."), result, t));
      await reload();
      bumpBoard();
      postLibraryChanged();
    } catch (e) {
      flash(t("공유 해제 실패:") + " " + String(e));
    }
  };

  const onReviewSelection = async (
    generations: Generation[],
    action: ReviewAction,
    canFinalize: (generation: Generation) => boolean,
  ) => {
    const targets = reviewTargets(generations, action, canFinalize)
      .filter((generation) => !reviewInFlightRef.current.has(generation.id));
    if (!targets.length) { flash(t("바꿀 수 있는 항목이 없습니다.")); return; }
    for (const generation of targets) reviewInFlightRef.current.add(generation.id);
    armStateGlow(targets.map((generation) => generation.id)); // 뒤이은 재조회에서 이 중 상태가 달라진 카드만 빛난다
    try {
      // 기존 다중 등급 처리와 같은 부분 성공 방식. 요청 헤더는 이 호출 문맥에서 함께 고정한다.
      const results = await Promise.allSettled(targets.map((generation) => api.setReviewState(generation, action)));
      const succeeded = results.filter((result) => result.status === "fulfilled").length;
      const mirrorPending = results.some((result) => result.status === "fulfilled" && result.value.mirror_pending);
      const firstError = results.find((result) => result.status === "rejected")?.reason;
      const failed = targets.length - succeeded;
      const kept = generations.length - targets.length;
      const summary = t("{success}개 적용 · {failed}개 실패 · {kept}개 유지")
        .replace("{success}", String(succeeded)).replace("{failed}", String(failed)).replace("{kept}", String(kept));
      flash(withMirrorPendingNotice(summary, { mirror_pending: mirrorPending }, t) +
        (firstError ? `\n${String(firstError)}` : ""));
      if (succeeded) {
        postLibraryChanged();
        bumpBoard();
      }
      await reload();
    } finally {
      for (const generation of targets) reviewInFlightRef.current.delete(generation.id);
    }
  };

  const onReview = (generation: Generation, action: ReviewAction) => onReviewSelection([generation], action, canFinalize);

  const onFinalize = async (g: Generation) => {
    armStateGlow([g.id]);
    try {
      const result = await api.finalize(g.id);
      flash(withMirrorPendingNotice(t("최종(골드)으로 지정했습니다."), result, t));
      await reload();
      postLibraryChanged();
    } catch (e) {
      flash(t("최종 지정 실패:") + " " + String(e));
    }
  };

  const onUnfinalize = async (g: Generation) => {
    armStateGlow([g.id]);
    try {
      const result = await api.unfinalize(g.id);
      flash(withMirrorPendingNotice(t("최종 지정을 해제했습니다."), result, t));
      await reload();
      postLibraryChanged();
    } catch (e) {
      flash(t("최종 해제 실패:") + " " + String(e));
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

  const onSetSource = async (g: Generation, name: string | null, isSource: boolean) => {
    try {
      await api.setSource(g.id, name, isSource);
      void reload();
    } catch (e) {
      flash("소스 변경 실패: " + String(e));
    }
  };

  return {
    onFinalize,
    onReviewSelection,
    onReview,
    onImport,
    onRecoveryRequeue,
    onRegenerate,
    onSetSource,
    onUnfinalize,
    onUnpublish,
  };
}
