// 편집 문서 하나의 상태 — 읽기·바꾸기·저장·Undo·다른 창의 변경 받아들이기.
// (키, 문서)를 한 쌍으로 들어 옛 문서가 새 키에 저장되는 틈을 만들지 않는다. 계약은 docs/EDIT_TAB.md.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { emptyEditDoc, keepClipDurs, type EditDoc } from "./editTimeline";
import { createEditArchive, knownDocEquals, MAX_ARCHIVE_BYTES, parseEditArchive, utf8Bytes, type ArchiveTarget } from "./editArchive";
import { captureEditBackupGuard, editBackupActive, loadEditBackup, restoreEditBackup, subscribeEditBackup } from "./editDocBackup";
import { getAccountScope } from "./accountScope";
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
  writeEditRaw,
  pendingEditRestore,
  keepPendingEditRestore,
  type StoredEditDoc,
} from "./editTimelineStore";
import { t } from "./i18n";
import { isLeaving } from "./unloadGuard";

interface Held {
  account: string;
  version: number;
  readError: boolean;
  valid: boolean;
  restoreExternal: boolean;
  restoreExternalRaw?: string | null;
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
  // 충돌로 **알고 있는** 다른 창의 원문과 그 번호. '안다'는 것은 그때 본 원문에 대해서다 — 알고 이어 가는 동안 다른 창이 또 저장하면
  //  (새 원문) 그것은 새로 안 충돌이다: 번호가 바뀌고, 이어지던 조작은 다시 한 번 멈춘다(Codex 코드 리뷰 3회째 P1).
  seenRaw: string | null;
  conflictId: number; // 0 = 충돌을 안 적 없음
  warned: boolean;
  checked: boolean; // 연 직후의 확인을 마쳤다(effect 가 두 번 돌아도 한 번만 한다)
}

// rev 는 열 때마다 새 번호 — 다른 문서에서 시작한 지연 콜백이 번호가 우연히 같아 끼어들지 못하게 한다.
let lastRev = 0;
let lastConflict = 0; // 충돌 번호 — 새 외부 저장을 알 때마다 새 번호

// 읽기만 한다(렌더 중에 불리고 StrictMode 에서는 두 번 불린다) — 모듈 상태는 아래 effect 가 고친다.
function open(key: string | null, stored: StoredEditDoc | null = key ? readEditDoc(key) : null): Held {
  const pending = key ? pendingEditRestore(key) : undefined;
  const kept = key ? unsavedEditDoc(key) : undefined; // 저장하지 못한 채 떠났던 문서 — 버리지 않고 이어 간다
  const raw = stored?.raw ?? null;
  const value: Held = {
    account: getAccountScope(),
    version: 0, readError: !!stored?.inaccessible, valid: !!kept || (!!stored && !stored.bad && !stored.inaccessible), restoreExternal: false,
    key, rev: ++lastRev, doc: kept?.doc ?? stored?.doc ?? emptyEditDoc(),
    bad: !!stored?.bad, badRaw: stored?.bad ? raw : null, dirty: !!kept,
    savedRaw: kept ? kept.base : raw, openRaw: raw, conflict: !stored?.inaccessible && !!kept && kept.base !== raw, warned: false, checked: false,
    seenRaw: kept && kept.base !== raw ? raw : null, conflictId: !stored?.inaccessible && kept && kept.base !== raw ? ++lastConflict : 0,
  };
  if (pending) Object.assign(value, { doc: pending.doc, savedRaw: pending.raw, bad: pending.bad,
    badRaw: pending.bad ? pending.raw : null, dirty: pending.dirty, valid: pending.valid, conflict: false });
  return value;
}

export interface ArchiveSnapshot {
  readonly key: string;
  readonly rev: number;
  readonly doc: EditDoc;
  readonly docRaw: string;
  readonly raw: string | null;
  readonly bad: boolean;
  readonly dirty: boolean;
  readonly readError: boolean;
  readonly valid: boolean;
  readonly conflict: boolean;
}
export interface VerifiedArchiveBackup { readonly snapshot: ArchiveSnapshot }
export type RestoreOutcome = "saved" | "unchanged" | "stopped" | "failed" | "uncertain";
const READ_ERROR = "편집 저장소를 읽지 못했습니다. 편집을 멈췄습니다. 파일로 보관하거나 다시 읽기를 눌러 주세요.";

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

