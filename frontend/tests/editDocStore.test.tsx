// @vitest-environment jsdom
// 편집 문서의 저장·되돌리기·다른 창 변경 — docs/EDIT_TAB.md 의 문서 계약을 지키는지.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clipKey, emptyEditDoc, insertClip, removeClips, setClipDurs, setClipRange, type EditDoc } from "../src/lib/editTimeline";
import { clearUndo, editDocKey, keepPendingEditRestore, keepUnsavedEditDoc, pendingEditRestore, readEditDoc, readEditRaw, undoStack, unsavedEditDoc } from "../src/lib/editTimelineStore";
import { useEditDoc, type ArchiveSnapshot, type VerifiedArchiveBackup } from "../src/lib/useEditDoc";
import { createEditArchive, createRecoveryArchive, MAX_ARCHIVE_BYTES, utf8Bytes } from "../src/lib/editArchive";
import { setLeaving, unloadHeld } from "../src/lib/unloadGuard";

let host: HTMLDivElement;
let root: Root;
let edit: ReturnType<typeof useEditDoc>;
const flash = vi.fn();
// 키는 시험마다 새로 — 저장소 모듈이 키별로 기억하는 것(마지막 원문·저장 못 한 문서)이 다음 시험에 새지 않게.
let KEY_A = "";
let KEY_B = "";
let serial = 0;
const clip = (gen: string, cut = "e070/c1") => ({ cut, gen, kind: "video" as const, dur: 5 });
const add = (gen: string, cut?: string) => act(() => { edit.applyEdit((doc) => insertClip(doc, clip(gen, cut))); });
const gens = () => edit.doc.clips.map((item) => item.gen);

function Harness({ docKey }: { docKey: string | null }) {
  edit = useEditDoc(docKey, flash);
  return null;
}
const render = (docKey: string | null) => act(() => root.render(<Harness docKey={docKey} />));
const renderStrict = (docKey: string | null) => act(() => root.render(<StrictMode><Harness docKey={docKey} /></StrictMode>));
const storageEvent = (key: string) => act(() => { window.dispatchEvent(new StorageEvent("storage", { key })); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.setItem("ch.accountScope", "");
  KEY_A = `mvhub.editDoc:test:p${++serial}:e070`;
  KEY_B = `mvhub.editDoc:test:p${serial}:e071`;
  clearUndo(KEY_A);
  clearUndo(KEY_B);
  flash.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  // 저장 못 한 채 끝난 시험의 문서 — 남으면 '나갈 때 묻기'가 다음 시험에도 걸려 있다
  keepUnsavedEditDoc(KEY_A, null);
  keepUnsavedEditDoc(KEY_B, null);
  keepPendingEditRestore(KEY_A, null);
  keepPendingEditRestore(KEY_B, null);
  setLeaving(false);
});

it("바꿀 때마다 저장하고, 다른 문서로 넘어가도 옛 문서가 새 키에 써지지 않는다", () => {
  render(KEY_A);
  add("a1");
  expect(readEditDoc(KEY_A).doc.clips.map((item) => item.gen)).toEqual(["a1"]);
  render(KEY_B);
  expect(gens()).toEqual([]);
  expect(localStorage.getItem(KEY_B)).toBeNull();
  add("b1", "e071/c1");
  expect(readEditDoc(KEY_A).doc.clips.map((item) => item.gen)).toEqual(["a1"]);
  expect(readEditDoc(KEY_B).doc.clips.map((item) => item.gen)).toEqual(["b1"]);
  render(KEY_A);
  expect(gens()).toEqual(["a1"]);
});

it("되돌리기·다시 하기, 길이 기록은 되돌리기 단계가 아니다", () => {
  render(KEY_A);
  add("a1");
  add("a2");
  act(() => { edit.applyEdit((doc) => setClipDurs(doc, new Map([[clipKey({ cut: "e070/c1", gen: "a1" }), 7]])), { undo: false }); });
  act(() => edit.undo());
  expect(gens()).toEqual(["a1"]);
  expect(edit.doc.clips[0].dur).toBe(7); // 되돌려도 그 사이 확정된 길이는 남는다
  act(() => edit.undo());
  expect(gens()).toEqual([]);
  expect(edit.canUndo).toBe(false);
  act(() => edit.redo());
  act(() => edit.redo());
  expect(gens()).toEqual(["a1", "a2"]);
  expect(readEditDoc(KEY_A).doc.clips).toHaveLength(2);
});

it("저장에 실패하면 '저장 안 됨'이 남고 다음 변경 때 다시 시도한다", () => {
  render(KEY_A);
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("a1");
  add("a2");
  expect(edit.dirty).toBe(true);
  expect(gens()).toEqual(["a1", "a2"]); // 화면의 편집은 그대로
  expect(flash).toHaveBeenCalledTimes(1); // 알림은 한 번만
  setItem.mockRestore();
  add("a3");
  expect(edit.dirty).toBe(false);
  expect(readEditDoc(KEY_A).doc.clips).toHaveLength(3);
});

it("읽지 못한 문서는 빈 문서로 덮지 않는다 — 처음 저장할 때 원문을 .bad 로 옮긴 뒤에만 덮는다", () => {
  localStorage.setItem(KEY_A, "{깨진 원문");
  render(KEY_A);
  expect(edit.bad).toBe(true);
  expect(gens()).toEqual([]);
  expect(localStorage.getItem(KEY_A)).toBe("{깨진 원문"); // 열기만 해서는 그대로
  const real = Storage.prototype.setItem;
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
    if (key.endsWith(".bad")) throw new Error("quota");
    real.call(this, key, value);
  });
  add("a1");
  expect(localStorage.getItem(KEY_A)).toBe("{깨진 원문"); // 보관에 실패하면 덮지 않는다
  expect(edit.dirty).toBe(true);
  setItem.mockRestore();
  add("a2");
  expect(localStorage.getItem(`${KEY_A}.bad`)).toBe("{깨진 원문");
  expect(readEditDoc(KEY_A).doc.clips.map((item) => item.gen)).toEqual(["a1", "a2"]);
  expect(edit.bad).toBe(false);
});

