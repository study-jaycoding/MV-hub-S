// 편집 문서 하나의 상태 — 읽기·바꾸기·저장·Undo·다른 창의 변경 받아들이기.
// (키, 문서)를 한 쌍으로 들어 옛 문서가 새 키에 저장되는 틈을 만들지 않는다. 계약은 docs/EDIT_TAB.md.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { emptyEditDoc, keepClipDurs, type EditDoc } from "./editTimeline";
import {
  clearUndo,
  editRawChanged,
  keepUnsavedEditDoc,
  noteEditRaw,
  pushUndo,
  readEditDoc,
  undoStack,
  unsavedEditDoc,
  writeEditDoc,
} from "./editTimelineStore";
import { t } from "./i18n";

interface Held {
  key: string | null;
  doc: EditDoc;
  rev: number; // 문서를 새로 열거나 다른 창의 문서를 받아들일 때마다 바뀐다 — 그 전에 시작한 지연 콜백을 버리는 기준
  bad: boolean; // 저장돼 있던 문서를 읽지 못함(아직 덮지 않았다)
  badRaw: string | null;
  dirty: boolean; // 마지막 변경이 저장되지 않았다
  savedRaw: string | null; // 이 창이 저장소에 있다고 아는 원문(마지막으로 읽었거나 쓴 것)
  openRaw: string | null; // 열 때 저장소에 있던 원문
  // 저장 못 한 편집이 있는데 그 사이 다른 창이 저장했다. 풀릴 때까지 **자동 저장은 하지 않는다** — 사용자가 편집을
  // 이어 갈 때만 저장한다(그것이 다른 창의 저장을 덮는다는 것을 알린 뒤다).
  conflict: boolean;
  warned: boolean;
  checked: boolean; // 연 직후의 확인을 마쳤다(effect 가 두 번 돌아도 한 번만 한다)
}

// rev 는 열 때마다 새 번호 — 다른 문서에서 시작한 지연 콜백이 번호가 우연히 같아 끼어들지 못하게 한다.
let lastRev = 0;

// 읽기만 한다(렌더 중에 불리고 StrictMode 에서는 두 번 불린다) — 모듈 상태는 아래 effect 가 고친다.
function open(key: string | null): Held {
  const stored = key ? readEditDoc(key) : null;
  const kept = key ? unsavedEditDoc(key) : undefined; // 저장하지 못한 채 떠났던 문서 — 버리지 않고 이어 간다
  const raw = stored?.raw ?? null;
  return {
    key, rev: ++lastRev, doc: kept?.doc ?? stored?.doc ?? emptyEditDoc(),
    bad: !!stored?.bad, badRaw: stored?.bad ? raw : null, dirty: !!kept,
    savedRaw: kept ? kept.base : raw, openRaw: raw, conflict: !!kept && kept.base !== raw, warned: false, checked: false,
  };
}

export interface EditOptions {
  undo?: boolean; // false = 사용자의 편집이 아니다(확정 길이 기록 등) — Undo 단계가 아니고, 충돌 중에는 저장하지 않는다
  rev?: number; // 지연 콜백이 시작할 때 본 rev — 그 사이 문서가 갈렸으면 버린다
}

const CHANGED_ELSEWHERE = "다른 창에서 이 편집이 바뀌었습니다. 이 창의 변경은 아직 저장되지 않았습니다.";

