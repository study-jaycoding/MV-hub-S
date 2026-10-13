// @vitest-environment jsdom
// 편집 문서의 저장·되돌리기·다른 창 변경 — docs/EDIT_TAB.md 의 문서 계약을 지키는지.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clipKey, insertClip, removeClips, setClipDurs } from "../src/lib/editTimeline";
import { clearUndo, editDocKey, keepUnsavedEditDoc, migrateEditDocs, readEditDoc } from "../src/lib/editTimelineStore";
import { useEditDoc } from "../src/lib/useEditDoc";

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
  let applied = true;
  act(() => { applied = edit.applyEdit((doc) => removeClips(doc, [clipKey({ cut: "e070/c1", gen: "theirs" })]), { rev: before }); });
  expect(applied).toBe(false);
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
//  되돌린 뒤 계정을 바꾸면 편집본이 사라졌다. 모듈이 실릴 때 새 자리로 옮긴다(이 시험은 그 함수를 직접 부른다).
it("옛 자리의 문서를 새 자리로 옮긴다 — 보관본(.bad)도 같이, 화면 설정·마지막으로 연 시퀀스는 그대로", () => {
  const old = (rest: string) => `ch.editTimeline:${rest}`;
  const now = (rest: string) => `mvhub.editDoc:${rest}`;
  localStorage.setItem(old("me@x:p1:e070"), theirs("a"));
  localStorage.setItem(old("me@x:p1:e070.bad"), "{깨진 원문");
  localStorage.setItem(old("other@x:p2:e071"), theirs("b")); // 다른 계정 · 열어 보지 않은 시퀀스도
  localStorage.setItem(old("me@x:p1:e080"), theirs("same"));
  localStorage.setItem(now("me@x:p1:e080"), theirs("same")); // 새 자리에 같은 것이 이미 있다(옮기다 만 것) — 옛것만 치운다
  localStorage.setItem("ch.editTimeline.last:me@x", "{}");
  localStorage.setItem("ch.editTimeline.ui", "{}");
  migrateEditDocs();
  expect(localStorage.getItem(now("me@x:p1:e070"))).toBe(theirs("a"));
  expect(localStorage.getItem(now("me@x:p1:e070.bad"))).toBe("{깨진 원문");
  expect(localStorage.getItem(now("other@x:p2:e071"))).toBe(theirs("b"));
  expect(localStorage.getItem(now("me@x:p1:e080"))).toBe(theirs("same"));
  expect(Object.keys(localStorage).filter((key) => key.startsWith("ch.editTimeline")).sort()).toEqual(["ch.editTimeline.last:me@x", "ch.editTimeline.ui"]);
  expect(Object.keys(localStorage).filter((key) => key.endsWith(".old"))).toEqual([]); // 같은 것에는 보관본을 만들지 않는다
  migrateEditDocs(); // 두 번 불러도 같다
  expect(localStorage.getItem(now("me@x:p1:e070"))).toBe(theirs("a"));
});

// Codex 재검토 P1: '새 자리에 있으면 그쪽이 새것'이라 보고 옛 자리를 지웠다 — 옛 자리만 아는 빌드·옮기기 전에 열려 있던 창이 **그 뒤에**
//  저장한 편집이 사라진다. 어느 쪽이 새것인지 알 수 없으니 다른 것은 지우지 않고 보관본(`<새 키>.old`)으로 옮긴다.
it("옛 자리와 새 자리의 내용이 다르면 옛것을 지우지 않고 보관본으로 옮긴다 — 보관하지 못하면 옛 자리에 그대로 둔다", () => {
  const old = (rest: string) => `ch.editTimeline:${rest}`;
  const now = (rest: string) => `mvhub.editDoc:${rest}`;
  localStorage.setItem(now("me@x:p1:e070"), theirs("moved"));
  localStorage.setItem(old("me@x:p1:e070"), theirs("moved", "later")); // 옮긴 뒤 옛 빌드가 옛 자리에 저장했다
  migrateEditDocs();
  expect(localStorage.getItem(now("me@x:p1:e070"))).toBe(theirs("moved")); // 화면의 문서는 새 자리의 것 그대로
  expect(localStorage.getItem(now("me@x:p1:e070.old"))).toBe(theirs("moved", "later"));
  expect(localStorage.getItem(old("me@x:p1:e070"))).toBeNull();

  // 보관본 자리에 이미 다른 것이 있다 — 그것도 이것도 지우지 않는다
  localStorage.setItem(old("me@x:p1:e070"), theirs("third"));
  migrateEditDocs();
  expect(localStorage.getItem(now("me@x:p1:e070.old"))).toBe(theirs("moved", "later"));
  expect(localStorage.getItem(old("me@x:p1:e070"))).toBe(theirs("third"));

  // 저장할 때도 같다: 이 창이 알던 것과 다른 것이 옛 자리에 있으면 보관본으로(여기서는 보관본 자리가 차 있어 그대로 남는다)
  render(now("me@x:p1:e070"));
  add("mine");
  expect(localStorage.getItem(old("me@x:p1:e070"))).toBe(theirs("third"));
  expect(readEditDoc(now("me@x:p1:e070")).doc.clips.map((item) => item.gen).sort()).toEqual(["mine", "moved"]);
  keepUnsavedEditDoc(now("me@x:p1:e070"), null);
});

it("옮기지 못한 문서(용량 부족)는 옛 자리에 남고 그대로 읽힌다 — 다음에 저장되면 새 자리로 가고 옛것은 지운다", () => {
  const OLD_A = KEY_A.replace("mvhub.editDoc:", "ch.editTimeline:");
  localStorage.setItem(OLD_A, theirs("kept"));
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  migrateEditDocs();
  expect([localStorage.getItem(OLD_A), localStorage.getItem(KEY_A)]).toEqual([theirs("kept"), null]);
  render(KEY_A);
  expect(gens()).toEqual(["kept"]); // 옛 자리의 것을 읽는다 — 빈 문서로 열리지 않는다
  setItem.mockRestore();
  add("more");
  expect(stored()).toEqual(["kept", "more"]);
  expect([localStorage.getItem(OLD_A), localStorage.getItem(KEY_A) !== null]).toEqual([null, true]);
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
  let applied = true;
  act(() => { applied = edit.applyEdit((doc) => insertClip(doc, clip("more"))); });
  expect(applied).toBe(false);
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
  expect(applied).toBe(false);
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
  let applied = true;
  act(() => { applied = edit.applyEdit((doc) => insertClip(doc, clip("more"))); });
  expect(applied).toBe(false);
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
