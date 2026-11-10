// @vitest-environment jsdom
// 줌(범위 크기 변경)도 새로 붙일 카드·선이 있을 때만 판을 다시 그린다 · 쉬면(150ms) 그때의 범위로 대상이 달라졌을 때만 정리 ·
//  누름·화면 맞춤·씬 전환·끌기 시작에서 정리 예약을 거둔다 · 보드 크기는 ResizeObserver 가 적어 둔 값(매 프레임 강제 읽기 없음) (2026-11-10)
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSceneViewport } from "../src/lib/useSceneViewport";
import { sceneViewRect, type SceneViewRect } from "../src/lib/sceneViewport";
import type { BeginSceneDrag } from "../src/lib/useSceneDragSession";

type Api = ReturnType<typeof useSceneViewport>;
let api: Api;
let root: Root | null = null;
let frames: FrameRequestCallback[] = [];
let resize: (() => void) | null = null;
let rect = { width: 1000, height: 600 };
const plain = (r: SceneViewRect | null) => r && { l: r.l + 0, t: r.t + 0, r: r.r + 0, b: r.b + 0 };

// 멀리 본 배율(20% — 보이는 범위 5000×3000)에서 줌 — 범위는 가장자리가 500 넘게 움직여야 다시 재므로(SCENE_CULL_REFRESH_DISTANCE) 몇 칸씩 돌린다
function Host({ gate, changed, sceneId = "s", busy = () => false, tick = 0 }: { gate: () => boolean; changed: () => boolean; sceneId?: string; busy?: () => boolean; tick?: number }) {
  void tick; // 같은 카메라로 다시 그리기만 하려고 바꾸는 값
  api = useSceneViewport({ sceneId, camera: { z: 0.2, x: 0, y: 0 }, cullingEnabled: true, shouldCommitView: gate, cullSetChanged: changed, isInteracting: busy });
  return <div ref={api.scrollRef}><div ref={api.gridRef} /><div ref={api.canvasRef} /></div>;
}

let readCount = 0;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  frames = [];
  rect = { width: 1000, height: 600 };
  readCount = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { resize = cb; } observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => {
    readCount++;
    return { x: 0, y: 0, left: 0, top: 0, width: rect.width, height: rect.height, right: rect.width, bottom: rect.height, toJSON: () => ({}) } as DOMRect;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const flush = () => act(async () => { for (let i = 0; i < 3; i++) frames.splice(0).forEach((cb) => cb(0)); });
const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
async function mount(gate: () => boolean, changed: () => boolean) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Host gate={gate} changed={changed} />));
  await flush();
}
const current = () => plain(sceneViewRect(api.getCamera(), rect));
const zoomSteps = async (dir: 1 | -1, n = 3) => {
  for (let i = 0; i < n; i++) await act(async () => api.stepZoom(dir));
  await flush();
};

it("확대: 판정이 거짓이면 확정하지 않고 최신 범위만 올린다 — 쉬면 대상이 달라졌을 때만 지금 범위로 정리, 휠을 이으면 예약을 다시 건다", async () => {
  const gate = vi.fn(() => false);
  let differ = false;
  const changed = vi.fn(() => differ);
  await mount(gate, changed);
  const first = api.viewRect;
  expect(plain(first)).toEqual({ l: 0, t: 0, r: 5000, b: 3000 });

  await zoomSteps(1);
  expect(gate).toHaveBeenCalledTimes(1);
  expect(api.viewRect).toBe(first);
  expect(plain(api.liveView.getSnapshot())).toEqual(current());
  await wait(100);
  await zoomSteps(1); // 이어서 더 — 예약을 거두고 다시 건다
  await wait(149);
  expect(changed).not.toHaveBeenCalled();
  await wait(1);
  expect(changed).toHaveBeenCalledTimes(1); // 쉼 정리 — 대상이 같다고 하면 그대로
  expect(api.viewRect).toBe(first);

  differ = true;
  await zoomSteps(1);
  await wait(150);
  expect(plain(api.viewRect)).toEqual(current()); // 지금 카메라의 범위로
  expect(api.liveView.getSnapshot()).toBe(api.viewRect);
});