it("다른 창의 저장 알림 — 늦게 온 옛 알림은 무시하고, 실제로 바뀌었을 때만 받아들인다", () => {
  render(KEY_A);
  add("mine");
  storageEvent(KEY_A); // 저장소는 내가 방금 쓴 값 그대로 = 낡은 알림
  expect(gens()).toEqual(["mine"]);
  expect(edit.canUndo).toBe(true);
  expect(flash).not.toHaveBeenCalled();

  const before = edit.rev;
  localStorage.setItem(KEY_A, JSON.stringify({ v: 1, clips: [{ cut: "e070/c1", gen: "theirs", track: 1 }], tracksOff: [], tracksLocked: [] }));
  storageEvent(KEY_A);
  expect(gens()).toEqual(["theirs"]);
  expect(edit.canUndo).toBe(false); // 받아들이면 되돌리기는 비운다
  expect(edit.rev).not.toBe(before);
  expect(flash).toHaveBeenCalledTimes(1);

  // 받아들이기 전에 시작한 지연 콜백(끌기 확정·길이 기록)은 버려진다.
  let applied = "";
  act(() => { applied = edit.applyEdit((doc) => removeClips(doc, [clipKey({ cut: "e070/c1", gen: "theirs" })]), { rev: before }); });
  expect(applied).toBe("none"); // 옛 rev 의 지연 콜백 — 바꿀 것이 없다
  expect(gens()).toEqual(["theirs"]);
  storageEvent("다른 키");
  expect(gens()).toEqual(["theirs"]);
});

it("저장 실패 중에는 다른 창의 문서를 받아들이지 않고 알리기만 한다", () => {
  render(KEY_A);
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("unsaved");
  setItem.mockRestore();
  flash.mockClear();
  localStorage.setItem(KEY_A, JSON.stringify({ v: 1, clips: [], tracksOff: [], tracksLocked: [] }));
  storageEvent(KEY_A);
  expect(gens()).toEqual(["unsaved"]);
  expect(flash).toHaveBeenCalledTimes(1);
});

it("문서 키는 계정·프로젝트·폴더로 정해지고 서버 주소는 들어가지 않는다 — `ch.` 로 시작하지 않는다(옛 판의 계정 전환 정리가 지운다)", () => {
  expect(editDocKey("p1", "e070")).toBe("mvhub.editDoc:local:p1:e070");
});

// 배포 전 점검(2026-10-13): 문서의 옛 자리(`ch.editTimeline:<계정>:…`)는 편집 탭이 없던 옛 판의 계정 전환 정리가 지운다 — 새 판을 쓰다 옛 판으로
//  되돌린 뒤 계정을 바꾸면 편집본이 사라졌다. 새 자리(`mvhub.editDoc:`)에 쓴다. **옮기지는 않는다**: 읽을 때 새 자리에 없으면 옛 자리의 것을
//  읽고, 옛 자리는 지우지도 고치지도 않는다 — 처음엔 한 번에 옮겼는데(복사 → 삭제) 두 창이 엇갈리면 늦은 복사가 방금 저장한 편집을 덮고,
//  옛 자리에 나중에 저장된 것을 지울 수 있었다(Codex 재검토 P1 두 번).
it("옛 자리의 문서는 그대로 읽힌다 — 열기만 해서는 아무것도 쓰지 않고, 저장하면 새 자리에만 쓴다(옛 자리는 그대로)", () => {
  const OLD_A = KEY_A.replace("mvhub.editDoc:", "ch.editTimeline:");
  localStorage.setItem(OLD_A, theirs("kept"));
  localStorage.setItem("ch.editTimeline.last:test", "{}");
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  render(KEY_A);
  expect(gens()).toEqual(["kept"]); // 빈 문서로 열리지 않는다
  expect(setItem).not.toHaveBeenCalled(); // 복사하지 않는다
  expect(localStorage.getItem(KEY_A)).toBeNull();
  setItem.mockRestore();
  add("more");
  expect(stored()).toEqual(["kept", "more"]);
  expect(localStorage.getItem(OLD_A)).toBe(theirs("kept")); // 지우지도 고치지도 않는다
  expect(localStorage.getItem("ch.editTimeline.last:test")).toBe("{}");
  // 새 자리에 생긴 뒤에는 옛 자리를 보지 않는다 — 옛 자리만 아는 빌드가 거기에 무엇을 써도 이 문서는 그대로다(그것도 지우지 않는다)
  localStorage.setItem(OLD_A, theirs("older build"));
  render(null);
  render(KEY_A);
  expect(gens()).toEqual(["kept", "more"]);
  add("again");
  expect(localStorage.getItem(OLD_A)).toBe(theirs("older build"));
});

it("옛 자리에만 있는 문서를 보는 동안 다른 창이 옛 자리에 저장해도(옛 빌드) 덮지 않는다 — 받아들이고 이번 조작은 버린다", () => {
  const OLD_A = KEY_A.replace("mvhub.editDoc:", "ch.editTimeline:");
  localStorage.setItem(OLD_A, theirs("kept"));
  render(KEY_A);
  localStorage.setItem(OLD_A, theirs("kept", "theirs")); // 새 자리는 아직 없다 — 이 창이 읽는 것은 옛 자리다
  let outcome = "";
  act(() => { outcome = edit.applyEdit((doc) => insertClip(doc, clip("mine"))); });
  expect([outcome, gens(), localStorage.getItem(KEY_A)]).toEqual(["stopped", ["kept", "theirs"], null]);
  add("mine");
  expect(stored().sort()).toEqual(["kept", "mine", "theirs"]);
});

const theirs = (...ids: string[]) => JSON.stringify({
  v: 1, clips: ids.map((gen, i) => ({ cut: "e070/c1", gen, track: i + 1 })), tracksOff: [], tracksLocked: [],
});

