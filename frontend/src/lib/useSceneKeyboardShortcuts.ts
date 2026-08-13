import { useEffect, useRef } from "react";
import { KEY_COLORS } from "./appConstants";
import {
  isSceneTextEntryTarget,
  sceneCopyShortcut,
  sceneKeyIntent,
} from "./sceneKeyboard";
import { matchShortcut } from "./shortcuts";
import type { SceneCardKind } from "./scenes";

interface SceneKeyboardActions {
  isTextEditing: () => boolean;
  isPopupOpen: () => boolean;
  isPickerOpen: () => boolean;
  selectionCount: () => number;
  onEscape: () => void;
  onPopupColor: (color: string) => void;
  onPopupDisable: () => boolean;
  onPopupTag: () => boolean;
  onCreateNode: (kind: SceneCardKind) => void;
  onTogglePicker: () => boolean;
  onUndo: () => void;
  onRedo: () => void;
  onCopy: () => void;
  onGroup: () => void;
  onFrame: () => void;
  onAutoConnect: () => boolean;
  onArrange: (repeat: boolean) => boolean;
  onConnect: () => void;
  onDisable: () => boolean;
  onColor: (color: string) => void;
  onTag: () => boolean;
  onCutHeldChange: (held: boolean) => void;
  onDelete: () => void;
}

const colorValue = (color: "red" | "green" | "blue") =>
  color === "red" ? KEY_COLORS.r : color === "green" ? KEY_COLORS.g : KEY_COLORS.b;

export function useSceneKeyboardShortcuts(actions: SceneKeyboardActions): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = actionsRef.current;
      if (isSceneTextEntryTarget(event.target as HTMLElement | null)) return;

      // 실제 입력 요소에 포커스가 없는 Ctrl+C는 최우선으로 처리한다. 편집 상태나 결과 팝업이
      // 비정상적으로 남더라도 선택 노드 복사가 새로고침 전까지 막히지 않게 한다.
      if (sceneCopyShortcut(event, current.selectionCount())) {
        event.preventDefault();
        current.onCopy();
        return;
      }
      if (current.isTextEditing() && event.key !== "Escape") return;

      if (event.key === "Escape") {
        current.onEscape();
        return;
      }

      if (current.isPopupOpen()) {
        if (event.repeat) return;
        if (matchShortcut(event, "colorRed")) {
          event.preventDefault();
          current.onPopupColor(KEY_COLORS.r);
        } else if (matchShortcut(event, "colorGreen")) {
          event.preventDefault();
          current.onPopupColor(KEY_COLORS.g);
        } else if (matchShortcut(event, "colorBlue")) {
          event.preventDefault();
          current.onPopupColor(KEY_COLORS.b);
        } else if (matchShortcut(event, "boardDisable")) {
          if (current.onPopupDisable()) event.preventDefault();
        } else if (matchShortcut(event, "tag")) {
          if (current.onPopupTag()) event.preventDefault();
        }
        return;
      }

      const intent = sceneKeyIntent(
        event,
        {
          pickerOpen: current.isPickerOpen(),
          selectionCount: current.selectionCount(),
        },
        matchShortcut,
      );
      if (!intent) return;

      switch (intent.type) {
        case "toggle-picker":
          if (current.onTogglePicker()) event.preventDefault();
          return;
        case "create-node":
          event.preventDefault();
          current.onCreateNode(intent.kind);
          return;
        case "undo":
          event.preventDefault();
          current.onUndo();
          return;
        case "redo":
          event.preventDefault();
          current.onRedo();
          return;
        case "copy":
          event.preventDefault();
          current.onCopy();
          return;
        case "group":
          event.preventDefault();
          if (!event.repeat) current.onGroup();
          return;
        case "frame":
          event.preventDefault();
          current.onFrame();
          return;
        case "auto-connect":
          if (current.onAutoConnect()) {
            event.preventDefault();
            return;
          }
          if (matchShortcut(event, "boardConnect")) {
            event.preventDefault();
            if (!event.repeat) current.onConnect();
          }
          return;
        case "arrange":
          if (current.onArrange(event.repeat)) event.preventDefault();
          return;
        case "connect":
          event.preventDefault();
          if (!event.repeat) current.onConnect();
          return;
        case "disable":
          if (!event.repeat && current.onDisable()) event.preventDefault();
          return;
        case "color":
          event.preventDefault();
          if (!event.repeat) current.onColor(colorValue(intent.color));
          return;
        case "tag":
          if (current.onTag()) event.preventDefault();
          return;
        case "cut-start":
          if (!event.repeat) current.onCutHeldChange(true);
          return;
        case "delete":
          event.preventDefault();
          current.onDelete();
          return;
        case "escape":
          return;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "y" || event.key === "Y") actionsRef.current.onCutHeldChange(false);
    };
    const onBlur = () => actionsRef.current.onCutHeldChange(false);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}
