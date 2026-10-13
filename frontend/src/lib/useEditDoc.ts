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
  readEditRaw,
  undoStack,
  unsavedEditDoc,
  writeEditDoc,
} from "./editTimelineStore";
import { t } from "./i18n";
import { isLeaving } from "./unloadGuard";

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
  // 같은 이름으로 **잇달아** 한 편집은 되돌리기 한 단계다(길이 조절 창을 한 번 연 동안의 여러 걸음). 그사이 다른 편집·되돌리기·다른 창의
  //  문서가 끼어들면 새 단계가 된다. undo:false 로 묶지 않는다 — 그것은 '사용자의 편집이 아니다'라는 뜻이라 충돌 중에 저장되지 않는다.
  group?: string;
}

/** 바꾸기의 결과. `none` 과 `stopped` 를 가른다 — 부르는 쪽이 `none` 에 띄우는 안내("바꾸지 못했습니다 — 잠긴 트랙…")가 `stopped` 의 알림
 *  ("다른 창에서 바꾼 편집을 불러왔습니다…")을 덮지 않게(알림 칸은 하나다 — Codex 재검토).
 *  done = 바꿨다 · none = 바꿀 것이 없었다(변경 함수가 거부했거나, 옛 rev 의 지연 콜백) · stopped = 다른 창의 저장 때문에 이번 조작을 버렸다. */
export type EditOutcome = "done" | "none" | "stopped";

const CHANGED_ELSEWHERE = "다른 창에서 이 편집이 바뀌었습니다. 이 창의 변경은 아직 저장되지 않았습니다.";

export function useEditDoc(key: string | null, flash: (message: string) => void) {
  const held = useRef<Held | null>(null);
  // 문서 전환은 렌더 중에 확정한다.
  if (!held.current || held.current.key !== key) held.current = open(key);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const group = useRef<{ id: string; doc: EditDoc } | null>(null); // 되돌리기 한 단계로 묶는 중인 편집(EditOptions.group)

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

  // 다른 창이 저장했는가 — 그 알림(storage 이벤트)이 왔을 때, 그리고 **이 창이 문서를 바꾸기 직전**에 본다. 알림은 늦게 온다(비동기):
  //  그 전에 이 창이 저장하면 이 창의 낡은 문서 전체가 다른 창의 편집을 덮었다(Codex 배포 전 검토 — 바꾸기 직전에 보면 그 틈이 읽고 쓰는
  //  사이로 줄어든다). 이벤트 본문이 아니라 지금 저장소의 값을 읽는다(늦게 온 옛 알림을 받아들이면 그 뒤 이 창이 저장한 것을 되돌린다).
  //  원문이 같으면 문서를 풀어 읽지 않는다 — 편집마다 부른다.
  //  돌려주는 값 = **이번 조작을 멈춰야 하는가**(announced = 알림으로 불렸다 — 멈출 조작이 없다):
  //   · 다른 창의 문서를 방금 받아들였다 → 멈춘다. 그 조작은 옛 화면을 보고 고른 것이다(비어 있던 트랙에 넣기로 했는데 그사이 다른 창이
  //     그 트랙에 넣은 클립을 밀어내는 식 — Codex 재검토). 화면이 새 문서로 바뀌고 알림이 뜬다 — 사용자가 다시 한다.
  //   · 저장 못 한 편집이 있는데 다른 창이 저장한 것을 **방금 알았다** → 멈춘다(알림이 뜨기도 전에 그 저장을 덮지 않게). 알고 난 뒤의
  //     편집은 전처럼 저장한다(사용자가 알고 이어 가는 것이다).
  const pull = useCallback((announced: boolean): boolean => {
    const cur = held.current!;
    if (!cur.key || readEditRaw(cur.key) === cur.savedRaw) return false; // 이 창의 마지막 저장과 같다 = 바뀐 것 없음(낡은 알림 포함)
    if (cur.dirty) {
      // 저장 못 한 편집이 있다 — 받아들이지 않고, 자동 저장으로 덮지도 않는다. 알림이 올 때마다, 편집 직전에는 처음 알았을 때만 알린다.
      const known = cur.conflict;
      cur.conflict = true;
      if (announced || !known) flashRef.current(t(CHANGED_ELSEWHERE));
      return !known;
    }
    clearUndo(cur.key);
    held.current = open(cur.key);
    noteEditRaw(cur.key, held.current.openRaw);
    held.current.checked = true; // 방금 읽은 것이 기준이다 — 연 직후의 확인을 다시 하지 않는다
    flashRef.current(t(announced
      ? "다른 창에서 바꾼 편집을 불러왔습니다."
      : "다른 창에서 바꾼 편집을 불러왔습니다. 방금 한 조작은 적용하지 않았습니다 — 다시 해 주세요."));
    bump();
    return true;
  }, []);

  const applyEdit = useCallback(
    (change: (doc: EditDoc) => EditDoc | null, options: EditOptions = {}): EditOutcome => {
      const cur = held.current!;
      if (!cur.key || (options.rev !== undefined && options.rev !== cur.rev)) return "none";
      if (isLeaving()) {
        // 떠나는 중(로그아웃 응답 대기) — 곧 새로고침이라 받지 않는다(lib/unloadGuard). 사용자의 조작이면 까닭을 알린다(자동 기록은 조용히).
        if (options.undo !== false) flashRef.current(t("로그아웃하는 중입니다 — 지금 한 조작은 적용하지 않았습니다."));
        return "stopped";
      }
      if (pull(false)) return "stopped";
      const next = change(cur.doc);
      if (!next || next === cur.doc) return "none";
      const run = group.current; // 이어지는 묶음 — 이름이 같고, 그 묶음의 마지막 문서가 지금 문서 그대로일 때만 잇는다
      const joined = options.group !== undefined && run?.id === options.group && run.doc === cur.doc;
      if (options.undo !== false && !joined) pushUndo(cur.key, cur.doc);
      // 자동 기록(확정 길이)은 묶음을 끊지 않는다 — 창을 연 사이 실측이 와도 되돌리기는 한 단계다
      group.current = options.group !== undefined ? { id: options.group, doc: next }
        : options.undo === false && run?.doc === cur.doc ? { id: run.id, doc: next } : null;
      commit(next, options.undo !== false);
      return "done";
    },
    [commit, pull],
  );

  const step = useCallback(
    (from: "past" | "future") => {
      if (isLeaving() || pull(false)) return; // 되돌리기도 다른 창의 저장을 덮지 않는다 · 떠나는 중에는 받지 않는다
      const cur = held.current!;
      if (!cur.key) return;
      const stack = undoStack(cur.key);
      const next = stack[from].pop();
      if (!next) return;
      stack[from === "past" ? "future" : "past"].push(cur.doc);
      group.current = null; // 되돌리기·다시 하기는 묶음을 끊는다
      commit(keepClipDurs(next, cur.doc), true); // 확정된 길이는 되돌리기 대상이 아니다
    },
    [commit, pull],
  );

  // 다른 창의 저장은 '바뀌었다'는 알림으로만 쓴다(위 pull).
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === held.current!.key) pull(true);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [pull]);

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
