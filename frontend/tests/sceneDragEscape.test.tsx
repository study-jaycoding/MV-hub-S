// 끄는 중 Esc = 끌기 취소(29회차 제안, Jay 안 A — 이동·크기만 버린다). 실제 SceneBoard 로 본다(끌기 훅·세션·되돌리기 묶음은 실제 코드).
//  · 카드·그룹 머리·크기 손잡이 셋 다 — Esc 로 끌기 전 자리(크기)로 돌아가고, 끄는 중에 한 다른 일(삭제)은 남는다.
//  · 선택은 그대로 — 끌기를 버린 Esc 가 선택까지 풀지 않는다. 끌기가 없을 때의 Esc 는 전처럼 선택 해제.
//  · 되돌리기에 빈 단계를 쌓지 않는다 — 버린 끌기는 흔적을 남기지 않는다(끄는 중의 사용자 저장이 있었으면 그 저장의 단계만 남는다).
//  · 손은 아직 눌려 있다 — 그 뒤의 놓기(mouseup)와 click 은 아무 일도 하지 않는다.
// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[] = [];
let clock = 1000;
let patches: Record<string, unknown>[] = [];
const shift = (el: HTMLElement) => {
  const [x, y] = (el.style.translate || "").split(" ").map((part) => parseFloat(part) || 0);
  return { x: x || 0, y: y || 0 };
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  frames = []; patches = []; clock = 1000;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = noop; });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const on = this.matches(".scene-card, .scene-group");
    const n = (v: string) => (on ? parseFloat(v) || 0 : 0);
    const moved = on ? shift(this) : { x: 0, y: 0 };
    const [x, y, w, h] = [n(this.style.left) + moved.x, n(this.style.top) + moved.y, n(this.style.width), n(this.style.height)];
    return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: noop } as DOMRect;
  });
  localStorage.clear();
  sessionStorage.clear();
  fixture.data = {
    genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
  } as unknown as SceneGenDataApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const textCard = (id: string, x: number, y = 110) => ({ id, kind: "text", x, y, text: id });
