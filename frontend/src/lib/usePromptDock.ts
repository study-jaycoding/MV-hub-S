import { useEffect, useState } from "react";
import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { matchShortcut } from "./shortcuts";
import type { Store } from "./storage";
import { useCustomEvent } from "./useCustomEvent";

interface UsePromptDockResult {
  composerExpanded: boolean;
  promptVisible: boolean;
  setPromptVisible: (visible: boolean) => void;
  toggleComposerExpanded: () => void;
}

export function usePromptDock(store: Store): UsePromptDockResult {
  const [promptVisible, setPromptVisibleState] = useState(true);
  const [composerExpanded, setComposerExpanded] = useState(
    () => store.get("composerExpanded", "0") === "1",
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchShortcut(e, "focusPrompt")) {
        e.preventDefault();
        setPromptVisibleState((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
