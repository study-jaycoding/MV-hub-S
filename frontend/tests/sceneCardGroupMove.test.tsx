// 카드를 끌어 놓을 때의 그룹 소속 — 실제 SceneBoard 로 본다(끌기 훅·재배정·이탈 계산은 실제 코드).
// 2026-10-10 캔버스 실측: 전부 고르고(Ctrl+A) 끌어 놓으면 그룹이 줄었다(32 → 31, 되풀이하면 20 → 9. Ctrl+Z 로만 복구).
//  · 카드가 같이 옮겨 온 옆 그룹의 **옛 자리**에 떨어져 그 그룹으로 넘어가거나(속도와 무관)
//  · 빠르게 끌면 전부 이탈해, 비게 된 그룹이 지워졌다.
// 멤버를 전부 같이 끄는 그룹은 통째로 간다(rect 도 같이, 이탈·재배정 없음). 한 장만 끌 때의 편입·이탈은 그대로다.
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
type Group = { id: string; cardIds: string[]; rect?: { x: number; y: number; w: number; h: number } };
/** 요소의 translate("Xpx Ypx") — 끄는 동안 카드의 바깥 틀은 left/top 을 끌기 전 자리에 두고 이것으로 옮긴다(아래 '일부만 끄는 길'). */
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
  vi.spyOn(performance, "now").mockImplementation(() => clock); // 끄는 속도(화면 px / ms)를 시험이 정한다 — 이탈 문턱은 3
  // 카드·그룹은 style 의 캔버스 좌표를 화면 위치로 쓴다(확대 100%·이동 0 인 첫 화면과 같다). 보이는 자리 = left/top + translate.
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
const show = (cards: object[], groups: object[]) => act(async () => {
  const scene = { id: "S", name: "S", created_at: 0, edges: [], cards, groups } as never;
  root.render(<SceneBoard scene={scene} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
});
// 두 그룹: gA{a1} 프레임 x 66..396, gB{b1} 프레임 x 616..946. 카드 폭 152, 격자 22.
const twoGroups = () => show(
  [textCard("a1", 110), textCard("b1", 660)],
  [
    { id: "gA", name: "A", cardIds: ["a1"], rect: { x: 66, y: 44, w: 330, h: 330 } },
    { id: "gB", name: "B", cardIds: ["b1"], rect: { x: 616, y: 44, w: 330, h: 330 } },
  ],
);
const card = (id: string) => host.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`)!;
/** 카드가 보이는 자리(캔버스 좌표) — 끄는 도중에는 이것으로 본다(끄는 동안의 left/top 은 끌기 전 자리다). */
const shownAt = (id: string) => [parseFloat(card(id).style.left) + shift(card(id)).x, parseFloat(card(id).style.top) + shift(card(id)).y];
const selectAll =() => act(async () => {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true, cancelable: true }));
});
const grab = (id: string, x: number, y: number, ctrlKey = false) => act(async () => {
  card(id).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: y, ctrlKey }));
});
// 끄는 중의 mousemove 는 실제 브라우저처럼 buttons 를 싣는다(왼쪽 단추 = 1). jsdom 의 기본값 0 은 '단추를 다 뗀 채 움직임'이라
//  끌기 세션이 놓친 mouseup 으로 읽고 그 자리에서 끝낸다(lib/sceneDragSession — 아래 hoverTo 가 그 길이다).
const dragTo = (x: number, y: number, ms: number) => act(async () => {
  clock += ms;
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons: 1 }));
  frames.splice(0).forEach((cb) => cb(0));
});
// 단추를 다 뗀 채 움직인다 — mouseup 은 오지 않았다(창 밖에서 뗌 등)
const hoverTo = (x: number, y: number) => act(async () => {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons: 0 }));
  frames.splice(0).forEach((cb) => cb(0));
});
const release = (x: number, y: number) => act(async () => {
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: x, clientY: y }));
});
const groups = (): Group[] => ([...patches].reverse().find((patch) => "groups" in patch)?.groups ?? []) as Group[];
const members = () => Object.fromEntries(groups().map((group) => [group.id, group.cardIds]));
const rectX = (id: string) => groups().find((group) => group.id === id)?.rect?.x;
const rectY = (id: string) => groups().find((group) => group.id === id)?.rect?.y;
const canvas = () => host.querySelector<HTMLElement>(".scene-canvas")!;
const savedCards = () => ([...patches].reverse().find((patch) => "cards" in patch)?.cards ?? []) as { id: string; x: number; y: number }[];
const savedX = (id: string) => savedCards().find((item) => item.id === id)?.x;
const key = (init: KeyboardEventInit) => act(async () => {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});

it("전부 고르고 천천히 끌어 옆 그룹의 옛 자리에 놓아도 소속이 바뀌지 않는다 — 그룹의 네모도 카드와 같은 만큼 간다", async () => {
  await twoGroups();
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000); // +550px 를 2초에(0.275px/ms — 이탈 문턱 미만). a1 이 gB 가 있던 자리(616..946)에 온다
  await release(700, 150);
  expect(members()).toEqual({ gA: ["a1"], gB: ["b1"] });
  expect([rectX("gA"), rectX("gB")]).toEqual([616, 1166]);
});

it("전부 고르고 빠르게 끌어도 그룹에서 이탈하지 않는다", async () => {
  await twoGroups();
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(150, 370, 40); // 5.5px/ms
  await dragTo(150, 590, 40);
  await release(150, 590);
  expect(members()).toEqual({ gA: ["a1"], gB: ["b1"] });
  expect([rectY("gA"), rectY("gB")]).toEqual([484, 484]);
});

it("한 장만 끌 때는 전과 같다 — 다른 그룹 안에 놓으면 그 그룹으로, 빠르게 빈 곳으로 끌면 이탈(비게 된 그룹은 정리)", async () => {
  await twoGroups();
  await grab("a1", 150, 150);
  await dragTo(590, 150, 2000); // a1 의 중심이 gB 안
  await release(590, 150);
  expect(members()).toEqual({ gB: ["b1", "a1"] });

  act(() => root.unmount());
  root = createRoot(host);
  patches = [];
  await twoGroups();
  await grab("a1", 150, 150);
  await dragTo(150, 370, 40);
  await dragTo(150, 590, 40);
  await release(150, 590);
  expect(members()).toEqual({ gB: ["b1"] });
});

it("그룹의 카드를 전부 골라 가만히 있는 다른 그룹 안에 놓으면 합쳐지지 않고 그룹째 옮겨진다 — 헤더를 잡고 끌 때와 같다", async () => {
  await show(
    [textCard("a1", 110), textCard("a2", 110, 264), textCard("b1", 660), textCard("b2", 880, 264)],
    [
      { id: "gA", name: "A", cardIds: ["a1", "a2"], rect: { x: 66, y: 44, w: 330, h: 400 } },
      { id: "gB", name: "B", cardIds: ["b1", "b2"], rect: { x: 616, y: 44, w: 660, h: 660 } },
    ],
  );
  await grab("a1", 150, 150);
  await release(150, 150); // a1 선택
  await grab("a2", 150, 300, true);
  await release(150, 300); // Ctrl+클릭으로 a2 추가
  await grab("a1", 150, 150);
  await dragTo(810, 150, 2000); // 둘 다 gB 프레임(616..1276) 안으로
  await release(810, 150);
  expect(members()).toEqual({ gA: ["a1", "a2"], gB: ["b1", "b2"] });
  expect(rectX("gA")).toBe(726);
});

it("네모가 없는 자동 그룹도 통째로 간다 — 전부 고르고 빠르게 끌어도 이탈하지 않는다", async () => {
  await show(
    [textCard("a1", 110), textCard("b1", 660)],
    [{ id: "gA", name: "A", cardIds: ["a1"] }, { id: "gB", name: "B", cardIds: ["b1"] }],
  );
  await selectAll();
  const frameTop = (id: string) => parseFloat(host.querySelector<HTMLElement>(`.scene-group[data-group-id="${id}"]`)?.style.top ?? "NaN");
  const before = [frameTop("gA"), frameTop("gB")];
  await grab("a1", 150, 150);
  await dragTo(150, 370, 40);
  await dragTo(150, 590, 40);
  // 보드의 카드를 전부 끄는 동안에는 좌표를 그대로 두고 캔버스 층을 민다 — 틀도 층과 같이 간다
  expect(canvas().style.translate).toBe("0px 440px");
  expect([frameTop("gA") - before[0], frameTop("gB") - before[1]]).toEqual([0, 0]);
  await release(150, 590);
  expect(canvas().style.translate).toBe("");
  expect([frameTop("gA") - before[0], frameTop("gB") - before[1]]).toEqual([440, 440]);
  // 네모가 없는 그룹은 저장할 것이 안 바뀐다 — 그룹을 담은 저장이 아예 없거나, 있으면 두 그룹이 그대로여야 한다(빈 배열이면 실패)
  const saved = [...patches].reverse().find((patch) => "groups" in patch)?.groups as Group[] | undefined;
  if (saved) expect(Object.fromEntries(saved.map((group) => [group.id, group.cardIds]))).toEqual({ gA: ["a1"], gB: ["b1"] });
  expect(host.querySelectorAll(".scene-group").length).toBe(2);
});

it("통째로 옮겨 간 그룹의 옛 자리에 다른 카드가 떨어져도 그 그룹으로 넘어가지 않는다", async () => {
  // gB{b1,b2} 가 왼쪽, gA{a1} 이 오른쪽. b1 과 a1 만 고른다 — gA 는 통째로, gB 는 일부만. +550 으로 끌면 b1 이 gA 가 있던 자리에 온다.
  await show(
    [textCard("b1", 110), textCard("b2", 110, 264), textCard("a1", 660)],
    [
      { id: "gB", name: "B", cardIds: ["b1", "b2"], rect: { x: 66, y: 44, w: 330, h: 400 } },
      { id: "gA", name: "A", cardIds: ["a1"], rect: { x: 616, y: 44, w: 330, h: 330 } },
    ],
  );
  await grab("b1", 150, 150);
  await release(150, 150);
  await grab("a1", 700, 150, true);
  await release(700, 150);
  await grab("b1", 150, 150);
  await dragTo(700, 150, 2000);
  await release(700, 150);
  expect(members()).toEqual({ gB: ["b1", "b2"], gA: ["a1"] });
  expect(rectX("gA")).toBe(1166);
});

// ── 보드를 통째로 끄는 빠른 길 — 걸음마다 카드 N장을 다시 그리지 않고 캔버스 층(.scene-canvas)을 CSS translate 로 민다 ──
// 2026-10-10 캔버스 실측: 412장을 전부 고르고 끌면 걸음마다 전부 다시 그려 화면 갱신이 초당 약 6번이었다.

it("보드의 카드를 전부 끌면 끄는 동안 좌표는 그대로 두고 캔버스 층만 민다 — 시작 자리로 돌아오면 0, 놓으면 좌표에 넣고 층을 되돌린다", async () => {
  await twoGroups();
  await selectAll();
  const saves = () => patches.filter((patch) => "cards" in patch).length;
  const before = saves();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000);
  expect(canvas().style.translate).toBe("550px 0px");
  expect(canvas().hasAttribute("data-layer-move")).toBe(true); // 합성기만으로 밀리게 하는 표시(scene.css)
  expect([card("a1").style.left, card("b1").style.left]).toEqual(["110px", "660px"]);
  await dragTo(150, 150, 2000); // 시작 자리로 돌아왔다 — 0 도 반영한다
  expect(canvas().style.translate).toBe("");
  await dragTo(700, 150, 2000);
  expect(canvas().style.translate).toBe("550px 0px");
  expect(saves()).toBe(before); // 끄는 동안 저장 없음
  await release(700, 150);
  expect(canvas().style.translate).toBe("");
  expect(canvas().hasAttribute("data-layer-move")).toBe(false);
  expect([card("a1").style.left, card("b1").style.left]).toEqual(["660px", "1210px"]);
  expect(saves()).toBe(before + 1);
  expect([savedX("a1"), savedX("b1")]).toEqual([660, 1210]);
  expect([rectX("gA"), rectX("gB")]).toEqual([616, 1166]);
});

it("보드의 일부만 끌 때는 층을 밀지 않는다 — 통째로 고른 그룹을 빠르게 끌어도 이탈하지 않고 틀이 걸음마다 따라온다", async () => {
  await show(
    [textCard("a1", 110), textCard("a2", 110, 264), textCard("c1", 1100)],
    [{ id: "gA", name: "A", cardIds: ["a1", "a2"] }],
  );
  await grab("a1", 150, 150);
  await release(150, 150);
  await grab("a2", 150, 300, true);
  await release(150, 300); // a1·a2 만 골랐다(c1 은 남는다)
  const frameTop = () => parseFloat(host.querySelector<HTMLElement>('.scene-group[data-group-id="gA"]')?.style.top ?? "NaN");
  const before = frameTop();
  await grab("a1", 150, 150);
  await dragTo(150, 370, 40);
  await dragTo(150, 590, 40);
  expect(canvas().style.translate || "").toBe("");
  expect(shownAt("a1")).toEqual([110, 550]);
  expect(frameTop() - before).toBe(440); // 이탈로 치면 틀이 제자리에 남거나 사라진다
  await release(150, 590);
  expect(members()).toEqual({ gA: ["a1", "a2"] });
});

it("끄는 중 단축키가 오면 층에만 있던 이동을 좌표에 먼저 넣고, 그 뒤의 이동은 넣은 자리에서 이어 민다 — 끄는 중의 묶기(Ctrl+G)는 받지 않는다", async () => {
  await twoGroups();
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000);
  await key({ key: "g", code: "KeyG", ctrlKey: true });
  expect(card("a1").style.left).toBe("660px"); // 좌표에 들어갔다
  expect(canvas().style.translate).toBe(""); // 층은 같은 커밋에서 제자리로
  expect(host.querySelectorAll(".scene-group").length).toBe(2); // 새 그룹이 생기지 않았다
  await dragTo(920, 150, 2000);
  expect(canvas().style.translate).toBe("220px 0px");
  expect(card("a1").style.left).toBe("660px");
  await release(920, 150);
  expect(canvas().style.translate).toBe("");
  expect(card("a1").style.left).toBe("880px");
  expect(members()).toEqual({ gA: ["a1"], gB: ["b1"] });
  expect([rectX("gA"), rectX("gB")]).toEqual([836, 1386]);
});

it("끄는 중 씬을 바꾸면 — 직전의 저장 확정이 층에만 있던 이동을 저장에 넣고, 새 씬은 밀려 보이지 않는다", async () => {
  const actionRef = { current: null as { flushPending: () => void } | null };
  const open = (id: string, cards: object[]) => act(async () => {
    const scene = { id, name: id, created_at: 0, edges: [], cards, groups: [] } as never;
    root.render(<SceneBoard scene={scene} actionRef={actionRef as never} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  await open("S", [textCard("a1", 110), textCard("b1", 660)]);
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000);
  await act(async () => { actionRef.current!.flushPending(); }); // App 의 selectScene 이 전환 직전에 부른다
  expect([savedX("a1"), savedX("b1")]).toEqual([660, 1210]);
  await open("T", [textCard("a1", 220)]); // 새 씬 — id 가 같은 카드가 있어도 옛 끌기가 건드리지 않는다
  expect(canvas().style.translate).toBe("");
  expect(card("a1").style.left).toBe("220px");
  const count = patches.length;
  await release(700, 150);
  expect(card("a1").style.left).toBe("220px");
  expect(patches.length).toBe(count);
});

it("끄는 중 화면이 내려가도 층에만 있던 이동이 저장에 들어간다", async () => {
  await twoGroups();
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000);
  act(() => root.unmount());
  expect([savedX("a1"), savedX("b1")]).toEqual([660, 1210]);
  expect([rectX("gA"), rectX("gB")]).toEqual([616, 1166]);
  root = createRoot(host); // afterEach 가 내릴 뿌리
});

it("끄는 중 저장 확정 없이 씬이 바뀌어도(다른 창의 전환 등) 버린 끌기가 새 씬을 밀어 두지 않는다", async () => {
  const open = (id: string, cards: object[]) => act(async () => {
    const scene = { id, name: id, created_at: 0, edges: [], cards, groups: [] } as never;
    root.render(<SceneBoard scene={scene} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  await open("S", [textCard("a1", 110), textCard("b1", 660)]);
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000);
  expect(canvas().style.translate).toBe("550px 0px");
  await open("T", [textCard("a1", 220)]);
  expect(canvas().style.translate).toBe("");
  await open("T", [textCard("a1", 220), textCard("n1", 440)]); // 새 씬이 다시 그려져도 옛 끌기의 층 맞춤이 돌지 않는다
  expect(canvas().style.translate).toBe("");
  expect(card("a1").style.left).toBe("220px");
});

it("보드의 카드를 전부 끄는 동안에는 화면 밖 연결선도 그린다 — 층만 밀어서 끌려 들어온 선이 다시 계산되지 않기 때문이다", async () => {
  // 보이는 영역에서 한참 떨어진 두 카드(f1 → f2)의 연결선은 평소에 그리지 않는다(컬링)
  await act(async () => {
    const scene = {
      id: "S", name: "S", created_at: 0, groups: [],
      cards: [textCard("a1", 110), textCard("f1", 6600), textCard("f2", 7040)],
      edges: [{ id: "e1", from: "f1", to: "f2" }],
    } as never;
    root.render(<SceneBoard scene={scene} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); }); // 보이는 영역을 잰다(컬링은 다음 프레임에 켜진다)
  const lines = () => host.querySelectorAll("path.scene-edge").length;
  const idle = lines();
  expect(idle).toBe(0); // 이 시험 환경에서도 컬링이 돈다(안 돌면 아래가 뜻이 없다)
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000);
  expect(lines()).toBe(1);
  // 끄는 중 카드가 새로 생겨도(생성 완료 등) 그 끌기가 끝날 때까지는 컬링하지 않는다
  await act(async () => {
    const scene = {
      id: "S", name: "S", created_at: 0, groups: [],
      cards: [textCard("a1", 110), textCard("f1", 6600), textCard("f2", 7040), textCard("n1", 330, 330)],
      edges: [{ id: "e1", from: "f1", to: "f2" }],
    } as never;
    root.render(<SceneBoard scene={scene} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  expect(lines()).toBe(1);
  await release(370, 150);
  expect(lines()).toBe(idle);
});

it("손을 뗀 것을 놓친 전체 끌기 뒤에 다시 잡아 끌어도 앞의 이동이 사라지지 않는다", async () => {
  await twoGroups();
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000); // +550 — mouseup 은 오지 않았다(창 밖에서 뗌)
  await grab("a1", 700, 150); // 다시 잡는다
  await dragTo(920, 150, 2000); // +220
  await release(920, 150);
  expect(canvas().style.translate).toBe("");
  expect([card("a1").style.left, card("b1").style.left]).toEqual(["880px", "1430px"]);
  expect([savedX("a1"), savedX("b1")]).toEqual([880, 1430]);
  expect([rectX("gA"), rectX("gB")]).toEqual([836, 1386]);
});

it("누르기만 하고 움직이지 않았으면 끄는 중의 키가 좌표를 건드리지 않는다 — 격자 밖 카드가 격자로 끌려가지 않는다", async () => {
  await show([textCard("a1", 100), textCard("b1", 650)], []);
  await selectAll();
  await grab("a1", 150, 150);
  await key({ key: "F9", code: "F9" }); // 좌표와 무관한 키 — 끄는 중의 키는 층에 밀어 둔 이동량을 좌표에 넣게 한다(넣을 것이 없어야 한다)
  expect([card("a1").style.left, card("b1").style.left]).toEqual(["100px", "650px"]);
  await release(150, 150);
  expect([card("a1").style.left, card("b1").style.left]).toEqual(["100px", "650px"]);
  for (const patch of patches) {
    const cards = (patch.cards ?? []) as { id: string; x: number }[];
    if (cards.length) expect(cards.find((item) => item.id === "a1")?.x).toBe(100);
  }
});

it("끄는 중의 정렬(a)은 받지 않는다 — 정렬한 좌표와 끌기의 시작 좌표가 엇갈리지 않는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660, 330)], []);
  await selectAll();
  await grab("b1", 700, 370);
  await dragTo(920, 370, 2000); // +220
  await key({ key: "a", code: "KeyA" });
  await release(920, 370);
  expect([card("a1").style.left, card("a1").style.top]).toEqual(["330px", "110px"]);
  expect([card("b1").style.left, card("b1").style.top]).toEqual(["880px", "330px"]);
});

// 저장소처럼 구는 부모 — 저장한 것은 복제해 쥐고, 카메라만 저장하면 '마지막으로 저장한 카드'(복제본)를 돌려준다(lib/scenes.updateScene 과 같다).
let rerenderStore: () => void = noop; // 씬 객체는 그대로 두고 보드만 다시 그린다(목록 밖 데이터 — 생성 결과 — 가 도착했을 때처럼)
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

it("끄는 중 화면 맞춤(F)으로 카메라가 저장돼도, 추가 이동 없이 놓은 자리가 저장된다 — 저장소가 돌려준 옛 카드로 덮이지 않는다", async () => {
  await act(async () => { root.render(<StoreParent cards={[textCard("a1", 110), textCard("b1", 660)]} />); });
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000);
  await key({ key: "f", code: "KeyF" });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await release(700, 150);
  expect([savedX("a1"), savedX("b1")]).toEqual([660, 1210]);
  expect([card("a1").style.left, card("b1").style.left]).toEqual(["660px", "1210px"]);
});

it("한 장만 끄는 평소 길도 같다 — 끄는 중 카메라가 저장돼도 놓은 자리가 저장된다", async () => {
  await act(async () => { root.render(<StoreParent cards={[textCard("a1", 110), textCard("b1", 660)]} />); });
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000); // a1 만 +220
  await key({ key: "f", code: "KeyF" });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await release(370, 150);
  expect([savedX("a1"), savedX("b1")]).toEqual([330, 660]);
  expect(card("a1").style.left).toBe("330px");
});

const undoOnce = () => key({ key: "z", code: "KeyZ", ctrlKey: true });

it("끄는 중에 저장이 끼어도(화면 맞춤으로 카메라 저장) 한 번의 끌기는 되돌리기 한 단계다 — Ctrl+Z 한 번에 끌기 전 자리로", async () => {
  await act(async () => { root.render(<StoreParent cards={[textCard("a1", 110), textCard("b1", 660)]} />); });
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000);
  await key({ key: "f", code: "KeyF" }); // 화면 맞춤 — 카메라를 저장하기 전에 옮긴 자리를 먼저 저장한다
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await release(700, 150);
  expect([savedX("a1"), savedX("b1")]).toEqual([660, 1210]);
  await undoOnce();
  expect([savedX("a1"), savedX("b1")]).toEqual([110, 660]);
  expect([card("a1").style.left, card("b1").style.left]).toEqual(["110px", "660px"]);
});

it("한 장만 끄는 평소 길도 같다 — 끄는 중 화면 맞춤 뒤 더 끌어 놓아도 Ctrl+Z 한 번에 끌기 전 자리로", async () => {
  await act(async () => { root.render(<StoreParent cards={[textCard("a1", 110), textCard("b1", 660)]} />); });
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000);
  await key({ key: "f", code: "KeyF" });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await dragTo(480, 260, 2000); // 카메라가 바뀐 뒤 더 끈다
  await release(480, 260);
  expect(savedX("a1")).not.toBe(110);
  await undoOnce();
  expect([savedX("a1"), savedX("b1")]).toEqual([110, 660]);
});

it("끌기가 끝나면 묶음도 끝난다 — 이어서 한 다음 끌기는 따로 되돌려진다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000);
  await release(370, 150); // a1 → 330
  await grab("a1", 370, 150);
  await dragTo(590, 150, 2000);
  await release(590, 150); // a1 → 550
  expect(savedX("a1")).toBe(550);
  await undoOnce();
  expect(savedX("a1")).toBe(330);
  await undoOnce();
  expect(savedX("a1")).toBe(110);
});

it("끄는 중 줌이 바뀌어도 잡은 자리가 마우스를 따라온다 — 끈 거리를 캔버스 좌표로 잰다", async () => {
  const actionRef = { current: null as { zoomStep: (dir: 1 | -1) => void } | null };
  await act(async () => {
    const scene = { id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: [textCard("a1", 110), textCard("b1", 660)] } as never;
    root.render(<SceneBoard scene={scene} actionRef={actionRef as never} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  const camera = () => {
    const found = /translate[(]([-0-9.]+)px, ([-0-9.]+)px[)] scale[(]([-0-9.]+)[)]/.exec(canvas().style.transform);
    return found ? { x: +found[1], y: +found[2], z: +found[3] } : { x: 0, y: 0, z: 1 };
  };
  const grabbedAt = { x: (150 - camera().x) / camera().z, y: (150 - camera().y) / camera().z }; // 누른 자리의 캔버스 좌표
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000);
  await act(async () => { actionRef.current!.zoomStep(1); frames.splice(0).forEach((cb) => cb(0)); });
  const now = camera();
  expect(now.z).not.toBe(1); // 줌이 바뀌었다
  await dragTo(590, 260, 2000);
  await release(590, 260);
  // 지금 마우스(590,260)의 캔버스 좌표 − 누른 자리의 캔버스 좌표만큼 옮겨져야 한다(격자 22 에 맞춤)
  const snap = (value: number) => Math.round(value / 22) * 22;
  const want = { x: snap(110 + (590 - now.x) / now.z - grabbedAt.x), y: snap(110 + (260 - now.y) / now.z - grabbedAt.y) };
  expect([parseFloat(card("a1").style.left), parseFloat(card("a1").style.top)]).toEqual([want.x, want.y]);
});

it("끄는 중에 전부 지우고 놓아도 되돌리기는 한 단계다 — Ctrl+Z 한 번에 카드와 그룹이 끌기 전 자리로 돌아온다", async () => {
  await twoGroups();
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000);
  await key({ key: "Delete", code: "Delete" });
  expect(host.querySelectorAll(".scene-card").length).toBe(0);
  await dragTo(590, 150, 2000);
  await release(590, 150);
  expect(canvas().style.translate || "").toBe("");
  await undoOnce();
  expect(host.querySelectorAll(".scene-card").length).toBe(2);
  expect([card("a1").style.left, card("b1").style.left]).toEqual(["110px", "660px"]);
  expect(host.querySelectorAll(".scene-group").length).toBe(2);
});

it("보드를 통째로 끄는 중에 줌이 바뀌어도 잡은 자리가 마우스를 따라온다 — 층을 미는 양도 새 줌으로 다시 잰다", async () => {
  const actionRef = { current: null as { zoomStep: (dir: 1 | -1) => void } | null };
  await act(async () => {
    const scene = { id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: [textCard("a1", 110), textCard("b1", 660)] } as never;
    root.render(<SceneBoard scene={scene} actionRef={actionRef as never} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  const camera = () => {
    const found = /translate[(]([-0-9.]+)px, ([-0-9.]+)px[)] scale[(]([-0-9.]+)[)]/.exec(canvas().style.transform);
    return found ? { x: +found[1], y: +found[2], z: +found[3] } : { x: 0, y: 0, z: 1 };
  };
  const grabbedAt = { x: (150 - camera().x) / camera().z, y: (150 - camera().y) / camera().z };
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000);
  expect(canvas().style.translate).toBe("220px 0px");
  await act(async () => { actionRef.current!.zoomStep(1); frames.splice(0).forEach((cb) => cb(0)); });
  const now = camera();
  expect(now.z).not.toBe(1);
  await dragTo(590, 260, 2000);
  const snap = (value: number) => Math.round(value / 22) * 22;
  const moved = { x: snap(110 + (590 - now.x) / now.z - grabbedAt.x) - 110, y: snap(110 + (260 - now.y) / now.z - grabbedAt.y) - 110 };
  expect(canvas().style.translate).toBe(`${moved.x * now.z}px ${moved.y * now.z}px`); // 화면 px = 캔버스 이동량 × 지금 줌
  await release(590, 260);
  expect(canvas().style.translate).toBe("");
  expect([parseFloat(card("a1").style.left), parseFloat(card("a1").style.top)]).toEqual([110 + moved.x, 110 + moved.y]);
  expect([parseFloat(card("b1").style.left), parseFloat(card("b1").style.top)]).toEqual([660 + moved.x, 110 + moved.y]);
});

it("끌기를 놓은 뒤의 편집은 그 끌기와 묶이지 않는다 — 놓고 나서 지운 것을 되돌리면 옮긴 자리에 돌아온다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000);
  await release(370, 150); // a1 → 330
  await selectAll(); // 키보드로 전부 고른다 — 마우스를 다시 누르지 않는다(누르면 새 묶음이 열린다)
  await key({ key: "Delete", code: "Delete" }); // 끌기는 이미 끝났다
  expect(host.querySelectorAll(".scene-card").length).toBe(0);
  await undoOnce();
  expect(host.querySelectorAll(".scene-card").length).toBe(2);
  expect(card("a1").style.left).toBe("330px"); // 지운 것만 되돌아온다 — 끌기까지 되돌아가지 않는다
  await undoOnce();
  expect(card("a1").style.left).toBe("110px");
});

it("그룹 머리를 잡고 끄는 것도 한 번의 끌기다 — 끄는 중 화면 맞춤 뒤 더 끌어 놓아도 Ctrl+Z 한 번에 끌기 전 자리로", async () => {
  await act(async () => {
    root.render(<StoreParent cards={[textCard("a1", 110), textCard("b1", 660)]} groups={[{ id: "gA", name: "A", cardIds: ["a1"], rect: { x: 66, y: 44, w: 330, h: 330 } }]} />);
  });
  const head = () => host.querySelector<HTMLElement>('.scene-group[data-group-id="gA"] .scene-group-grab')!;
  await act(async () => { head().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 100, clientY: 50 })); });
  await dragTo(320, 50, 2000); // +220
  expect(shownAt("a1")).toEqual([330, 110]);
  await key({ key: "f", code: "KeyF" });
  await act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
  await dragTo(430, 160, 2000);
  await release(430, 160);
  expect(savedX("a1")).not.toBe(110);
  await undoOnce();
  expect([savedX("a1"), savedX("b1")]).toEqual([110, 660]);
  expect(rectX("gA")).toBe(66);
});

it("그룹 머리를 잡고 끄는 중에 줌이 바뀌어도 잡은 자리가 마우스를 따라온다 — 카드 끌기와 같이 캔버스 좌표로 잰다", async () => {
  const actionRef = { current: null as { zoomStep: (dir: 1 | -1) => void } | null };
  await act(async () => {
    const scene = {
      id: "S", name: "S", created_at: 0, edges: [], cards: [textCard("a1", 110), textCard("b1", 660)],
      groups: [{ id: "gA", name: "A", cardIds: ["a1"], rect: { x: 66, y: 44, w: 330, h: 330 } }],
    } as never;
    root.render(<SceneBoard scene={scene} actionRef={actionRef as never} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  const camera = () => {
    const found = /translate[(]([-0-9.]+)px, ([-0-9.]+)px[)] scale[(]([-0-9.]+)[)]/.exec(canvas().style.transform);
    return found ? { x: +found[1], y: +found[2], z: +found[3] } : { x: 0, y: 0, z: 1 };
  };
  const grabbedAt = { x: (100 - camera().x) / camera().z, y: (50 - camera().y) / camera().z };
  const head = host.querySelector<HTMLElement>('.scene-group[data-group-id="gA"] .scene-group-grab')!;
  await act(async () => { head.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 100, clientY: 50 })); });
  await dragTo(320, 50, 2000);
  await act(async () => { actionRef.current!.zoomStep(1); frames.splice(0).forEach((cb) => cb(0)); });
  const now = camera();
  expect(now.z).not.toBe(1);
  await dragTo(540, 160, 2000);
  await release(540, 160);
  const snap = (value: number) => Math.round(value / 22) * 22;
  const want = { x: snap(110 + (540 - now.x) / now.z - grabbedAt.x), y: snap(110 + (160 - now.y) / now.z - grabbedAt.y) };
  expect([parseFloat(card("a1").style.left), parseFloat(card("a1").style.top)]).toEqual([want.x, want.y]);
  expect(card("b1").style.left).toBe("660px"); // 그룹 밖 카드는 그대로
});

// ── 7회차 ──
// 손을 뗀 것을 놓친 끌기(R33) — mouseup 이 오지 않으면(창 밖에서 뗌·브라우저가 삼킴) 단추를 뗀 마우스를 카드가 따라오고, '끄는 중' 표시와
//  되돌리기·묶기·정렬 잠금이 다음 mouseup 까지 남았다. 단추를 다 뗀 채 온 첫 움직임에서 끝낸다(창을 떠날 때와 같은 끝맺음).
const board = () => host.querySelector<HTMLElement>(".scene-board")!;
const grabHead = (groupId: string, x: number, y: number) => act(async () => {
  host.querySelector<HTMLElement>(`.scene-group[data-group-id="${groupId}"] .scene-group-hd`)!
    .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: y }));
});
const redoOnce = () => key({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true });

it("손을 뗀 것을 놓친 카드 끌기는 단추를 뗀 채 움직이는 순간 끝난다 — 카드가 마우스를 따라오지 않고, 끄는 중 표시와 되돌리기 잠금이 풀린다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000); // a1 → 330. mouseup 은 오지 않는다
  expect(board().classList.contains("dragging")).toBe(true);
  await hoverTo(700, 400);
  expect([card("a1").style.left, card("a1").style.top]).toEqual(["330px", "110px"]); // 단추를 뗀 마우스를 따라오지 않는다
  expect(board().classList.contains("dragging")).toBe(false);
  expect(savedX("a1")).toBe(330); // 놓은 것으로 확정됐다
  await hoverTo(900, 500);
  expect(card("a1").style.left).toBe("330px");
  await undoOnce(); // 잠금(누르고 있는 동안의 되돌리기 막기)이 남아 있으면 먹지 않는다
  expect(card("a1").style.left).toBe("110px");
});

// 2026-10-11 격리 실측(dist_b46) 5/5: 첫 이동이 프레임을 기다리는 사이 같은 카드(나 같이 고른 카드)를 다시 누르면, 새 끌기가 시작 좌표를
//  읽은 뒤에야 앞 끌기의 걸음이 반영돼 — 둘째 끌기가 움직이는 순간 앞 끌기의 이동이 통째로 사라졌다(끝 (198,132), 기대 (462,308)).
it("손을 뗀 것을 놓친 끌기의 밀린 걸음이 남은 채 같은 카드를 다시 잡아도 앞의 이동이 사라지지 않는다 — 새 누름이 앞 끌기를 먼저 끝낸다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  await grab("a1", 150, 150);
  await act(async () => { // +220 — 프레임이 돌기 전(밀린 걸음). mouseup 은 오지 않는다
    clock += 2000;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 370, clientY: 150, buttons: 1 }));
  });
  expect(card("a1").style.left).toBe("110px"); // 아직 반영 전
  await act(async () => { // 다시 잡는다 — 눌린 단추는 이것 하나뿐(buttons 1)
    card("a1").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1, clientX: 370, clientY: 150 }));
  });
  expect(card("a1").style.left).toBe("330px"); // 누름의 첫머리에서 앞 끌기가 끝났다 — 새 끌기는 이 자리에서 출발한다
  await dragTo(480, 150, 2000); // +110
  await release(480, 150);
  expect([card("a1").style.left, savedX("a1")]).toEqual(["440px", 440]);
  await undoOnce(); // 두 끌기는 따로 되돌려진다
  expect(card("a1").style.left).toBe("330px");
  await undoOnce();
  expect(card("a1").style.left).toBe("110px");
});

it("그룹 머리를 끌다 놓친 채(밀린 걸음) 같은 머리를 다시 잡아도 같다 — 네모도 카드와 같은 자리에서 출발한다(네모의 ref 가 바로 맞는다)", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], [{ id: "gA", name: "A", cardIds: ["a1"], rect: { x: 66, y: 44, w: 330, h: 330 } }]);
  const head = () => host.querySelector<HTMLElement>('.scene-group[data-group-id="gA"] .scene-group-hd')!;
  await grabHead("gA", 100, 50);
  await act(async () => { // +220 — 프레임이 돌기 전(밀린 걸음). mouseup 은 오지 않는다
    clock += 2000;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 320, clientY: 50, buttons: 1 }));
  });
  await act(async () => { // 같은 머리를 다시 잡는다
    head().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1, clientX: 320, clientY: 50 }));
  });
  await dragTo(430, 50, 2000); // +110
  await release(430, 50);
  expect([card("a1").style.left, savedX("a1")]).toEqual(["440px", 440]);
  expect(rectX("gA")).toBe(396); // 66 + 220 + 110 — 한 걸음 전의 네모(66)에서 출발하면 176 이 된다
});

it("그룹을 끌다 놓친 채(밀린 걸음) 다른 카드를 잡아 그 그룹의 **옛 자리**에 놓아도 편입되지 않는다 — 재배정의 기준 틀을 누르는 순간에 다시 잰다", async () => {
  // gA 틀 x 66..396 → +440 옮겨 506..836. 그룹 밖 카드 c1 을 옛 자리(가운데 231)에 놓는다 — 렌더가 잡아 둔 옛 틀로 보면 gA 에 들어간다.
  await show(
    [textCard("a1", 110), textCard("c1", 1100)],
    [{ id: "gA", name: "A", cardIds: ["a1"], rect: { x: 66, y: 44, w: 330, h: 330 } }],
  );
  await grabHead("gA", 100, 50);
  await act(async () => { // +440 — 프레임이 돌기 전(밀린 걸음). mouseup 은 오지 않는다
    clock += 2000;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 540, clientY: 50, buttons: 1 }));
  });
  await act(async () => { // 그룹 밖 카드를 잡는다
    card("c1").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1, clientX: 1150, clientY: 150 }));
  });
  await dragTo(204, 150, 2000); // c1 → x 154(가운데 230) = gA 의 옛 자리 안
  await release(204, 150);
  expect(card("a1").style.left).toBe("550px"); // 앞의 그룹 끌기는 확정됐다
  expect(card("c1").style.left).toBe("154px");
  expect(members()).toEqual({ gA: ["a1"] }); // 옛 자리에 놓은 카드는 편입되지 않는다
});

it("네모 없는 자동 그룹을 끌다 놓친 채(밀린 걸음) 그 그룹의 크기 손잡이를 잡았다 놓아도, 옛 틀이 아니라 옮겨 간 틀이 네모로 저장된다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], [{ id: "gB", name: "B", cardIds: ["b1"] }]);
  const groupEl = () => host.querySelector<HTMLElement>('.scene-group[data-group-id="gB"]')!;
  const frameX0 = parseFloat(groupEl().style.left); // 끌기 전 틀(멤버에서 계산)
  await grabHead("gB", 700, 60);
  await act(async () => { // +220 — 프레임이 돌기 전(밀린 걸음). mouseup 은 오지 않는다
    clock += 2000;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 920, clientY: 60, buttons: 1 }));
  });
  await act(async () => { // 크기 손잡이를 누른다 — 이 누름이 앞 끌기를 끝낸다
    groupEl().querySelector<HTMLElement>(".scene-group-resize")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 1200, clientY: 400 }));
  });
  await release(1200, 400); // 끌지 않고 놓는다 — 지금의 틀이 수동 네모가 된다
  expect(card("b1").style.left).toBe("880px");
  expect(rectX("gB")).toBe(frameX0 + 220);
});

it("가운데 단추로 판을 밀다(밀린 걸음) 왼쪽으로 카드를 잡아도 밀린 화면 이동이 카드 이동량에 섞이지 않는다 — 누름의 첫머리에서 판 밀기가 먼저 끝난다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  await act(async () => { // 가운데 단추로 판을 민다
    board().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1, buttons: 4, clientX: 500, clientY: 400 }));
  });
  await act(async () => { // +200 — 프레임이 돌기 전(밀린 걸음)
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 700, clientY: 400, buttons: 4 }));
  });
  await act(async () => { // 가운데를 누른 채 왼쪽으로 카드를 잡는다(buttons 5)
    card("a1").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 5, clientX: 150, clientY: 150 }));
  });
  await dragTo(260, 150, 2000); // 화면에서 +110
  await release(260, 150);
  expect(card("a1").style.left).toBe("220px"); // 110 + 110 — 밀린 판 이동(+200)이 섞이면 다른 값이 된다
});

it("전부 고르고 끌다 손을 뗀 것을 놓쳐도 같다 — 층에만 밀어 둔 이동이 좌표에 들어가고 층이 제자리로 돌아온다", async () => {
  await twoGroups();
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000); // +550 — 좌표는 그대로, 캔버스 층만 밀려 있다
  expect(canvas().style.translate).toBe("550px 0px");
  await hoverTo(900, 400);
  expect(canvas().style.translate).toBe("");
  expect(canvas().hasAttribute("data-layer-move")).toBe(false);
  expect([card("a1").style.left, card("b1").style.left]).toEqual(["660px", "1210px"]);
  expect([savedX("a1"), savedX("b1")]).toEqual([660, 1210]);
  expect([rectX("gA"), rectX("gB")]).toEqual([616, 1166]);
  await hoverTo(1000, 500);
  expect(canvas().style.translate).toBe("");
  await undoOnce();
  expect([card("a1").style.left, card("b1").style.left]).toEqual(["110px", "660px"]);
});

it("그룹 머리를 잡고 끌다 손을 뗀 것을 놓쳐도 같다 — 단추를 뗀 채 움직이면 그 자리에서 끝나고 되돌리기가 먹는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], [{ id: "gA", name: "A", cardIds: ["a1"], rect: { x: 66, y: 44, w: 330, h: 330 } }]);
  await grabHead("gA", 100, 50);
  await dragTo(320, 50, 2000); // +220
  expect(shownAt("a1")).toEqual([330, 110]);
  await hoverTo(700, 400);
  expect(card("a1").style.left).toBe("330px");
  expect(board().classList.contains("dragging")).toBe(false);
  expect([savedX("a1"), rectX("gA")]).toEqual([330, 286]);
  await undoOnce();
  expect([card("a1").style.left, rectX("gA")]).toEqual(["110px", 66]);
});

it("범위 선택·화면 이동도 같은 끝맺음을 쓴다 — 단추를 뗀 채 움직이면 사각형이 걷히고 화면이 더 끌려가지 않는다(가운데 단추로 미는 동안은 끊기지 않는다)", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  const marquee = () => host.querySelector<HTMLElement>(".scene-marquee")!;
  await act(async () => { board().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 })); });
  await dragTo(500, 400, 2000);
  expect(marquee().hidden).toBe(false);
  await hoverTo(600, 500);
  expect(marquee().hidden).toBe(true);
  // 가운데 단추로 화면을 미는 동안의 움직임은 buttons 가 4 다 — 왼쪽 단추(1)만 보고 '뗐다'고 하면 화면 이동이 첫 걸음에 끊긴다
  await act(async () => { board().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1, clientX: 100, clientY: 100 })); });
  await act(async () => {
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 150, clientY: 130, buttons: 4 }));
    frames.splice(0).forEach((cb) => cb(0));
  });
  expect(board().classList.contains("panning")).toBe(true);
  expect(canvas().style.transform).toContain("translate(50px, 30px)");
  await hoverTo(400, 400); // 가운데 단추를 뗀 것을 놓쳤다
  expect(board().classList.contains("panning")).toBe(false);
  expect(canvas().style.transform).toContain("translate(50px, 30px)");
});

// 끄는 동안의 포인터(7회차 R2-a) — 전엔 `.scene-board.dragging .scene-card { pointer-events: none }` 이 끄는 동안 카드를 마우스에서
//  떼어 놓았다(겹친 뒤 카드의 hover·포트가 끄는 카드 위로 튀어나오지 않게. 덤으로 놓을 때의 click 도 카드 안으로 가지 않았다).
//  그 한 줄이 끌기의 시작과 끝마다 6천여 요소의 스타일을 다시 계산했다(2026-10-11 실측 40~55ms). 같은 일을 스타일 없이 한다:
//  끄는 동안의 포인터를 보드가 쥐고(포인터 캡처 — hover·이벤트가 보드로 간다), 놓은 뒤의 click 은 한 번 삼킨다.
const pressOn = (target: Element, x: number, y: number, pointerId: number) => act(async () => {
  target.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { pointerId }));
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: y }));
});
// jsdom 에는 포인터 캡처가 없다 — 어느 요소가 어느 포인터를 쥐고 놓는지만 적는다
function recordPointerCapture() {
  const held: [Element, number][] = [];
  const let_go: [Element, number][] = [];
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture = function (this: Element, id: number) { held.push([this, id]); };
  proto.releasePointerCapture = function (this: Element, id: number) { let_go.push([this, id]); };
  return { held, let_go, restore: () => { delete proto.setPointerCapture; delete proto.releasePointerCapture; } };
}

it("4px 넘게 끌기 시작하면 그 포인터를 보드가 쥔다 — 누르기만 한 것은 쥐지 않고, 걸음마다 다시 쥐지 않는다(카드·그룹 머리 둘 다)", async () => {
  const pointer = recordPointerCapture();
  try {
    await show([textCard("a1", 110), textCard("b1", 660)], [{ id: "gB", name: "B", cardIds: ["b1"], rect: { x: 616, y: 44, w: 330, h: 330 } }]);
    await pressOn(card("a1"), 150, 150, 7);
    await dragTo(152, 151, 10); // 4px 안 — 아직 끌기가 아니다(클릭일 수 있다)
    expect(pointer.held).toEqual([]);
    await dragTo(370, 150, 2000);
    expect(pointer.held).toEqual([[board(), 7]]);
    await dragTo(590, 150, 2000);
    expect(pointer.held.length).toBe(1);
    await release(590, 150);
    expect(pointer.let_go).toEqual([[board(), 7]]);

    await pressOn(card("a1"), 590, 150, 9); // 누르기만 하고 뗀다 — 쥘 것도 놓을 것도 없다
    await release(590, 150);
    expect([pointer.held.length, pointer.let_go.length]).toEqual([1, 1]);

    const head = host.querySelector<HTMLElement>('.scene-group[data-group-id="gB"] .scene-group-hd')!;
    // 놓는 것과 그 뒤의 click 을 브라우저처럼 한 작업 안에서 보낸다 — 삼켰는지(기본 동작을 막았는지) 돌려준다
    const releaseOnHead = (x: number) => {
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      act(() => {
        window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: x, clientY: 50 }));
        head.dispatchEvent(click);
      });
      return click.defaultPrevented;
    };
    await pressOn(head, 700, 50, 11);
    await dragTo(920, 50, 2000);
    expect(pointer.held[1]).toEqual([board(), 11]);
    expect(releaseOnHead(920)).toBe(true); // 끌어 놓은 뒤의 click 은 삼킨다(카드 끌기와 같다)
    expect(pointer.let_go[1]).toEqual([board(), 11]);
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    await pressOn(head, 920, 50, 12); // 그룹 머리를 누르기만 했다 — 그 click 은 그대로 간다
    expect(releaseOnHead(920)).toBe(false);
    expect(pointer.held.length).toBe(2);
  } finally {
    pointer.restore();
  }
});

// Codex 1단계 리뷰(P3): 쥔 포인터가 끝난 끌기 뒤에 남는 길이 있었다 — 왼쪽으로 끄는 중에 오른쪽 단추를 눌렀다 놓으면 세션은 그
//  mouseup 으로 끝나는데 캡처는 왼쪽을 뗄 때까지 남았고, 씬 전환·화면 내려감은 취소 콜백 없이 세션만 버려서 놓지 않았다.
it("끌기가 어느 길로 끝나든 쥔 포인터를 놓는다 — 다른 단추의 mouseup·창 떠남·놓친 mouseup·다음 끌기·씬 전환·화면이 내려감", async () => {
  const pointer = recordPointerCapture();
  try {
    const open = (id: string) => act(async () => {
      const scene = { id, name: id, created_at: 0, edges: [], groups: [], cards: [textCard("a1", 110), textCard("b1", 660)] } as never;
      root.render(<SceneBoard scene={scene} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
    });
    await open("S");
    // 포인터 pointerId 로 a1 을 +220 끌어 쥐게 한다(끝내지는 않는다)
    const dragHolding = async (pointerId: number) => {
      const x = parseFloat(card("a1").style.left) + 40;
      await pressOn(card("a1"), x, 150, pointerId);
      await dragTo(x + 220, 150, 2000);
      expect(pointer.held.at(-1), `쥠 ${pointerId}`).toEqual([board(), pointerId]);
      return x + 220;
    };
    const lastLetGo = () => pointer.let_go.at(-1);

    // 왼쪽으로 끄는 중에 오른쪽 단추를 눌렀다 놓는다 — 세션은 그 mouseup 으로 끝난다(왼쪽은 아직 눌려 있어 브라우저는 스스로 놓지 않는다)
    let x = await dragHolding(1);
    await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { button: 2, buttons: 1, clientX: x, clientY: 150 })); });
    expect(lastLetGo()).toEqual([board(), 1]);

    x = await dragHolding(2);
    await act(async () => { window.dispatchEvent(new Event("blur")); }); // 창을 떠났다
    expect(lastLetGo()).toEqual([board(), 2]);

    await dragHolding(3);
    await hoverTo(1500, 600); // 손을 뗀 것을 놓쳤다(단추를 다 뗀 채 움직임)
    expect(lastLetGo()).toEqual([board(), 3]);

    await dragHolding(4);
    await pressOn(card("b1"), 700, 150, 5); // 끝나지 않은 끌기 위에 다음 누름 — 앞 끌기를 닫는다
    expect(lastLetGo()).toEqual([board(), 4]);
    await release(700, 150);

    await dragHolding(6);
    const before = pointer.let_go.length;
    await open("T"); // 끄는 중에 씬이 바뀌었다 — 끌기는 취소 콜백 없이 버려진다
    expect(pointer.let_go.slice(before)).toEqual([[board(), 6]]);

    await dragHolding(7);
    const boardEl = board();
    act(() => root.unmount()); // 끄는 중에 화면이 내려갔다
    expect(lastLetGo()).toEqual([boardEl, 7]);
    root = createRoot(host); // afterEach 가 내릴 뿌리
  } finally {
    pointer.restore();
  }
});

it("끌어 놓은 뒤에 따라오는 click 은 카드 안으로 가지 않는다 — 리스트의 행을 잡고 끌어도 행 선택이 바뀌지 않는다(끌지 않은 클릭은 그대로 먹는다)", async () => {
  const genCard = (id: string, y: number) => ({ id, kind: "generation", x: 110, y });
  await act(async () => {
    const scene = {
      id: "S", name: "S", created_at: 0, groups: [],
      cards: [genCard("g1", 110), genCard("g2", 330), { id: "L", kind: "list", x: 660, y: 110 }],
      edges: [{ id: "e1", from: "g1", to: "L" }, { id: "e2", from: "g2", to: "L" }],
    } as never;
    root.render(<SceneBoard scene={scene} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  const row = () => host.querySelector<HTMLElement>('.scene-listrow[data-reid="g1"]')!;
  const picked = () => row().classList.contains("selrow");
  // 브라우저는 누른 요소와 뗀 요소가 같으면 mouseup 에 이어 **같은 작업 안에서** click 을 보낸다 — 끄는 카드는 마우스를 따라와 늘 같은 요소다
  const releaseOnRow = (x: number, y: number, ctrlKey = false) => {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey });
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: x, clientY: y }));
      row().dispatchEvent(click);
    });
    return click;
  };
  const nextTask = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });

  await pressOn(row(), 700, 150, 1); // 끌지 않은 클릭 — 행이 골라진다
  expect(releaseOnRow(700, 150).defaultPrevented).toBe(false);
  expect(picked()).toBe(true);
  await nextTask();

  await pressOn(row(), 700, 150, 1); // 행을 잡고 리스트 카드를 끌어 놓는다
  await dragTo(920, 150, 2000);
  expect(releaseOnRow(920, 150).defaultPrevented).toBe(true); // 삼켰다
  expect(card("L").style.left).toBe("880px");
  expect(picked()).toBe(true); // 행 선택이 뒤집히지 않았다

  await nextTask(); // 삼키는 것은 그 놓기에 딸린 click 한 번뿐이다 — 다음 클릭(Ctrl = 골라진 행 빼기)은 다시 먹는다
  await pressOn(row(), 920, 150, 1);
  expect(releaseOnRow(920, 150, true).defaultPrevented).toBe(false);
  expect(picked()).toBe(false);

  await pressOn(row(), 920, 150, 1); // 끌어 놓았는데 click 이 오지 않은 경우(뗀 자리가 다른 요소였다) — 삼킬 것을 다음 작업에서 거둔다
  await dragTo(1140, 150, 2000);
  await release(1140, 150);
  await nextTask();
  await pressOn(row(), 1140, 150, 1);
  expect(releaseOnRow(1140, 150).defaultPrevented).toBe(false); // 한참 뒤의 클릭을 삼키지 않는다
  expect(picked()).toBe(true);
});

// 2026-10-12 격리 실측(두 빌드 20/20·19/20): 카드를 끌어 놓자마자 누른 씬 탭 세 번이 전부 안 먹었다 — 삼키는 리스너가 타이머가 돌 때까지
//  남아 그 사이의 click 을 전부 삼켰다(입력은 타이머보다 먼저 처리된다 — 놓은 직후 화면을 다시 그리느라 바쁜 큰 씬에서는 손으로도 닿는다).
it("끌어 놓은 직후(다음 작업이 돌기 전) 이어서 누른 것은 삼키지 않는다 — 삼키는 것은 그 놓기에 딸린 click 한 번이고, 새 누름이 시작되면 끝난다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  const outside = document.createElement("button");
  document.body.append(outside);
  let got = 0;
  outside.addEventListener("click", () => { got += 1; });
  const clickOutside = () => {
    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  };
  try {
    await grab("a1", 150, 150);
    await dragTo(370, 150, 2000);
    const own = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => { // 놓기 + 딸린 click + 키보드로 누른 단추(누름 없이 click 만) + 마우스로 두 번 — 전부 한 작업 안에서(타이머는 아직 안 돌았다)
      window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 370, clientY: 150 }));
      board().dispatchEvent(own);
      outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      clickOutside();
      clickOutside();
    });
    expect([own.defaultPrevented, got]).toEqual([true, 3]);
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

    // 놓기에 click 이 딸려 오지 않았을 때(뗀 자리가 다른 요소였다) — 타이머가 돌기 전의 새 누름과 그 click 도 삼키지 않는다
    got = 0;
    await grab("a1", 370, 150);
    await dragTo(590, 150, 2000);
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: 590, clientY: 150 }));
      clickOutside();
    });
    expect([got, card("a1").style.left]).toEqual([1, "550px"]);
  } finally {
    outside.remove();
  }
});

// 접힌 그룹 이동과 실행 취소·다시 실행(R5) — 접힌 그룹의 멤버는 화면에 없다(막대만 보인다). 좌표는 저장된 값으로 본다.
it("접힌 그룹을 머리로 끌어 옮기고 실행 취소·다시 실행 — 숨은 멤버의 좌표와 수동 그룹의 네모가 함께 오간다(네모 있는 그룹·없는 그룹 둘 다)", async () => {
  await act(async () => {
    root.render(<StoreParent
      cards={[textCard("m1", 110), textCard("m2", 110, 264), textCard("a1", 660), textCard("a2", 660, 264), textCard("f1", 1210)]}
      groups={[
        { id: "gM", name: "M", cardIds: ["m1", "m2"], collapsed: true, rect: { x: 66, y: 44, w: 330, h: 400 } },
        { id: "gA", name: "A", cardIds: ["a1", "a2"], collapsed: true },
      ]}
    />);
  });
  expect(host.querySelectorAll(".scene-group.collapsed").length).toBe(2);
  expect(host.querySelector('.scene-card[data-id="m1"]')).toBeNull(); // 접힌 그룹의 멤버는 그리지 않는다
  const at = (id: string) => { const found = savedCards().find((item) => item.id === id); return found ? [found.x, found.y] : null; };
  const state = () => ({ m1: at("m1"), m2: at("m2"), a1: at("a1"), a2: at("a2"), f1: at("f1"), gM: [rectX("gM"), rectY("gM")] });
  const start = { m1: [110, 110], m2: [110, 264], a1: [660, 110], a2: [660, 264], f1: [1210, 110], gM: [66, 44] };
  const movedM = { ...start, m1: [330, 110], m2: [330, 264], gM: [286, 44] };
  const movedBoth = { ...movedM, a1: [660, 330], a2: [660, 484] };

  await grabHead("gM", 100, 50);
  await dragTo(320, 50, 2000); // 네모 있는 그룹을 +220 옆으로
  await release(320, 50);
  expect(state()).toEqual(movedM);
  await grabHead("gA", 700, 100);
  await dragTo(700, 320, 2000); // 네모 없는 그룹을 +220 아래로
  await release(700, 320);
  expect(state()).toEqual(movedBoth);
  expect(groups().map((group) => [group.id, group.cardIds, !!(group as { collapsed?: boolean }).collapsed]))
    .toEqual([["gM", ["m1", "m2"], true], ["gA", ["a1", "a2"], true]]);

  await undoOnce();
  expect(state()).toEqual(movedM);
  await undoOnce();
  expect(state()).toEqual(start);
  await redoOnce();
  expect(state()).toEqual(movedM);
  await redoOnce();
  expect(state()).toEqual(movedBoth);
  expect(host.querySelectorAll(".scene-group.collapsed").length).toBe(2); // 접힌 채로 오간다
  expect(groups().find((group) => group.id === "gA")?.rect).toBeUndefined(); // 네모 없는 그룹에 네모가 생기지 않는다
});

// 카드 끌기의 되감기 배선(R32) — 끄는 중에 낀 파생 저장(되돌리기 단계를 만들지 않는 저장)이 '마지막 저장분'의 좌표를 옮기던 자리로 바꿔 놓는다.
//  놓을 때 쌓는 되돌리기 단계는 그 좌표를 끌기 전으로 되감아야 한다(useSceneCardMove 가 beginGesture 에 넘기는 rewindSceneMove).
it("실제 보드에서: 끄는 중에 파생 저장(늦게 온 생성 결과가 연결 레퍼런스를 채움)이 끼어도 Ctrl+Z 는 끌기 전 자리로 간다 — 파생 값은 남는다", async () => {
  const genCard = (id: string, x: number, extra: object = {}) => ({ id, kind: "generation", x, y: 110, ...extra });
  await act(async () => {
    root.render(<StoreParent
      cards={[genCard("src", 110, { genId: "g1", genIds: ["g1"] }), genCard("dst", 660)]}
      edges={[{ id: "e1", from: "src", to: "dst" }]}
    />);
  });
  const refsOf = (id: string) => ((savedCards().find((item) => item.id === id) as { refs?: unknown[] } | undefined)?.refs ?? []);
  const derivedSaves = () => patches.filter((patch) => "cards" in patch).length;
  expect(derivedSaves()).toBe(0); // 전제: 생성 결과가 아직 없어 채울 레퍼런스가 없다
  await grab("dst", 700, 150);
  await dragTo(920, 150, 2000); // dst → 880
  expect(shownAt("dst")).toEqual([880, 110]);
  // 끄는 중에 src 의 생성 결과가 도착한다 → dst 의 연결 레퍼런스가 채워지고 파생 저장이 난다(좌표는 옮기던 자리)
  const g1 = {
    id: "g1", status: "done", prompt: "g1", tags: [], auto_tags: [], references: [], shared: false, deleted: false, is_mine: true,
    comment_count: 0, has_unread: false, created_at: "2026-10-11 00:00:00", sort_ts: 1,
    assets: [{ id: "asset-g1", generation_id: "g1", type: "image", file_path: "/g1.png", thumbnail_path: null, source_url: null, cached: true }],
  };
  fixture.data = { ...fixture.data, genData: { g1 }, genDataRef: { current: { g1 } } } as unknown as SceneGenDataApi;
  await act(async () => { rerenderStore(); });
  expect(derivedSaves()).toBe(1);
  expect([savedX("dst"), refsOf("dst").length]).toEqual([880, 1]);
  await dragTo(1030, 150, 2000); // 더 끌어
  await release(1030, 150); // 놓는다
  expect(savedX("dst")).toBe(990);
  await undoOnce();
  expect(savedX("dst")).toBe(660); // 끌기 전 — 파생 저장이 난 중간 자리(880)가 아니다
  expect(card("dst").style.left).toBe("660px");
  expect(refsOf("dst").length).toBe(1); // 파생 저장이 넣은 값은 남는다
});

// ── 여러 장을 고른 끌기의 빠른 그리기(7회차 3·4단계) — 좌표는 지금처럼 걸음마다 넣는다. 그리는 방법만 바꾼다 ──
// 2026-10-11 격리 실측: 412장 씬에서 158장을 끌면 화면 갱신이 초당 12~13번이었다(걸음 80ms = 레이어 정리 32 + React 18~20 + 다시 칠하기 22).
//  카드의 left/top 을 걸음마다 써서 레이아웃·다시 칠하기·레이어 정리가 매번 돌았다. 끄는 동안 카드의 **바깥 틀**은 left/top 을 끌기 전
//  자리에 두고 translate(= 지금 좌표 − 끌기 전 자리, 캔버스 좌표 그대로)로 옮긴다. 표식(data-layer-move)이 붙은 요소에는 값 0 의 덧셈
//  애니메이션이 걸려(styles/scene.css) 브라우저가 합성기만으로 민다. 좌표·저장·되돌리기·이탈·재배정은 전과 같다 — 위의 시험들이 지킨다.
// 켜는 조건(첫 걸음에 한 번): 끄는 카드가 40장 이상이고 **전부 골라져 있다** · 화면 배율 30% 이상 · 모니터 배율 1 · 카드를 잡은 끌기
//  (그룹 머리 끌기·한 장·판 밀기는 전의 길). 근거는 같은 실측 — 40장 아래는 이득 없이 레이어만 늘고, 배율 25% 아래에서는 끄는 카드가
//  흐려지고, 고르지 않은 채 끄는 카드는 배지·포트의 위아래가 달라진다.
// 끄는 조건: 끄는 중에 선택이 풀리거나 배율·모니터 배율이 조건을 벗어나면 **그 갱신에서** 원래 그리기로 돌아가고, 그 끌기에서는 다시
//  켜지 않는다. 좌표는 걸음마다 들어가 있으므로 끌기는 그대로 이어진다.
/** 바깥 틀이 쥔 값 그대로: [left, top, translate, 표식]. */
const outer = (id: string) => [card(id).style.left, card(id).style.top, card(id).style.translate || "", card(id).hasAttribute("data-layer-move")];
/** 끄는 표시(표식·translate)가 남아 있는 카드. */
const marked = () => [...host.querySelectorAll<HTMLElement>(".scene-card")]
  .filter((el) => el.hasAttribute("data-layer-move") || !!el.style.translate).map((el) => el.dataset.id);
/** 고를 카드 n 장(p0 … — 가로로 10장씩, 220 간격)과 고르지 않을 한 장(z). p0 = (110,110). */
const manyCards = (n: number) => [
  ...Array.from({ length: n }, (_, i) => textCard(`p${i}`, 110 + (i % 10) * 220, 110 + Math.floor(i / 10) * 220)),
  textCard("z", 110, 2420),
];
const ctrlClick = async (id: string) => {
  await grab(id, 5, 5, true);
  await release(5, 5);
};
/** 보드의 카드를 전부 고른 뒤 z 만 뺀다 — p 들만 골라진다(전부 고르면 판 밀기라 이 길이 아니다). */
const pickAllButZ = async () => {
  await selectAll();
  await ctrlClick("z");
};
/** 범위 선택으로 카드와 (통째로 감싼) 그룹을 함께 고른다 — Ctrl+A 는 그룹 선택을 푼다. */
const marqueeAll = async () => {
  await act(async () => { board().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 1, clientY: 1 })); });
  await dragTo(9000, 9000, 2000);
  await release(9000, 9000);
};
const groupPicked = (id: string) => host.querySelector(`.scene-group[data-group-id="${id}"]`)?.classList.contains("selected");

it("고른 카드 40장을 끄는 동안 카드의 바깥 틀은 끌기 전 자리에 두고 translate 로 옮긴다 — 표식이 붙고, 놓으면 새 좌표가 되며 둘 다 빠진다", async () => {
  await show(manyCards(40), []);
  await pickAllButZ();
  await grab("p0", 150, 150);
  await dragTo(152, 151, 10); // 4px 안 — 아직 끌기가 아니다
  expect(marked()).toEqual([]);
  await dragTo(370, 150, 2000); // +220
  expect(marked().length).toBe(40);
  expect([outer("p0"), outer("p39")]).toEqual([["110px", "110px", "220px 0px", true], ["2090px", "770px", "220px 0px", true]]);
  expect(outer("z")).toEqual(["110px", "2420px", "", false]); // 안 끄는 카드에는 아무것도 없다
  await dragTo(590, 260, 2000); // +440, +110 — left/top 은 그대로, translate 만 바뀐다
  expect([outer("p0"), outer("p39")]).toEqual([["110px", "110px", "440px 110px", true], ["2090px", "770px", "440px 110px", true]]);
  await dragTo(150, 150, 2000); // 시작 자리로 — 이동량이 0 이어도 끄는 동안에는 표식을 둔다(레이어를 걸음마다 만들고 없애지 않게)
  expect(outer("p0")).toEqual(["110px", "110px", "0px 0px", true]);
  await dragTo(370, 150, 2000);
  await release(370, 150);
  expect(marked()).toEqual([]);
  expect([outer("p0"), outer("p39"), outer("z")]).toEqual([["330px", "110px", "", false], ["2310px", "770px", "", false], ["110px", "2420px", "", false]]);
  expect([savedX("p0"), savedX("p39")]).toEqual([330, 2310]);
});

it("고른 카드가 40장이 안 되면 전의 길이다 — 39장은 걸음마다 left/top 으로 옮긴다", async () => {
  await show(manyCards(39), []);
  await pickAllButZ();
  await grab("p0", 150, 150);
  await dragTo(370, 150, 2000);
  expect(marked()).toEqual([]);
  expect([outer("p0"), outer("p38")]).toEqual([["330px", "110px", "", false], ["2090px", "770px", "", false]]);
  await release(370, 150);
  expect([savedX("p0"), savedX("p38")]).toEqual([330, 2090]);
});

it("고르지 않은 카드가 하나라도 같이 끌리면 켜지 않는다 — 고른 그룹의 안 고른 멤버", async () => {
  await show(manyCards(41), [{ id: "gA", name: "A", cardIds: ["p0", "p1"], rect: { x: 66, y: 44, w: 520, h: 330 } }]);
  await marqueeAll();
  await ctrlClick("p1"); // 그룹 멤버 p1 을 선택에서 뺀다 — 그룹은 고른 채다
  await ctrlClick("z");
  expect([groupPicked("gA"), card("p0").classList.contains("sel"), card("p1").classList.contains("sel")]).toEqual([true, true, false]);
  await grab("p0", 150, 150);
  await dragTo(370, 150, 2000);
  expect(shownAt("p1")).toEqual([550, 110]); // 고르지 않은 p1 도 고른 그룹과 같이 끌린다(끄는 카드 41장 중 40장만 골라져 있다)
  expect(marked()).toEqual([]);
  expect(outer("p0")).toEqual(["330px", "110px", "", false]);
  await release(370, 150);
  expect(savedX("p1")).toBe(550);
});

it("한 장을 잡아 끌 때는 켜지 않는다 — 고르지 않은 카드든 혼자 고른 카드든", async () => {
  await show(manyCards(40), []);
  await grab("z", 150, 2460); // 고르지 않은 카드를 바로 잡아 끈다
  await dragTo(370, 2460, 2000);
  expect([marked(), outer("z")]).toEqual([[], ["330px", "2420px", "", false]]);
  await release(370, 2460);
  await grab("z", 370, 2460);
  await release(370, 2460); // z 를 고른다
  expect(card("z").classList.contains("sel")).toBe(true);
  await grab("z", 370, 2460);
  await dragTo(590, 2460, 2000);
  expect([marked(), outer("z")]).toEqual([[], ["550px", "2420px", "", false]]);
  await release(590, 2460);
});

it("그룹 머리를 잡고 끌 때는 켜지 않는다 — 멤버가 40장을 넘고 전부 골라져 있어도", async () => {
  const cards = manyCards(41);
  await show(cards, [{ id: "gA", name: "A", cardIds: cards.slice(0, 41).map((item) => item.id), rect: { x: 66, y: 44, w: 2400, h: 1300 } }]);
  await marqueeAll();
  await ctrlClick("z");
  expect([groupPicked("gA"), host.querySelectorAll(".scene-card.sel").length]).toEqual([true, 41]);
  await grabHead("gA", 100, 50);
  await dragTo(320, 50, 2000); // +220 — 고른 카드 41장이 그룹과 같이 간다
  expect([shownAt("p0"), shownAt("p40")]).toEqual([[330, 110], [330, 990]]);
  expect(marked()).toEqual([]);
  await release(320, 50);
  expect([savedX("p0"), rectX("gA")]).toEqual([330, 286]);
});

it("보드의 카드를 전부 끌 때(판 밀기)는 카드에 표식도 translate 도 달지 않는다 — 캔버스 층 하나만 민다", async () => {
  await show(manyCards(40), []);
  await selectAll(); // 41장 전부
  await grab("p0", 150, 150);
  await dragTo(700, 150, 2000);
  expect(canvas().style.translate).toBe("550px 0px");
  expect(marked()).toEqual([]);
  await release(700, 150);
  expect(marked()).toEqual([]);
});

it("화면 배율이 30% 아래면 켜지 않는다 — 29% 는 전의 길, 30% 는 켠다(translate 는 캔버스 이동량 그대로 — 배율을 곱하지 않는다)", async () => {
  const at = (zoom: number) => act(async () => {
    const scene = { id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: manyCards(40), camera: { z: zoom, x: 0, y: 0 } } as never;
    root.render(<SceneBoard scene={scene} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  await at(0.29);
  await pickAllButZ();
  await grab("p0", 40, 40);
  await dragTo(40 + 220 * 0.29, 40, 2000); // 화면에서 63.8px = 캔버스에서 220
  expect([marked(), outer("p0")]).toEqual([[], ["330px", "110px", "", false]]);
  await release(40 + 220 * 0.29, 40);

  act(() => root.unmount());
  root = createRoot(host);
  await at(0.3);
  await pickAllButZ();
  await grab("p0", 40, 40);
  await dragTo(40 + 220 * 0.3, 40, 2000); // 화면에서 66px = 캔버스에서 220
  expect(marked().length).toBe(40);
  expect(outer("p0")).toEqual(["110px", "110px", "220px 0px", true]); // 66px 이 아니다
  await release(40 + 220 * 0.3, 40);
  expect(outer("p0")).toEqual(["330px", "110px", "", false]);
});

it("모니터 배율(devicePixelRatio)이 1 이 아니면 켜지 않는다 — 끄는 중에 바뀌어도 다음 걸음에서 꺼진다", async () => {
  await show(manyCards(40), []);
  await pickAllButZ();
  vi.stubGlobal("devicePixelRatio", 1.25);
  await grab("p0", 150, 150);
  await dragTo(370, 150, 2000);
  expect([marked(), outer("p0")]).toEqual([[], ["330px", "110px", "", false]]);
  await release(370, 150);

  vi.stubGlobal("devicePixelRatio", 1);
  await grab("p0", 370, 150);
  await dragTo(590, 150, 2000);
  expect(marked().length).toBe(40);
  vi.stubGlobal("devicePixelRatio", 1.5); // 창을 다른 모니터로 옮겼다 — 따로 지켜보지 않는다. 다음에 그릴 때 본다
  await dragTo(810, 150, 2000);
  expect([marked(), outer("p0")]).toEqual([[], ["770px", "110px", "", false]]);
  vi.stubGlobal("devicePixelRatio", 1); // 돌아와도 그 끌기에서는 다시 켜지 않는다
  await dragTo(1030, 150, 2000);
  expect([marked(), outer("p0")]).toEqual([[], ["990px", "110px", "", false]]);
  await release(1030, 150);
});

it("끌기가 어느 길로 끝나든 표식과 translate 가 남지 않는다 — 놓기·다른 단추의 mouseup·창 떠남·놓친 mouseup·다음 끌기·씬 전환·화면이 내려감", async () => {
  const open = (id: string, cards: object[]) => act(async () => {
    const scene = { id, name: id, created_at: 0, edges: [], groups: [], cards } as never;
    root.render(<SceneBoard scene={scene} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  await open("S", manyCards(40));
  await pickAllButZ();
  // 고른 40장을 p0 을 잡고 +220 끌어 둔다(끝내지는 않는다)
  const dragging = async () => {
    const x = parseFloat(card("p0").style.left) + 40;
    await grab("p0", x, 150);
    await dragTo(x + 220, 150, 2000);
    expect(marked().length).toBe(40);
    return x + 220;
  };
  const settledAt = (left: number) => expect([marked(), outer("p0")]).toEqual([[], [`${left}px`, "110px", "", false]]);

  let x = await dragging();
  await release(x, 150);
  settledAt(330);

  x = await dragging(); // 왼쪽으로 끄는 중에 오른쪽 단추를 눌렀다 놓는다 — 끌기는 그 mouseup 으로 끝난다
  await act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { button: 2, buttons: 1, clientX: x, clientY: 150 })); });
  settledAt(550);

  await dragging();
  await act(async () => { window.dispatchEvent(new Event("blur")); }); // 창을 떠났다
  settledAt(770);

  await dragging();
  await hoverTo(1500, 600); // 손을 뗀 것을 놓쳤다(단추를 다 뗀 채 움직임)
  settledAt(990);

  await dragging();
  await grab("z", 150, 2460); // 끝나지 않은 끌기 위에 다음 누름 — 앞 끌기를 닫는다
  settledAt(1210);
  await release(150, 2460); // 누르기만 한 z 가 혼자 골라졌다
  await pickAllButZ(); // 다시 p 들을 고른다

  await dragging();
  await open("T", manyCards(40)); // 끄는 중에 씬이 바뀌었다 — id 가 같은 카드들이 있어도 옛 끌기의 표시가 넘어가지 않는다
  settledAt(110);

  await pickAllButZ();
  await dragging();
  act(() => root.unmount()); // 끄는 중에 화면이 내려갔다 — 남을 요소가 없다
  expect(host.querySelectorAll(".scene-card").length).toBe(0);
  root = createRoot(host); // afterEach 가 내릴 뿌리
});

it("끄는 중에 지워도 표시가 남지 않는다 — 끌던 카드들이 사라지고, 되돌리면 표시 없이 끌기 전 자리로 돌아온다", async () => {
  await show(manyCards(40), []);
  await pickAllButZ();
  await grab("p0", 150, 150);
  await dragTo(370, 150, 2000);
  expect(marked().length).toBe(40);
  await key({ key: "Delete", code: "Delete" });
  expect([...host.querySelectorAll<HTMLElement>(".scene-card")].map((el) => el.dataset.id)).toEqual(["z"]);
  await dragTo(590, 150, 2000);
  await release(590, 150);
  expect([marked(), outer("z")]).toEqual([[], ["110px", "2420px", "", false]]);
  await undoOnce(); // 한 번에 끌기 전으로 — 되살아난 카드에도 표시가 없다
  expect(host.querySelectorAll(".scene-card").length).toBe(41);
  expect([marked(), outer("p0"), outer("p39")]).toEqual([[], ["110px", "110px", "", false], ["2090px", "770px", "", false]]);
});

// ── 끄는 조건 — 시작할 때만 켤 수 있고, 조건을 잃으면 그 끌기가 끝날 때까지 끈다 ──
it("끄는 중에 선택이 풀리면(Esc) 그 자리에서 원래 그리기로 돌아간다 — 끌기는 이어지고, 다시 골라도 그 끌기에서는 다시 켜지 않으며, 놓으면 되돌리기 한 단계다", async () => {
  await act(async () => { root.render(<StoreParent cards={manyCards(40)} />); });
  await pickAllButZ();
  await grab("p0", 150, 150);
  await dragTo(370, 150, 2000); // +220
  expect(marked().length).toBe(40);
  await key({ key: "Escape", code: "Escape" }); // 끄는 중의 Esc 는 선택을 푼다 — 포인터를 쥐고 있어도 키는 온다
  expect(host.querySelectorAll(".scene-card.sel").length).toBe(0);
  expect(marked()).toEqual([]);
  expect([outer("p0"), outer("p39")]).toEqual([["330px", "110px", "", false], ["2310px", "770px", "", false]]); // left/top 이 지금 좌표다
  await dragTo(590, 150, 2000); // 끌기는 이어진다 — 걸음마다 left/top 으로
  expect([marked(), outer("p0")]).toEqual([[], ["550px", "110px", "", false]]);
  await selectAll(); // 다시 골라도
  expect(host.querySelectorAll(".scene-card.sel").length).toBe(41);
  await dragTo(810, 150, 2000);
  expect([marked(), outer("p0")]).toEqual([[], ["770px", "110px", "", false]]); // 그 끌기에서는 다시 켜지 않는다
  await release(810, 150);
  expect([savedX("p0"), savedX("p39"), savedX("z")]).toEqual([770, 2750, 110]);
  await undoOnce();
  expect([savedX("p0"), savedX("p39")]).toEqual([110, 2090]);
  expect(outer("p0")).toEqual(["110px", "110px", "", false]);
});

it("끄는 중에 화면 배율이 30% 아래로 내려가면 그 갱신에서 바로 꺼진다(다음 움직임을 기다리지 않는다) — 다시 확대해도 그 끌기에서는 다시 켜지 않는다", async () => {
  const actionRef = { current: null as { zoomStep: (dir: 1 | -1) => void } | null };
  await act(async () => {
    const scene = { id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: manyCards(40), camera: { z: 0.3, x: 0, y: 0 } } as never;
    root.render(<SceneBoard scene={scene} actionRef={actionRef as never} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  const zoom = () => +(/scale[(]([-0-9.]+)[)]/.exec(canvas().style.transform)?.[1] ?? 1);
  // 지금 배율에서 p0 을 잡고 캔버스 거리 +220 만큼 끈다(누른 자리의 화면 좌표를 돌려준다)
  const dragByCanvas = async (canvasDx: number) => {
    await grab("p0", 500, 300);
    await dragTo(500 + canvasDx * zoom(), 300, 2000);
  };
  await pickAllButZ();

  // ① 툴바의 축소(화면 가운데 기준 한 단계)
  await dragByCanvas(220);
  expect(marked().length).toBe(40);
  await act(async () => { actionRef.current!.zoomStep(-1); }); // 30% → 27% — 마우스는 움직이지 않았다
  expect(zoom()).toBeLessThan(0.295);
  expect([marked(), outer("p0")]).toEqual([[], ["330px", "110px", "", false]]);
  await act(async () => { actionRef.current!.zoomStep(1); }); // 다시 30%
  expect(Math.round(zoom() * 100)).toBe(30);
  expect(marked()).toEqual([]);
  await act(async () => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: 505, clientY: 300, buttons: 1 })); frames.splice(0).forEach((cb) => cb(0)); });
  expect(marked()).toEqual([]); // 걸음이 이어져도 다시 켜지 않는다
  await release(505, 300);
  expect(marked()).toEqual([]);

  // ② 휠 축소 — 다음 끌기는 다시 켜지고(배율이 30% 다), 끄는 중의 휠 한 칸에 꺼진다
  await dragByCanvas(220);
  expect(marked().length).toBe(40);
  await act(async () => { board().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100, clientX: 500, clientY: 300 })); });
  expect(zoom()).toBeLessThan(0.295);
  expect(marked()).toEqual([]);
  await release(500, 300);

  // ③ 화면 맞춤(F) — 고른 카드에 맞추면서 배율이 바뀐다
  await act(async () => { actionRef.current!.zoomStep(1); }); // 다시 30%
  await dragByCanvas(220);
  expect(marked().length).toBe(40);
  await key({ key: "f", code: "KeyF" });
  expect(zoom()).toBeLessThan(0.295); // (시험 환경의 보드는 크기가 0 이라 가장 작은 배율로 맞춰진다)
  expect(marked()).toEqual([]);
  await release(500, 300);
});

// 가짜 matchMedia — 질의마다 change 를 듣는 쪽을 적는다(jsdom 에는 matchMedia 가 없다). 모니터 배율이 바뀐 것은
//  `(resolution: <지금 배율>dppx)` 질의가 어긋나는 것으로 안다.
function fakeMatchMedia() {
  const queries: { text: string; listeners: Set<() => void> }[] = [];
  vi.stubGlobal("matchMedia", (text: string) => {
    const query = { text, listeners: new Set<() => void>() };
    queries.push(query);
    return {
      media: text,
      matches: true,
      addEventListener: (_type: string, listener: () => void) => { query.listeners.add(listener); },
      removeEventListener: (_type: string, listener: () => void) => { query.listeners.delete(listener); },
    };
  });
  return {
    queries,
    /** 지금 듣는 쪽이 붙어 있는 질의들 */
    listening: () => queries.filter((query) => query.listeners.size > 0).map((query) => query.text),
    /** 그 질의가 어긋났다고 알린다(듣는 쪽이 붙어 있는 것에만) */
    change: (text: string) => act(async () => {
      for (const query of [...queries]) if (query.text === text) [...query.listeners].forEach((listener) => listener());
    }),
  };
}

it("끄는 중에 모니터 배율이 바뀌면 더 움직이지 않아도 꺼진다 — 켜져 있는 동안에만 듣고, 알림이 올 때마다 지금 배율로 다시 듣는다", async () => {
  const media = fakeMatchMedia();
  await show(manyCards(40), []);
  await pickAllButZ();
  expect(media.listening()).toEqual([]); // 평소에는 듣지 않는다
  await grab("p0", 150, 150);
  await dragTo(370, 150, 2000);
  expect(marked().length).toBe(40);
  expect(media.listening()).toEqual(["(resolution: 1dppx)"]);
  // 알림이 왔는데 배율은 그대로다 — 켜진 채 둔다. 질의는 값 하나에 묶여 있으므로 지금 배율로 다시 건다(앞의 것은 거둔다)
  await media.change("(resolution: 1dppx)");
  expect([marked().length, media.queries.length, media.listening()]).toEqual([40, 2, ["(resolution: 1dppx)"]]);
  vi.stubGlobal("devicePixelRatio", 1.5); // 창을 배율이 다른 모니터로 옮겼다 — 마우스는 움직이지 않는다
  await media.change("(resolution: 1dppx)");
  expect([marked(), outer("p0")]).toEqual([[], ["330px", "110px", "", false]]);
  expect(media.listening()).toEqual([]); // 꺼지면 듣기를 거둔다
  await release(370, 150);
  expect(savedX("p0")).toBe(330);

  vi.stubGlobal("devicePixelRatio", 1); // 다음 끌기 — 다시 켜지고, 놓으면 듣기를 거둔다
  await grab("p0", 370, 150);
  await dragTo(590, 150, 2000);
  expect([marked().length, media.listening()]).toEqual([40, ["(resolution: 1dppx)"]]);
  await release(590, 150);
  expect([marked(), media.listening()]).toEqual([[], []]);
});

it("화면 배율의 경계는 툴바에 보이는 % 다 — 29% 로 보이는 0.294 는 전의 길, 30% 로 보이는 0.295 는 켠다", async () => {
  const dragAt = async (zoom: number) => {
    await act(async () => {
      const scene = { id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: manyCards(40), camera: { z: zoom, x: 0, y: 0 } } as never;
      root.render(<SceneBoard scene={scene} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
    });
    await pickAllButZ();
    await grab("p0", 40, 40);
    await dragTo(40 + 220 * zoom, 40, 2000); // 캔버스에서 +220
    const seen = [marked().length, shownAt("p0")];
    await release(40 + 220 * zoom, 40);
    act(() => root.unmount());
    root = createRoot(host);
    return seen;
  };
  expect(await dragAt(0.294)).toEqual([0, [330, 110]]);
  expect(await dragAt(0.295)).toEqual([40, [330, 110]]);
});

// 화면 맞춤(F)은 캔버스를 250ms 에 걸쳐 미끄러뜨리는데(useSceneViewport.frameRects), 줌 저장소는 누른 순간 이미 **목표** 배율을 알린다.
//  낮은 배율에서 30% 이상인 목표로 가는 중에 끌기를 시작하면 보이는 배율이 아직 문턱 아래인 프레임에 켜졌다(2026-10-11 격리 실측 6/6 —
//  8% → 43% 에서 두세 프레임). 켜는 순간에는 캔버스가 **지금 실제로 그려지는** 배율(계산된 transform)도 문턱을 넘어야 한다.
it("화면 맞춤 전환이 도는 중(보이는 배율 9%·목표 43%)에 시작한 끌기는 켜지 않는다 — 전환이 끝난 뒤의 다음 끌기는 켠다", async () => {
  // 보드에 크기를 준다(1118×900) — 화면 맞춤이 고른 40장(폭 2132)을 43% 로 맞춘다
  const rectOf = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    if (this.matches(".scene-board")) return { x: 0, y: 0, left: 0, top: 0, width: 1118, height: 900, right: 1118, bottom: 900, toJSON: noop } as DOMRect;
    return rectOf.call(this);
  });
  const zoom = () => +(/scale[(]([-0-9.]+)[)]/.exec(canvas().style.transform)?.[1] ?? 1); // 목표 배율(캔버스에 써 둔 값)
  // 브라우저처럼: 전환이 도는 동안 캔버스의 계산된 transform 은 아직 출발 배율(9%)이고, 끝나면 써 둔 값(목표)이다
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
    if (element !== canvas()) return computed(element, pseudo);
    const scale = canvas().style.transition ? 0.09 : zoom();
    return { transform: `matrix(${scale}, 0, 0, ${scale}, 0, 0)` } as CSSStyleDeclaration;
  });
  await act(async () => {
    const scene = { id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: manyCards(40), camera: { z: 0.09, x: 0, y: 0 } } as never;
    root.render(<SceneBoard scene={scene} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  await pickAllButZ();
  expect(Math.round(zoom() * 100)).toBe(9);
  // p0 을 잡고 캔버스 거리만큼 끈다(지금의 목표 배율로 화면 거리를 잰다)
  const dragByCanvas = async (canvasDx: number) => {
    await grab("p0", 500, 300);
    await dragTo(500 + canvasDx * zoom(), 300, 2000);
  };

  await key({ key: "f", code: "KeyF" }); // 화면 맞춤 — 줌 저장소는 곧바로 목표(43%)를 알린다
  expect([Math.round(zoom() * 100), canvas().style.transition !== ""]).toEqual([43, true]);
  await dragByCanvas(220); // 전환이 도는 중에 끌기를 시작했다 — 보이는 배율은 아직 9% 다
  expect([marked(), shownAt("p0")]).toEqual([[], [330, 110]]);
  await act(async () => { await new Promise((done) => setTimeout(done, 320)); }); // 전환이 끝났다(보이는 배율 43%)
  expect(canvas().style.transition).toBe("");
  await dragTo(500 + 440 * zoom(), 300, 2000);
  expect([marked(), shownAt("p0")]).toEqual([[], [550, 110]]); // 그 끌기에서는 다시 켜지 않는다
  await release(500 + 440 * zoom(), 300);

  await dragByCanvas(220); // 다음 끌기 — 보이는 배율도 43% 다
  expect(marked().length).toBe(40);
  // 켜진 뒤의 화면 맞춤(목표가 30% 이상)은 켜진 채 둔다 — 보이는 배율은 켜는 순간에만 본다(걸음마다 읽지 않는다)
  await key({ key: "f", code: "KeyF" });
  expect([canvas().style.transition !== "", Math.round(zoom() * 100), marked().length]).toEqual([true, 43, 40]);
  await release(500 + 220 * zoom(), 300);
  expect(marked()).toEqual([]);
});

// 11회차(조작 규칙 38): 브라우저는 Ctrl+V 를 누르고 있으면 반복 keydown 마다 paste 를 또 보낸다 — 카드가 반복 횟수만큼 붙었다.
it("길게 눌린 Ctrl+V 는 보드에서 반복 붙여넣기가 되지 않는다 — 반복 keydown 의 기본 동작(paste)을 막는다. 입력칸에서는 그대로다", async () => {
  await show([textCard("a1", 110)], []);
  const pressPaste = (target: EventTarget, repeat: boolean) => {
    const event = new KeyboardEvent("keydown", { key: "v", code: "KeyV", ctrlKey: true, bubbles: true, cancelable: true, repeat });
    act(() => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  expect([pressPaste(document.body, false), pressPaste(document.body, true)]).toEqual([false, true]); // 첫 누름의 paste 는 그대로 온다
  const input = document.createElement("input");
  document.body.append(input);
  try {
    expect(pressPaste(input, true)).toBe(false); // 글자를 치는 자리의 붙여넣기는 브라우저 몫이다
  } finally {
    input.remove();
  }
});

// ── 9회차 ──
// 끄는 중에 밖에서 씬이 갱신된다(생성 결과 도착·다른 창의 편집) — 받은 값에는 저장 전인 끌기의 좌표·크기·네모가 없다. 전엔 끌던 것이
//  끌기 전 자리로 돌아가 보였고(다음 움직임에 다시 옴 — 2026-10-11 캔버스 실측 3/3), **더 움직이지 않고 놓으면 그 값이 저장**됐다:
//  카드 끌기·크기 조절은 한 일이 사라지고, 그룹 머리 끌기는 네모만 가고 멤버는 남았다. 끌기가 쥔 값은 받은 값 위에 다시 얹는다
//  (lib/sceneDragSession rebase). 밖 갱신 = 같은 씬 id 의 새 배열 — show 를 다시 부른다.
const savedCard = (id: string) => savedCards().find((item) => item.id === id) as Record<string, unknown> | undefined;
const groupEl = (id: string) => host.querySelector<HTMLElement>(`.scene-group[data-group-id="${id}"]`)!;
const pressHandle = (el: HTMLElement, x: number, y: number) => act(async () => {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y }));
});
const rectGroup = (id: string, cardIds: string[], x: number) => ({ id, name: id, cardIds, rect: { x, y: 44, w: 330, h: 330 } });

it("끄는 중에 밖에서 씬이 갱신돼도 끌던 카드는 끈 자리에 있다 — 더 움직이지 않고 놓으면 끈 자리가 저장되고, 밖에서 온 내용은 남는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000); // a1 +220
  expect(card("a1").style.left).toBe("330px");
  await show([textCard("a1", 110), { ...textCard("b1", 660), text: "밖에서 고친 글" }], []); // 저장분(끌기 전 좌표) + b1 의 새 글
  expect(card("a1").style.left).toBe("330px"); // 끌기 전 자리로 돌아가 보이지 않는다
  expect(board().classList.contains("dragging")).toBe(true); // 끌기는 이어진다
  await release(370, 150);
  expect([savedX("a1"), card("a1").style.left]).toEqual([330, "330px"]);
  expect(savedCard("b1")?.text).toBe("밖에서 고친 글");
  await undoOnce(); // 되돌리기는 끌기만 — 밖에서 온 글은 남는다(끄는 중에 저장이 끼지 않은 보통 끌기)
  expect([savedX("a1"), savedCard("b1")?.text]).toEqual([110, "밖에서 고친 글"]);
});

it("밖 갱신 뒤의 다음 걸음은 끌기 전 자리에서 다시 잰다 — 다시 얹은 좌표에 한 번 더 더하지 않는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000);
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  await dragTo(480, 150, 2000); // 누른 자리에서 +330
  await release(480, 150);
  expect([savedX("a1"), savedX("b1")]).toEqual([440, 660]);
});

it("여러 장을 끄는 중의 밖 갱신이 일부만 되돌려도 전부 다시 놓는다 — 기준 카드가 제자리라고 건너뛰지 않는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660), textCard("c1", 1100)], []);
  await grab("a1", 150, 150);
  await release(150, 150); // a1 선택
  await grab("b1", 700, 150, true);
  await release(700, 150); // Ctrl+클릭으로 b1 추가
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000); // 둘 다 +220
  expect([card("a1").style.left, card("b1").style.left]).toEqual(["330px", "880px"]);
  // 밖 갱신: 기준 카드(a1)는 끈 자리 그대로, b1 만 끌기 전 자리
  await show([textCard("a1", 330), textCard("b1", 660), textCard("c1", 1100)], []);
  expect([card("a1").style.left, card("b1").style.left]).toEqual(["330px", "880px"]);
  await release(370, 150);
  expect([savedX("a1"), savedX("b1"), savedX("c1")]).toEqual([330, 880, 1100]);
});

it("그룹 머리를 끄는 중의 밖 갱신 — 더 움직이지 않고 놓아도 네모와 멤버가 같은 만큼 간 채 저장된다(전엔 네모만 갔다)", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], [rectGroup("gA", ["a1"], 66)]);
  await grabHead("gA", 100, 50);
  await dragTo(320, 50, 2000); // +220
  const shown = [card("a1").style.left, groupEl("gA").style.left];
  expect(shown[0]).toBe("330px");
  await show([textCard("a1", 110), textCard("b1", 660)], [rectGroup("gA", ["a1"], 66)]);
  expect([card("a1").style.left, groupEl("gA").style.left]).toEqual(shown); // 카드도 틀도 되돌아가 보이지 않는다
  await release(320, 50);
  expect([savedX("a1"), rectX("gA")]).toEqual([330, 286]);
});

it("전부 끄는 중(판 밀기) 좌표에 넣어 둔 이동이 밖 갱신으로 갈려도, 놓으면 끈 자리가 저장된다 — 같이 간 네모도", async () => {
  const cards = () => [textCard("a1", 110), textCard("b1", 660)];
  const groupsNow = () => [rectGroup("gA", ["a1"], 66), rectGroup("gB", ["b1"], 616)];
  await show(cards(), groupsNow());
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000); // +550 — 층에만
  await key({ key: "g", code: "KeyG", ctrlKey: true }); // 끄는 중의 키 — 층의 이동을 좌표에 넣는다(저장은 하지 않는다)
  expect([card("a1").style.left, canvas().style.translate]).toEqual(["660px", ""]);
  await show(cards(), groupsNow()); // 밖 갱신 — 저장분은 끌기 전 좌표다
  expect([card("a1").style.left, card("b1").style.left, canvas().style.translate]).toEqual(["660px", "1210px", ""]);
  await release(700, 150);
  expect([savedX("a1"), savedX("b1")]).toEqual([660, 1210]);
  expect([rectX("gA"), rectX("gB")]).toEqual([616, 1166]);
  expect(canvas().style.translate).toBe("");
});

it("전부 끄는 중 좌표에 넣은 적이 없으면 밖 갱신이 와도 층만 밀려 있다 — 놓으면 끈 자리가 저장된다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000);
  await show([textCard("a1", 110), { ...textCard("b1", 660), text: "새 글" }], []);
  expect([card("a1").style.left, canvas().style.translate]).toEqual(["110px", "550px 0px"]);
  await release(700, 150);
  expect([savedX("a1"), savedX("b1"), savedCard("b1")?.text]).toEqual([660, 1210, "새 글"]);
});

it("카드 크기를 늘리는 중의 밖 갱신 — 더 움직이지 않고 놓아도 늘린 크기가 저장된다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  await pressHandle(card("a1").querySelector<HTMLElement>(".scene-resize")!, 262, 200);
  await dragTo(262 + 220, 200 + 110, 2000);
  const grown = [card("a1").style.width, card("a1").style.height];
  await show([textCard("a1", 110), textCard("b1", 660)], []); // 저장분에는 크기가 없다
  expect([card("a1").style.width, card("a1").style.height]).toEqual(grown);
  await release(482, 310);
  expect([`${savedCard("a1")?.w}px`, `${savedCard("a1")?.h}px`]).toEqual(grown);
  expect(Number(savedCard("a1")?.w)).toBeGreaterThan(300); // 실제로 늘었다(기본 폭 + 220)
});

it("누르기만 하고 끌지 않았으면 밖 갱신이 그대로 들어온다 — 쥔 것이 없는 끌기는 좌표·크기를 다시 얹지 않는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  await grab("a1", 150, 150); // 누르기만
  await show([textCard("a1", 220), textCard("b1", 660)], []); // 밖에서 a1 을 옮겼다
  expect(card("a1").style.left).toBe("220px");
  await release(150, 150);
  // 크기 손잡이도 같다 — 누르기만 한 뒤 밖 갱신이 와도 카드에 크기를 새로 적지 않는다(뒤따르는 저장에 기본 크기가 박히지 않는다)
  await pressHandle(card("a1").querySelector<HTMLElement>(".scene-resize")!, 262, 200);
  await show([textCard("a1", 220), textCard("b1", 660)], []);
  await release(262, 200);
  await grab("b1", 700, 150);
  await dragTo(920, 150, 2000);
  await release(920, 150); // 다른 카드를 옮겨 저장을 일으킨다
  expect([savedX("b1"), savedCard("a1")?.w, savedCard("a1")?.h]).toEqual([880, undefined, undefined]);
});

it("그룹 머리를 누르기만 했을 때의 밖 갱신도 그대로 들어온다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], [rectGroup("gA", ["a1"], 66)]);
  await grabHead("gA", 100, 50);
  await show([textCard("a1", 132), textCard("b1", 660)], [rectGroup("gA", ["a1"], 66)]);
  expect(card("a1").style.left).toBe("132px");
  await release(100, 50);
});

it("그룹 크기를 늘리는 중의 밖 갱신 — 늘리던 테두리가 되돌아가 보이지 않고, 놓으면 그 테두리가 저장된다", async () => {
  await show([textCard("a1", 110), textCard("b1", 1100)], [rectGroup("gA", ["a1"], 66)]);
  await pressHandle(groupEl("gA").querySelector<HTMLElement>(".scene-group-resize")!, 396, 374);
  await dragTo(396 + 220, 374, 2000);
  const width = groupEl("gA").style.width;
  await show([textCard("a1", 110), textCard("b1", 1100)], [rectGroup("gA", ["a1"], 66)]);
  expect(groupEl("gA").style.width).toBe(width);
  await release(616, 374);
  expect(groups().find((group) => group.id === "gA")?.rect?.w).toBe(550);
});

it("그룹 크기 손잡이를 누르기만 했을 때의 밖 갱신은 그대로 보인다 — 누른 순간의 테두리로 덮지 않는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 1100)], [rectGroup("gA", ["a1"], 66)]);
  await pressHandle(groupEl("gA").querySelector<HTMLElement>(".scene-group-resize")!, 396, 374);
  const wider = { id: "gA", name: "gA", cardIds: ["a1"], rect: { x: 66, y: 44, w: 550, h: 330 } };
  await show([textCard("a1", 110), textCard("b1", 1100)], [wider]); // 밖에서 폭을 늘렸다
  expect(groupEl("gA").style.width).toBe("550px");
  await release(396, 374); // 끌지 않고 놓는다 — 저장되는 것도 밖에서 온 테두리다(누른 순간의 330 이 아니다)
  expect([groupEl("gA").style.width, groups().find((group) => group.id === "gA")?.rect?.w]).toEqual(["550px", 550]);
  // 밖 갱신 뒤에 끌기 시작하면 밖에서 온 테두리에서 늘어난다
  await pressHandle(groupEl("gA").querySelector<HTMLElement>(".scene-group-resize")!, 616, 374);
  await show([textCard("a1", 110), textCard("b1", 1100)], [{ ...wider, rect: { ...wider.rect, w: 660 } }]);
  await dragTo(616 + 110, 374, 2000);
  await release(726, 374);
  expect(groups().find((group) => group.id === "gA")?.rect?.w).toBe(770);
});

it("카드 크기 손잡이를 누르기만 한 뒤 밖에서 그 카드가 커지면, 그 뒤의 끌기는 받은 크기에서 늘어난다 — 누른 순간의 크기로 줄지 않는다", async () => {
  const sized = (w: number) => [{ ...textCard("a1", 110), w, h: 154 }, textCard("b1", 660)];
  await show(sized(220), []);
  await pressHandle(card("a1").querySelector<HTMLElement>(".scene-resize")!, 330, 264);
  await show(sized(440), []); // 밖에서 폭 220 → 440
  expect(card("a1").style.width).toBe("440px");
  await dragTo(330 + 22, 264, 2000);
  await release(352, 264);
  expect([savedCard("a1")?.w, savedCard("a1")?.h]).toEqual([462, 154]);
});

it("그룹째 끄는 중(일부 끌기)에 기준 카드가 밖에서 지워져도 네모는 남은 카드와 같이 간다 — 엇갈린 채 저장되지 않는다", async () => {
  const cards = () => [textCard("a1", 110), textCard("a2", 110, 264), textCard("c1", 1100)];
  const group = (cardIds: string[]) => [{ id: "gA", name: "A", cardIds, rect: { x: 66, y: 44, w: 330, h: 400 } }];
  await show(cards(), group(["a1", "a2"]));
  await grab("a1", 150, 150);
  await release(150, 150); // a1 선택
  await grab("a2", 150, 300, true);
  await release(150, 300); // Ctrl+클릭으로 a2 추가 — 그룹의 멤버 전부(c1 은 안 골랐다 — 판 밀기가 아니다)
  await grab("a1", 150, 150);
  await dragTo(370, 150, 2000); // +220
  await show(cards().filter((item) => item.id !== "a1"), group(["a2"])); // 밖에서 기준 카드 a1 이 지워졌다
  await dragTo(590, 150, 2000); // 누른 자리에서 +440
  await release(590, 150);
  expect([savedX("a2"), rectX("gA")]).toEqual([550, 506]); // 카드도 네모도 +440
});

it("전부 끄는 중에 기준 카드(잡은 카드)가 밖에서 지워져도 남은 카드는 끈 자리에 보인다 — 층이 풀리지 않고, 놓으면 끈 자리가 저장된다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], []);
  await selectAll();
  await grab("a1", 150, 150);
  await dragTo(700, 150, 2000); // +550 — 층에만
  expect(canvas().style.translate).toBe("550px 0px");
  await show([textCard("b1", 660)], []); // 밖에서 a1 이 지워졌다
  expect([card("b1").style.left, canvas().style.translate]).toEqual(["660px", "550px 0px"]);
  await release(700, 150);
  expect([savedX("b1"), card("b1").style.left, canvas().style.translate]).toEqual([1210, "1210px", ""]);
});

it("카드 크기를 늘린 뒤 마우스를 멈춘 채 줌이 바뀌고 밖 갱신이 와도 늘린 크기 그대로다 — 다시 계산하지 않고 마지막 결과를 얹는다", async () => {
  const actionRef = { current: null as { zoomStep: (dir: 1 | -1) => void } | null };
  const render = () => act(async () => {
    const scene = { id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: [textCard("a1", 110), textCard("b1", 660)] } as never;
    root.render(<SceneBoard scene={scene} actionRef={actionRef as never} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />);
  });
  await render();
  await pressHandle(card("a1").querySelector<HTMLElement>(".scene-resize")!, 262, 200);
  await dragTo(262 + 220, 200 + 110, 2000);
  const grown = [card("a1").style.width, card("a1").style.height];
  const scaleNow = () => /scale[(]([-0-9.]+)[)]/.exec(canvas().style.transform)?.[1];
  const before = scaleNow();
  await act(async () => { actionRef.current!.zoomStep(1); frames.splice(0).forEach((cb) => cb(0)); });
  expect(scaleNow()).not.toBe(before); // 줌이 바뀌었다(마우스는 그대로)
  await render(); // 밖 갱신
  expect([card("a1").style.width, card("a1").style.height]).toEqual(grown);
  await release(482, 310);
  expect([`${savedCard("a1")?.w}px`, `${savedCard("a1")?.h}px`]).toEqual(grown);
});

it("그룹 크기를 조절하는 중에 그 그룹이 밖에서 지워지면 놓아도 아무것도 저장하지 않는다 — 테두리 안의 카드를 다른 그룹에서 빼지 않는다", async () => {
  await show([textCard("a1", 110), textCard("b1", 660)], [rectGroup("gA", ["a1"], 66), rectGroup("gB", ["b1"], 616)]);
  await pressHandle(groupEl("gA").querySelector<HTMLElement>(".scene-group-resize")!, 396, 374);
  await dragTo(396 + 440, 374, 2000); // gA 의 테두리가 b1 의 가운데(736)를 덮는다
  await show([textCard("a1", 110), textCard("b1", 660)], [rectGroup("gB", ["b1"], 616)]); // 밖에서 gA 가 지워졌다
  patches = [];
  await release(836, 374);
  expect(patches).toEqual([]);
  expect([...host.querySelectorAll<HTMLElement>(".scene-group")].map((el) => el.dataset.groupId)).toEqual(["gB"]);
});
