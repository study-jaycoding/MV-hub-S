// @vitest-environment jsdom
// 편집 문서의 저장·되돌리기·다른 창 변경 — docs/EDIT_TAB.md 의 문서 계약을 지키는지.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clipKey, insertClip, removeClips, setClipDurs } from "../src/lib/editTimeline";
import { clearUndo, editDocKey, readEditDoc } from "../src/lib/editTimelineStore";
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
  KEY_A = `ch.editTimeline:test:p${++serial}:e070`;
  KEY_B = `ch.editTimeline:test:p${serial}:e071`;
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

it("문서 키는 계정·프로젝트·폴더로 정해지고 서버 주소는 들어가지 않는다", () => {
  expect(editDocKey("p1", "e070")).toBe("ch.editTimeline:local:p1:e070");
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
