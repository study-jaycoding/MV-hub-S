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
  // 카드·그룹은 style 의 캔버스 좌표를 화면 위치로 쓴다(확대 100%·이동 0 인 첫 화면과 같다).
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const on = this.matches(".scene-card, .scene-group");
    const n = (v: string) => (on ? parseFloat(v) || 0 : 0);
    const [x, y, w, h] = [n(this.style.left), n(this.style.top), n(this.style.width), n(this.style.height)];
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
const selectAll = () => act(async () => {
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
  expect(card("a1").style.top).toBe("550px");
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
  expect(card("a1").style.left).toBe("330px");
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
  expect(card("a1").style.left).toBe("330px");
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
  expect(card("dst").style.left).toBe("880px");
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