const rectGroup = (id: string, cardIds: string[], x: number) => ({ id, name: id, cardIds, rect: { x, y: 44, w: 330, h: 330 } });
const open = (id: string, cards: object[], groups: object[] = []) => act(async () => {
  const scene = { id, name: id, created_at: 0, edges: [], cards, groups } as never;
  root.render(<SceneBoard scene={scene} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
});
const show = (cards: object[], groups: object[] = []) => open("S", cards, groups);
/** 저장소가 돌려주는 부모(실제 앱의 저장소처럼) — 키 앞의 확정(F)·카메라 저장·파생 저장이 있는 시험은 이것으로 띄운다(tests/sceneCardGroupMove 와 같다). */
let rerenderStore = () => {};
function StoreParent({ cards, groups = [], edges = [] }: { cards: object[]; groups?: object[]; edges?: object[] }) {
  const [scene, setScene] = useState(() => ({ id: "S", name: "S", created_at: 0, edges, groups, cards }) as Record<string, unknown>);
  const saved = useRef(structuredClone(scene));
  const [, bump] = useState(0);
  rerenderStore = () => bump((n) => n + 1);
  return (
    <SceneBoard
      scene={scene as never}
      onChange={(patch) => {
        patches.push(patch as Record<string, unknown>);
        saved.current = { ...saved.current, ...structuredClone(patch as Record<string, unknown>) };
        setScene({ ...saved.current, ...(patch as Record<string, unknown>) });
      }}
      onCameraChange={(camera) => {
        saved.current = { ...saved.current, camera };
        setScene({ ...saved.current });
      }}
    />
  );
}
const showStored = (cards: object[], groups: object[] = []) => act(async () => { root.render(<StoreParent cards={cards} groups={groups} />); });
const card = (id: string) => host.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`)!;
const groupEl = (id: string) => host.querySelector<HTMLElement>(`.scene-group[data-group-id="${id}"]`)!;
const board = () => host.querySelector<HTMLElement>(".scene-board")!;
const canvas = () => host.querySelector<HTMLElement>(".scene-canvas")!;
const picked = (id: string) => card(id).classList.contains("sel");
const savedCards = () => ([...patches].reverse().find((patch) => "cards" in patch)?.cards ?? []) as Record<string, unknown>[];
const savedCard = (id: string) => savedCards().find((item) => item.id === id);
const savedX = (id: string) => savedCard(id)?.x;
const savedRectX = (id: string) =>
  (([...patches].reverse().find((patch) => "groups" in patch)?.groups ?? []) as { id: string; rect?: { x: number } }[]).find((g) => g.id === id)?.rect?.x;
const key = (init: KeyboardEventInit) => act(async () => {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});
const escape = () => key({ key: "Escape", code: "Escape" });
const undoOnce = () => key({ key: "z", code: "KeyZ", ctrlKey: true });
const selectAll = () => key({ key: "a", code: "KeyA", ctrlKey: true });
const grab = (id: string, x: number, y: number) => act(async () => {
  card(id).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: y }));
});
const grabHead = (groupId: string, x: number, y: number) => act(async () => {
  host.querySelector<HTMLElement>(`.scene-group[data-group-id="${groupId}"] .scene-group-hd`)!
    .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: y }));
});
const pressHandle = (el: HTMLElement, x: number, y: number) => act(async () => {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y }));
});
const dragTo = (x: number, y: number, ms = 2000) => act(async () => {
  clock += ms;
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons: 1 }));
  frames.splice(0).forEach((cb) => cb(0));
});
const release = (x: number, y: number) => act(async () => {
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: x, clientY: y }));
});
// detail 1 = 마우스 클릭(브라우저는 몇 번째 클릭인지 싣는다), 0 = 키보드로 누른 단추의 click(Enter·Space)
const clickOn = (id: string, detail = 1) => act(async () => {
  card(id).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail }));
});
// 손을 떼는 mouseup 과 그 놓기에 딸린 click 은 같은 작업 안에서 온다(브라우저) — 한 act 안에서 잇달아 보낸다
const releaseAndClick = (id: string, x: number, y: number) => act(async () => {
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: x, clientY: y }));
  card(id).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
});
const redoOnce = () => key({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true });
/** 캔버스 좌표 → 지금 카메라(F 로 바뀐 뒤)의 화면 좌표 — 끌기는 화면 좌표를 캔버스 좌표로 바꿔 거리를 잰다(보드 rect 는 0,0 으로 모의). */
const clientAt = (cx: number, cy: number) => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)/.exec(canvas().style.transform);
  const [x, y, z] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1];
  return [cx * z + x, cy * z + y] as const;
};
const hoverBoard = (x: number, y: number) => act(async () => {
  card("a1").dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y, buttons: 1 })); // 보드의 onMouseMove 가 마우스 자리를 적는다
});

it("카드를 끌다 Esc — 끌기 전 자리로 돌아오고 저장하지 않는다. 끄는 중 표시가 걷히고, 그 뒤의 놓기는 아무 일도 하지 않으며 딸린 click 한 번은 삼킨다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)]);
  await grab("a1", 150, 150);
  await dragTo(370, 150);
  expect([card("a1").style.left, board().classList.contains("dragging")]).toEqual(["330px", true]);
  await escape();
  expect([card("a1").style.left, card("a1").style.top]).toEqual(["110px", "110px"]);
  expect(board().classList.contains("dragging")).toBe(false);
  expect(patches).toHaveLength(0); // 끄는 중에 저장한 것이 없으니 되돌릴 것도 저장할 것도 없다
  await dragTo(500, 300); // 손을 뗀 뒤까지 더 움직여도 따라오지 않는다
  const clicks = vi.fn();
  document.addEventListener("click", clicks);
  await clickOn("a1", 0); // 손을 떼기 전의 키보드 click(Enter 로 누른 단추) — 놓기의 것이 아니다, 그대로 간다
  expect(clicks).toHaveBeenCalledTimes(1);
  await releaseAndClick("a1", 500, 300); // 놓기와 딸린 click — 이것은 삼킨다
  expect([card("a1").style.left, picked("a1"), patches.length, clicks.mock.calls.length]).toEqual(["110px", false, 0, 1]);
  await clickOn("a1"); // 다음 것은 그대로 간다
  document.removeEventListener("click", clicks);
  expect(clicks).toHaveBeenCalledTimes(2);
  await undoOnce(); // 빈 단계를 쌓지 않았다 — 되돌릴 것이 없다
  expect(patches).toHaveLength(0);
});

it("Esc 뒤 창을 떠나면(blur) click 억제를 거둔다 — 밖에서 손을 떼어 click 이 안 와도 돌아온 뒤의 클릭을 먹지 않는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)]);
  await grab("a1", 150, 150);
  await dragTo(370, 150);
  await escape();
  await act(async () => { window.dispatchEvent(new Event("blur")); });
  const clicks = vi.fn();
  document.addEventListener("click", clicks);
  await clickOn("a1");
  document.removeEventListener("click", clicks);
  expect(clicks).toHaveBeenCalledTimes(1);
});

it("전부 골라 끄는 중(캔버스 층만 밀 때) Esc — 층이 제자리로 돌아오고 좌표·저장·선택은 그대로다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)]);
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150);
  expect([card("a1").style.left, canvas().style.translate, canvas().hasAttribute("data-layer-move")]).toEqual(["110px", "550px 0px", true]);
  await escape();
  expect([card("a1").style.left, card("b1").style.left, canvas().style.translate, canvas().hasAttribute("data-layer-move")])
    .toEqual(["110px", "660px", "", false]);
  expect([patches.length, picked("a1"), picked("b1")]).toEqual([0, true, true]);
  await release(700, 150);
  expect([card("a1").style.left, patches.length]).toEqual(["110px", 0]);
});

it("전부 끄는 중 키 앞의 확정(F)으로 좌표가 저장된 뒤 Esc — 끌기 전 자리로 되돌려 저장하고, 되돌리기에 같은 모습의 단계를 남기지 않는다", async () => {
  await showStored([textCard("a1", 110), textCard("b1", 660)]);
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150);
  await key({ key: "f", code: "KeyF" }); // 화면 맞춤 — 카메라를 저장하기 전에 옮긴 자리를 먼저 저장한다
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  expect([savedX("a1"), savedX("b1")]).toEqual([660, 1210]);
  await escape();
  expect([card("a1").style.left, card("b1").style.left, canvas().style.translate]).toEqual(["110px", "660px", ""]);
  expect([savedX("a1"), savedX("b1")]).toEqual([110, 660]); // 되돌린 자리를 저장했다
  const saved = patches.length;
  await undoOnce(); // F 가 쌓은 단계는 되돌린 모습과 같다 — 걷혔다. 헛도는 Ctrl+Z 가 없다
  expect([patches.length, card("a1").style.left]).toEqual([saved, "110px"]);
});

it("한 장만 끄는 중 키 앞의 확정(F)이 끼어도 같다 — Esc 로 끌기 전 자리, 같은 모습의 단계는 남지 않는다", async () => {
  await showStored([textCard("a1", 110), textCard("b1", 660)]);
  await grab("a1", 150, 150);
  await dragTo(370, 150);
  await key({ key: "f", code: "KeyF" });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  expect(savedX("a1")).toBe(330);
  await escape();
  expect([card("a1").style.left, savedX("a1")]).toEqual(["110px", 110]);
  const saved = patches.length;
  await undoOnce();
  expect([patches.length, card("a1").style.left]).toEqual([saved, "110px"]);
});

it("끄는 중의 삭제는 남고 이동만 버려진다 — Ctrl+Z 한 번에 지운 카드만 돌아오고 끌던 카드는 끌기 전 자리 그대로다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)]);
  await grab("b1", 700, 150);
  await release(700, 150); // b1 을 고른다
  expect(picked("b1")).toBe(true);
  await grab("a1", 150, 150); // 고르지 않은 a1 을 잡아 끈다 — 고른 b1 은 그대로다
  await dragTo(370, 150);
  await key({ key: "Delete", code: "Delete" }); // 끄는 중에 고른 b1 을 지운다
  expect(savedCards().map((c) => c.id)).toEqual(["a1"]);
  expect(savedX("a1")).toBe(330);
  await escape();
  expect([card("a1").style.left, savedX("a1"), savedCards().map((c) => c.id)]).toEqual(["110px", 110, ["a1"]]);
  await undoOnce();
  expect(savedCards().map((c) => [c.id, c.x])).toEqual([["a1", 110], ["b1", 660]]);
  expect(card("b1").style.left).toBe("660px");
});

it("끌다 F 로 저장하고 제자리로 돌아와 다시 F 로 저장한 뒤 Esc — 값은 같아도 묶음의 단계를 걷는다(Ctrl+Z 가 헛돌지 않는다)", async () => {
  await showStored([textCard("a1", 110), textCard("b1", 660)]);
  await grab("a1", 150, 150);
  await dragTo(370, 150);
  await key({ key: "f", code: "KeyF" });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  expect(savedX("a1")).toBe(330);
  const [bx, by] = clientAt(150, 150); // F 가 카메라를 바꿨다 — 잡은 자리(캔버스 150,150)가 지금 화면 어디인지로 제자리에 놓는다
  await dragTo(bx, by);
  expect(card("a1").style.left).toBe("110px");
  await key({ key: "f", code: "KeyF" });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  expect(savedX("a1")).toBe(110);
  await escape();
  const saved = patches.length;
  await undoOnce();
  expect([patches.length, card("a1").style.left]).toEqual([saved, "110px"]);
});

it("판 전체를 끌다 F 로 저장하고 제자리로 돌아와 다시 F 로 저장한 뒤 Esc — 좌표에 넣은 양이 0 이어도 단계를 걷고 다시 하기 기록이 남는다", async () => {
  await showStored([textCard("a1", 110), textCard("b1", 660)]);
  await grab("b1", 700, 150);
  await dragTo(920, 150);
  await release(920, 150); // b1 → 880 (되돌리기 한 단계)
  await undoOnce();
  expect(card("b1").style.left).toBe("660px"); // 다시 하기 한 단계
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150);
  await key({ key: "f", code: "KeyF" });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  expect([savedX("a1"), savedX("b1")]).toEqual([660, 1210]);
  const [bx, by] = clientAt(150, 150);
  await dragTo(bx, by); // 제자리로 — 층에만 있던 이동량이 0 이 된다
  await key({ key: "f", code: "KeyF" });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  expect([savedX("a1"), savedX("b1")]).toEqual([110, 660]);
  await escape();
  const saved = patches.length;
  await undoOnce(); // 같은 모습의 단계가 남지 않았다
  expect([patches.length, card("a1").style.left]).toEqual([saved, "110px"]);
  await redoOnce(); // 끌기 전의 다시 하기(b1 → 880)가 살아 있다
  expect([card("b1").style.left, savedX("b1")]).toEqual(["880px", 880]);
});

it("중첩 값이 있는 카드(genIds)를 끌다 F 로 저장한 뒤 Esc — 저장소를 한 바퀴 돌아 복제된 값도 '같은 모습'으로 보고 단계를 걷는다", async () => {
  const genCard = (id: string, x: number, extra: object = {}) => ({ id, kind: "generation", x, y: 110, ...extra });
  await showStored([genCard("a1", 110, { genId: "g1", genIds: ["g1"] }), textCard("b1", 660)]);
  await grab("a1", 150, 150);
  await dragTo(370, 150);
  await key({ key: "f", code: "KeyF" });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  expect(savedX("a1")).toBe(330);
  await escape();
  expect([card("a1").style.left, savedX("a1")]).toEqual(["110px", 110]);
  const saved = patches.length;
  await undoOnce();
  expect([patches.length, card("a1").style.left]).toEqual([saved, "110px"]);
});

it("끌기를 버리면 끌기 전의 다시 하기 기록이 살아난다 — 끄는 중의 저장(F)이 비웠던 것", async () => {
  await showStored([textCard("a1", 110), textCard("b1", 660)]);
  await grab("a1", 150, 150);
  await dragTo(370, 150);
  await release(370, 150); // a1 → 330 (되돌리기 한 단계)
  await undoOnce();
  expect(card("a1").style.left).toBe("110px"); // 다시 하기 한 단계가 생겼다
  await grab("b1", 700, 150);
  await dragTo(920, 150);
  await key({ key: "f", code: "KeyF" }); // 끄는 중의 저장 — 다시 하기 기록을 비운다
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await escape(); // 끌기를 버린다 — 그 저장의 단계가 걷히며 다시 하기 기록이 돌아온다
  expect([card("b1").style.left, savedX("b1")]).toEqual(["660px", 660]);
  await redoOnce();
  expect([card("a1").style.left, savedX("a1")]).toEqual(["330px", 330]);
});

it("끄는 중 Tab 으로 연 노드 선택기가 떠 있으면 Esc 는 선택기를 먼저 닫고, 다음 Esc 가 끌기를 버린다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)]);
  await grab("a1", 150, 150);
  await dragTo(370, 150);
  await hoverBoard(370, 150);
  await key({ key: "Tab", code: "Tab" });
  expect(host.querySelector(".scene-nodepick")).not.toBeNull();
  await escape();
  expect([host.querySelector(".scene-nodepick"), card("a1").style.left]).toEqual([null, "330px"]); // 선택기만 닫혔다 — 끌기는 이어진다
  await dragTo(480, 150);
  expect(card("a1").style.left).toBe("440px");
  await escape();
  expect([card("a1").style.left, patches.length]).toEqual(["110px", 0]);
});

it("그룹의 크기 손잡이를 끌다 Esc — 네모가 끌기 전으로 돌아오고 멤버 재배정 없이 저장하지 않는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], [rectGroup("gA", ["a1"], 66)]);
  const before = [groupEl("gA").style.width, groupEl("gA").style.height];
  await pressHandle(host.querySelector<HTMLElement>('.scene-group[data-group-id="gA"] .scene-group-resize')!, 396, 374);
  await dragTo(996, 374); // 오른쪽으로 600 — b1(660) 까지 덮는다
  expect(groupEl("gA").style.width).not.toBe(before[0]);
  await escape();
  expect([groupEl("gA").style.width, groupEl("gA").style.height, patches.length]).toEqual([before[0], before[1], 0]);
  await release(996, 374);
  expect(patches).toHaveLength(0); // 놓아도 upr(멤버 재배정)이 돌지 않는다 — b1 은 gA 에 들어가지 않는다
});

it("끄는 중의 파생 저장이 좌표를 옮겨 놓은 뒤 Esc — 끌기 전 자리로 되돌려 저장하고 파생 값은 남으며, 되돌리기 단계는 생기지 않는다", async () => {
  const genCard = (id: string, x: number, extra: object = {}) => ({ id, kind: "generation", x, y: 110, ...extra });
  await act(async () => {
    root.render(<StoreParent
      cards={[genCard("src", 110, { genId: "g1", genIds: ["g1"] }), genCard("dst", 660)]}
      edges={[{ id: "e1", from: "src", to: "dst" }]}
    />);
  });
  const refsOf = (id: string) => ((savedCard(id) as { refs?: unknown[] } | undefined)?.refs ?? []);
  await grab("dst", 700, 150);
  await dragTo(920, 150); // dst → 880
  // 끄는 중에 src 의 생성 결과가 도착한다 → dst 의 연결 레퍼런스가 채워지고 파생 저장이 난다(좌표는 옮기던 자리 — tests/sceneCardGroupMove 와 같다)
  const g1 = {
    id: "g1", status: "done", prompt: "g1", tags: [], auto_tags: [], references: [], shared: false, deleted: false, is_mine: true,
    comment_count: 0, has_unread: false, created_at: "2026-10-11 00:00:00", sort_ts: 1,
    assets: [{ id: "asset-g1", generation_id: "g1", type: "image", file_path: "/g1.png", thumbnail_path: null, source_url: null, cached: true }],
  };
  fixture.data = { ...fixture.data, genData: { g1 }, genDataRef: { current: { g1 } } } as unknown as SceneGenDataApi;
  await act(async () => { rerenderStore(); });
  expect([savedX("dst"), refsOf("dst").length]).toEqual([880, 1]);
  await escape();
  expect([card("dst").style.left, savedX("dst"), refsOf("dst").length]).toEqual(["660px", 660, 1]); // 자리만 돌아오고 파생 값은 남는다
  const saved = patches.length;
  await undoOnce(); // 버린 끌기는 단계를 남기지 않는다(파생 저장은 원래 되돌리기 밖이다)
  expect([patches.length, card("dst").style.left]).toEqual([saved, "660px"]);
});

// 다시 하기 비우기를 묶음이 끝날 때로 미뤘으니(lib/useSceneHistory endGesture), 묶음이 '끝맺음 없이' 끝나는 길에서도 닫혀야 한다 — 끄는 중의 씬 전환과
//  탭 이탈(언마운트). 안 닫으면 단계를 쌓은 끌기의 씬에 옛 다시 하기가 남아 돌아왔을 때 되살아난다(Codex 3차 리뷰 P2).
const makeRedoThenDirtyDrag = async () => {
  // c1 을 옮겼다 되돌려 다시 하기 한 단계를 만든다 → b1 을 고르고 a1 을 끌면서 Delete — 끄는 중의 저장(단계를 쌓은 묶음)
  await grab("c1", 1250, 150);
  await dragTo(1470, 150);
  await release(1470, 150);
  expect(card("c1").style.left).toBe("1320px");
  await undoOnce();
  expect(card("c1").style.left).toBe("1100px");
  await grab("b1", 700, 150);
  await release(700, 150);
  await grab("a1", 150, 150);
  await dragTo(370, 150);
  await key({ key: "Delete", code: "Delete" });
  expect(savedCards().map((c) => c.id)).toEqual(["a1", "c1"]);
  return [...savedCards()] as object[];
};

it("끄는 중 씬을 바꾸면 떠나는 씬의 묶음이 그 씬의 기록에 대해 닫힌다 — 돌아와도 끌기 전의 다시 하기가 되살아나지 않고, Ctrl+Z 는 끄는 중의 삭제를 되돌린다", async () => {
  await open("S", [textCard("a1", 110), textCard("b1", 660), textCard("c1", 1100)]);
  const savedS = await makeRedoThenDirtyDrag();
  await open("T", [textCard("t1", 110)]); // 누른 채 씬 전환 — 끌기는 버려진다
  expect(card("t1").style.left).toBe("110px");
  await release(370, 150); // 손을 뗀다 — 버려진 끌기라 아무 일도 없지만 '누르고 있는 동안'(moveHeldRef)은 여기서 풀린다
  await open("S", savedS);
  const saved = patches.length;
  await redoOnce(); // 단계를 쌓은 끌기였다 — c1 의 다시 하기는 끝났다
  expect([patches.length, card("c1").style.left]).toEqual([saved, "1100px"]);
  await undoOnce(); // 끄는 중의 삭제(b1)가 되돌아온다
  expect(savedCards().map((c) => c.id)).toEqual(["a1", "b1", "c1"]);
});

it("누른 채 탭을 떠나도(언마운트) 묶음이 닫힌 채 보관된다 — 돌아와도 끌기 전의 다시 하기가 되살아나지 않는다", async () => {
  await open("S", [textCard("a1", 110), textCard("b1", 660), textCard("c1", 1100)]);
  const savedS = await makeRedoThenDirtyDrag();
  act(() => root.unmount());
  root = createRoot(host);
  await open("S", savedS);
  const saved = patches.length;
  await redoOnce();
  expect([patches.length, card("c1").style.left]).toEqual([saved, "1100px"]);
  await undoOnce();
  expect(savedCards().map((c) => c.id)).toEqual(["a1", "b1", "c1"]);
});

it("그룹 머리를 끌다 Esc — 멤버는 끌기 전 자리로, 네모는 끌기 전 네모로 돌아오고 저장하지 않는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], [rectGroup("gA", ["a1"], 66), rectGroup("gB", ["b1"], 616)]);
  await grabHead("gA", 100, 50);
  await dragTo(320, 270);
  expect([card("a1").style.left, groupEl("gA").style.left]).toEqual(["330px", "286px"]);
  await escape();
  expect([card("a1").style.left, card("a1").style.top, groupEl("gA").style.left, groupEl("gA").style.top])
    .toEqual(["110px", "110px", "66px", "44px"]);
  expect(patches).toHaveLength(0);
  await release(320, 270);
  expect([card("a1").style.left, groupEl("gA").style.left, patches.length]).toEqual(["110px", "66px", 0]);
});

it("그룹 머리를 끌다 F 로 저장된 뒤 Esc — 멤버·네모를 끌기 전으로 되돌려 저장하고, 같은 모습의 단계는 남지 않는다", async () => {
  await showStored([textCard("a1", 110), textCard("b1", 660)], [rectGroup("gA", ["a1"], 66)]);
  await grabHead("gA", 100, 50);
  await dragTo(320, 270);
  await key({ key: "f", code: "KeyF" });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  expect([savedX("a1"), savedRectX("gA")]).toEqual([330, 286]);
  await escape();
  expect([card("a1").style.left, groupEl("gA").style.left, savedX("a1"), savedRectX("gA")]).toEqual(["110px", "66px", 110, 66]);
  const saved = patches.length;
  await undoOnce();
  expect([patches.length, card("a1").style.left, groupEl("gA").style.left]).toEqual([saved, "110px", "66px"]);
});

it("크기 손잡이를 끌다 Esc — 크기가 끌기 전으로 돌아오고 크기를 저장하지 않는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)]);
  const before = [card("a1").style.width, card("a1").style.height];
  await pressHandle(card("a1").querySelector<HTMLElement>(".scene-resize")!, 262, 200);
  await dragTo(482, 310);
  expect(card("a1").style.width).not.toBe(before[0]);
  await escape();
  expect([card("a1").style.width, card("a1").style.height]).toEqual(before);
  await release(482, 310);
  expect([card("a1").style.width, savedCard("a1")?.w, savedCard("a1")?.h]).toEqual([before[0], undefined, undefined]);
});

it("Esc 로 끌기를 버려도 선택은 그대로다 — 끌기가 없을 때의 Esc 는 전처럼 선택을 푼다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)]);
  await grab("a1", 150, 150);
  await release(150, 150); // a1 을 고른다
  expect(picked("a1")).toBe(true);
  await grab("a1", 150, 150);
  await dragTo(370, 150);
  await escape();
  expect([card("a1").style.left, picked("a1")]).toEqual(["110px", true]);
  await release(370, 150);
  expect(picked("a1")).toBe(true);
  await escape(); // 끌기가 없다 — 선택 해제
  expect(picked("a1")).toBe(false);
});

it("누르기만 하고(4px 미만) Esc — 그 뒤의 놓기는 클릭 선택을 하지 않는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)]);
  await grab("a1", 150, 150);
  await escape();
  await release(150, 150);
  expect([picked("a1"), card("a1").style.left, patches.length]).toEqual([false, "110px", 0]);
  await grab("a1", 150, 150); // 다음 누름은 평소대로 — 클릭 선택이 된다
  await release(150, 150);
  expect(picked("a1")).toBe(true);
});

it("Esc 를 버린 끌기 뒤에 다시 잡아 끌면 평소대로 옮겨져 저장된다 — 버린 끌기가 다음 끌기를 막지 않는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)]);
  await grab("a1", 150, 150);
  await dragTo(370, 150);
  await escape();
  await release(370, 150);
  await grab("a1", 150, 150);
  await dragTo(260, 150);
  await release(260, 150);
  expect([card("a1").style.left, savedX("a1")]).toEqual(["220px", 220]);
  await undoOnce();
  expect([savedX("a1"), card("a1").style.left]).toEqual([110, "110px"]);
});
