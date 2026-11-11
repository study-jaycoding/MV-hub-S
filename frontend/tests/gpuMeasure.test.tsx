// @vitest-environment jsdom
// GPU 보기 모드의 숨은 측정 칸(features/canvas/gpu/GpuMeasure) — 한 번에 4장까지 화면 밖에 붙여 크기를 재고, 결과를 씬 id 와 함께 넘긴다
//  (docs/status/캔버스_GPU판설계_2026-11-11.md 계약 size). jsdom 은 배치를 안 하므로 크기는 data-* 로 흉내 낸다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GpuMeasure, GPU_MEASURE_BATCH, type GpuMeasureItem } from "../src/features/canvas/gpu/GpuMeasure";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

it("한 번에 최대 4장만 붙여 재고, 씬 id·지문과 함께 넘긴다", () => {
  const onMeasured = vi.fn();
  const items = [1, 2, 3, 4, 5, 6].map((n) => item("c" + n, 100 + n));
  act(() => root.render(<GpuMeasure sceneId="A" items={items} onMeasured={onMeasured} />));
  expect(GPU_MEASURE_BATCH).toBe(4);
  expect(host.querySelectorAll(".scene-gpu-measure > .scene-card")).toHaveLength(4);
  expect(onMeasured).toHaveBeenCalledTimes(1);
  expect(onMeasured.mock.calls[0][0]).toBe("A");
  expect(onMeasured.mock.calls[0][1]).toEqual([1, 2, 3, 4].map((n) => ({ id: "c" + n, sig: "s-c" + n, w: 260, h: 100 + n })));
});

it("잴 것이 없으면 칸을 그리지도 부르지도 않는다 — 높이 0(못 잼)은 넘기지 않는다", () => {
  const onMeasured = vi.fn();
  act(() => root.render(<GpuMeasure sceneId="A" items={[]} onMeasured={onMeasured} />));
  expect(host.querySelector(".scene-gpu-measure")).toBeNull();
  act(() => root.render(<GpuMeasure sceneId="A" items={[item("z", 0)]} onMeasured={onMeasured} />));
  expect(onMeasured).not.toHaveBeenCalled();
});

it("고정 폭(레퍼런스)은 칸에 폭을 준다 — 제목처럼 폭이 없으면 내용에 맞춘다", () => {
  act(() => root.render(<GpuMeasure sceneId="A" items={[item("r", 50), { ...item("h", 40), width: undefined, className: "scene-card-head" }]} onMeasured={() => {}} />));
  const [ref, head] = [...host.querySelectorAll<HTMLElement>(".scene-gpu-measure > .scene-card")];
  expect(ref.style.width).toBe("260px");
  expect(head.style.width).toBe("");
  expect(head.className).toContain("scene-card-head");
});
