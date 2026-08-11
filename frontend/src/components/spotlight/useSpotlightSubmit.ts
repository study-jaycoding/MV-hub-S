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


export const SPOTLIGHT_MAX_COUNT = 4;

interface UseSpotlightSubmitOptions {
  activeProjectId?: string;
  armedAutoTags: string[];
  armedFolder?: { projectId: string; path: string } | null;
  busy: boolean;
  count: number;
  dragParentRef: MutableRefObject<string | null>;
  editorRef: RefObject<HTMLDivElement>;
  historyRef: MutableRefObject<HistEntry[]>;
  inCompose: boolean;
  model: string;
  onCreated: (created?: Generation[], dragParentId?: string | null) => void;
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
  busy,
  count,
  dragParentRef,
  editorRef,
  historyRef,
  inCompose,
  model,
  onCreated,
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
  return useCallback(async (batchOverride?: number) => {
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
      const { body, error } = buildSpotlightCreateBody({
        text,
        inlineRefs,
        trayRefs,
        parts,
        displayPrompt,
        model,
        optionValues: resolvedOptions,
        armedAutoTags,
        activeProjectId,
        folderPath:
          armedFolder && armedFolder.projectId === activeProjectId
            ? armedFolder.path
            : undefined,
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
      const created = await Promise.all(
        Array.from({ length: batch }, () => api.create(body, workspace)),
      );

      const dragParent = dragParentRef.current;
      dragParentRef.current = null;
      onCreated(created, dragParent);

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
      if (!inCompose) requestAnimationFrame(() => editor.focus());
    } catch (error) {
      setError(String(error));
      setBusy(false);
    }
  }, [
    activeProjectId,
    armedAutoTags,
    armedFolder,
    busy,
    clearMention,
    count,
    dragParentRef,
    editorRef,
    historyRef,
    inCompose,
    model,
    notifyPromptChanged,
    onCreated,
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
