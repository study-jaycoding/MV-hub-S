import type { SceneCardKind } from "./scenes";
import { SCENE_NODE_KEYS } from "./sceneNodeCatalog";

export interface SceneKeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface SceneKeyboardTarget {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

export type SceneKeyIntent =
  | { type: "escape" }
  | { type: "create-node"; kind: SceneCardKind }
  | { type: "toggle-picker" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "copy" }
  | { type: "group" }
  | { type: "frame" }
  | { type: "auto-connect" }
  | { type: "arrange" }
  | { type: "connect" }
  | { type: "disable" }
  | { type: "color"; color: "red" | "green" | "blue" }
  | { type: "tag" }
  | { type: "cut-start" }
  | { type: "delete" };

export type SceneEscapeTarget = "color" | "picker" | "popup" | "selection" | null;

// Escape 우선순위 — 열린 UI를 먼저 한 단계 닫고, 닫을 UI가 없을 때만 캔버스 선택을 해제한다.
// 팝업을 닫으면서 선택까지 동시에 잃으면 연속 편집이 불편하고, 반대로 아무 UI도 없는데 선택이
// 남으면 라이브러리의 Escape 동작과 어긋난다. 순수 함수로 고정해 SceneBoard 회귀를 막는다.
export function sceneEscapeTarget(context: {
  colorOpen: boolean;
  pickerOpen: boolean;
  popupOpen: boolean;
  selectionCount: number;
  rowSelectionCount: number;
}): SceneEscapeTarget {
  if (context.colorOpen) return "color";
  if (context.pickerOpen) return "picker";
  if (context.popupOpen) return "popup";
  if (context.selectionCount > 0 || context.rowSelectionCount > 0) return "selection";
  return null;
}

export type SceneShortcutMatcher = (
  event: SceneKeyLike,
  shortcut:
    | "boardArrange"
    | "boardConnect"
    | "boardDisable"
    | "colorRed"
    | "colorGreen"
    | "colorBlue"
    | "tag",
) => boolean;

const NON_TEXT_INPUT = new Set([
  "checkbox",
  "radio",
  "button",
  "range",
  "color",
  "file",
  "submit",
  "reset",
  "image",
]);

// 생성 가능 노드의 단축키 매핑 — 카탈로그(sceneNodeCatalog)에서 파생(3중 선언 어긋남 방지).
const NODE_KEYS: Record<string, SceneCardKind> = SCENE_NODE_KEYS;

export function isSceneTextEntryTarget(target: SceneKeyboardTarget | null | undefined): boolean {
  if (!target) return false;
  const tagName = target.tagName?.toUpperCase();
  return (
    (tagName === "INPUT" && !NON_TEXT_INPUT.has((target.type || "").toLowerCase())) ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    !!target.isContentEditable ||
    !!target.closest?.(".sl-dockbar")
  );
}

export function sceneNodeKindForKey(key: string): SceneCardKind | null {
  return NODE_KEYS[key.toLowerCase()] ?? null;
}

export function sceneCopyShortcut(event: SceneKeyLike, selectionCount: number): boolean {
  return (
    selectionCount > 0 &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "c"
  );
}

export function scenePasteShortcut(event: SceneKeyLike, clipboardNodeCount: number): boolean {
  return (
    clipboardNodeCount > 0 &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "v"
  );
}

export function sceneKeyIntent(
  event: SceneKeyLike,
  context: { pickerOpen: boolean; selectionCount: number },
  matchesShortcut: SceneShortcutMatcher = () => false,
): SceneKeyIntent | null {
  const { key } = event;
  const lower = key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey;

  if (key === "Escape") return { type: "escape" };

  if (context.pickerOpen && plain) {
    const kind = sceneNodeKindForKey(key);
    if (kind) return { type: "create-node", kind };
  }
  if (key === "Tab" && plain && !event.shiftKey) return { type: "toggle-picker" };
  if (mod && !event.altKey && lower === "z") {
    return { type: event.shiftKey ? "redo" : "undo" };
  }
  if (sceneCopyShortcut(event, context.selectionCount)) {
    return { type: "copy" };
  }
  if (mod && lower === "g") return { type: "group" };
  if (plain && lower === "f") return { type: "frame" };
  if (plain && lower === "c" && context.selectionCount >= 2) {
    return { type: "auto-connect" };
  }
  if (matchesShortcut(event, "boardArrange") && context.selectionCount >= 2) {
    return { type: "arrange" };
  }
  if (matchesShortcut(event, "boardConnect") && context.selectionCount >= 2) {
    return { type: "connect" };
  }
  if (matchesShortcut(event, "boardDisable")) return { type: "disable" };
  if (matchesShortcut(event, "colorRed")) return { type: "color", color: "red" };
  if (matchesShortcut(event, "colorGreen")) return { type: "color", color: "green" };
  if (matchesShortcut(event, "colorBlue")) return { type: "color", color: "blue" };
  if (matchesShortcut(event, "tag")) return { type: "tag" };
  if (lower === "y") return { type: "cut-start" };
  if (key === "Delete" && context.selectionCount > 0) return { type: "delete" };
  return null;
}