it("줌을 건너뛴 뒤 다른 까닭으로 다시 그려져도(같은 카메라) 판정 없이 확정하지 않는다 — 걸린 예약도 늘이지 않는다", async () => {
  const gate = vi.fn(() => false);
  const changed = vi.fn(() => true);
  await mount(gate, changed);
  const first = api.viewRect;
  await zoomSteps(1);
  expect(api.viewRect).toBe(first);
  await wait(100);
  gate.mockClear();
  await act(async () => root!.render(<Host gate={gate} changed={changed} tick={1} />)); // 선택 바뀜 같은 다시 그리기
  await flush();
  expect(gate).toHaveBeenCalled(); // 확정값과 크기가 달라 다시 물었다
  expect(api.viewRect).toBe(first);
  await wait(50); // 처음 예약(150ms)이 그대로 — 다시 그리기가 늘이지 않았다
  expect(changed).toHaveBeenCalledTimes(1);
  expect(plain(api.viewRect)).toEqual(current());
});

it("휠 직후 화면 갱신 전에 카드를 쥐어도(예약보다 끌기 시작이 먼저) 쥐고 있는 동안은 쉼 정리를 미루고, 놓은 뒤 정리한다", async () => {
  let held = false;
  const changed = vi.fn(() => true);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Host gate={() => false} changed={changed} busy={() => held} />));
  await flush();
  const first = api.viewRect;
  for (let i = 0; i < 3; i++) await act(async () => api.stepZoom(1)); // 범위 계산(rAF)은 아직
  held = true;
  await act(async () => api.cancelSettle()); // 끌기 시작(holdMove) — 이때는 걸린 예약이 없다
  await flush(); // 이제 rAF — 예약이 걸린다
  await wait(400);
  expect(changed).not.toHaveBeenCalled(); // 쥐고 있는 동안 미룸
  expect(api.viewRect).toBe(first);
  held = false;
  await wait(150);
  expect(changed).toHaveBeenCalled();
  expect(plain(api.viewRect)).toEqual(current());
});

it("축소로 새 카드가 들어오면(판정 참) 바로 확정한다", async () => {
  await mount(() => true, () => true);
  await zoomSteps(-1);
  expect(plain(api.viewRect)).toEqual(current());
});

it("쉼 정리 예약은 가운데 버튼 누름·화면 맞춤·씬 전환·끌기 시작(cancelSettle)에서 거둔다", async () => {
  const changed = vi.fn(() => true);
  const zoomSkipped = () => zoomSteps(1);
  await mount(() => false, changed);
  const beginDrag: BeginSceneDrag = () => {};

  await zoomSkipped();
  api.beginPan({ button: 1, clientX: 10, clientY: 10, preventDefault: () => {} }, beginDrag);
  await wait(300);
  expect(changed).not.toHaveBeenCalled();

  await zoomSkipped();
  await act(async () => api.cancelSettle()); // SceneBoard 가 카드·그룹 끌기 시작(holdMove)에서 부른다
  await wait(300);
  expect(changed).not.toHaveBeenCalled();

  await zoomSkipped();
  await act(async () => root!.render(<Host gate={() => false} changed={changed} sceneId="s2" />));
  await wait(300);
  expect(changed).not.toHaveBeenCalled();
});

it("보드 크기는 ResizeObserver 가 적어 둔 값 — 끄는 걸음마다 getBoundingClientRect 를 읽지 않고, 크기 변경·숨김 뒤 복귀의 범위는 그 크기 그대로", async () => {
  await mount(() => true, () => true);
  let drag: { move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null = null;
  const beginDrag: BeginSceneDrag = (move, up) => { drag = { move, up }; };
  const before = readCount;
  api.beginPan({ button: 1, clientX: 500, clientY: 300, preventDefault: () => {} }, beginDrag);
  for (let i = 1; i <= 5; i++) {
    await act(async () => drag!.move(new MouseEvent("mousemove", { clientX: 500 - i * 200, clientY: 300 })));
    await flush();
  }
  await act(async () => drag!.up(new MouseEvent("mouseup")));
  await flush();
  expect(readCount).toBe(before); // 매 프레임 강제 읽기 없음

  rect = { width: 1200, height: 700 }; // 보드가 커졌다 — 관찰자가 알린다(20% 라 범위는 6000×3500)
  await act(async () => resize!());
  await flush();
  expect(plain(api.viewRect)).toEqual(current());
  expect(api.viewRect!.r - api.viewRect!.l).toBeCloseTo(6000);

  rect = { width: 0, height: 0 }; // 숨김
  await act(async () => resize!());
  await flush();
  rect = { width: 1000, height: 600 }; // 복귀
  await act(async () => resize!());
  await flush();
  expect(api.viewRect!.r - api.viewRect!.l).toBeCloseTo(5000);
  expect(api.viewRect!.b - api.viewRect!.t).toBeCloseTo(3000);
});
