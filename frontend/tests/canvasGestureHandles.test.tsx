// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCanvasGestures, type CanvasGestureActive, type CanvasGestures } from "../src/features/canvas/gestures";
import type { SceneCard, SceneEdge, SceneGroup } from "../src/lib/scenes";
import { useSceneHistory } from "../src/lib/useSceneHistory";

vi.mock("../src/lib/sceneCardLinks", () => ({
  reviveCardGenerations: vi.fn(), markCardGenerationsRemoved: vi.fn(async () => {}),
  mergeCardLinksIntoScenes: () => null, serverCardLinks: () => ({}),
}));

const card = (id: string, x: number): SceneCard => ({ id, kind: "text", x, y: 0, text: id });
const rect = { x: 0, y: 0, w: 100, h: 100 };
let root: Root, host: HTMLDivElement;
let cardsRef: { current: SceneCard[] }, edgesRef: { current: SceneEdge[] }, groupsRef: { current: SceneGroup[] };
let activeRef: { current: CanvasGestureActive | null };
let history: ReturnType<typeof useSceneHistory>, gestures: CanvasGestures;
let alive: boolean;
const saved = vi.fn();
const reconcile = vi.fn((cards: SceneCard[]) => cards);
const setCards = (next: SceneCard[] | ((cards: SceneCard[]) => SceneCard[])) => {
  cardsRef.current = typeof next === "function" ? next(cardsRef.current) : next;
};
const setEdges = (next: SceneEdge[] | ((edges: SceneEdge[]) => SceneEdge[])) => {
  edgesRef.current = typeof next === "function" ? next(edgesRef.current) : next;
};
const setGroups = (next: SceneGroup[] | ((groups: SceneGroup[]) => SceneGroup[])) => {
  groupsRef.current = typeof next === "function" ? next(groupsRef.current) : next;
};
function port(current = () => alive) {
  return createCanvasGestures({ cardsRef, edgesRef, groupsRef, setCards, setGroups, history, current,
    activeRef, withGenerationRefs: reconcile, cardSize: (item) => ({ w: item.w ?? 20, h: item.h ?? 20 }) });
}
function Harness() {
  history = useSceneHistory({ sceneId: "gesture-handles", initialSnapshot: { cards: cardsRef.current, edges: [], groups: groupsRef.current },
    sceneIdRef: { current: "gesture-handles" }, cardsRef, edgesRef, groupsRef, setCards, setEdges, setGroups,
    clearSelection: () => {}, onChange: saved, frozenRef: { current: false } });
  gestures = port();
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network in isolated gesture test"); }));
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated gesture test"); } });
  localStorage.clear(); sessionStorage.clear(); saved.mockClear(); reconcile.mockClear();
  cardsRef = { current: [card("a", 0), card("b", 200)] };
  edgesRef = { current: [] }; groupsRef = { current: [] }; activeRef = { current: null }; alive = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("이동 손잡이는 시작 때 잡은 ID의 기하만 바꾸고 Esc는 그사이 편집·결과·삭제를 보존한다", () => {
  const move = gestures.beginCardMove(["a", "b"], []);
  move.preview({ positions: { a: { x: 40, y: 30 }, b: { x: 240, y: 30 }, foreign: { x: 9, y: 9 } } });
  cardsRef.current = [{ ...cardsRef.current[0], text: "edited", genIds: ["result"] }, card("new", 700)];
  history.persist(cardsRef.current, [], []);
  move.cancel();
  expect(cardsRef.current.map((item) => [item.id, item.x, item.y, item.text])).toEqual([["a", 0, 0, "edited"], ["new", 700, 0, "new"]]);
  expect(cardsRef.current[0].genIds).toEqual(["result"]);
  expect(activeRef.current).toBeNull();
  history.undo();
  expect(cardsRef.current.map((item) => item.id)).toEqual(["a", "b"]);
});

it("다음 끌기는 앞 끌기를 먼저 확정하고 옛 token은 새 끌기를 바꾸거나 닫지 못한다", () => {
  const move = gestures.beginCardMove(["a"], []);
  move.preview({ positions: { a: { x: 40, y: 0 }, b: { x: 900, y: 0 } } });
  const resize = port().beginCardResize("b");
  const active = activeRef.current;
  expect(saved).toHaveBeenCalledTimes(1);
  expect(cardsRef.current[1].x).toBe(200);
  expect(move.preview({ positions: { a: { x: 999, y: 0 } } })).toBe(false);
  move.cancel(); move.finish(); move.rebase();
  expect(activeRef.current).toBe(active);
  resize.preview({ w: 80, h: 90 }); resize.finish();
  history.undo(); expect(cardsRef.current[1].w).toBeUndefined(); expect(cardsRef.current[0].x).toBe(40);
  history.undo(); expect(cardsRef.current[0].x).toBe(0);
  expect(reconcile).toHaveBeenCalledTimes(1);
});

it("다른 문서 세대의 옛 port·handle은 새 active를 탈취하거나 새 문서를 쓰지 못한다", () => {
  const old = gestures.beginCardMove(["a"], []);
  alive = false; activeRef.current = null; history.endGesture();
  const next = port(() => true).beginCardResize("a");
  const active = activeRef.current;
  old.preview({ positions: { a: { x: 999, y: 0 } } }); old.rebase(); old.cancel(); old.finish();
  gestures.beginCardResize("a").cancel();
  expect(activeRef.current).toBe(active); expect(saved).not.toHaveBeenCalled();
  next.preview({ w: 80, h: 90 }); next.finish();
  expect(cardsRef.current[0].x).toBe(0); expect(cardsRef.current[0].w).toBe(80);
});

it("없는 대상을 시작하거나 잘못된 기하를 보내도 현재 끌기는 그대로 유지한다", () => {
  const move = gestures.beginCardMove(["a"], []);
  const active = activeRef.current;
  gestures.beginCardMove(["gone"], []).finish();
  gestures.beginGroupMove([], ["gone"]).cancel();
  gestures.beginCardResize("gone").finish();
  gestures.beginGroupResize("gone", rect).finish();
  expect(activeRef.current).toBe(active);
  expect(move.preview({ positions: { a: { x: Number.NaN, y: 9 } } })).toBe(false);
  expect(cardsRef.current[0].x).toBe(0);
  move.finish(); expect(saved).not.toHaveBeenCalled();
});

it("가져온 문서의 객체 속성명 같은 ID도 시작 때 지정한 대상만 바꾼다", () => {
  cardsRef.current = [card("a", 0), card("toString", 200), card("constructor", 400)];
  const move = gestures.beginCardMove(["a"], []);
  move.preview({ positions: { a: { x: 40, y: 0 }, toString: { x: 999, y: 0 }, constructor: { x: 999, y: 0 } } });
  expect(cardsRef.current.map((item) => item.x)).toEqual([40, 200, 400]);
  move.cancel(); expect(cardsRef.current.map((item) => item.x)).toEqual([0, 200, 400]);
  const named = gestures.beginCardMove(["toString"], []);
  named.preview({ positions: { toString: { x: 240, y: 0 } } }); named.cancel();
  expect(cardsRef.current.map((item) => item.x)).toEqual([0, 200, 400]);
});

it("원래 없던 카드 크기는 Esc 뒤에도 없고 버린 끌기가 redo를 소비하지 않는다", () => {
  cardsRef.current = [{ ...cardsRef.current[0], text: "typed" }, cardsRef.current[1]];
  history.persist(cardsRef.current, []); history.undo();
  const resize = gestures.beginCardResize("a");
  resize.preview({ w: 60, h: 80 });
  history.persist(cardsRef.current, []);
  resize.cancel();
  expect(cardsRef.current[0].w).toBeUndefined(); expect(cardsRef.current[0].h).toBeUndefined();
  history.redo(); expect(cardsRef.current[0].text).toBe("typed");
});

it("움직이기 전 rebase는 최신 크기를 Undo 출발점으로 삼고 이후 rebase는 기하만 재적용한다", () => {
  const resize = gestures.beginCardResize("a");
  cardsRef.current = [{ ...cardsRef.current[0], w: 330, h: 200 }, cardsRef.current[1]];
  history.commitDerivedState({ cards: cardsRef.current, edges: [], groups: [] });
  resize.rebase(); resize.preview({ w: 400, h: 240 });
  cardsRef.current = [{ ...cardsRef.current[0], w: 330, h: 200, text: "arrived" }, cardsRef.current[1]];
  resize.rebase(); expect(cardsRef.current[0]).toMatchObject({ w: 400, h: 240, text: "arrived" });
  resize.cancel(); expect(cardsRef.current[0]).toMatchObject({ w: 330, h: 200, text: "arrived" });
});

it("통째 이동의 멤버는 재배정하지 않고 삭제된 시작 프레임은 되살리지 않는다", () => {
  groupsRef.current = [{ id: "whole", name: "whole", cardIds: ["a"], rect }, { id: "gone", name: "gone", cardIds: ["b"], rect }];
  const move = gestures.beginCardMove(["a"], ["whole"]);
  move.preview({ positions: { a: { x: 220, y: 0 } }, rects: { whole: { ...rect, x: 220 } } });
  groupsRef.current = groupsRef.current.filter((item) => item.id !== "gone");
  move.finish({ startFrames: [{ id: "gone", frame: { ...rect, x: 200 } }], ejected: new Set(["a"]) });
  expect(groupsRef.current).toEqual([{ id: "whole", name: "whole", cardIds: ["a"], rect: { ...rect, x: 220 } }]);
  const single = gestures.beginCardMove(["b"], []);
  single.preview({ positions: { b: { x: 220, y: 0 } } });
  single.finish({ startFrames: [{ id: "gone", frame: { ...rect, x: 200 } }] });
  expect(groupsRef.current.map((item) => item.id)).toEqual(["whole"]);
});

it("느리게 프레임 밖에 놓으면 멤버를 유지하고 빠른 이탈만 기존 소속을 뺀다", () => {
  groupsRef.current = [{ id: "g", name: "g", cardIds: ["a"], rect }];
  const frames = [{ id: "g", frame: rect }];
  const slow = gestures.beginCardMove(["a"], []);
  slow.preview({ positions: { a: { x: 400, y: 0 } } }); slow.finish({ startFrames: frames });
  expect(groupsRef.current[0].cardIds).toEqual(["a"]);
  const fast = gestures.beginCardMove(["a"], []);
  fast.preview({ positions: { a: { x: 500, y: 0 } } }); fast.finish({ startFrames: frames, ejected: new Set(["a"]) });
  expect(groupsRef.current).toEqual([]);
});

it("자동 그룹의 no-move rebase 뒤 Esc는 rect를 만들지 않고 놓기는 최신 관측 프레임으로 고정한다", () => {
  groupsRef.current = [{ id: "g", name: "g", cardIds: ["a"] }];
  const resized = gestures.beginGroupResize("g", rect);
  resized.rebase({ ...rect, w: 200 }); resized.preview({ ...rect, w: 220 }); resized.cancel();
  expect(groupsRef.current[0].rect).toBeUndefined();
  const pressed = gestures.beginGroupResize("g", rect);
  pressed.rebase({ ...rect, w: 200 }); pressed.finish({ containedIds: ["a", "deleted"] });
  expect(groupsRef.current[0].rect).toEqual({ ...rect, w: 200 });
  expect(groupsRef.current[0].cardIds).toEqual(["a"]);
});

it("그룹 크기 확정은 기존 멤버를 보존하고 실존 관측 카드만 옮기며 삭제된 대상은 아무 소속도 바꾸지 않는다", () => {
  groupsRef.current = [{ id: "target", name: "target", cardIds: ["a"], rect }, { id: "other", name: "other", cardIds: ["b"] }];
  const resized = gestures.beginGroupResize("target", rect);
  resized.preview({ ...rect, w: 300 }); resized.finish({ containedIds: ["b", "deleted"] });
  expect(groupsRef.current.map((item) => [item.id, item.cardIds])).toEqual([["target", ["a", "b"]]]);
  const deleted = gestures.beginGroupResize("target", rect);
  deleted.preview({ ...rect, w: 400 }); groupsRef.current = [{ id: "other", name: "other", cardIds: ["b"] }];
  const before = saved.mock.calls.length;
  deleted.finish({ containedIds: ["b"] });
  expect(groupsRef.current).toEqual([{ id: "other", name: "other", cardIds: ["b"] }]);
  expect(saved).toHaveBeenCalledTimes(before);
});