it("자리를 비운 사이 다른 창이 저장했으면, 돌아와서 옛 되돌리기가 그 저장을 덮지 않는다", () => {
  render(KEY_A);
  add("mine");
  expect(edit.canUndo).toBe(true);
  render(null); // 다른 탭으로 — 이 문서의 storage 알림을 듣지 못한다
  localStorage.setItem(KEY_A, theirs("mine", "theirs"));
  render(KEY_A);
  expect(gens()).toEqual(["mine", "theirs"]);
  expect(edit.canUndo).toBe(false);
  act(() => edit.undo());
  expect(readEditDoc(KEY_A).doc.clips.map((item) => item.gen)).toEqual(["mine", "theirs"]);

  // 다른 시퀀스를 보는 동안 바뀐 문서도 같다.
  add("more");
  render(KEY_B);
  localStorage.setItem(KEY_A, theirs("replaced"));
  render(KEY_A);
  expect(gens()).toEqual(["replaced"]);
  expect(edit.canUndo).toBe(false);
});

it("저장하지 못한 편집은 다른 시퀀스·탭에 다녀와도 남고, 저장이 되면 그때 저장한다", () => {
  render(KEY_A);
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("unsaved");
  render(KEY_B);
  render(KEY_A);
  expect(gens()).toEqual(["unsaved"]);
  expect(edit.dirty).toBe(true);
  render(null);
  setItem.mockRestore();
  render(KEY_A); // 돌아오면 한 번 더 저장해 본다
  expect(gens()).toEqual(["unsaved"]);
  expect(edit.dirty).toBe(false);
  expect(readEditDoc(KEY_A).doc.clips.map((item) => item.gen)).toEqual(["unsaved"]);
});

it("저장 못 한 편집을 들고 돌아왔는데 그 사이 다른 창이 저장했으면, 덮지 않고 알린다", () => {
  render(KEY_A);
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("unsaved");
  render(null);
  setItem.mockRestore();
  localStorage.setItem(KEY_A, theirs("theirs"));
  flash.mockClear();
  render(KEY_A);
  expect(gens()).toEqual(["unsaved"]); // 이 창의 편집은 화면에 그대로
  expect(edit.dirty).toBe(true);
  expect(flash).toHaveBeenCalledTimes(1);
  expect(readEditDoc(KEY_A).doc.clips.map((item) => item.gen)).toEqual(["theirs"]); // 알아서 덮지 않는다
});

// 저장 못 한 편집 + 다른 창의 저장(충돌)은 사용자가 편집을 이어 가기 전에는 어떤 길로도 덮이지 않는다.
function conflicted(strict = false) {
  const show = strict ? renderStrict : render;
  show(KEY_A);
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("unsaved");
  act(() => root.render(null));
  setItem.mockRestore();
  localStorage.setItem(KEY_A, theirs("theirs"));
  flash.mockClear();
  return show;
}
const stored = () => readEditDoc(KEY_A).doc.clips.map((item) => item.gen);

it("충돌 — 편집 없이 몇 번을 오가도 다른 창의 저장을 덮지 않는다", () => {
  const show = conflicted();
  show(KEY_A);
  expect(stored()).toEqual(["theirs"]);
  show(KEY_B);
  show(KEY_A);
  act(() => root.render(null));
  show(KEY_A);
  expect(gens()).toEqual(["unsaved"]);
  expect(edit.dirty).toBe(true);
  expect(stored()).toEqual(["theirs"]);
});

it("충돌 — StrictMode 의 두 번 렌더·두 번 effect 에서도 덮지 않고 한 번만 알린다", () => {
  const show = conflicted(true);
  show(KEY_A);
  expect(gens()).toEqual(["unsaved"]);
  expect(stored()).toEqual(["theirs"]);
  expect(flash).toHaveBeenCalledTimes(1);
  // 이어 가면 무엇이 사라지는지 알림이 미리 말한다(Jay 2026-10-14 — 전엔 "아직 저장되지 않았습니다"에서 끝났다)
  expect(flash.mock.calls[0][0]).toContain("계속 편집하면 이 창의 내용으로 저장되고 다른 창의 변경은 사라집니다");
});

it("충돌 — 자동 길이 기록은 저장하지 않고, 사용자가 편집을 이어 가면 그때 저장한다", () => {
  const show = conflicted();
  show(KEY_A);
  act(() => { edit.applyEdit((doc) => setClipDurs(doc, new Map([[clipKey({ cut: "e070/c1", gen: "unsaved" }), 7]])), { undo: false }); });
  expect(edit.doc.clips[0].dur).toBe(7); // 화면의 문서에는 반영되지만
  expect(stored()).toEqual(["theirs"]); // 저장소는 그대로다
  add("more"); // 사용자의 편집
  expect(stored()).toEqual(["unsaved", "more"]);
  expect(edit.dirty).toBe(false);
});

it("저장 실패 중에 다른 창의 알림이 와도 자동 길이 기록이 그 저장을 덮지 않는다", () => {
  render(KEY_A);
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("unsaved");
  setItem.mockRestore();
  localStorage.setItem(KEY_A, theirs("theirs"));
  storageEvent(KEY_A);
  act(() => { edit.applyEdit((doc) => setClipDurs(doc, new Map([[clipKey({ cut: "e070/c1", gen: "unsaved" }), 7]])), { undo: false }); });
  expect(stored()).toEqual(["theirs"]);
});

