// 범위 선택 미리보기(Jay 2026-09-30 b안) — 끄는 동안에는 선택 표시만 직접 켜고, 손을 뗄 때 한 번에 확정한다. 실제 SceneBoard 로 본다.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { Scene } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

// 바꾸는 것은 생성물 읽기·프레임 예약·요소 위치뿐 — SceneBoard·범위 선택 훅·끌기 세션은 실제 코드다.
const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = noop; });
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
    genData: {}, genDataRef: { current: {} }, setGenData: noop,
    missingIds: new Set(), disabledIds: new Set(), refParents: {},
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

const sceneOf = (id: string, cards: object[], groups: object[] = []): Scene =>
  ({ id, name: id, created_at: 0, edges: [], cards, groups }) as unknown as Scene;
const textCard = (id: string, x: number) => ({ id, kind: "text", x, y: 100, text: id });
const show = (scene: Scene) =>
  act(async () => {
    root.render(<SceneBoard scene={scene} onChange={noop} />);
  });
const down = (x: number, y: number) =>
  act(async () => {
    host.querySelector(".scene-board")!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: y }),
    );
  });
// 끌기 세션은 한 프레임에 한 번 반영한다 — 움직인 뒤 예약된 프레임을 돌린다.
const dragTo = (x: number, y: number) =>
  act(async () => {
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
    frames.splice(0).forEach((cb) => cb(0));
  });
const release = (x: number, y: number) =>
  act(async () => {
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: x, clientY: y }));
  });
const press = (key: string, code: string, ctrlKey = false) =>
  act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, code, ctrlKey, bubbles: true, cancelable: true }));
  });
