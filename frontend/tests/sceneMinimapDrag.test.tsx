// @vitest-environment jsdom
// 미니맵 끌기의 끝 — 놓으면(mouseup) 그 자리로 확정하고, mouseup 을 놓치면(단추를 뗀 채 온 움직임·창을 떠남) 정리만 한다.
import { act, createRef, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneMinimap } from "../src/components/scene/SceneMinimap";

let host: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[];
const onNavigate = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames[id - 1] = () => {}; });
  onNavigate.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const scroll = createRef<HTMLDivElement>();
  const ref = <T,>(current: T) => ({ current }) as MutableRefObject<T>;
  act(() => root.render(
    <SceneMinimap boxes={[]} bounds={{ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }} selected={new Set()} scrollRef={scroll}
      panRef={ref({ x: 0, y: 0 })} zoomRef={ref(1)} updateRef={ref<(() => void) | null>(null)} onNavigate={onNavigate} />,
  ));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const map = () => host.querySelector<HTMLElement>(".scene-minimap")!;
const mouse = (type: string, target: EventTarget, init: MouseEventInit) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })); });
const runFrames = () => act(() => { const pending = frames.splice(0); pending.forEach((callback) => callback(0)); });
const commits = () => onNavigate.mock.calls.filter((call) => call[2] === true).length;

it("놓으면 그 자리로 한 번 확정한다", () => {
  mouse("mousedown", map(), { clientX: 10, clientY: 10 });
  mouse("mousemove", window, { clientX: 40, clientY: 30, buttons: 1 });
  runFrames();
  mouse("mouseup", window, { clientX: 40, clientY: 30 });
  expect(commits()).toBe(1);
  const calls = onNavigate.mock.calls.length;
  mouse("mousemove", window, { clientX: 90, clientY: 90, buttons: 1 });
  runFrames();
  expect(onNavigate).toHaveBeenCalledTimes(calls);
});

it.each([
  ["단추를 뗀 채 온 움직임", () => mouse("mousemove", window, { clientX: 100, clientY: 100, buttons: 0 })],
  ["창을 떠남(blur)", () => act(() => { window.dispatchEvent(new Event("blur")); })],
])("mouseup 을 놓치면 정리만 한다 — 예약된 걸음도 버리고 확정하지 않는다: %s", (_name, lose) => {
  mouse("mousedown", map(), { clientX: 10, clientY: 10 });
  mouse("mousemove", window, { clientX: 40, clientY: 30, buttons: 1 }); // 걸음이 예약만 됐다
  const calls = onNavigate.mock.calls.length;
  lose();
  runFrames();
  mouse("mousemove", window, { clientX: 120, clientY: 90, buttons: 1 });
  runFrames();
  mouse("mouseup", window, { clientX: 120, clientY: 90 });
  expect(onNavigate).toHaveBeenCalledTimes(calls);
  expect(commits()).toBe(0);
});
