import { useRef } from "react";
import { t } from "./i18n";
import { api } from "../api";
import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { errorDetail, HttpError, surelyNotRun } from "./http";
import { postLibraryChanged } from "./libraryBroadcast";
import { modelBlockMessage } from "./modelPolicy";
import { isGenerationWorkspaceReady } from "./workspaceContext";
import type { Filters, Generation, WorkspaceContext } from "../types";
import type { CanvasGenerationLink } from "./canvasGenerationRecovery";
import { withMirrorPendingNotice } from "./shareMirrorPending";
import { generationIssueFor } from "./generationDisplay";
import { reviewTargets, type ReviewAction } from "./generationReview";
import { armStateGlow } from "./stateGlow";
import { SLOW_NOTICE, slowRefs, watchSlowRequests } from "./shareConfirm";

// 최종 지정·해제·등급 전환이 권한 없음(403)으로 거절되면 최종 권한 목록을 다시 읽게 한다 — 그사이 검수 역할이 회수됐으면
//  단추가 사라진다(49회차 — 전엔 새로 고침 전까지 같은 단추가 남아 같은 실패를 되풀이했다).
export const rereadRolesOnForbidden = (error: unknown) => {
  if (error instanceof HttpError && error.status === 403) dispatchAppEvent(APP_EVENTS.finalizeRolesStale);
};

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
  // 재생성 요청이 나가 있는 생성물 — 응답 전의 다시 누름(더블클릭)은 받지 않는다. 누름마다 요청 키가 새로 만들어져 서버의 중복 제거로도
  //  합쳐지지 않고 유료 생성이 둘이 된다(조작 규칙 39). 응답이 오면 바로 푼다 — '큐에 등록' 안내를 보고 일부러 한 번 더 누르는 것은 새 요청이다.
  const regenInFlightRef = useRef(new Set<string>());
  // 공유 탭 재생성은 원본 받기 → 재생성 두 단계라, 원본을 받는 동안의 다시 누름도 막아야 한다(Codex 10-16 P1 — 유료 생성 둘).
  //  키는 공유 카드 id — 원본 id 와 같을 수 있어 regenInFlightRef 와 섞으면 onRegenerate 가 자기 자신을 막는다.
  const importInFlightRef = useRef(new Set<string>());
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
    if (regenInFlightRef.current.has(g.id)) {
      onDefinitiveReject?.(); // 나가지 않은 것이 확실하다 — 캔버스가 이 누름에 만든 pending 연결을 버린다
      flash("재생성 처리 중입니다 — 완료 후 다시 누르세요.");
      return null;
    }
    regenInFlightRef.current.add(g.id);
    try {
      let ng: Generation;
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
        ng = await submit();
      } finally {
        regenInFlightRef.current.delete(g.id); // 목록 갱신(reload)까지 잡고 있지 않는다
      }
      flash("재생성 잡을 큐에 등록했습니다.");
      await reload();
      bumpBoard();
      postLibraryChanged();
      return ng;
    } catch (e) {
      if (surelyNotRun(e)) onDefinitiveReject?.(); // 멈춤(다른 탭 로그아웃)으로 못 보낸 것도 — 대기 표식이 남지 않게(Codex 62회차)
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
      if (slowNotice(e)) return;
      flash(t("공유 해제 실패:") + " " + String(e));
    }
  };

  // 서버가 늦어 결과 불명이면(Jay 결정 10A) '실패' 대신 '확인 중'으로 알리고 원장으로 끝을 확인한 뒤 다시 읽는다. 그런 오류였으면 true.
  const afterSettled = async () => {
    await reload();
    bumpBoard();
    postLibraryChanged();
  };
  const slowNotice = (error: unknown): boolean => {
    const refs = slowRefs(error);
    if (!refs) return false;
    flash(t(SLOW_NOTICE));
    watchSlowRequests(refs, flash, afterSettled);
    return true;
  };

  const onReviewSelection = async (
    generations: Generation[],
    action: ReviewAction,
    canFinalize: (generation: Generation) => boolean,
    // release(편집 탭의 '최종 선택' 해제 — Jay 2026-10-14): 최종인 것을 '공유로'(고른 전환) 대신 **해제**로 보낸다 — 최종 전에
    //  보류였던 것은 보류로 돌아온다(api.unfinalize). 부르는 쪽은 action 을 "shared" 로 준다(대상 거르기가 같다).
    release = false,
  ) => {
    const targets = reviewTargets(generations, action, canFinalize)
      .filter((generation) => !reviewInFlightRef.current.has(generation.id));
    if (!targets.length) { flash(t("바꿀 수 있는 항목이 없습니다.")); return; }
    for (const generation of targets) reviewInFlightRef.current.add(generation.id);
    armStateGlow(targets.map((generation) => generation.id)); // 뒤이은 재조회에서 이 중 상태가 달라진 카드만 빛난다
    try {
      // 기존 다중 등급 처리와 같은 부분 성공 방식. 요청 헤더는 이 호출 문맥에서 함께 고정한다.
      const results = await Promise.allSettled(targets.map((generation) =>
        release && generation.is_final ? api.unfinalize(generation.id) : api.setReviewState(generation, action)));
      // 해제로 보류가 되살아난 것은 따로 알린다 — '최종 선택'을 풀었는데 카드가 보류(빨강)로 보이는 까닭이다
      const reheld = release ? results.filter((result) => result.status === "fulfilled" && result.value.is_held).length : 0;
      const succeeded = results.filter((result) => result.status === "fulfilled").length;
      const mirrorPending = results.some((result) => result.status === "fulfilled" && result.value.mirror_pending);
      // 서버가 늦어 결과 불명인 것은 실패로 세지 않고 '확인 중'으로 — 끝은 원장으로 확인한다(Jay 결정 10A)
      const slow = results.flatMap((result) => (result.status === "rejected" ? [slowRefs(result.reason)] : [])).filter((refs) => refs !== null);
      const firstError = results.find((result): result is PromiseRejectedResult =>
        result.status === "rejected" && !slowRefs(result.reason))?.reason;
      const forbidden = results.find((result): result is PromiseRejectedResult =>
        result.status === "rejected" && result.reason instanceof HttpError && result.reason.status === 403);
      if (forbidden) rereadRolesOnForbidden(forbidden.reason);
      const failed = targets.length - succeeded - slow.length;
      const kept = generations.length - targets.length;
      const summary = t("{success}개 적용 · {failed}개 실패 · {kept}개 유지")
        .replace("{success}", String(succeeded)).replace("{failed}", String(failed)).replace("{kept}", String(kept)) +
        (slow.length ? t(" · {count}개 확인 중").replace("{count}", String(slow.length)) : "") +
        (reheld ? " · " + t("원래의 보류로 {count}개").replace("{count}", String(reheld)) : "");
      watchSlowRequests(slow.flat(), flash, afterSettled);
      flash(withMirrorPendingNotice(summary, { mirror_pending: mirrorPending }, t) +
        (firstError ? `\n${errorDetail(firstError)}` : "")); // 까닭만 — "TypeError: Failed to fetch"·"Error: 500: …" 앞머리는 뗀다(16회차의 통일에서 빠진 자리)
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
      if (slowNotice(e)) return;
      rereadRolesOnForbidden(e);
      flash(t("최종 지정 실패:") + " " + String(e));
    }
  };

  const onUnfinalize = async (g: Generation) => {
    armStateGlow([g.id]);
    try {
      const result = await api.unfinalize(g.id);
      // 최종 전에 보류였던 것은 보류로 돌아온다(서버가 정한다 — api.unfinalize) — 그랬으면 그렇게 알린다
      flash(withMirrorPendingNotice(
        result.is_held ? t("최종 지정을 해제했습니다 — 원래의 보류로 돌아갔습니다.") : t("최종 지정을 해제했습니다."), result, t));
      await reload();
      postLibraryChanged();
    } catch (e) {
      if (slowNotice(e)) return;
      rereadRolesOnForbidden(e);
      flash(t("최종 해제 실패:") + " " + String(e));
    }
  };

  // 공유 탭 '내 워크스페이스 / 재생성' — 원본을 이 PC 에 찾거나 받아 온 뒤 일반 재생성 그대로(워크스페이스·권한·중복 누름·요청행).
  //  예전 '가져오기'는 대기 행만 만들고 요청을 안 넣어 힉스필드로 나가지 않았다(Jay 2026-10-16).
  const onImport = async (g: Generation) => {
    if (importInFlightRef.current.has(g.id)) {
      flash("재생성 처리 중입니다 — 완료 후 다시 누르세요.");
      return;
    }
    importInFlightRef.current.add(g.id);
    try {
      let source: Generation;
      try {
        source = await api.regenSource(g.id);
      } catch (e) {
        flash("재생성 실패: " + String(e));
        return;
      }
      if (await onRegenerate(source)) navTab("my");
    } finally {
      importInFlightRef.current.delete(g.id);
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
