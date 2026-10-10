import { backgroundKeysBlocked, isTypingTarget } from "./keyGate";
import { useEffect, useState, type MutableRefObject } from "react";
import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { getBinding, matchShortcut } from "./shortcuts";
import type { Store } from "./storage";
import { useCustomEvent } from "./useCustomEvent";

interface UsePromptDockResult {
  composerExpanded: boolean;
  promptVisible: boolean;
  setPromptVisible: (visible: boolean) => void;
  toggleComposerExpanded: () => void;
}

// inactiveRef — 프롬프트 도크가 화면에 없는 동안(편집 탭)에는 표시/숨김 단축키를 듣지 않는다.
export function usePromptDock(store: Store, inactiveRef?: MutableRefObject<boolean>): UsePromptDockResult {
  const [promptVisible, setPromptVisibleState] = useState(true);
  const [composerExpanded, setComposerExpanded] = useState(
    () => store.get("composerExpanded", "0") === "1",
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 위에 창·메뉴가 떠 있으면 쉰다 — 설정 창 뒤에서 도크가 켜지며 초점이 창 뒤 프롬프트로 가던 것(2026-10-10 실측).
      if (backgroundKeysBlocked()) return;
      // 수식키 없는 글자로 재지정했다면 글자를 치는 중에는 그 글자다(프롬프트에 그 글자를 칠 때마다 도크가 숨었다).
      const binding = getBinding("focusPrompt");
      if (!binding.startsWith("mod+") && !binding.startsWith("alt+") && isTypingTarget(e.target)) return;
      if (!inactiveRef?.current && matchShortcut(e, "focusPrompt")) {
        e.preventDefault();
        setPromptVisibleState((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inactiveRef]);

  useEffect(() => {
    if (promptVisible) dispatchAppEvent(APP_EVENTS.focusPrompt);
  }, [promptVisible]);

  useCustomEvent(APP_EVENTS.addReference, () => setPromptVisibleState(true));

  useEffect(() => {
    store.set("composerExpanded", composerExpanded ? "1" : "0");
  }, [composerExpanded, store]);

  return {
    composerExpanded,
    promptVisible,
    setPromptVisible: setPromptVisibleState,
    toggleComposerExpanded: () => setComposerExpanded((v) => !v),
  };
}
