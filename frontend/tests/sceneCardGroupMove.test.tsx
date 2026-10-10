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
const dragTo = (x: number, y: number, ms: number) => act(async () => {
  clock += ms;
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
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
function StoreParent({ cards, groups = [] }: { cards: object[]; groups?: object[] }) {
  const [scene, setScene] = useState(() => ({ id: "S", name: "S", created_at: 0, edges: [], groups, cards }) as Record<string, unknown>);
  const saved = useRef(structuredClone(scene));
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
