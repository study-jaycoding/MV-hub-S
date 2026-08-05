import type { SceneCardKind } from "./scenes";

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

const NODE_KEYS: Record<string, SceneCardKind> = {
  n: "generation",
  m: "model",
  l: "list",
  t: "text",
  v: "view",
  o: "output",
  i: "input",
  h: "head",
  r: "render",
  c: "comfy",
};

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
  if (mod && !event.altKey && lower === "c" && context.selectionCount > 0) {
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
