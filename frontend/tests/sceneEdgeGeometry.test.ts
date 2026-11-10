// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import * as sceneEdges from "../src/lib/sceneEdges";
import { buildEdgeGeometry, buildWireTraceGeometry, edgeBoxOutside, edgeClassName, type EdgeGeometryInput, type EdgeLane } from "../src/lib/sceneEdges";
import type { SceneCard, SceneEdge, SceneEdgeRole } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";
import { SceneBoard } from "../src/components/scene/SceneBoard";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const card = (id: string, kind: SceneCard["kind"], x: number, y: number, w = 152, h = 131): SceneCard => ({ id, kind, x, y, w, h });
const size = (c: SceneCard) => ({ w: c.w!, h: c.h! });
const laneDelta = (lane: EdgeLane, c: SceneCard) => {
  const slots: EdgeLane[] = c.kind === "generation" ? ["model", "ref", "text", "set"] : ["ref", "text"];
  const gap = Math.min(26, Math.max(8, (c.h! - 16) / (slots.length - 1)));
  const i = slots.indexOf(lane);
  return i < 0 ? 0 : (i - (slots.length - 1) / 2) * gap;
};
const laneOf = (role?: SceneEdgeRole): EdgeLane => role === "model" ? "model" : role === "text" ? "text" : role === "set" ? "set" : "ref";
const inputFor = (cards: SceneCard[], edges: SceneEdge[]): EdgeGeometryInput => {
  const inEdges = new Map<string, SceneEdge[]>(), outEdges = new Map<string, SceneEdge[]>(), inEdgesLaned = new Map<string, SceneEdge[]>();
  const add = (m: Map<string, SceneEdge[]>, key: string, e: SceneEdge) => m.set(key, [...m.get(key) ?? [], e]);
  for (const e of edges) {
    add(inEdges, e.to, e);
    add(outEdges, e.from, e);
    add(inEdgesLaned, e.to + ":" + laneOf(e.role), e);
  }
  return { cardsById: new Map(cards.map((c) => [c.id, c])), edges, cardSize: size, laneDelta,
    edgeRoles: new Map(edges.filter((e) => e.role).map((e) => [e.id, e.role!])), inEdges, outEdges, inEdgesLaned };
};

// 추출 전의 끝점·문자열 계산을 독립적으로 고정해 같은 함수를 두 번 부르는 시험이 되지 않게 한다.
function oldGeometry(input: EdgeGeometryInput) {
  return input.edges.flatMap((e) => {
    const a = input.cardsById.get(e.from), b = input.cardsById.get(e.to);
    if (!a || !b) return [];
    const lane = laneOf(input.edgeRoles.get(e.id) || "ref");
    const laned = b.kind === "generation" || b.kind === "comfy";
    const fanList = laned ? input.inEdgesLaned.get(b.id + ":" + lane) : input.inEdges.get(b.id);
    const x1 = Math.round(a.x + input.cardSize(a).w + 24), y1 = Math.round(a.y + input.cardSize(a).h / 2);
    const x2 = Math.round(b.x - 24), y2 = Math.round(b.y + input.cardSize(b).h * 0.5 + (laned ? input.laneDelta(lane, b) : 0));
    const m1 = (input.outEdges.get(a.id)?.length ?? 0) > 1, m2 = (fanList?.length ?? 0) > 1;
    const sx = m1 ? x1 + 28 / 3 : x1, ex = m2 ? x2 - 28 / 3 : x2, mx = (sx + ex) / 2;
    const d = `M ${x1} ${y1}` + (m1 ? ` L ${sx} ${y1}` : "") + ` C ${mx} ${y1}, ${mx} ${y2}, ${ex} ${y2}` + (m2 ? ` L ${x2} ${y2}` : "");
    return [{ id: e.id, from: e.from, to: e.to, x1, y1, x2, y2, m1, m2, d,
      box: { l: Math.min(x1, x2), t: Math.min(y1, y2), r: Math.max(x1, x2), b: Math.max(y1, y2) } }];
  });
}

