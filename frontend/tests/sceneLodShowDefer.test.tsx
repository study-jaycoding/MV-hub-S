// @vitest-environment jsdom
// 멀리 보기 단순화(data-lod-low) — 25% 이하로 내려가면 바로 숨기고, 25% 를 넘게 올라가면 배율이 150ms 쉰 뒤에 다시 보인다
//  (docs/status/캔버스_LOD보이기미루기_2026-11-10.md — 확대 도중 경계를 넘자마자 카드 수백 장의 작은 조각을 칠했다). 실제 useSceneViewport 로.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSceneViewport } from "../src/lib/useSceneViewport";

let api: ReturnType<typeof useSceneViewport>;
let root: Root;
let host: HTMLDivElement;
let renderTick = 0;

function Host({ sceneId, z }: { sceneId: string; z: number; tick?: number }) {
  api = useSceneViewport({ sceneId, camera: { z, x: 0, y: 0 }, cullingEnabled: false });
  return <div ref={api.scrollRef}><div ref={api.gridRef} /><div ref={api.canvasRef} /></div>;
}
const board = () => api.scrollRef.current!;
const low = () => board().hasAttribute("data-lod-low");
const wheel = (deltaY: number) =>
  act(() => { board().dispatchEvent(new WheelEvent("wheel", { deltaY, clientX: 500, clientY: 300, bubbles: true, cancelable: true })); });
/** 배율이 조건을 넘을 때까지 휠 — 한 칸 ×1.1 */
async function wheelUntil(deltaY: number, done: (pct: number) => boolean) {
  for (let i = 0; i < 40 && !done(Math.round(api.zoomRef.current * 100)); i += 1) await wheel(deltaY);
}
const show = (props: { sceneId: string; z: number }) => act(() => { root.render(<Host {...props} tick={(renderTick += 1)} />); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, toJSON: () => ({}) } as DOMRect,
  );
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("25% 이하로 내려가면 바로 숨기고, 넘게 올라가면 150ms 쉰 뒤에 다시 보인다", async () => {
  await show({ sceneId: "s", z: 0.5 });
  expect(low()).toBe(false);
  await wheelUntil(100, (pct) => pct <= 25);
  expect(low()).toBe(true); // 타이머 없이 바로
  await wheelUntil(-100, (pct) => pct > 25);
  expect(low()).toBe(true); // 아직 숨긴 채
  await act(() => { vi.advanceTimersByTime(149); });
  expect(low()).toBe(true);
  await act(() => { vi.advanceTimersByTime(1); });
  expect(low()).toBe(false);
});

it("다시 보이기를 기다리는 동안 같은 배율로 다시 그려져도 예약이 늘지 않고, 다시 25% 이하로 내려가면 예약을 지운다", async () => {
  await show({ sceneId: "s", z: 0.2 });
  expect(low()).toBe(true);
  await wheelUntil(-100, (pct) => pct > 25);
  await act(() => { vi.advanceTimersByTime(100); });
  await show({ sceneId: "s", z: 0.2 }); // 같은 씬·같은 카메라 — 보드만 다시 그려진다(applyTransform 이 다시 돈다)
  await act(() => { vi.advanceTimersByTime(50); });
  expect(low()).toBe(false); // 다시 그리기가 150ms 를 새로 세지 않았다

  await wheelUntil(100, (pct) => pct <= 25);
  expect(low()).toBe(true);
  await wheelUntil(-100, (pct) => pct > 25); // 다시 보이기 예약
  await act(() => { vi.advanceTimersByTime(80); });
  await wheelUntil(100, (pct) => pct <= 25); // 기다리는 동안 다시 내려감
  await act(() => { vi.advanceTimersByTime(300); });
  expect(low()).toBe(true); // 예약이 지워져 켠 채 남는다
});

it("씬을 바꾸면 새 씬의 배율로 바로 정하고, 언마운트하면 예약을 남기지 않는다", async () => {
  await show({ sceneId: "a", z: 0.2 });
  expect(low()).toBe(true);
  await show({ sceneId: "b", z: 0.5 });
  expect(low()).toBe(false); // 기다리지 않고 바로
  await show({ sceneId: "c", z: 0.2 });
  expect(low()).toBe(true);
  await wheelUntil(-100, (pct) => pct > 25); // 다시 보이기 예약을 걸어 둔 채
  const before = vi.getTimerCount();
  expect(before).toBeGreaterThan(0);
  act(() => root.unmount());
  expect(vi.getTimerCount()).toBeLessThan(before);
  root = createRoot(host);
});