// 배포 전 점검(2026-10-13, Codex): 다른 창의 저장 알림(storage 이벤트)은 늦게 온다. 그 전에 이 창이 바꾸면 이 창의 낡은 문서 전체가 저장돼
//  다른 창의 편집이 사라졌다 — 바꾸기 직전에 저장소를 먼저 본다.
//  그 조작 자체는 버린다 — 옛 화면을 보고 고른 것이라(비어 있던 트랙에 넣기로 했는데 그사이 다른 창이 그 트랙에 넣은 클립을 밀어낸다,
//  Codex 재검토). 화면이 새 문서로 바뀌고 알림이 뜬다 — 사용자가 다시 한다.
it("알림이 오기 전에 이 창이 바꿔도 다른 창의 편집을 덮지 않는다 — 다른 창의 문서를 받아들이고 이번 조작은 버린다", () => {
  render(KEY_A);
  add("mine");
  const before = edit.rev;
  localStorage.setItem(KEY_A, theirs("mine", "theirs")); // 다른 창이 저장했다 — 알림은 아직 안 왔다
  let applied = "";
  act(() => { applied = edit.applyEdit((doc) => insertClip(doc, clip("more"))); });
  expect(applied).toBe("stopped");
  expect([stored(), gens()]).toEqual([["mine", "theirs"], ["mine", "theirs"]]); // 다른 창의 것 그대로 — 이 창의 조작은 들어가지 않았다
  expect(flash.mock.calls).toEqual([["다른 창에서 바꾼 편집을 불러왔습니다. 방금 한 조작은 적용하지 않았습니다 — 다시 해 주세요."]]);
  expect([edit.rev !== before, edit.canUndo]).toEqual([true, false]);
  storageEvent(KEY_A); // 늦게 온 그 알림 — 이미 받아들였다
  expect(flash).toHaveBeenCalledTimes(1);
  add("more"); // 다시 하면 새 문서 위에 들어간다
  expect(stored().sort()).toEqual(["mine", "more", "theirs"]);
  act(() => edit.undo());
  expect(stored()).toEqual(["mine", "theirs"]);

  // 자동 길이 기록 같은 지연 콜백도 같다 — 받아들이고 버린다.
  const stale = edit.rev;
  localStorage.setItem(KEY_A, theirs("replaced"));
  act(() => { applied = edit.applyEdit((doc) => removeClips(doc, [clipKey({ cut: "e070/c1", gen: "mine" })]), { rev: stale, undo: false }); });
  expect(applied).toBe("stopped");
  expect([stored(), gens()]).toEqual([["replaced"], ["replaced"]]);
});

// 저장 못 한 편집이 있는데 다른 창이 저장한 것을 **편집하는 순간에야 알았을 때**: 그 편집은 멈춘다(알림이 뜨기도 전에 다른 창의 저장을
//  덮지 않게 — Codex 재검토). 알고 난 뒤의 편집은 전처럼 저장한다(사용자가 알고 이어 가는 것이다).
it("저장 못 한 편집 + 방금 안 다른 창의 저장 — 그 조작은 멈추고 알리기만 한다. 다음 편집부터 저장한다", () => {
  render(KEY_A);
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("unsaved");
  setItem.mockRestore();
  flash.mockClear();
  localStorage.setItem(KEY_A, theirs("theirs")); // 알림은 아직 안 왔다
  let applied = "";
  act(() => { applied = edit.applyEdit((doc) => insertClip(doc, clip("more"))); });
  expect(applied).toBe("stopped");
  expect([stored(), gens()]).toEqual([["theirs"], ["unsaved"]]); // 덮지 않았고, 이 창의 편집도 그대로다
  expect(flash).toHaveBeenCalledTimes(1);
  act(() => edit.undo()); // 되돌리기도 그 순간에는 같다 — 이미 알린 뒤라 이번에는 진행한다
  expect(stored()).toEqual([]); // 'unsaved' 를 넣기 전(빈 문서)으로 되돌린 것이 저장됐다 — 사용자가 알고 이어 간 조작
  add("more");
  expect(stored()).toEqual(["more"]);
  expect(edit.dirty).toBe(false);
});

it("알림이 오기 전의 되돌리기도 다른 창의 저장을 덮지 않는다", () => {
  render(KEY_A);
  add("a1");
  add("a2");
  localStorage.setItem(KEY_A, theirs("theirs"));
  act(() => edit.undo());
  expect([stored(), gens(), edit.canUndo]).toEqual([["theirs"], ["theirs"], false]);
});

it("저장하지 못한 편집이 있는 동안에는 창을 닫거나 새로고침할 때 브라우저가 묻는다 — 저장되면 묻지 않는다", () => {
  const leaving = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  render(KEY_A);
  add("saved");
  expect(leaving()).toBe(false);
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("unsaved");
  expect(leaving()).toBe(true);
  render(KEY_B); // 다른 시퀀스로 옮겨도 그 편집은 메모리에만 있다
  expect(leaving()).toBe(true);
  setItem.mockRestore();
  render(KEY_A); // 돌아와 저장에 성공하면 풀린다
  expect([edit.dirty, leaving()]).toEqual([false, false]);
});

// Codex 재검토 3회째: 로그아웃의 확인은 요청 전에 한 번뿐이다. 응답을 기다리는 동안 한 편집이 저장에 실패하면 묻지 못한 채 새로고침에
//  사라진다 — 그사이에는 편집·되돌리기·자동 길이 기록을 받지 않는다(lib/unloadGuard 의 setLeaving).
it("떠나는 중(로그아웃 응답 대기)에는 편집·되돌리기를 받지 않는다 — 풀리면 다시 받는다", () => {
  render(KEY_A);
  add("a1");
  setLeaving(true);
  try {
    let outcome = "";
    act(() => { outcome = edit.applyEdit((doc) => insertClip(doc, clip("late"))); });
    act(() => edit.undo());
    expect([outcome, gens(), stored()]).toEqual(["stopped", ["a1"], ["a1"]]);
    expect(flash.mock.calls).toEqual([["로그아웃하는 중입니다 — 지금 한 조작은 적용하지 않았습니다."]]); // 까닭을 알린다(되돌리기는 조용히)
    // 자동 기록(확정 길이)은 조용히 버린다 — 영상마다 알림이 뜨지 않게
    act(() => { edit.applyEdit((doc) => setClipDurs(doc, new Map([[clipKey({ cut: "e070/c1", gen: "a1" }), 7]])), { undo: false }); });
    expect([edit.doc.clips[0].dur, flash.mock.calls.length]).toEqual([5, 1]);
  } finally {
    setLeaving(false);
  }
  add("a2");
  expect([gens(), stored()]).toEqual([["a1", "a2"], ["a1", "a2"]]);
});

