import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject, type MouseEvent } from "react";
import type { SpotlightTrayRef } from "../components/spotlight/SpotlightRefTray";
import { serializeParts, wrapRefTokens, type PromptPart } from "./promptEditor";
import { seedanceTrayTypeIndex, type SeedanceImageTokenKind } from "./seedancePrompt";
import { captureRoleSelection, editSeedanceImageRole, restoreRoleSelection, restoreRoleSnapshot, roleEditorFingerprint, type EditorBookmark } from "./seedanceRoleEditor";

interface Params {
  scope: string;
  model: string;
  mode: unknown;
  ready: boolean;
  active: boolean;
  trayRefs: SpotlightTrayRef[];
  editorRef: RefObject<HTMLDivElement>;
  allowFocusRef: MutableRefObject<boolean>;
  resolveMedia: (kind: string, n: number) => string | undefined;
  onEdited: () => void;
}
type Menu = { uid: string; scope: string; x: number; y: number };
type Undo = { parts: PromptPart[]; selection: EditorBookmark | null; after: string; scope: string };

export function useSeedanceRoleMenu(params: Params) {
  const latest = useRef(params);
  latest.current = params;
  const [menu, setMenu] = useState<Menu | null>(null);
  const bookmark = useRef<EditorBookmark | null>(null);
  const undo = useRef<Undo | null>(null);
  const interacted = useRef(false);
  const editing = useRef(false);
  useLayoutEffect(() => {
    bookmark.current = null;
    undo.current = null;
    interacted.current = false;
    setMenu(null);
  }, [params.scope]);
  useEffect(() => { if (!params.active) setMenu(null); }, [params.active]);

  useEffect(() => {
    const editor = params.editorRef.current;
    if (!editor) return;
    const capture = () => {
      if (!editing.current && interacted.current && document.activeElement === editor) {
        const selection = captureRoleSelection(editor);
        if (selection) bookmark.current = selection;
      }
    };
    const interact = () => { interacted.current = true; };
    const input = () => { interact(); undo.current = null; capture(); };
    const undoEdit = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "z" || event.isComposing) return;
      const entry = undo.current;
      if (!entry || entry.scope !== latest.current.scope || entry.after !== roleEditorFingerprint(editor)) return;
      // 1회 E Undo만 소유한다. 일반 입력이 끼면 폐기하고 브라우저의 입력 이력을 가로채지 않는다.
      event.preventDefault(); event.stopPropagation();
      editing.current = true;
      restoreRoleSnapshot(editor, entry.parts);
      wrapRefTokens(editor, latest.current.resolveMedia);
      restoreRoleSelection(editor, entry.selection);
      undo.current = null;
      editing.current = false;
      capture();
      latest.current.onEdited();
    };
    editor.addEventListener("mousedown", interact);
    editor.addEventListener("keydown", interact);
    editor.addEventListener("keydown", undoEdit);
    editor.addEventListener("input", input);
    editor.addEventListener("keyup", capture);
    editor.addEventListener("mouseup", capture);
    document.addEventListener("selectionchange", capture);
    return () => {
      editor.removeEventListener("mousedown", interact);
      editor.removeEventListener("keydown", interact);
      editor.removeEventListener("keydown", undoEdit);
      editor.removeEventListener("input", input);
      editor.removeEventListener("keyup", capture);
      editor.removeEventListener("mouseup", capture);
      document.removeEventListener("selectionchange", capture);
    };
  }, [params.editorRef]);

  const enabled = params.model === "seedance_2_5" && params.ready && params.mode === "omni_reference";
  const openMenu = (event: MouseEvent, uid: string) => {
    if (params.model !== "seedance_2_5" || params.trayRefs.find((ref) => ref.uid === uid)?.type !== "image") return;
    event.preventDefault(); event.stopPropagation();
    const editor = params.editorRef.current;
    if (editor && interacted.current && document.activeElement === editor) {
      const selection = captureRoleSelection(editor);
      if (selection) bookmark.current = selection;
    }
    setMenu({ uid, scope: params.scope, x: event.clientX, y: event.clientY });
  };
  const choose = (role: SeedanceImageTokenKind) => {
    const current = latest.current;
    const target = menu;
    setMenu(null);
    if (!target || target.scope !== current.scope || !current.active || current.model !== "seedance_2_5" || !current.ready || current.mode !== "omni_reference") return;
    const index = current.trayRefs.findIndex((ref) => ref.uid === target.uid);
    const editor = current.editorRef.current;
    if (index < 0 || current.trayRefs[index].type !== "image" || !editor) return;
    const saved = bookmark.current?.fingerprint === roleEditorFingerprint(editor) ? bookmark.current : null;
    const parts = serializeParts(editor);
    editing.current = true;
    current.allowFocusRef.current = true;
    editor.focus();
    editSeedanceImageRole(editor, seedanceTrayTypeIndex(current.trayRefs, index), role, saved, current.resolveMedia);
    editing.current = false;
    interacted.current = true;
    bookmark.current = captureRoleSelection(editor);
    undo.current = { parts, selection: saved, after: roleEditorFingerprint(editor), scope: current.scope };
    current.onEdited();
  };
  return { menu: menu?.scope === params.scope && params.model === "seedance_2_5" && params.trayRefs.some((ref) => ref.uid === menu.uid) ? menu : null,
    enabled, openMenu, choose, close: () => setMenu(null) };
}
