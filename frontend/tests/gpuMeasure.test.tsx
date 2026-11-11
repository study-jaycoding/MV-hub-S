// @vitest-environment jsdom
// GPU 보기 모드의 숨은 측정 칸(features/canvas/gpu/GpuMeasure) — 프레임마다 최대 4장을 화면 밖에 붙여 크기를 재고, 결과를 모아(묶음 8개마다·다 재면)
//  씬 id 와 함께 넘긴다(docs/status/캔버스_GPU판설계_2026-11-11.md 계약 size). jsdom 은 배치를 안 하므로 크기는 data-* 로 흉내 낸다.
//  프레임은 손으로 돌린다(requestAnimationFrame 을 대기열로 바꿈).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GpuMeasure, GPU_MEASURE_BATCH, type GpuMeasureItem } from "../src/features/canvas/gpu/GpuMeasure";

let root: Root;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 1;
const runFrame = () => act(() => {
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb(performance.now());
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.set(nextFrame, cb); return nextFrame++; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // 측정 칸 안 카드 = 속(data-h·data-w)의 크기
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return Number((this as HTMLElement).querySelector("[data-h]")?.getAttribute("data-h") ?? 0); } });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return Number((this as HTMLElement).querySelector("[data-w]")?.getAttribute("data-w") ?? 0); } });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
});

const item = (id: string, h: number, w = 260): GpuMeasureItem => ({ id, sig: "s-" + id, className: "scene-card-ref", width: 260, node: <div data-h={h} data-w={w} /> });
const shown = () => [...host.querySelectorAll(".scene-gpu-measure > .scene-card [data-h]")].map((el) => el.getAttribute("data-h"));

it("프레임마다 최대 4장만 붙여 재고, 다 재면 씬 id·지문과 함께 한 번에 넘긴다 — 같은 프레임에 다음 묶음으로 이어 가지 않는다", () => {
  const onMeasured = vi.fn();
  const items = Array.from({ length: 10 }, (_, i) => item("c" + (i + 1), 101 + i));
  act(() => root.render(<GpuMeasure sceneId="A" items={items} onMeasured={onMeasured} />));
  expect(GPU_MEASURE_BATCH).toBe(4);
  expect(shown()).toEqual(["101", "102", "103", "104"]);
  expect(onMeasured).not.toHaveBeenCalled(); // layout 단계에서 바로 넘기지 않는다
  runFrame();
  expect(shown()).toEqual(["105", "106", "107", "108"]);
  runFrame();
  expect(shown()).toEqual(["109", "110"]);
  expect(onMeasured).not.toHaveBeenCalled();
  runFrame();
  expect(onMeasured).toHaveBeenCalledTimes(1);
  expect(onMeasured.mock.calls[0][0]).toBe("A");
  expect(onMeasured.mock.calls[0][1]).toEqual(items.map((it, i) => ({ id: it.id, sig: it.sig, w: 260, h: 101 + i })));
});

it("오래 걸리면 묶음 8개(32장)마다 모아 넘긴다 — 묶음마다 부모를 다시 그리지 않는다", () => {
  const onMeasured = vi.fn();
  const items = Array.from({ length: 40 }, (_, i) => item("c" + i, 50));
  act(() => root.render(<GpuMeasure sceneId="A" items={items} onMeasured={onMeasured} />));
  for (let i = 0; i < 8; i++) runFrame();
  expect(onMeasured).toHaveBeenCalledTimes(1);
  expect(onMeasured.mock.calls[0][1]).toHaveLength(32);
  runFrame();
  runFrame();
  expect(onMeasured).toHaveBeenCalledTimes(2);
  expect(onMeasured.mock.calls[1][1]).toHaveLength(8);
});

it("잴 것이 없으면 칸을 그리지도 부르지도 않는다 — 높이 0(못 잼)도 넘겨 같은 카드가 자리를 계속 차지하지 않게 한다", () => {
  const onMeasured = vi.fn();
  act(() => root.render(<GpuMeasure sceneId="A" items={[]} onMeasured={onMeasured} />));
  expect(host.querySelector(".scene-gpu-measure")).toBeNull();
  runFrame();
  expect(onMeasured).not.toHaveBeenCalled();
  act(() => root.render(<GpuMeasure sceneId="A" items={[item("z", 0)]} onMeasured={onMeasured} />));
  runFrame();
  expect(onMeasured).toHaveBeenCalledWith("A", [{ id: "z", sig: "s-z", w: 260, h: 0 }]);
});

it("씬이 바뀌면 걸어 둔 넘기기를 취소하고 새 씬의 결과만 넘긴다", () => {
  const onMeasured = vi.fn();
  act(() => root.render(<GpuMeasure sceneId="A" items={[item("a", 10)]} onMeasured={onMeasured} />));
  act(() => root.render(<GpuMeasure sceneId="B" items={[item("b", 20)]} onMeasured={onMeasured} />));
  runFrame();
  expect(onMeasured).toHaveBeenCalledTimes(1);
  expect(onMeasured).toHaveBeenCalledWith("B", [{ id: "b", sig: "s-b", w: 260, h: 20 }]);
});

it("고정 폭(레퍼런스)은 칸에 폭을 준다 — 제목처럼 폭이 없으면 내용에 맞춘다", () => {
  act(() => root.render(<GpuMeasure sceneId="A" items={[item("r", 50), { ...item("h", 40), width: undefined, className: "scene-card-head" }]} onMeasured={() => {}} />));
  const [ref, head] = [...host.querySelectorAll<HTMLElement>(".scene-gpu-measure > .scene-card")];
  expect(ref.style.width).toBe("260px");
  expect(head.style.width).toBe("");
  expect(head.className).toContain("scene-card-head");
});