// 길이 조절 창(Jay 2026-10-13) — 창을 한 번 연 동안의 여러 걸음이 되돌리기 한 단계다(EditOptions.group).
it("같은 이름으로 잇달아 한 편집은 되돌리기 한 단계다 — 자동 길이 기록은 묶음을 끊지 않고, 다른 이름·되돌리기는 끊는다", () => {
  render(KEY_A);
  add("a1");
  const k = clipKey({ cut: "e070/c1", gen: "a1" });
  const trim = (seconds: number, group: string) => act(() => { edit.applyEdit((doc) => setClipRange(doc, k, { head: 0, trim: seconds }), { group }); });
  trim(4, "g1");
  trim(3, "g1");
  act(() => { edit.applyEdit((doc) => setClipDurs(doc, new Map([[k, 6]])), { undo: false }); }); // 창을 연 사이 실측이 왔다
  trim(2, "g1");
  expect(readEditDoc(KEY_A).doc.clips[0].trim).toBe(2); // 걸음마다 저장한다
  act(() => edit.undo());
  expect([edit.doc.clips[0].trim, edit.doc.clips[0].dur]).toEqual([undefined, 6]); // 한 번에 줄이기 전으로 — 길이 기록은 남는다
  act(() => edit.undo());
  expect(gens()).toEqual([]); // 그 앞 단계는 클립을 넣은 것
  act(() => edit.redo());
  act(() => edit.redo());
  expect(edit.doc.clips[0].trim).toBe(2);
  trim(1, "g1"); // 되돌리기·다시 하기를 거쳤다 — 같은 이름이어도 새 단계
  trim(0.5, "g2"); // 창을 다시 열었다(다른 이름) — 새 단계
  act(() => edit.undo());
  expect(edit.doc.clips[0].trim).toBe(1);
  act(() => edit.undo());
  expect(edit.doc.clips[0].trim).toBe(2);
});

it("StrictMode — 저장 못 한 편집을 들고 돌아와 저장에 성공해도 되돌리기는 남는다", () => {
  renderStrict(KEY_A);
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("unsaved");
  act(() => root.render(null));
  setItem.mockRestore();
  renderStrict(KEY_A);
  expect(edit.dirty).toBe(false);
  expect(stored()).toEqual(["unsaved"]);
  expect(edit.canUndo).toBe(true);
});

const denyLocalReads = () => {
  const realGet = Storage.prototype.getItem;
  return vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
    if (this === localStorage) throw new Error("denied");
    return realGet.call(this, key);
  });
};

it("저장소 접근 실패는 문서 부재와 다르고 새 키 실패 뒤 옛 키를 읽지 않는다", () => {
  expect(readEditRaw(KEY_A)).toEqual({ kind: "ok", raw: null });
  const old = KEY_A.replace("mvhub.editDoc:", "ch.editTimeline:");
  localStorage.setItem(old, theirs("legacy"));
  const realGet = Storage.prototype.getItem;
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (key) {
    if (key === KEY_A) throw new Error("denied");
    return realGet.call(this, key);
  });
  expect(readEditRaw(KEY_A)).toEqual({ kind: "error" });
  expect(readEditDoc(KEY_A)).toMatchObject({ inaccessible: true, bad: false, raw: null });
  expect(get.mock.calls.every(([key]) => key === KEY_A)).toBe(true);
  get.mockRestore();
  expect(readEditRaw(KEY_A)).toEqual({ kind: "ok", raw: theirs("legacy") });
});

it("첫 읽기 실패는 편집·Undo·측정·이벤트·재마운트에서 쓰기 0, 재시도 성공은 새 rev로 기존 문서를 연다", () => {
  localStorage.setItem(KEY_A, theirs("existing"));
  const get = denyLocalReads();
  const set = vi.spyOn(Storage.prototype, "setItem");
  renderStrict(KEY_A);
  const before = edit.rev;
  expect([edit.readError, edit.hasValidDoc]).toEqual([true, false]);
  expect(edit.captureArchiveSnapshot()?.valid).toBe(false);
  add("blocked");
  act(() => edit.undo());
  act(() => edit.applyEdit((doc) => ({ ...doc, tracks: 4 }), { undo: false }));
  storageEvent(KEY_A);
  render(KEY_B);
  render(KEY_A);
  expect(set).not.toHaveBeenCalled();
  expect(gens()).toEqual([]);
  get.mockRestore();
  act(() => edit.retryRead());
  expect([edit.readError, edit.hasValidDoc, gens()]).toEqual([false, true, ["existing"]]);
  expect(edit.rev).not.toBe(before);
  expect(set).not.toHaveBeenCalled();
});

it.each([false, true])("읽기 실패는 기존 작업본·Undo·dirty를 보존한다 (dirty=%s)", (dirty) => {
  render(KEY_A);
  add("saved");
  if (dirty) {
    const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    add("unsaved");
    fail.mockRestore();
  }
  const before = edit.doc;
  const past = [...undoStack(KEY_A).past];
  const unsaved = unsavedEditDoc(KEY_A);
  const raw = localStorage.getItem(KEY_A);
  const get = denyLocalReads();
  const set = vi.spyOn(Storage.prototype, "setItem");
  storageEvent(KEY_A);
  add("blocked");
  act(() => edit.undo());
  act(() => edit.redo());
  act(() => edit.applyEdit((doc) => setClipDurs(doc, new Map([[clipKey(clip("saved")), 9]])), { undo: false }));
  act(() => edit.retryRead());
  expect(edit.doc).toBe(before);
  expect(edit.dirty).toBe(dirty);
  expect(undoStack(KEY_A).past).toEqual(past);
  expect(unsavedEditDoc(KEY_A)).toBe(unsaved);
  expect(edit.captureArchiveSnapshot()).toMatchObject({ valid: true, raw, readError: true });
  expect(edit.captureArchiveSnapshot(true)).toBeNull();
  expect(set).not.toHaveBeenCalled();
  get.mockRestore();
  act(() => edit.retryRead());
  expect(edit.readError).toBe(false);
  expect(edit.doc).toBe(before);
  expect(set).toHaveBeenCalledTimes(dirty ? 1 : 0);
  expect(edit.dirty).toBe(false);
  expect(undoStack(KEY_A).past).toEqual(past);
});

