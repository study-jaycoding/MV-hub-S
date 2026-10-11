import { useCallback, useRef } from "react";
import type { RefObject, MutableRefObject } from "react";
import { api } from "../../api";
import { resolveAutoAspectRatio } from "../../lib/aspectAuto";
import { isGenerationWorkspaceReady } from "../../lib/workspaceContext";
import {
  HIST_MAX,
  partsDisplay,
  saveHistory,
  serialize,
  serializeParts,
} from "../../lib/promptEditor";
import type { ChipRef, HistEntry } from "../../lib/promptEditor";
import {
  buildSpotlightCreateBody,
  normalizeSpotlightBatch,
} from "../../lib/spotlightSubmit";
import type { Generation, ModelParam, WorkspaceContext } from "../../types";
import type { SpotlightTrayRef } from "./SpotlightRefTray";
import type { SceneGenerationAssignment } from "../../lib/sceneGenerationInputs";
import type {
  CanvasGenerationLink,
  CanvasGenerationTarget,
} from "../../lib/canvasGenerationRecovery";


export const SPOTLIGHT_MAX_COUNT = 4;

interface UseSpotlightSubmitOptions {
  activeProjectId?: string;
  armedAutoTags: string[];
  armedFolder?: { projectId: string; path: string } | null;
  generationAssignment?: SceneGenerationAssignment;
  busy: boolean;
  count: number;
  dragParentRef: MutableRefObject<string | null>;
  editorRef: RefObject<HTMLDivElement>;
  historyRef: MutableRefObject<HistEntry[]>;
  inCompose: boolean;
  preservePromptAfterSubmit?: boolean;
  promptContextKey?: string | null;
  model: string;
  // 그룹 사용 모델 가드 문구(modelPolicyCore.submitBlockMessage) — 값이 있으면 pending 기록·업로드 전에 막는다.
  modelBlockedMessage?: string | null;
  onCreated: (created?: Generation[], dragParentId?: string | null) => void;
  canvasTarget?: CanvasGenerationTarget | null;
  // ★비동기다 — 생성 요청보다 '어느 카드 것인지' 표식이 **먼저 저장돼야** 한다. 저장이 IndexedDB 로
  //  옮겨가며 기다리는 일이 됐으므로, 호출부는 반드시 await 한 뒤 제출한다.
  prepareCanvasGeneration?: (
    target: CanvasGenerationTarget,
    count: number,
  ) => Promise<CanvasGenerationLink[]>;
  settleCanvasGeneration?: (link: CanvasGenerationLink, generation: Generation) => void;
  discardCanvasGeneration?: (link: CanvasGenerationLink) => void;
  onCanvasBatchCreated?: (created: Generation[]) => void;
  optionValues: Record<string, unknown>;
  paramsLoading: boolean;
  paramsModel: string;
  trayRefs: SpotlightTrayRef[];
  /** 트레이가 지금의 묶임(카드·씬)에 맞춰졌는가(lib/useSpotlightTray). 아니면 trayRefs 는 **앞 카드의 것**이다 — 제출하지 않는다. */
  trayReady: boolean;
  tunable: ModelParam[];
  workspace: WorkspaceContext;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  clearMention: () => void;
  updatePlaceholder: () => void;
  notifyPromptChanged: () => void;
  onHistorySaved?: () => void;
}

