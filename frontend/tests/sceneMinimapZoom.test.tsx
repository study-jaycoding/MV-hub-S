// @vitest-environment jsdom
// 캔버스 줌 막대 [− 비율 +] — 툴바에서 네비게이터(미니맵) 위로 옮겼다(Jay 2026-10-30 A안 · "네비게이터 없으면 보이지 않는다").
//  기록: docs/status/캔버스_줌막대_보기단추_2026-10-30.md
//  · 미니맵과 같이 보이고 숨는다 · 비율에 올리면 'Fit'(CSS) · 누르면 맞춤 · −/+ = 한 단계 · 누름은 미니맵 이동·보드로 새지 않는다
//  · 줌 막대가 들어가게 좁은 미니맵은 132px 로 넓히고 카드·보는 영역·누른 자리를 가운데로 민다
import { act, type MutableRefObject } from "react";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneMinimap } from "../src/components/scene/SceneMinimap";
import { setSceneZoomPct } from "../src/lib/sceneZoomStore";

let host: HTMLDivElement;
let root: Root;
let observers: Array<() => void>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observers = [];
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const ref = <T,>(current: T) => ({ current }) as MutableRefObject<T>;
const board = () => {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { get: () => 800 });
  Object.defineProperty(el, "clientHeight", { get: () => 600 });
  return el;
};
const draw = (opts: { maxX: number; maxY: number; zoom?: { onFit: () => void; onStep: (dir: 1 | -1) => void }; onNavigate?: () => void; boxes?: { id: string; x: number; y: number; w: number; h: number; kind: string }[] }) => {
  act(() => root.render(
    <SceneMinimap boxes={opts.boxes ?? []} bounds={{ minX: 0, minY: 0, maxX: opts.maxX, maxY: opts.maxY }} selected={new Set()} scrollRef={ref(board())}
      panRef={ref({ x: 0, y: 0 })} zoomRef={ref(1)} updateRef={ref<(() => void) | null>(null)} onNavigate={opts.onNavigate ?? (() => {})} zoom={opts.zoom} />,
  ));
  act(() => observers.forEach((cb) => cb())); // 보드 크기를 알려 오면 보이기/숨기기를 정한다
};
const bar = () => host.querySelector<HTMLElement>(".scene-minimap-zoom");
const map = () => host.querySelector<HTMLElement>(".scene-minimap")!;
const spies = () => ({ onFit: vi.fn(), onStep: vi.fn() });

it("미니맵과 같이 보이고 숨는다 — 화면 밖 카드가 없으면 막대도 없다", () => {
  draw({ maxX: 3000, maxY: 1000, zoom: spies() }); // 카드(3000)가 화면(800) 밖
  expect([map().style.display, bar()!.style.display]).toEqual(["block", "flex"]);
  draw({ maxX: 500, maxY: 400, zoom: spies() }); // 다 화면 안
  expect([map().style.display, bar()!.style.display]).toEqual(["none", "none"]);
});

it("비율 칸 = 지금 % (올리면 'Fit' — CSS) · 누르면 맞춤 · −/+ = 한 단계 · 누름은 미니맵 이동으로 새지 않는다", () => {
  const zoom = spies();
  const onNavigate = vi.fn();
  act(() => setSceneZoomPct(97));
  draw({ maxX: 3000, maxY: 1000, zoom, onNavigate });
  const [minus, fit, plus] = [...bar()!.querySelectorAll("button")];
  expect([fit.querySelector(".scene-minimap-pct")!.textContent, fit.querySelector(".scene-minimap-fitword")!.textContent]).toEqual(["97%", "Fit"]);
  act(() => setSceneZoomPct(120));
  expect(fit.querySelector(".scene-minimap-pct")!.textContent).toBe("120%");
  act(() => { fit.click(); minus.click(); plus.click(); });
  expect([zoom.onFit.mock.calls.length, zoom.onStep.mock.calls]).toEqual([1, [[-1], [1]]]);
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  act(() => { fit.dispatchEvent(press); });
  expect([press.defaultPrevented, onNavigate.mock.calls.length]).toEqual([true, 0]); // 초점도 안 옮기고 캔버스도 안 움직인다
  // 비율 ↔ Fit 은 마우스 올림 CSS 로 바뀐다
  const css = readFileSync(new NodeURL("../src/styles/scene.css", import.meta.url), "utf8");
  expect(css).toContain(".scene-minimap-fit:hover .scene-minimap-pct { display: none; }");
  expect(css).toContain(".scene-minimap-fit:hover .scene-minimap-fitword { display: inline; }");
});

it("좁은 미니맵은 132px 로 넓히고 카드·보는 영역을 가운데로 민다 — 막대를 안 주면 지금 그대로", () => {
  // 세로로 긴 씬: 폭 = 60+300+60 = 420 · 높이 = 60+3000+60 = 3120 → 높이 130 에 맞춰 축소 → 폭 ≈ 17.5 → 최소 40
  const boxes = [{ id: "a", x: 0, y: 0, w: 300, h: 300, kind: "generation" }];
  draw({ maxX: 300, maxY: 3000, zoom: spies(), boxes });
  const scale = 130 / 3120;
  const mmW = Math.max(40, 420 * scale);
  const off = (132 - mmW) / 2;
  expect([bar()!.style.width, map().style.width]).toEqual(["132px", "132px"]);
  expect(parseFloat(host.querySelector<HTMLElement>(".scene-minimap-card")!.style.left)).toBeCloseTo(60 * scale + off);
  const viewX = parseFloat(host.querySelector<HTMLElement>(".scene-minimap-view")!.style.transform.replace("translate(", ""));
  expect(viewX - off).toBeGreaterThanOrEqual(0); // 보는 영역도 같은 만큼 밀렸다(미니맵 안쪽)
  expect(viewX - off).toBeLessThanOrEqual(mmW);
  draw({ maxX: 300, maxY: 3000, boxes });
  expect([bar(), map().style.width, map().classList.contains("has-zoom")]).toEqual([null, `${mmW}px`, false]);
});