it("읽기 회복 중 다른 창 변경은 dirty 작업본과 Undo를 유지하며 충돌로 알린다", () => {
  render(KEY_A);
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("unsaved");
  fail.mockRestore();
  const get = denyLocalReads();
  storageEvent(KEY_A);
  get.mockRestore();
  localStorage.setItem(KEY_A, theirs("external"));
  const set = vi.spyOn(Storage.prototype, "setItem");
  act(() => edit.retryRead());
  expect([gens(), edit.dirty, edit.canUndo]).toEqual([["unsaved"], true, true]);
  expect(edit.conflict).not.toBe(0);
  expect(edit.captureArchiveSnapshot(true)).toBeNull();
  expect(set).not.toHaveBeenCalled();
});

it("dirty 문서를 읽기 실패 중 다시 열면 effect는 저장하지 않고 작업본과 Undo를 보존한다", () => {
  render(KEY_A);
  add("saved");
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("unsaved");
  fail.mockRestore();
  const before = edit.doc;
  const past = [...undoStack(KEY_A).past];
  act(() => root.render(null));
  const get = denyLocalReads();
  const set = vi.spyOn(Storage.prototype, "setItem");
  renderStrict(KEY_A);
  render(KEY_B);
  render(KEY_A);
  expect([edit.dirty, edit.readError, edit.hasValidDoc]).toEqual([true, true, true]);
  expect(edit.doc).toBe(before);
  expect(undoStack(KEY_A).past).toEqual(past);
  expect(set).not.toHaveBeenCalled();
  get.mockRestore();
  act(() => edit.retryRead());
  expect(edit.doc).toBe(before);
  expect(set).toHaveBeenCalledTimes(1);
  expect(JSON.parse(localStorage.getItem(KEY_A)!)).toEqual(before);
  expect([edit.dirty, edit.readError, unloadHeld()]).toEqual([false, false, false]);
  expect(undoStack(KEY_A).past).toEqual(past);
});

it.each([false, true])("읽기 회복 뒤 손상 원문 백업이 먼저 성공해야 dirty 작업본을 저장한다 (backupBlocked=%s)", (backupBlocked) => {
  localStorage.setItem(KEY_A, "damaged original");
  render(KEY_A);
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("unsaved");
  fail.mockRestore();
  act(() => root.render(null));
  const get = denyLocalReads();
  render(KEY_A);
  expect([edit.readError, edit.dirty]).toEqual([true, true]);
  get.mockRestore();
  const realSet = Storage.prototype.setItem;
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    if (backupBlocked && key === `${KEY_A}.bad`) throw new Error("backup quota");
    realSet.call(this, key, value);
  });
  act(() => edit.retryRead());
  expect(set.mock.calls[0]).toEqual([`${KEY_A}.bad`, "damaged original"]);
  expect(gens()).toEqual(["unsaved"]);
  if (backupBlocked) {
    expect(localStorage.getItem(KEY_A)).toBe("damaged original");
    expect([edit.dirty, unloadHeld()]).toEqual([true, true]);
    expect(set).toHaveBeenCalledTimes(1);
  } else {
    expect(localStorage.getItem(`${KEY_A}.bad`)).toBe("damaged original");
    expect(JSON.parse(localStorage.getItem(KEY_A)!).clips[0].gen).toBe("unsaved");
    expect(edit.dirty).toBe(false);
  }
});

it("다른 창 변경을 읽은 뒤 재조회가 실패해도 이미 읽은 원문으로 일관되게 연다", () => {
  render(KEY_A);
  add("mine");
  localStorage.setItem(KEY_A, theirs("external"));
  const realGet = Storage.prototype.getItem;
  let reads = 0;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (key) {
    if (key === KEY_A && ++reads > 1) throw new Error("second read denied");
    return realGet.call(this, key);
  });
  const set = vi.spyOn(Storage.prototype, "setItem");
  storageEvent(KEY_A);
  expect([gens(), edit.readError, edit.canUndo]).toEqual([["external"], false, false]);
  expect(set).not.toHaveBeenCalled();
});

const candidateDoc = () => insertClip(emptyEditDoc(), clip("imported"))!;
const capture = () => {
  let snapshot: ArchiveSnapshot | null = null;
  act(() => { snapshot = edit.captureArchiveSnapshot(true); });
  expect(snapshot).not.toBeNull();
  return snapshot!;
};
const recoveryText = (snapshot: ArchiveSnapshot) => {
  const target = { projectId: `p${serial}`, seq: "e070" };
  return createRecoveryArchive(target, snapshot.valid ? createEditArchive(snapshot.doc, target, snapshot.dirty) : null, snapshot.raw, snapshot.bad);
};
const backup = async (snapshot: ArchiveSnapshot) => {
  const text = recoveryText(snapshot);
  const verified = await edit.verifyArchiveBackup(snapshot, text, { size: utf8Bytes(text), text: async () => text });
  expect(verified).not.toBeNull();
  return verified!;
};
const restore = (candidate: EditDoc, snapshot: ArchiveSnapshot, verified: VerifiedArchiveBackup | null) => {
  let outcome = "";
  act(() => { outcome = edit.replaceFromArchive(candidate, snapshot, verified); });
  return outcome;
};
const retryRestore = (acceptExternal = false) => {
  let outcome = "";
  act(() => { outcome = edit.retryRestore(acceptExternal); });
  return outcome;
};