export function useSpotlightSubmit({
  activeProjectId,
  armedAutoTags,
  armedFolder,
  generationAssignment,
  busy,
  count,
  dragParentRef,
  editorRef,
  historyRef,
  inCompose,
  preservePromptAfterSubmit = false,
  promptContextKey = null,
  model,
  modelBlockedMessage = null,
  onCreated,
  canvasTarget,
  prepareCanvasGeneration,
  settleCanvasGeneration,
  discardCanvasGeneration,
  onCanvasBatchCreated,
  optionValues,
  paramsLoading,
  paramsModel,
  trayRefs,
  trayReady,
  tunable,
  workspace,
  setBusy,
  setError,
  clearMention,
  updatePlaceholder,
  notifyPromptChanged,
  onHistorySaved,
}: UseSpotlightSubmitOptions) {
  const contextKey = JSON.stringify([
    inCompose, canvasTarget?.sceneId, canvasTarget?.cardId,
    promptContextKey, workspace.scope, workspace.id,
  ]);
  const promptContextRef = useRef({ key: contextKey });
  // 객체 교체로 A→B→A 전환도 구별한다. 늦은 성공 응답이 돌아온 카드의 초안을 지우면 안 된다.
  if (promptContextRef.current.key !== contextKey) {
    promptContextRef.current = { key: contextKey };
  }
  return useCallback(async (
    batchOverride?: number,
    generationAssignmentOverride?: SceneGenerationAssignment | null,
    canvasTargetOverride?: CanvasGenerationTarget | null,
  ) => {
    if (busy) return;
    // 묶인 카드(씬)가 막 바뀌어 트레이가 아직 앞 카드의 레퍼런스를 들고 있는 한 박자 — 그대로 내면 앞 카드의 레퍼런스로 생성이 나간다
    //  (씬을 바꾼 직후에는 대상 카드도 없어 일반 생성으로. 2026-10-11 Codex 코드 리뷰). 그 사이에 밀려 들어온 제출 키는 받지 않는다.
    if (!trayReady) return;
    setError(null);
    if (!isGenerationWorkspaceReady(workspace)) {
      setError("워크스페이스를 확인하는 중입니다. 계정 메뉴에서 공간을 선택해 주세요.");
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;

    const { text, refs: inlineRefs } = serialize(editor);
    if (!text && trayRefs.length + inlineRefs.length === 0) {
      setError("프롬프트를 입력하세요.");
      editor.focus();
      return;
    }
    if (modelBlockedMessage) {
      // 못 쓰는 모델·정책 첫 조회 중·이 타입을 전부 못 씀 — 캔버스 pending 기록·업로드보다 먼저 거절해 유령 표식을
      // 남기지 않는다. `!model` 검사보다 앞에 둬야 "모델을 선택하세요" 대신 진짜 이유가 나온다(코덱스 P2).
      setError(modelBlockedMessage);
      return;
    }
    if (!model) {
      setError("모델을 선택하세요.");
      return;
    }
    if (paramsLoading || paramsModel !== model) {
      setError("모델 옵션을 불러오는 중입니다. 잠시 후 다시 생성해 주세요.");
      return;
    }

    const parts = serializeParts(editor);
    const submittedParts = JSON.stringify(parts);
    const submittedContext = promptContextRef.current;
    const displayPrompt = partsDisplay(parts);
    setBusy(true);
    try {
      const effectiveAssignment =
        generationAssignmentOverride !== undefined
          ? generationAssignmentOverride || undefined
          : generationAssignment;
      const targetProjectId = effectiveAssignment?.projectId ?? activeProjectId;
      const targetFolderPath = effectiveAssignment?.folderPath ??
        (armedFolder && armedFolder.projectId === targetProjectId ? armedFolder.path : undefined);
      const targetTags = effectiveAssignment?.tags || [];
      const { body, error } = buildSpotlightCreateBody({
        text,
        inlineRefs,
        trayRefs,
        parts,
        displayPrompt,
        model,
        optionValues,
        tags: targetTags,
        armedAutoTags,
        activeProjectId: targetProjectId,
        folderPath: targetFolderPath,
      });
      if (error || !body) {
        setError(error || "생성 요청을 만들 수 없습니다.");
        setBusy(false);
        return;
      }
      // 검증을 통과한 요청만 이미지 비율을 비동기로 잰다. 무시되는 옵션도 기존 auto 변환은 유지한다.
      body.params = await resolveAutoAspectRatio(body.params || {}, tunable, [...trayRefs, ...inlineRefs]);

      const batch = normalizeSpotlightBatch(
        batchOverride,
        count,
        SPOTLIGHT_MAX_COUNT,
      );
      const effectiveCanvasTarget =
        canvasTargetOverride !== undefined ? canvasTargetOverride : canvasTarget;
      // 요청보다 먼저 generation id와 목적 카드를 저장한다. 이 다음 순간 창이 닫혀도 재시작 복구가 가능하다.
      const canvasLinks = effectiveCanvasTarget && prepareCanvasGeneration
        ? await prepareCanvasGeneration(effectiveCanvasTarget, batch)
        : [];
      if (effectiveCanvasTarget && canvasLinks.length !== batch) {
        throw new Error("캔버스 생성 위치를 저장하지 못했습니다. 씬을 다시 선택한 뒤 시도하세요.");
      }
      const outcomes = await Promise.all(
        Array.from({ length: batch }, async (_, index) => {
          const link = canvasLinks[index];
          try {
            const submit = api.prepareCreate(body, workspace, link);
            const generation = await submit();
            if (link) settleCanvasGeneration?.(link, generation);
            return { generation };
          } catch (error) {
            const status = Number((error as { status?: number })?.status);
            // 서버가 요청을 확실히 거절한 4xx는 유령 표식을 즉시 치운다. 타임아웃·과부하·네트워크
            // 단절은 서버 커밋 여부가 모호하므로 재시작 복구가 확인할 수 있게 남긴다.
            if (link && status >= 400 && status < 500 && status !== 408 && status !== 429) {
              discardCanvasGeneration?.(link);
            }
            return { error };
          }
        }),
      );
      const created = outcomes.flatMap((outcome) =>
        "generation" in outcome && outcome.generation ? [outcome.generation] : [],
      );
      const failed = outcomes.filter((outcome) => "error" in outcome).length;
      if (!created.length) {
        const firstError = outcomes.find((outcome) => "error" in outcome);
        throw (firstError && "error" in firstError ? firstError.error : new Error("생성 요청 실패"));
      }

      const dragParent = dragParentRef.current;
      dragParentRef.current = null;
      // 캔버스는 요청 전에 이미 연결했다. 일반 생성만 기존 콜백으로 결과 카드를 추가한다.
      if (canvasLinks.length) onCanvasBatchCreated?.(created);
      else onCreated(created, dragParent);

      if (displayPrompt) {
        const filtered = historyRef.current.filter((entry) => entry.text !== displayPrompt);
        const historyTray: ChipRef[] = trayRefs.map(({ uid: _uid, ...ref }) => ref);
        filtered.push({
          parts,
          text: displayPrompt,
          trayRefs: historyTray.length ? historyTray : undefined,
        });
        historyRef.current = filtered.slice(-HIST_MAX);
        saveHistory(historyRef.current);
        onHistorySaved?.();
      }
      // 파생 Text는 같은 카드/원문이면 복원 effect가 다시 돌지 않으므로 비우지 않는다.
      // 일반 입력도 요청 대기 중 다른 카드로 이동하거나 새로 편집했으면 그대로 보존한다.
      if (!preservePromptAfterSubmit && editorRef.current === editor &&
          promptContextRef.current === submittedContext &&
          JSON.stringify(serializeParts(editor)) === submittedParts) {
        editor.innerHTML = "";
        updatePlaceholder();
        notifyPromptChanged();
        clearMention();
        // 다음 입력을 바로 칠 수 있게 프롬프트에 초점을 — 단 응답을 기다리는 사이 **다른 곳으로 옮긴 초점은 빼앗지 않는다**(검색칸에 치던
        //  글자가 프롬프트로 들어갔다 — Codex 검토). 줄 때: 갈 곳을 잃었거나(BODY) · 아직 프롬프트 입력칸이거나 · 마우스로 누른 생성 단추에
        //  남아 있을 때뿐. 패널 안이라도 옵션의 입력칸(길이·시드 등)으로 옮긴 초점은 두어야 한다.
        if (!inCompose) requestAnimationFrame(() => {
          const active = document.activeElement;
          const free = !active || active === document.body || editor.contains(active) || active.matches("button.sl-gen");
          if (free && editorRef.current === editor && promptContextRef.current === submittedContext &&
              serializeParts(editor).length === 0) editor.focus();
        });
      }
      setBusy(false);
      if (failed) setError(`${batch}장 중 ${failed}장 제출 실패 — 성공한 요청은 계속 진행됩니다.`);
    } catch (error) {
      setError(String(error));
      setBusy(false);
    }
  }, [
    activeProjectId,
    armedAutoTags,
    armedFolder,
    generationAssignment,
    canvasTarget,
    busy,
    clearMention,
    count,
    discardCanvasGeneration,
    dragParentRef,
    editorRef,
    historyRef,
    inCompose,
    preservePromptAfterSubmit,
    model,
    notifyPromptChanged,
    onCreated,
    onHistorySaved,
    onCanvasBatchCreated,
    prepareCanvasGeneration,
    settleCanvasGeneration,
    optionValues,
    paramsLoading,
    paramsModel,
    setBusy,
    setError,
    trayRefs,
    trayReady,
    tunable,
    updatePlaceholder,
    workspace,
  ]);
}
