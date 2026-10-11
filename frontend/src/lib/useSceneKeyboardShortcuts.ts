import { backgroundKeysBlocked } from "./keyGate";
import { isKeyHandled } from "./keyHandled";
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
  /** 보드가 키를 받지 않는 동안(씬을 바꾸는 틈 — 화면의 카드가 떠난 씬의 것이다). 가위(Y)의 keyup 은 그대로 받는다. */
  isFrozen: () => boolean;
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
  onSelectAll: () => void;
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
      // 위에 창·메뉴가 떠 있으면 키는 그쪽 것이다(lib/keyGate) — 가려진 보드에서 Delete·Ctrl+Z·복사가 실행되지 않는다
      //  (2026-10-10 실측: 재생 창·모델 설정 창이 뜬 채 Delete 가 뒤 카드를 지웠다).
      if (backgroundKeysBlocked()) return;
      if (current.isFrozen()) return;
      // 폴더 창이 떠 있는 동안에는 보드를 누를 수도 없다(창의 막이 화면 전체를 덮고, 막을 누르면 창이 닫힌다) — 그동안의 키는 초점이
      //  어디에 있든 보드의 것이 아니다. 전엔 창 **안**에서 난 키만 걸렀다: 창에서 연 크게 보기·정보 창을 ✕·바깥 누름으로 닫거나 코멘트
      //  패널을 닫으면 초점이 BODY 로 떨어져(패널의 단추에 남아도 같다) r·d·Ctrl+A·Delete 가 가려진 보드 카드에 먹었다
      //  (2026-10-10 캔버스 실측 7가지 길, 각 6/6). 그 키는 창 안 격자가 받는다(lib/keyGate.useLooseKeys).
      if (document.querySelector(".folder-peek")) return;
      if (isSceneTextEntryTarget(event.target as HTMLElement | null)) return;

      // 실제 입력 요소에 포커스가 없는 Ctrl+C는 최우선으로 처리한다. 편집 상태나 결과 팝업이
      // 비정상적으로 남더라도 선택 노드 복사가 새로고침 전까지 막히지 않게 한다.
      // 단 '생성 결과' 창이 **화면에 떠 있으면** 쉰다(붙여넣기와 같다 — lib/useSceneClipboardDrop): 보드는 창에 가려져 있고 그 Ctrl+C 는
      //  창 안을 보고 누른 것이다. 전엔 뒤 보드의 고른 노드를 복사해 시스템 클립보드까지 표식으로 덮었다. 상태(isPopupOpen)가 아니라
      //  화면의 창을 본다 — 창 없이 상태만 남은 경우에는 위 약속대로 복사가 막히지 않는다.
      if (!document.querySelector(".scene-varwin") && sceneCopyShortcut(event, current.selectionCount())) {
        event.preventDefault();
        current.onCopy();
        return;
      }
      if (current.isTextEditing() && event.key !== "Escape") return;

      if (event.key === "Escape") {
        // 안쪽 처리(예: '생성 결과' 창 격자의 선택 해제)가 이미 쓴 Esc 는 다시 처리하지 않는다 — 한 번에 선택 해제 + 창 닫힘 방지.
        if (isKeyHandled(event)) return;
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
        } else if (matchShortcut(event, "selectAll")) {
          event.preventDefault(); // 결과 팝업이 떠 있을 때는 선택을 바꾸지 않되, 브라우저의 글자 전체 선택은 막는다
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
        case "select-all":
          event.preventDefault();
          if (!current.isPickerOpen()) current.onSelectAll(); // 노드 선택기가 열려 있으면 선택기 우선(선택은 그대로)
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
        case "arrange":
          if (current.onArrange(event.repeat)) event.preventDefault();
          return;
        case "connect":
          // 연결 키 — 자동 연결 규칙에 걸리는 쌍이 있으면 그것을 잇고, 없으면 왼→오른쪽으로 잇는다(꾹 눌러 반복된 키는 잇지 않는다)
          event.preventDefault();
          if (!current.onAutoConnect() && !event.repeat) current.onConnect();
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
      // 물리 키도 본다 — 한글 입력 상태에서는 keyup 의 key 가 글자가 아닐 수 있다(keydown 만 lib/keyGate 가 글자로 읽어 준다).
      if (event.key === "y" || event.key === "Y" || event.code === "KeyY") actionsRef.current.onCutHeldChange(false);
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