it("복원 토큰은 실제 읽기 성공이 필요하며 임의 객체·취소·크기/내용 불일치는 쓰지 않는다", async () => {
  render(KEY_A);
  add("original");
  const snapshot = capture();
  const text = recoveryText(snapshot);
  const set = vi.spyOn(Storage.prototype, "setItem");
  expect(restore(candidateDoc(), snapshot, null)).toBe("stopped");
  expect(restore(candidateDoc(), snapshot, { snapshot })).toBe("stopped");
  for (const size of [utf8Bytes(text) - 1, MAX_ARCHIVE_BYTES + 1]) {
    const read = vi.fn(async () => text);
    expect(await edit.verifyArchiveBackup(snapshot, text, { size, text: read })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  }
  expect(await edit.verifyArchiveBackup(snapshot, text, { size: utf8Bytes(text), text: async () => text.replace("original", "replaced") })).toBeNull();
  expect(await edit.verifyArchiveBackup(snapshot, text, { size: utf8Bytes(text), text: async () => { throw new Error("cancelled"); } })).toBeNull();
  expect(set).not.toHaveBeenCalled();
  expect(gens()).toEqual(["original"]);
});

it.each(["target", "edit", "measure", "edit-undo", "unmount"])("파일 확인 지연 중 %s 변경은 값이 같아져도 토큰을 폐기한다", async (change) => {
  render(KEY_A);
  add("original");
  const snapshot = capture();
  const text = recoveryText(snapshot);
  let resolve!: (value: string) => void;
  const waiting = edit.verifyArchiveBackup(snapshot, text, { size: utf8Bytes(text), text: () => new Promise((done) => { resolve = done; }) });
  if (change === "target") { render(KEY_B); render(KEY_A); }
  if (change === "edit" || change === "edit-undo") add("new");
  if (change === "edit-undo") act(() => edit.undo());
  if (change === "measure") act(() => edit.applyEdit((doc) => setClipDurs(doc, new Map([[clipKey(clip("original")), 8]])), { undo: false }));
  if (change === "unmount") { act(() => root.render(null)); render(KEY_A); }
  const set = vi.spyOn(Storage.prototype, "setItem");
  resolve(text);
  expect(await waiting).toBeNull();
  expect(restore(candidateDoc(), snapshot, { snapshot })).toBe("stopped");
  expect(set).not.toHaveBeenCalled();
});

it("복원 성공만 새 rev와 Undo 한 단계를 만들고 옛 측정 콜백은 버린다", async () => {
  render(KEY_A);
  add("original");
  const before = edit.doc;
  const snapshot = capture();
  const verified = await backup(snapshot);
  const set = vi.spyOn(Storage.prototype, "setItem");
  expect(restore(candidateDoc(), snapshot, verified)).toBe("saved");
  expect(set.mock.calls.map(([key]) => key)).toEqual([KEY_A]);
  expect([gens(), stored(), edit.dirty, unloadHeld()]).toEqual([["imported"], ["imported"], false, false]);
  expect(edit.rev).not.toBe(snapshot.rev);
  expect(undoStack(KEY_A).past.at(-1)).toBe(before);
  set.mockClear();
  act(() => edit.applyEdit(() => before, { undo: false, rev: snapshot.rev }));
  expect(set).not.toHaveBeenCalled();
  expect(gens()).toEqual(["imported"]);
  act(() => edit.undo());
  expect(gens()).toEqual(["original"]);
});

it("의미가 같은 복원은 사본 토큰 없이 모든 쓰기 0이며 Undo·rev·원문을 보존한다", () => {
  render(KEY_A);
  add("original");
  const snapshot = capture();
  const past = [...undoStack(KEY_A).past];
  const set = vi.spyOn(Storage.prototype, "setItem");
  expect(restore(JSON.parse(snapshot.docRaw), snapshot, null)).toBe("unchanged");
  expect(set).not.toHaveBeenCalled();
  expect([edit.rev, localStorage.getItem(KEY_A)]).toEqual([snapshot.rev, snapshot.raw]);
  expect(undoStack(KEY_A).past).toEqual(past);
});

it("확인 뒤 늦은 다른 창 저장은 복원 직전에 다시 비교해 중단한다", async () => {
  render(KEY_A);
  add("original");
  const snapshot = capture();
  const verified = await backup(snapshot);
  localStorage.setItem(KEY_A, theirs("external"));
  const set = vi.spyOn(Storage.prototype, "setItem");
  expect(restore(candidateDoc(), snapshot, verified)).toBe("stopped");
  expect(stored()).toEqual(["external"]);
  expect(set).not.toHaveBeenCalled();
});

it("검증된 사본도 다른 스냅샷에 재사용하거나 확인 뒤 계정이 바뀌면 복원하지 않는다", async () => {
  render(KEY_A);
  add("original");
  const snapshot = capture();
  const verified = await backup(snapshot);
  const nextSnapshot = capture();
  const set = vi.spyOn(Storage.prototype, "setItem");
  expect(restore(candidateDoc(), nextSnapshot, verified)).toBe("stopped");
  expect(set).not.toHaveBeenCalled();
  sessionStorage.setItem("ch.accountScope", "another-test-account");
  set.mockClear();
  expect(edit.captureArchiveSnapshot()).toBeNull();
  expect(restore(candidateDoc(), snapshot, verified)).toBe("stopped");
  expect(set).not.toHaveBeenCalled();
  expect(gens()).toEqual(["original"]);
});

it("본문 quota 실패는 기존 dirty·Undo·작업본을 보존하고 후보를 자동 저장하지 않는다", async () => {
  render(KEY_A);
  add("saved");
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  add("unsaved");
  const snapshot = capture();
  const past = [...undoStack(KEY_A).past];
  const verified = await backup(snapshot);
  set.mockClear();
  expect(restore(candidateDoc(), snapshot, verified)).toBe("failed");
  expect(set.mock.calls.map(([key]) => key)).toEqual([KEY_A]);
  expect(edit.doc).toBe(snapshot.doc);
  expect(edit.dirty).toBe(true);
  expect(undoStack(KEY_A).past).toEqual(past);
  expect(unsavedEditDoc(KEY_A)?.doc).toBe(snapshot.doc);
  expect(pendingEditRestore(KEY_A)).toBeUndefined();
  set.mockRestore();
  render(KEY_B);
  render(KEY_A);
  expect(stored()).toEqual(["saved", "unsaved"]);
});

it.each(["throw", "mismatch"])("손상 원문 .bad 보관 %s 실패면 본문과 legacy를 덮지 않는다", async (failure) => {
  const old = KEY_A.replace("mvhub.editDoc:", "ch.editTimeline:");
  localStorage.setItem(old, "{broken legacy");
  render(KEY_A);
  const snapshot = capture();
  const verified = await backup(snapshot);
  const realSet = Storage.prototype.setItem;
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    if (key === `${KEY_A}.bad`) {
      if (failure === "throw") throw new Error("quota");
      return;
    }
    realSet.call(this, key, value);
  });
  expect(restore(candidateDoc(), snapshot, verified)).toBe("failed");
  expect(set.mock.calls.map(([key]) => key)).toEqual([`${KEY_A}.bad`]);
  expect(localStorage.getItem(KEY_A)).toBeNull();
  expect(localStorage.getItem(old)).toBe("{broken legacy");
  expect([edit.bad, edit.dirty, edit.canUndo]).toEqual([true, false, false]);
});