// 끝 문장(Jay 2026-10-14): 이 알림 뒤에 편집을 이어 가면 이 창의 문서가 통째로 저장돼 다른 창의 변경이 사라진다(알고 이어 가는 편집 —
//  아래 pull 의 주석). 그 일을 알림이 미리 말한다. 동작은 그대로다.
const CHANGED_ELSEWHERE = "다른 창에서 이 편집이 바뀌었습니다. 이 창의 변경은 아직 저장되지 않았습니다. 계속 편집하면 이 창의 내용으로 저장되고 다른 창의 변경은 사라집니다.";

function backupCandidate(raw: string, target: ArchiveTarget): EditDoc | null {
  const archive = createEditArchive(emptyEditDoc(), target, false);
  archive.docRaw = raw;
  const result = parseEditArchive(JSON.stringify(archive), target);
  return result.ok ? result.doc : null;
}

export function useEditDoc(key: string | null, flash: (message: string) => void, target?: ArchiveTarget | null) {
  const held = useRef<Held | null>(null);
  // 문서 전환은 렌더 중에 확정한다.
  if (!held.current || held.current.key !== key) held.current = open(key);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const group = useRef<{ id: string; doc: EditDoc } | null>(null); // 되돌리기 한 단계로 묶는 중인 편집(EditOptions.group)
  const snapshots = useRef(new WeakMap<ArchiveSnapshot, { held: Held; version: number; account: string }>());
  const verifiedFiles = useRef(new WeakMap<VerifiedArchiveBackup, string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; snapshots.current = new WeakMap(); }; }, []);

  // user = 사용자의 편집(되돌리기 포함). 충돌 중에는 이것만 저장한다.
  const commit = useCallback((next: EditDoc, user: boolean) => {
    const cur = held.current!;
    if (!cur.key || cur.readError || pendingEditRestore(cur.key)) return;
    cur.version += 1;
    cur.valid = true;
    cur.doc = next;
    const raw = cur.conflict && !user ? null : writeEditDoc(cur.key, next, cur.bad ? cur.badRaw : null);
    if (raw !== null) {
      Object.assign(cur, { savedRaw: raw, dirty: false, bad: false, badRaw: null, conflict: false, seenRaw: null });
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
    if (!cur.key || cur.key !== key || cur.readError || pendingEditRestore(cur.key)) return;
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
    if (!cur.key) return false;
    if (pendingEditRestore(cur.key) || cur.readError) return true;
    const read = readEditRaw(cur.key);
    if (read.kind === "error") {
      cur.readError = true;
      cur.version += 1;
      flashRef.current(t(READ_ERROR));
      bump();
      return true;
    }
    const { raw } = read;
    if (raw === cur.savedRaw) return false;
    if (cur.dirty) {
      // 저장 못 한 편집이 있다 — 받아들이지 않고, 자동 저장으로 덮지도 않는다. 알림이 올 때마다, 편집 직전에는 **그 원문을 처음 봤을 때만** 알린다.
      const known = cur.conflict && cur.seenRaw === raw;
      cur.conflict = true;
      cur.version += 1;
      cur.seenRaw = raw;
      if (announced || !known) flashRef.current(t(CHANGED_ELSEWHERE));
      if (!known) {
        cur.conflictId = ++lastConflict;
        bump(); // 화면이 충돌을 알게 한다(conflict) — 이어지던 조작(길이 조절 창의 끌기)을 거기서 끝내게
      }
      return !known;
    }
    clearUndo(cur.key);
    held.current = open(cur.key, readEditDoc(cur.key, read));
    noteEditRaw(cur.key, held.current.openRaw);
    held.current.checked = true; // 방금 읽은 것이 기준이다 — 연 직후의 확인을 다시 하지 않는다
    flashRef.current(t(announced
      ? "다른 창에서 바꾼 편집을 불러왔습니다."
      : "다른 창에서 바꾼 편집을 불러왔습니다. 방금 한 조작은 적용하지 않았습니다 — 다시 해 주세요."));
    bump();
    return true;
  }, []);

  const retryRead = useCallback(() => {
    const cur = held.current!;
    if (!cur.key || pendingEditRestore(cur.key) || isLeaving() || cur.account !== getAccountScope()) return;
    const stored = readEditDoc(cur.key);
    if (stored.inaccessible) { flashRef.current(t(READ_ERROR)); return; }
    cur.readError = false;
    cur.version += 1;
    if (stored.raw === cur.savedRaw) {
      cur.bad = stored.bad;
      cur.badRaw = stored.bad ? stored.raw : null;
    }
    if (!cur.valid && !cur.dirty) {
      if (editRawChanged(cur.key, stored.raw)) clearUndo(cur.key);
      held.current = open(cur.key, stored);
      held.current.checked = true;
      noteEditRaw(cur.key, stored.raw);
      bump();
      return;
    }
    if (!pull(true) && cur.dirty && !cur.conflict) commit(cur.doc, false);
    bump();
  }, [commit, pull]);

  const isArchiveSnapshotCurrent = useCallback((snapshot: ArchiveSnapshot): boolean => {
    const captured = snapshots.current.get(snapshot);
    const cur = held.current!;
    return mounted.current && !isLeaving() && !!captured && captured.held === cur && captured.version === cur.version
      && captured.account === getAccountScope() && cur.key === snapshot.key && cur.rev === snapshot.rev && cur.doc === snapshot.doc
      && JSON.stringify(cur.doc) === snapshot.docRaw && cur.savedRaw === snapshot.raw;
  }, []);

  const captureArchiveSnapshot = useCallback((forRestore = false): ArchiveSnapshot | null => {
    if (isLeaving()) return null;
    if (forRestore && pull(false)) return null;
    const cur = held.current!;
    if (!cur.key || cur.account !== getAccountScope() || (forRestore && (cur.readError || cur.conflict || pendingEditRestore(cur.key)))) return null;
    const snapshot: ArchiveSnapshot = Object.freeze({ key: cur.key, rev: cur.rev, doc: cur.doc,
      docRaw: JSON.stringify(cur.doc), raw: cur.savedRaw, bad: cur.bad, dirty: cur.dirty,
      readError: cur.readError, valid: cur.valid, conflict: cur.conflict });
    snapshots.current.set(snapshot, { held: cur, version: cur.version, account: getAccountScope() });
    return snapshot;
  }, [pull]);

  const verifyArchiveBackup = useCallback(async (snapshot: ArchiveSnapshot, expectedText: string,
    file: { size: number; text(): Promise<string> }): Promise<VerifiedArchiveBackup | null> => {
    if (!isArchiveSnapshotCurrent(snapshot) || file.size > MAX_ARCHIVE_BYTES || file.size !== utf8Bytes(expectedText)) return null;
    try {
      const text = await file.text();
      if (!isArchiveSnapshotCurrent(snapshot) || text !== expectedText) return null;
      const verified = Object.freeze({ snapshot });
      verifiedFiles.current.set(verified, expectedText);
      return verified;
    } catch { return null; }
  }, [isArchiveSnapshotCurrent]);

  const finishRestore = useCallback((candidate: EditDoc, raw: string, recordUndo = true) => {
    const cur = held.current!;
    if (!cur.key) return;
    if (recordUndo) pushUndo(cur.key, cur.doc);
    else clearUndo(cur.key);
    Object.assign(cur, { doc: candidate, savedRaw: raw, openRaw: raw, dirty: false, bad: false, badRaw: null,
      conflict: false, seenRaw: null, readError: false, valid: true, restoreExternal: false, rev: ++lastRev, version: cur.version + 1 });
    group.current = null;
    noteEditRaw(cur.key, raw);
    keepUnsavedEditDoc(cur.key, null);
    keepPendingEditRestore(cur.key, null);
    bump();
  }, []);

  // 복구는 두 저장 자리가 모두 없을 때만. 요청 중 편집·계정·문맥이 바뀌면 원문을 쓰기 전에 멈춘다.
  useEffect(() => {
    let disposed = false;
    let running = false;
    let checked = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const recover = async () => {
      const cur = held.current!;
      if (disposed || running || checked || !target || !key || cur.key !== key || !editBackupActive()
        || cur.savedRaw !== null || cur.dirty || cur.bad || cur.readError || pendingEditRestore(key)) return;
      const snapshot = captureArchiveSnapshot();
      if (!snapshot) return;
      const authorized = captureEditBackupGuard();
      running = true;
      try {
        const listing = await loadEditBackup(key);
        const raw = listing.head?.data;
        if (disposed || !authorized() || !isArchiveSnapshotCurrent(snapshot)) return;
        checked = true;
        if (typeof raw !== "string") return;
        const candidate = backupCandidate(raw, target);
        const read = readEditRaw(key);
        if (!candidate || read.kind !== "ok" || read.raw !== null || !isArchiveSnapshotCurrent(snapshot)) return;
        if (writeEditRaw(key, raw) === null) return;
        const check = readEditRaw(key);
        if (check.kind !== "ok" || check.raw !== raw) { retryRead(); return; }
        finishRestore(candidate, raw, false);
        flashRef.current(t("DB 백업에서 편집을 복구했습니다."));
      } catch {
        if (!disposed) retry = setTimeout(() => { void recover(); }, 30_000);
      } finally { running = false; }
    };
    void recover();
    const unsubscribe = subscribeEditBackup(() => { void recover(); });
    return () => { disposed = true; unsubscribe(); if (retry) clearTimeout(retry); };
  }, [key, target?.projectId, target?.seq, captureArchiveSnapshot, isArchiveSnapshotCurrent, finishRestore, retryRead]);

  const replaceFromBackup = useCallback(async (raw: string, expected: ArchiveSnapshot, baseRevision: number | null,
    context: ArchiveTarget, adopt = false, copyHash?: string): Promise<RestoreOutcome> => {
    if (!isArchiveSnapshotCurrent(expected) || !expected.key || expected.readError || expected.conflict || pendingEditRestore(expected.key)) return "stopped";
    const candidate = backupCandidate(raw, context);
    if (!candidate) return "failed";
    const before = readEditRaw(expected.key);
    if (before.kind !== "ok" || before.raw !== expected.raw) { pull(true); return "stopped"; }
    const authorized = captureEditBackupGuard();
    try {
      const result = await restoreEditBackup(expected.key, baseRevision, copyHash ? { copy_hash: copyHash } : { data: raw },
        expected.dirty ? expected.docRaw : expected.raw, adopt ? "pre_adopt" : "pre_restore");
      if (!authorized() || result.status === "conflict" || !isArchiveSnapshotCurrent(expected)) return "stopped";
      const read = readEditRaw(expected.key);
      if (read.kind !== "ok" || read.raw !== expected.raw || !isArchiveSnapshotCurrent(expected)) { pull(true); return "stopped"; }
      const restoredRaw = result.data;
      if (typeof restoredRaw !== "string" || restoredRaw !== raw) return "uncertain";
      if (writeEditRaw(expected.key, restoredRaw, expected.bad ? expected.raw : null) === null) return "failed";
      const check = readEditRaw(expected.key);
      if (check.kind !== "ok" || check.raw !== restoredRaw) { retryRead(); return "uncertain"; }
      finishRestore(candidate, restoredRaw);
      return "saved";
    } catch { return "uncertain"; }
  }, [finishRestore, isArchiveSnapshotCurrent, pull, retryRead]);

  const replaceFromArchive = useCallback((candidate: EditDoc, expected: ArchiveSnapshot,
    verified: VerifiedArchiveBackup | null): RestoreOutcome => {
    const cur = held.current!;
    if (!isArchiveSnapshotCurrent(expected) || !cur.key || cur.readError || cur.conflict || pendingEditRestore(cur.key)) return "stopped";
    // shortcut: localStorage에는 비교와 쓰기를 묶는 잠금이 없다. 다른 창을 닫고 복원하며 다중 창 지원 때 저장 트랜잭션으로 바꾼다.
    const read = readEditRaw(cur.key);
    if (read.kind === "error" || read.raw !== expected.raw) { pull(true); return "stopped"; }
    if (cur.valid && knownDocEquals(candidate, cur.doc)) return "unchanged";
    const backupText = verified && verified.snapshot === expected ? verifiedFiles.current.get(verified) : undefined;
    if (backupText === undefined) return "stopped";
    verifiedFiles.current.delete(verified!);
    const raw = writeEditDoc(cur.key, candidate, cur.bad ? cur.badRaw : null);
    if (raw === null) return "failed";
    const check = readEditRaw(cur.key);
    if (check.kind === "error" || check.raw !== raw) {
      keepPendingEditRestore(cur.key, { doc: cur.doc, raw: expected.raw, dirty: cur.dirty, bad: cur.bad,
        valid: cur.valid, candidate, candidateRaw: raw, backupText });
      cur.version += 1;
      cur.readError = check.kind === "error";
      bump();
      return "uncertain";
    }
    finishRestore(candidate, raw);
    return "saved";
  }, [finishRestore, isArchiveSnapshotCurrent, pull]);

  const retryRestore = useCallback((acceptExternal = false): RestoreOutcome => {
    const cur = held.current!;
    const pending = cur.key ? pendingEditRestore(cur.key) : undefined;
    if (!cur.key || !pending || isLeaving() || cur.account !== getAccountScope()) return "stopped";
    const read = readEditRaw(cur.key);
    if (read.kind === "error") { cur.readError = true; bump(); return "uncertain"; }
    if (read.raw === pending.candidateRaw) { finishRestore(pending.candidate, pending.candidateRaw); return "saved"; }
    if (read.raw === pending.raw) {
      keepPendingEditRestore(cur.key, null);
      cur.readError = false;
      cur.restoreExternal = false;
      cur.version += 1;
      bump();
      return "failed";
    }
    if (acceptExternal && cur.restoreExternal && read.raw === cur.restoreExternalRaw) {
      keepPendingEditRestore(cur.key, null);
      keepUnsavedEditDoc(cur.key, null);
      clearUndo(cur.key);
      held.current = open(cur.key, readEditDoc(cur.key, read));
      held.current.checked = true;
      noteEditRaw(cur.key, held.current.openRaw);
      bump();
      return "stopped";
    }
    cur.restoreExternal = true;
    cur.restoreExternalRaw = read.raw;
    cur.readError = false;
    bump();
    return "uncertain";
  }, [finishRestore]);

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
    readError: cur.readError,
    hasValidDoc: cur.valid,
    restorePending: !!cur.key && !!pendingEditRestore(cur.key),
    restoreExternal: cur.restoreExternal,
    captureArchiveSnapshot, isArchiveSnapshotCurrent, verifyArchiveBackup, replaceFromArchive, replaceFromBackup, retryRead, retryRestore,
    // 저장 못 한 편집이 있는데 다른 창이 저장했다(풀릴 때까지). 여러 걸음에 걸친 한 조작(길이 조절 창의 슬라이더 끌기)은 이것이 켜지면
    //  끝낸다 — 같은 끌기의 다음 걸음을 '알고 이어 가는 편집'으로 받으면 알림을 읽기도 전에 다른 창의 저장을 덮는다(Codex 코드 리뷰 P1).
    //  값 = 충돌 번호(0 = 없음). **새 외부 저장을 알 때마다 번호가 바뀐다** — 알고 다시 연 조작 도중 다른 창이 또 저장하면 그 조작도 끝낸다.
    conflict: cur.conflict ? cur.conflictId : 0,
    canUndo: !!stack?.past.length,
    canRedo: !!stack?.future.length,
    applyEdit,
    undo: useCallback(() => step("past"), [step]),
    redo: useCallback(() => step("future"), [step]),
  };
}
