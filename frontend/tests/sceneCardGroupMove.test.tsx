// 카드를 끌어 놓을 때의 그룹 소속 — 실제 SceneBoard 로 본다(끌기 훅·재배정·이탈 계산은 실제 코드).
// 2026-10-10 캔버스 실측: 전부 고르고(Ctrl+A) 끌어 놓으면 그룹이 줄었다(32 → 31, 되풀이하면 20 → 9. Ctrl+Z 로만 복구).
//  · 카드가 같이 옮겨 온 옆 그룹의 **옛 자리**에 떨어져 그 그룹으로 넘어가거나(속도와 무관)
//  · 빠르게 끌면 전부 이탈해, 비게 된 그룹이 지워졌다.
// 멤버를 전부 같이 끄는 그룹은 통째로 간다(rect 도 같이, 이탈·재배정 없음). 한 장만 끌 때의 편입·이탈은 그대로다.
// @vitest-environment jsdom
import { act } from "react";
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
  // 끄는 동안에도 틀이 카드를 따라온다 — 이탈로 치면 멤버 없는 틀이 돼 사라지거나 제자리에 남는다
  expect([frameTop("gA") - before[0], frameTop("gB") - before[1]]).toEqual([440, 440]);
  await release(150, 590);
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