async function uncertainRestore(failure: "throw" | "mismatch" = "throw") {
  render(KEY_A);
  add("original");
  const snapshot = capture();
  const verified = await backup(snapshot);
  const realGet = Storage.prototype.getItem;
  let reads = 0;
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (key) {
    if (key === KEY_A && ++reads > 1) {
      if (failure === "throw") throw new Error("readback denied");
      return theirs("third");
    }
    return realGet.call(this, key);
  });
  expect(restore(candidateDoc(), snapshot, verified)).toBe("uncertain");
  get.mockRestore();
  return snapshot;
}

it.each(["throw", "mismatch"] as const)("본문 확인 %s: 원작업본·Undo·후보·사본과 unload holder는 대상 왕복·재마운트에도 남는다", async (failure) => {
  const snapshot = await uncertainRestore(failure);
  const pending = pendingEditRestore(KEY_A);
  expect(pending).toMatchObject({ doc: snapshot.doc, raw: snapshot.raw, candidate: candidateDoc(), backupText: expect.any(String) });
  const past = [...undoStack(KEY_A).past];
  expect([edit.restorePending, unloadHeld(), edit.dirty]).toEqual([true, true, false]);
  const set = vi.spyOn(Storage.prototype, "setItem");
  add("blocked");
  act(() => edit.undo());
  act(() => edit.applyEdit((doc) => ({ ...doc, tracks: 10 }), { undo: false }));
  storageEvent(KEY_A);
  render(KEY_B);
  keepUnsavedEditDoc(KEY_B, null);
  expect(unloadHeld()).toBe(true);
  render(KEY_A);
  act(() => root.render(null));
  renderStrict(KEY_A);
  expect([gens(), edit.restorePending]).toEqual([["original"], true]);
  expect(pendingEditRestore(KEY_A)).toBe(pending);
  expect(undoStack(KEY_A).past).toEqual(past);
  expect(set).not.toHaveBeenCalled();
  expect(unloadHeld()).toBe(true);
  expect(retryRestore()).toBe("saved");
  expect([gens(), edit.restorePending, unloadHeld()]).toEqual([["imported"], false, false]);
  expect(undoStack(KEY_A).past.at(-1)).toBe(snapshot.doc);
});

it("불확실 재조회 원문 일치면 실패 정산하고 원래 Undo·문서를 유지한다", async () => {
  const snapshot = await uncertainRestore();
  const past = [...undoStack(KEY_A).past];
  localStorage.setItem(KEY_A, snapshot.raw!);
  const set = vi.spyOn(Storage.prototype, "setItem");
  expect(retryRestore()).toBe("failed");
  expect([gens(), edit.restorePending, edit.readError, unloadHeld()]).toEqual([["original"], false, false, false]);
  expect(undoStack(KEY_A).past).toEqual(past);
  expect(set).not.toHaveBeenCalled();
});

it("불확실 재조회 제3값은 사용자 수용 전 보존하고 수용 직전 다시 바뀌면 다시 확인한다", async () => {
  await uncertainRestore();
  localStorage.setItem(KEY_A, theirs("third"));
  expect(retryRestore()).toBe("uncertain");
  const pending = pendingEditRestore(KEY_A);
  expect([gens(), edit.restoreExternal, unloadHeld()]).toEqual([["original"], true, true]);
  localStorage.setItem(KEY_A, theirs("fourth"));
  const set = vi.spyOn(Storage.prototype, "setItem");
  expect(retryRestore(true)).toBe("uncertain");
  expect(pendingEditRestore(KEY_A)).toBe(pending);
  expect(gens()).toEqual(["original"]);
  expect(retryRestore(true)).toBe("stopped");
  expect([gens(), edit.restorePending, edit.canUndo, unloadHeld()]).toEqual([["fourth"], false, false, false]);
  expect(set).not.toHaveBeenCalled();
});

it("불확실 재조회 접근 실패와 다른 key에서의 재시도는 후보를 적용하거나 holder를 해제하지 않는다", async () => {
  await uncertainRestore();
  const get = denyLocalReads();
  const set = vi.spyOn(Storage.prototype, "setItem");
  expect(retryRestore()).toBe("uncertain");
  expect([edit.restorePending, edit.readError, unloadHeld()]).toEqual([true, true, true]);
  get.mockRestore();
  render(KEY_B);
  expect(retryRestore()).toBe("stopped");
  expect(pendingEditRestore(KEY_A)).toBeDefined();
  expect(unloadHeld()).toBe(true);
  expect(set).not.toHaveBeenCalled();
});