describe("buildEdgeGeometry", () => {
  it.each([false, true].flatMap((m1) => [false, true].map((m2) => ({ m1, m2 }))))("합쳐짐 $m1/$m2 와 역방향·소수·측정 크기의 문자열·상자 등가", ({ m1, m2 }) => {
    const cards = [card("a", "reference", 500.2, -10.8, 155, 115), card("b", "text", -100, 90), card("c", "text", 800, 200)];
    const edges: SceneEdge[] = [{ id: "e", from: "a", to: "b" }];
    if (m1) edges.push({ id: "out", from: "a", to: "c" });
    if (m2) edges.push({ id: "in", from: "c", to: "b" });
    edges.push({ id: "missing", from: "gone", to: "c" }); // 없는 카드의 선은 건너뛴다 — b 의 들어오는 선 수(m2)에는 넣지 않는다
    const input = inputFor(cards, edges);
    input.cardSize = (c) => c.id === "a" ? { w: 191, h: 117 } : size(c);
    const actual = buildEdgeGeometry(input), old = oldGeometry(input);
    expect(actual.edges).toEqual(old);
    expect(actual.edges[0]).toMatchObject({ m1, m2 });
    expect(actual.cullEdgeBoxes).toEqual(old.map((e) => e.box));
  });

  it.each(["generation", "comfy"] as const)("%s 다입력 레인별 합쳐짐·위치", (kind) => {
    const cards = [card("a", "text", 0, 0), card("b", kind, 700, 50, 200, 70), card("c", "model", 0, 300)];
    const edges: SceneEdge[] = ["model", "text", "set", "ref", "lineage"].map((role, i) => ({ id: "e" + i, from: i % 2 ? "a" : "c", to: "b", role: role as SceneEdgeRole }));
    const input = inputFor(cards, edges);
    const geometry = buildEdgeGeometry(input);
    expect(geometry.edges).toEqual(oldGeometry(input));
    expect(geometry.edges.map((e) => e.m2)).toEqual([false, false, false, true, true]);
    expect(geometry.cullEdgeBoxes).toEqual(oldGeometry(input).map((e) => e.box));
  });

  it("숨긴 우회선·접힌 그룹의 문자열과 일반선만 들어가는 컬링 순서", () => {
    const cards = [card("a", "text", 1, 2), card("b", "reference", 500, 400), card("hidden", "text", 250, 200)];
    const edges = [{ id: "e", from: "b", to: "a" }];
    const input = inputFor(cards, edges);
    input.bridgeEdges = sceneEdges.computeBridgeEdges(cards, [{ id: "x", from: "a", to: "hidden" }, { id: "y", from: "hidden", to: "b" }], new Set(["hidden"]));
    input.groupBridges = [{ id: "gb", from: "a", to: "b", a: { x: 10.2, y: 20.5 }, b: { x: 500.1, y: -3 }, role: "text", ref: false, refg: false }];
    const geometry = buildEdgeGeometry(input);
    const [a, b] = cards;
    const x1 = a.x + a.w!, y1 = a.y + a.h! / 2, x2 = b.x, y2 = b.y + b.h! / 2, mx = (x1 + x2) / 2;
    expect(geometry.bridges[0].d).toBe(`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
    expect(geometry.groupBridges[0].d).toBe("M 10.2 20.5 C 255.15 20.5, 255.15 -3, 500.1 -3");
    expect(geometry.cullEdgeBoxes).toEqual(oldGeometry(input).map((e) => e.box));
    const rect = geometry.cullEdgeBoxes[0];
    expect(edgeBoxOutside(rect, { l: rect.r, t: rect.b, r: rect.r + 10, b: rect.b + 10 })).toBe(false);
    expect(edgeBoxOutside(rect, { l: rect.r + 1, t: rect.b, r: rect.r + 10, b: rect.b + 10 })).toBe(true);
    expect(edgeBoxOutside(rect, null)).toBe(false);
  });

  it("무선 짝 화살표는 옛 path 그대로, 없는 카드·겹친 카드는 생략", () => {
    const cards = [card("out", "output", 0, 0, 100, 100), { ...card("in", "input", 400, 0, 100, 100), channel: "out" }];
    const byId = new Map(cards.map((c) => [c.id, c]));
    const pairs = sceneEdges.wireTracePairs("out", cards, byId);
    expect(buildWireTraceGeometry(pairs, byId, size)).toEqual([{ id: "trace:in", from: "out", to: "in", d: "M 106 50 Q 250 93.2 394 50" }]);
    expect(buildWireTraceGeometry([["gone", "in"], ["out", "out"]], byId, size)).toEqual([]);
    expect(buildWireTraceGeometry([["in", "out"]], byId, size)[0].d).toBe("M 394 50 Q 250 6.8 106 50");
  });

  it("색·선택·pending·cut 문자열은 기존 우선순위 그대로", () => {
    const roles: (SceneEdgeRole | undefined)[] = [undefined, "model", "text", "set", "ref", "lineage", "list"];
    for (const role of roles) for (let mask = 0; mask < 32; mask++) {
      const [active, ref, refg, pending, cut] = [1, 2, 4, 8, 16].map((bit) => !!(mask & bit));
      const old = "scene-edge" + (active ? (role === "model" ? " model" : role === "text" ? " text" : role === "set" ? " set" : ref ? " ref" : refg ? " refg" : role === "ref" ? " ref" : "") + " onsel" : " idle") + (pending ? " pending" : "") + (cut ? " cut" : "");
      expect(edgeClassName({ role, active, ref, refg, pending, cut })).toBe(old);
    }
  });
});

it("실제 SceneBoard는 선택만 바꾸면 일반선 기하를 재계산하지 않고 색만 바꾼다", async () => {
  const noop = () => {};
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network"))));
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = noop; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const [w, h] = this.matches(".scene-board") ? [1000, 600] : [0, 0];
    return { x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h, toJSON: noop } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches(".scene-card") ? 131 : 0;
  });
  localStorage.clear();
  sessionStorage.clear();
  fixture.data = { genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {} } as unknown as SceneGenDataApi;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const build = vi.spyOn(sceneEdges, "buildEdgeGeometry");
  const flush = () => act(async () => { for (let i = 0; i < 4; i++) frames.splice(0).forEach((cb) => cb(0)); });
  try {
    const scene = { id: "S", name: "S", created_at: 0, groups: [], cards: [card("a", "text", 100, 100), card("b", "text", 500, 100)], edges: [{ id: "e", from: "a", to: "b", role: "text" }] } as never;
    await act(async () => { root.render(createElement(SceneBoard, { scene, onChange: noop })); });
    await flush();
    const path = () => host.querySelector(".scene-edge")!;
    const before = path().getAttribute("d");
    expect(path().classList.contains("idle")).toBe(true);
    build.mockClear();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true, bubbles: true, cancelable: true })); });
    await flush();
    expect(path().classList.contains("onsel")).toBe(true);
    expect(path().getAttribute("d")).toBe(before);
    expect(build).not.toHaveBeenCalled();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); });
    await flush();
    expect(path().classList.contains("idle")).toBe(true);
    expect(build).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
