// @vitest-environment jsdom
// GPU 판 칸(features/canvas/gpu/GpuBoard)의 프레임 루프 — 렌더러·아틀라스만 가짜로 두고 진짜 GpuBoard 를 돌린다
//  (docs/status/캔버스_GPU판설계_2026-11-11.md 계약 mode·transition·camera). jsdom 에는 WebGL 이 없다.
//  본다: 켤 때 검사는 표본 30개·모두 유한해야 믿는다 · 검사 결과는 카메라가 쉬고 화면을 끌지 않을 때 알린다 ·
//  렌더만 다시 해서(카메라 그대로) 알림이 와도 '조작 중'이 아니다 · 끝나면 컨텍스트를 놓는다.
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GpuSceneModel } from "../src/features/canvas/gpu/gpuScene";

const fx = vi.hoisted(() => ({ samples: [] as number[] | Error, destroyed: 0, draws: 0, timed: 0 }));
vi.mock("../src/features/canvas/gpu/gpuRenderer", () => ({
  createGpuRenderer: () => ({
    setScene() {}, setHidden() {}, setLowLod() {},
    draw() { fx.draws++; },
    timeGpu() { fx.timed++; return fx.samples instanceof Error ? Promise.reject(fx.samples) : Promise.resolve(fx.samples); },
    textureBytes: () => 0, texturePeak: () => 0, lost: () => false,
    destroy() { fx.destroyed++; },
    ensurePage() {}, upload() {}, deletePage() {},
  }),
}));
vi.mock("../src/features/canvas/gpu/cardAtlas", () => ({
  createCardAtlas: () => ({
    sync() {}, tick: () => ({ uploadedPx: 0, pending: 0, baked: 0 }), lookup: () => ({ page: 0 }),
    textureBytes: () => 0, cpuBytes: () => 0, cpuPeak: () => 0, reset() {}, dispose() {},
  }),
}));
const { GpuBoard } = await import("../src/features/canvas/gpu/GpuBoard");

let host: HTMLDivElement;
let root: Root;
let now = 1000;
let frames: FrameRequestCallback[] = [];
let listeners: Array<(ms: number) => void> = [];
const cam = { z: 1, x: 0, y: 0 };
const source = {
  subscribe: (l: (ms: number) => void) => { listeners.push(l); return () => { listeners = listeners.filter((x) => x !== l); }; },
  getSnapshot: () => cam,
};
const model: GpuSceneModel = { requests: [], cards: [{ id: "a", x: 0, y: 0, w: 100, h: 100, radius: 12, border: [0, 0, 0, 0], borderWidth: 2, hidden: false, z: 0 }], lines: [], rects: [], dots: [], quads: [], undrawable: [] };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  frames = [];
  listeners = [];
  now = 1000;
  Object.assign(fx, { samples: Array(30).fill(2), destroyed: 0, draws: 0, timed: 0 });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => now);
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

/** at 시각에 걸린 프레임을 돌리고, 검사 약속(마이크로태스크)을 푼다 */
const frameAt = (at: number) => act(async () => {
  now = at;
  for (const cb of frames.splice(0)) cb(at);
  await Promise.resolve();
  await Promise.resolve();
});
function mount(dispatch: ReturnType<typeof vi.fn>, phase: "probing" | "gpu" = "probing") {
  const boardRef = createRef<HTMLDivElement>();
  function Harness() {
    return (
      <div className="scene-board" ref={boardRef}>
        <GpuBoard phase={phase} token={1} sceneId="s" model={model} hiddenId={null} cameraSource={source} boardRef={boardRef}
          dispatch={dispatch} onHover={() => {}} overlayPinned={false} />
      </div>
    );
  }
  act(() => root.render(<Harness />));
  return boardRef;
}
const probes = (d: ReturnType<typeof vi.fn>) => d.mock.calls.map((c) => c[0]).filter((e) => e.type === "probe");

it("켤 때 검사 결과는 카메라가 150ms 쉰 뒤에야 알린다 — 검사 도중 시작한 이동 사이에 판을 바꾸지 않는다", async () => {
  const dispatch = vi.fn();
  mount(dispatch);
  act(() => listeners.forEach((l) => l(0))); // 검사가 도는 사이 화면을 옮김(now=1000)
  await frameAt(1010); // 검사 시작 → 결과가 옴
  expect(fx.timed).toBe(1);
  await frameAt(1100); // 아직 쉬는 중이 아님
  expect(probes(dispatch)).toEqual([]);
  await frameAt(1160);
  expect(probes(dispatch)).toEqual([{ type: "probe", token: 1, medianMs: 2 }]);
});

it("화면을 끄는 동안(data-panning)은 쉬어도 검사 결과를 붙잡아 둔다", async () => {
  const dispatch = vi.fn();
  const board = mount(dispatch);
  board.current!.setAttribute("data-panning", "");
  await frameAt(1200);
  await frameAt(1400);
  expect(probes(dispatch)).toEqual([]);
  board.current!.removeAttribute("data-panning");
  await frameAt(1420);
  expect(probes(dispatch)).toHaveLength(1);
});

it.each([
  ["몇 개 뒤 끊긴 짧은 배열", [1, 1, Infinity]],
  ["유한하지 않은 표본", [...Array(29).fill(1), NaN]],
  ["거부(측정 실패)", new Error("disjoint")],
])("표본이 정확히 30개·모두 유한이 아니면 느린 GPU 로 본다 — %s", async (_name, samples) => {
  fx.samples = samples as number[] | Error;
  const dispatch = vi.fn();
  mount(dispatch);
  await frameAt(1200);
  await frameAt(1210);
  expect(probes(dispatch)).toEqual([{ type: "probe", token: 1, medianMs: Infinity }]);
});

it("실제 화면 이동 중 50ms 넘는 프레임 3번이면 느린 GPU 로 잠근다(알림은 한 번) — 값이 그대로인 알림은 카메라 출처가 거른다(sceneViewport 시험)", async () => {
  const dispatch = vi.fn();
  mount(dispatch, "gpu");
  await frameAt(1000);
  // 실제 이동: 50ms 넘는 프레임 3번 → 느린 GPU
  for (let i = 0; i < 3; i++) {
    cam.x += 10;
    act(() => listeners.forEach((l) => l(0)));
    await frameAt(now + 5);
    await frameAt(now + 70);
  }
  expect(dispatch.mock.calls.map((c) => c[0])).toContainEqual({ type: "failure", reason: "slow-frames" });
  cam.x = 0;
});

it("내려가면 렌더러를 놓는다(destroy — 컨텍스트 놓기는 렌더러 시험이 본다)", () => {
  mount(vi.fn());
  act(() => root.render(<div />));
  expect(fx.destroyed).toBe(1);
});
