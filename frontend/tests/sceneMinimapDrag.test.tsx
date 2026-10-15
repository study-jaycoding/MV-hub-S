// @vitest-environment jsdom
// 미니맵 끌기의 끝 — 놓으면(mouseup) 그 자리로 확정하고, mouseup 을 놓치면(단추를 뗀 채 온 움직임·창을 떠남) 정리만 한다.
import { act, createRef, useRef, type MutableRefObject } from "react";
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

// 70회차 격리 실측 — 렌더마다 도는 update() 가 보드의 clientWidth 를 읽어 막 붙은 카드 전부의 배치를 강제로 계산했다(첫 씬 열기 긴 작업의 65ms).
//  보드 크기는 크기 감시가 알려 줄 때만 읽는다.
it("does not read the board size on render — only when the resize observer reports", () => {
  const observers: Array<() => void> = [];
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} });
  const board = document.createElement("div");
  let reads = 0;
  Object.defineProperty(board, "clientWidth", { get: () => { reads += 1; return 800; } });
  Object.defineProperty(board, "clientHeight", { get: () => 600 });
  const ref = <T,>(current: T) => ({ current }) as MutableRefObject<T>;
  const props = { boxes: [], bounds: { minX: 0, minY: 0, maxX: 3000, maxY: 3000 }, selected: new Set<string>(), scrollRef: ref(board),
    panRef: ref({ x: 0, y: 0 }), zoomRef: ref(1), updateRef: ref<(() => void) | null>(null), onNavigate };
  act(() => root.render(<SceneMinimap {...props} />));
  act(() => root.render(<SceneMinimap {...props} selected={new Set(["x"])} />)); // 다시 그려도
  expect(reads).toBe(0);
  act(() => observers.forEach((cb) => cb())); // 크기를 알려 오면 그때 읽고 갱신한다
  expect([reads, map().style.display]).toEqual([1, "block"]); // 카드(3000)가 화면(800) 밖 — 미니맵을 보인다
});

// Codex 70회차 리뷰 P2 — 실제 캔버스처럼 보드(조상)와 미니맵이 함께 처음 붙으면 미니맵의 effect 가 보드 ref 보다 먼저 돈다.
//  그때 한 번 보고 말면 크기 감시가 안 걸려 미니맵이 영영 숨었다.
it("watches the board even when board and minimap mount together (the board ref attaches after the child's effects)", () => {
  const observed: Element[] = [];
  const callbacks: Array<() => void> = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(cb: () => void) { callbacks.push(cb); }
    observe(el: Element) { observed.push(el); }
    disconnect() {}
  });
  const ref = <T,>(current: T) => ({ current }) as MutableRefObject<T>;
  function Board() {
    const scroll = useRef<HTMLDivElement>(null);
    return (
      <div className="board" ref={scroll}>
        <SceneMinimap boxes={[]} bounds={{ minX: 0, minY: 0, maxX: 3000, maxY: 3000 }} selected={new Set()} scrollRef={scroll}
          panRef={ref({ x: 0, y: 0 })} zoomRef={ref(1)} updateRef={ref<(() => void) | null>(null)} onNavigate={onNavigate} />
      </div>
    );
  }
  act(() => root.render(<Board />));
  const board = host.querySelector<HTMLElement>(".board")!;
  expect(observed).toEqual([board]);
  Object.defineProperty(board, "clientWidth", { get: () => 800 });
  Object.defineProperty(board, "clientHeight", { get: () => 600 });
  act(() => callbacks.forEach((cb) => cb()));
  expect(map().style.display).toBe("block"); // 카드(3000)가 화면(800) 밖 — 미니맵을 보인다
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