const selectAll = () => press("a", "KeyA", true);
const card = (id: string) => host.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`);
const shown = (id: string) => card(id)!.classList.contains("sel");
// 카드를 제자리에서 눌렀다 떼면 그 카드만 고른다(선택은 손을 뗄 때).
const clickCard = async (id: string, x: number) => {
  await act(async () => {
    card(id)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: 110 }));
  });
  await release(x, 110);
};
// 미니맵은 확정된 선택 상태로만 칠한다 — '아직 확정 안 됨'을 보는 창이다.
const committed = () => host.querySelectorAll(".scene-minimap-card.sel").length;

it("끄는 동안은 카드·그룹 선택 표시만 바뀌고, 손을 떼면 한 번에 확정된다", async () => {
  await show(
    sceneOf("A", [textCard("a1", 100), textCard("a2", 1000)], [
      { id: "g1", name: "그룹", cardIds: ["a1"], rect: { x: 60, y: 60, w: 400, h: 400 } },
    ]),
  );
  await selectAll();
  expect(committed()).toBe(2);

  // 빈 곳에서 a1 과 그룹만 감싸도록 끈다 — 먼저 골라 둔 a2 는 표시가 꺼져야 한다(일반 범위 선택은 교체).
  await down(20, 20);
  await dragTo(600, 600);
  expect(shown("a1")).toBe(true);
  expect(shown("a2")).toBe(false);
  const group = host.querySelector<HTMLElement>('.scene-group[data-group-id="g1"]')!;
  expect(group.classList.contains("selected")).toBe(true);
  expect(group.dataset.selected).toBe("true");
  expect(committed()).toBe(2); // 선택 상태는 아직 끌기 전 그대로

  await release(600, 600);
  expect(committed()).toBe(1);
  expect(shown("a1")).toBe(true);
  expect(shown("a2")).toBe(false);
  expect(group.classList.contains("selected")).toBe(true);
});

it("끄는 도중 씬을 바꾸면 직접 켠 선택 표시를 지운다 — 새 씬의 같은 id 카드가 선택돼 보이지 않는다", async () => {
  await show(sceneOf("A", [textCard("c1", 100)]));
  await down(20, 20);
  await dragTo(600, 600);
  expect(shown("c1")).toBe(true);

  await show(sceneOf("B", [textCard("c1", 100), textCard("c2", 1000)]));
  expect(shown("c1")).toBe(false);
  await press("Shift", "ShiftLeft"); // 다른 입력이 와도 버린 미리보기를 새 씬에서 확정하지 않는다
  await release(600, 600); // 버린 끌기라 확정하지 않는다
  expect(host.querySelectorAll(".scene-card.sel").length).toBe(0);
  expect(committed()).toBe(0);
});

it("창을 벗어나 끌기가 취소되면(blur) 마지막 미리보기를 확정한다 — 종전처럼 마지막 움직임까지 반영", async () => {
  await show(sceneOf("A", [textCard("a1", 100), textCard("a2", 1000)]));
  await down(20, 20);
  await dragTo(600, 600);
  expect(committed()).toBe(0);

  await act(async () => {
    window.dispatchEvent(new Event("blur"));
  });
  expect(committed()).toBe(1);
  expect(shown("a1")).toBe(true);
  expect(shown("a2")).toBe(false);
});

// 끄는 도중 다른 입력은 미리보기를 먼저 확정한 뒤 처리한다 — 걸음마다 확정하던 종전 결과와 같다(Codex P1).
it("끄는 도중 Delete 는 화면에 보이는 범위 선택을 지운다 — 꺼 둔 옛 선택이 아니다", async () => {
  await show(sceneOf("A", [textCard("a1", 100), textCard("c1", 1000)]));
  await selectAll();
  await down(20, 20);
  await dragTo(600, 600); // a1 만 감싼다 — c1 표시는 꺼진다
  expect(shown("c1")).toBe(false);

  await press("Delete", "Delete");
  expect(card("a1")).toBeNull();
  expect(card("c1")).not.toBeNull();
  await release(600, 600);
});

it("끄는 도중 Esc 로 푼 선택을 손 뗄 때 되살리지 않는다", async () => {
  await show(sceneOf("A", [textCard("a1", 100), textCard("c1", 1000)]));
  await down(20, 20);
  await dragTo(600, 600);

  await press("Escape", "Escape");
  await release(600, 600);
  expect(committed()).toBe(0);
  expect(host.querySelectorAll(".scene-card.sel").length).toBe(0);
});

it("끄는 도중 Ctrl+A 전체 선택을 손 뗄 때 범위 결과로 덮어쓰지 않는다", async () => {
  await show(sceneOf("A", [textCard("a1", 100), textCard("c1", 1000)]));
  await down(20, 20);
  await dragTo(600, 600);

  await selectAll();
  await release(600, 600);
  expect(committed()).toBe(2);
});

it("끄는 도중 Ctrl+Z 가 비운 선택을 손 뗄 때 되살리지 않는다 — 되돌리기는 선택을 비운다", async () => {
  await show(sceneOf("A", [textCard("a1", 100), textCard("c1", 1000)]));
  await clickCard("c1", 1010); // 되돌릴 편집 하나 — c1 을 골라 지운다
  await press("Delete", "Delete");
  expect(card("c1")).toBeNull();

  await down(20, 20);
  await dragTo(600, 600); // a1 미리보기
  await press("z", "KeyZ", true);
  expect(card("c1")).not.toBeNull();
  await release(600, 600);
  expect(committed()).toBe(0);
  expect(host.querySelectorAll(".scene-card.sel").length).toBe(0);
});

it("손 뗌을 놓친 채 Shift 로 새 범위를 이어 고르면 방금 고른 것에 더한다 — 그 전 선택이 아니다", async () => {
  await show(sceneOf("A", [textCard("a1", 100), textCard("b1", 1000), textCard("c1", 1400)]));
  await clickCard("c1", 1410);
  expect(committed()).toBe(1); // c1

  await down(20, 20);
  await dragTo(600, 600); // a1 만 — mouseup 은 오지 않았다
  await act(async () => {
    host.querySelector(".scene-board")!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, shiftKey: true, clientX: 900, clientY: 20 }),
    );
  });
  await dragTo(1300, 600); // b1 만 감싼다
  await release(1300, 600);
  expect(shown("a1")).toBe(true);
  expect(shown("b1")).toBe(true);
  expect(shown("c1")).toBe(false);
  expect(committed()).toBe(2);
});

it("손 뗌을 놓친 채 카드를 끌어도 범위로 고른 카드가 함께 움직인다", async () => {
  await show(sceneOf("A", [textCard("a1", 100), textCard("b1", 400), textCard("c1", 1000)]));
  await down(20, 20);
  await dragTo(600, 600); // a1·b1 미리보기 — mouseup 은 오지 않았다
  const left = (id: string) => parseFloat(card(id)!.style.left);

  await act(async () => {
    card("a1")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 150, clientY: 150 }));
  });
  await dragTo(300, 150);
  await release(300, 150);
  expect(left("a1")).toBeGreaterThan(100);
  expect(left("b1")).toBeGreaterThan(400);
  expect(left("c1")).toBe(1000);
});
