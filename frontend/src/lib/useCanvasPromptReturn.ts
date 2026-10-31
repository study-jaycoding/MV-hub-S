import { useEffect, useRef } from "react";
import { isCanvasWindow, leaveCanvasHandoff, registerCanvasMemory, type CanvasHandoff, type CanvasPromptDraft } from "./popupWindows";
import type { SceneModelCfg } from "./scenes";

// 떠 있는 캔버스 창의 프롬프트 값을 닫을 때 메인 창으로 돌려준다(2026-10-31, docs/status/캔버스_닫는순간_2026-10-31.md) — 여는 방향은 canvasHandoff.
// 닫는 순간 메인 창이 캔버스 자리를 보고 있을 때만 받아 두고, 떠 있음이 풀리는 순간(저장본을 다시 읽은 뒤) 넣는다. 프롬프트·개수는 메인의 다른 탭과 함께
// 쓰므로, 다른 탭에서 쓰던 값을 바꾸지 않는다. canvasAway 는 탭만 옮겨도 풀려 기준으로 삼지 않는다.

export interface CanvasPromptPort {
  shownModel: () => SceneModelCfg | null;
  canvasDraft: () => string;
  adoptCanvasPrompt: (returned: CanvasPromptDraft & { model: SceneModelCfg | null }) => void;
}

interface CanvasPromptView {
  floating: boolean; // 이 창의 캔버스가 다른 창에 떠 있나
  atCanvas: boolean; // 이 창이 캔버스 자리(컴포즈 탭·편집 닫힘)를 보고 있나
  sceneId: string | null;
  promptVisible: boolean;
  batchCount: number;
  setPromptVisible: (visible: boolean) => void;
  setBatchCount: (count: number) => void;
  prompt: { readonly current: CanvasPromptPort | null };
}

type CanvasPromptReturn = Omit<CanvasHandoff, "selection">;

/** 카드를 안 고른 캔버스의 글 — 놓일 묶임은 App 의 trayBinding 키와 같다. */
export const canvasPromptDraft = (prompt: CanvasPromptPort | null, sceneId: string | null): CanvasPromptDraft | null =>
  sceneId ? { key: `${sceneId}:none`, draft: prompt?.canvasDraft() ?? "" } : null;

export function useCanvasPromptReturn(view: CanvasPromptView): void {
  const latest = useRef(view);
  latest.current = view;
  const returned = useRef<CanvasPromptReturn | null>(null);
  useEffect(() => {
    registerCanvasMemory("promptView", {
      save: () => {
        if (!isCanvasWindow()) return null;
        const { promptVisible, batchCount, prompt, sceneId } = latest.current;
        const value: CanvasPromptReturn = {
          promptVisible, batchCount, prompt: prompt.current?.shownModel() ?? null, promptDraft: canvasPromptDraft(prompt.current, sceneId),
        };
        leaveCanvasHandoff({ ...value, selection: null }); // 닫는 것이 아니라 새로 고침이면 이 창이 다시 받는다
        return value;
      },
      load: (value) => {
        returned.current = value && latest.current.floating && latest.current.atCanvas ? (value as CanvasPromptReturn) : null;
      },
    });
  }, []);
  useEffect(() => {
    if (view.floating) return;
    const value = returned.current;
    returned.current = null;
    if (!value || !latest.current.atCanvas) return;
    const { setBatchCount, setPromptVisible, prompt } = latest.current;
    setBatchCount(value.batchCount);
    setPromptVisible(value.promptVisible);
    if (value.promptDraft) prompt.current?.adoptCanvasPrompt({ ...value.promptDraft, model: value.prompt });
  }, [view.floating]);
}
