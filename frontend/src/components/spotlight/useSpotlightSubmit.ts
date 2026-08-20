import { useCallback } from "react";
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
  model: string;
  onCreated: (created?: Generation[], dragParentId?: string | null) => void;
  canvasTarget?: CanvasGenerationTarget | null;
  prepareCanvasGeneration?: (
    target: CanvasGenerationTarget,
    count: number,
  ) => CanvasGenerationLink[];
  settleCanvasGeneration?: (link: CanvasGenerationLink, generation: Generation) => void;
  discardCanvasGeneration?: (link: CanvasGenerationLink) => void;
  onCanvasBatchCreated?: (created: Generation[]) => void;
  optionValues: Record<string, unknown>;
  paramsLoading: boolean;
  paramsModel: string;
  trayRefs: SpotlightTrayRef[];
  tunable: ModelParam[];
  workspace: WorkspaceContext;
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  clearMention: () => void;
  updatePlaceholder: () => void;
  notifyPromptChanged: () => void;
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
  model,
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
  tunable,
  workspace,
  setBusy,
  setError,
  clearMention,
  updatePlaceholder,
  notifyPromptChanged,
}: UseSpotlightSubmitOptions) {
  return useCallback(async (
    batchOverride?: number,
    generationAssignmentOverride?: SceneGenerationAssignment | null,
    canvasTargetOverride?: CanvasGenerationTarget | null,
  ) => {
    if (busy) return;
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
    if (!model) {
      setError("모델을 선택하세요.");
      return;
    }
    if (paramsLoading || paramsModel !== model) {
      setError("모델 옵션을 불러오는 중입니다. 잠시 후 다시 생성해 주세요.");
      return;
    }

    const parts = serializeParts(editor);
    const displayPrompt = partsDisplay(parts);
    setBusy(true);
    try {
      const resolvedOptions = await resolveAutoAspectRatio(
        optionValues,
        tunable,
        [...trayRefs, ...inlineRefs],
      );
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
        optionValues: resolvedOptions,
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

      const batch = normalizeSpotlightBatch(
        batchOverride,
        count,
        SPOTLIGHT_MAX_COUNT,
      );
      const effectiveCanvasTarget =
        canvasTargetOverride !== undefined ? canvasTargetOverride : canvasTarget;
      // 요청보다 먼저 generation id와 목적 카드를 저장한다. 이 다음 순간 창이 닫혀도 재시작 복구가 가능하다.
      const canvasLinks = effectiveCanvasTarget && prepareCanvasGeneration
        ? prepareCanvasGeneration(effectiveCanvasTarget, batch)
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
      }
      editor.innerHTML = "";
      updatePlaceholder();
      notifyPromptChanged();
      clearMention();
      setBusy(false);
      if (failed) setError(`${batch}장 중 ${failed}장 제출 실패 — 성공한 요청은 계속 진행됩니다.`);
      if (!inCompose) requestAnimationFrame(() => editor.focus());
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
    model,
    notifyPromptChanged,
    onCreated,
    onCanvasBatchCreated,
    prepareCanvasGeneration,
    settleCanvasGeneration,
    optionValues,
    paramsLoading,
    paramsModel,
    setBusy,
    setError,
    trayRefs,
    tunable,
    updatePlaceholder,
    workspace,
  ]);
}