export function useEditDoc(key: string | null, flash: (message: string) => void) {
  const held = useRef<Held | null>(null);
  // 문서 전환은 렌더 중에 확정한다.
  if (!held.current || held.current.key !== key) held.current = open(key);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const flashRef = useRef(flash);
  flashRef.current = flash;

  // user = 사용자의 편집(되돌리기 포함). 충돌 중에는 이것만 저장한다.
  const commit = useCallback((next: EditDoc, user: boolean) => {
    const cur = held.current!;
    if (!cur.key) return;
    cur.doc = next;
    const raw = cur.conflict && !user ? null : writeEditDoc(cur.key, next, cur.bad ? cur.badRaw : null);
    if (raw !== null) {
      Object.assign(cur, { savedRaw: raw, dirty: false, bad: false, badRaw: null, conflict: false });
      noteEditRaw(cur.key, raw);
      keepUnsavedEditDoc(cur.key, null);
    } else {
      if (!cur.dirty) flashRef.current(t("편집을 저장하지 못했습니다. 다음 변경 때 다시 시도합니다."));
      cur.dirty = true;
      keepUnsavedEditDoc(cur.key, { doc: next, base: unsavedEditDoc(cur.key)?.base ?? cur.savedRaw });
    }
    bump();
  }, []);

  // 문서를 연 직후 — 자리를 비운 사이 다른 창이 저장했으면 옛 되돌리기를 비우고, 저장 못 한 편집은 한 번 더 저장해 본다.
  // 그 편집과 다른 창의 저장이 겹쳤으면 덮지 않고 알리기만 한다.
  useEffect(() => {
    const cur = held.current!;
    if (!cur.key || cur.key !== key) return;
    if (!cur.checked) {
      cur.checked = true; // 아래 재시도 저장이 원문을 바꾸므로, 두 번째 실행이 그것을 '다른 창의 저장'으로 보지 않게
      if (editRawChanged(cur.key, cur.openRaw)) {
        clearUndo(cur.key); // 옛 되돌리기는 그 저장을 모른다 — 되돌리기가 남의 저장을 덮지 않게
        bump();
      }
      noteEditRaw(cur.key, cur.openRaw);
    }
    if (!cur.dirty) return;
    if (!cur.conflict) return commit(cur.doc, false);
    if (cur.warned) return;
    cur.warned = true;
    flashRef.current(t(CHANGED_ELSEWHERE));
  }, [key, commit]);

  const applyEdit = useCallback(
    (change: (doc: EditDoc) => EditDoc | null, options: EditOptions = {}): boolean => {
      const cur = held.current!;
      if (!cur.key || (options.rev !== undefined && options.rev !== cur.rev)) return false;
      const next = change(cur.doc);
      if (!next || next === cur.doc) return false;
      if (options.undo !== false) pushUndo(cur.key, cur.doc);
      commit(next, options.undo !== false);
      return true;
    },
    [commit],
  );

  const step = useCallback(
    (from: "past" | "future") => {
      const cur = held.current!;
      if (!cur.key) return;
      const stack = undoStack(cur.key);
      const next = stack[from].pop();
      if (!next) return;
      stack[from === "past" ? "future" : "past"].push(cur.doc);
      commit(keepClipDurs(next, cur.doc), true); // 확정된 길이는 되돌리기 대상이 아니다
    },
    [commit],
  );

  // 다른 창의 저장은 '바뀌었다'는 알림으로만 쓴다 — 이벤트 본문이 아니라 지금 저장소의 값을 다시 읽는다.
  // (늦게 온 옛 알림을 그대로 받아들이면 그 뒤 이 창이 저장한 것을 되돌린다.)
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const cur = held.current!;
      if (!cur.key || event.key !== cur.key) return;
      const stored = readEditDoc(cur.key);
      if (stored.raw === cur.savedRaw) return; // 이 창의 마지막 저장과 같다 = 낡은 알림
      if (cur.dirty) {
        cur.conflict = true; // 저장 못 한 편집이 있다 — 받아들이지 않고, 자동 저장으로 덮지도 않는다
        flashRef.current(t(CHANGED_ELSEWHERE));
        return;
      }
      clearUndo(cur.key);
      noteEditRaw(cur.key, stored.raw);
      held.current = open(cur.key);
      flashRef.current(t("다른 창에서 바꾼 편집을 불러왔습니다."));
      bump();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const cur = held.current;
  const stack = cur.key ? undoStack(cur.key) : null;
  return {
    doc: cur.doc,
    rev: cur.rev,
    bad: cur.bad,
    dirty: cur.dirty,
    canUndo: !!stack?.past.length,
    canRedo: !!stack?.future.length,
    applyEdit,
    undo: useCallback(() => step("past"), [step]),
    redo: useCallback(() => step("future"), [step]),
  };
}
