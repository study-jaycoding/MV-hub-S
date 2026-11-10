// @vitest-environment jsdom
// 가운데 버튼 화면 이동은 끄는 동안 transform 대신 translate + 표식(data-layer-move — 값 0 애니메이션, scene.css)으로 캔버스·점 격자·
//  미니맵 상자를 민다 — 걸음마다 transform 을 바꾸면 크롬이 화면 전체 레이어를 다시 합쳐 느린 PC 에서 끊겼다(2026-11-10 격리 실측).
//  손 떼거나 다른 카메라 변경이 오면 transform 으로 접어 화면·좌표가 같아야 한다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { sceneViewRect } from "../src/lib/sceneViewport";
import type { BeginSceneDrag } from "../src/lib/useSceneDragSession";
import { useSceneViewport } from "../src/lib/useSceneViewport";

type Camera = { z: number; x: number; y: number };
let api: ReturnType<typeof useSceneViewport>;
let root: Root | null = null;

function Host({ onCameraChange }: { onCameraChange: (camera: Camera) => void }) {
  api = useSceneViewport({ sceneId: "s", camera: { z: 2, x: 10, y: 20 }, onCameraChange, cullingEnabled: false });
  return <div ref={api.scrollRef}><div ref={api.gridRef} /><div ref={api.canvasRef} /></div>;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// 끄는 도중 다른 길이 바꾼 카메라를 다음 걸음이 덮지 않는다(Codex 묶음 리뷰 P2, 2026-11-10)
async function mountPlain() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(<Host onCameraChange={() => {}} />));
  let drag: { move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null = null;
  const beginDrag: BeginSceneDrag = (move, up) => { drag = { move, up }; };
  api.beginPan({ button: 1, clientX: 100, clientY: 100, preventDefault: () => {} }, beginDrag);
  return { move: (x: number, y: number) => drag!.move(new MouseEvent("mousemove", { clientX: x, clientY: y })), up: () => drag!.up(new MouseEvent("mouseup")) };
}

it("끄는 도중 보드가 스스로 스크롤돼 접힌 만큼은 다음 걸음에도 남는다", async () => {
  const pan = await mountPlain();
  pan.move(110, 100); // 시작 카메라 (2, 10, 20) → x 20
  const board = api.scrollRef.current!;
  board.scrollTop = 30;
  board.dispatchEvent(new Event("scroll")); // 캐럿 보이기 등 — 30px 를 팬으로 접는다(y 20 → −10)
  pan.move(120, 100); // 10px 더
  expect(api.getCamera()).toEqual({ z: 2, x: 30, y: -10 });
  pan.up();
});

it("끄는 도중 화면 맞춤은 지금 보이는 자리를 먼저 전환 없이 접고 나서 미끄러진다", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, toJSON: () => ({}) } as DOMRect,
  );
  const pan = await mountPlain();
  pan.move(150, 70); // (10, 20) + (50, −30) = (60, −10) — 화면은 translate 로 밀려 있다
  const canvas = api.canvasRef.current!;
  // transform 이 쓰일 때마다 그때의 전환(transition)과 함께 적는다
  const writes: string[] = [];
  let proto: object | null = canvas.style;
  let desc: PropertyDescriptor | undefined;
  while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, "transform"))) proto = Object.getPrototypeOf(proto);
  Object.defineProperty(canvas.style, "transform", {
    configurable: true,
    get: () => desc!.get!.call(canvas.style),
    set: (v: string) => { writes.push(`${canvas.style.transition || "none"} | ${v}`); desc!.set!.call(canvas.style, v); },
  });
  // 접은 뒤 스타일을 확정(계산된 값 읽기)해야 그 자리가 전환의 출발점이 된다 — 그 순서도 적는다
  const realComputed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
    if (el === canvas) writes.push("flush");
    return realComputed(el, pseudo);
  });
  await act(async () => api.frameRects([{ x: 0, y: 0, w: 100, h: 100 }], 1));
  expect(writes[0]).toBe("none | translate(60px, -10px) scale(2)"); // 먼저 보이던 자리 그대로, 전환 없이 접는다
  expect(writes[1]).toBe("flush"); // 그 스타일을 확정한다
  expect(writes[2]).toMatch(/^transform 0\.25s ease \| translate\(/); // 그다음 맞춤 자리로 미끄러진다
  expect(canvas.style.translate).toBe("");
  pan.up();
});

// 끄는 동안 컬링 확정 건너뛰기(2026-11-10) — 판정(shouldCommitView)이 거짓이면 확정값(viewRect)을 두고 최신 범위만 올린다
// 범위의 -0(카메라 0 ÷ 줌)을 0 으로 — toEqual 은 둘을 다르게 본다
const plain = (r: { l: number; t: number; r: number; b: number } | null) => r && { l: r.l + 0, t: r.t + 0, r: r.r + 0, b: r.b + 0 };
function GateHost({ gate, sceneId = "s", camera = { z: 1, x: 0, y: 0 } }: { gate: (committed: unknown, next: unknown) => boolean; sceneId?: string; camera?: Camera }) {
  api = useSceneViewport({ sceneId, camera, cullingEnabled: true, shouldCommitView: gate as never });
  return <div ref={api.scrollRef}><div ref={api.gridRef} /><div ref={api.canvasRef} /></div>;
}

it("끄는 동안 판정이 거짓이면 확정을 건너뛰고 최신 범위만 갱신하며, 손 떼면 다시 묻고, 씬 전환은 묻지 않고 확정한다 · 줌도 묻고 건너뛰면 쉼 정리가 지금 범위로 확정한다", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, toJSON: () => ({}) } as DOMRect,
  );
  const flush = () => act(async () => { for (let i = 0; i < 3; i++) frames.splice(0).forEach((cb) => cb(0)); });
  let allow = false;
  const gate = vi.fn(() => allow);
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(<GateHost gate={gate} />));
  await flush();
  expect(plain(api.viewRect)).toEqual({ l: 0, t: 0, r: 1000, b: 600 }); // 처음 잰 범위는 묻지 않고 확정
  expect(gate).not.toHaveBeenCalled();
  const first = api.viewRect;

  let drag: { move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null = null;
  const beginDrag: BeginSceneDrag = (move, up) => { drag = { move, up }; };
  api.beginPan({ button: 1, clientX: 500, clientY: 300, preventDefault: () => {} }, beginDrag);
  await act(async () => drag!.move(new MouseEvent("mousemove", { clientX: -200, clientY: 300 })));
  await flush();
  expect(gate).toHaveBeenCalledTimes(1);
  expect(api.viewRect).toBe(first); // 건너뜀 — SceneBoard 는 다시 그려지지 않는다
  expect(plain(api.liveView.getSnapshot())).toEqual({ l: 700, t: 0, r: 1700, b: 600 });

  await act(async () => drag!.up(new MouseEvent("mouseup")));
  await flush();
  expect(gate).toHaveBeenCalledTimes(2); // 손 뗀 직후 한 번 더 묻는다 — 여전히 거짓이면 그대로
  expect(api.viewRect).toBe(first);

  // 확정이 낡은 채(0..1000) 지금 카메라와 같은 자리(−700)에서 여는 씬으로 바꾼다 — 최신 범위와 같아도 비우고 새로 재서 확정해야 한다
  gate.mockClear();
  await act(async () => root!.render(<GateHost gate={gate} sceneId="s2" camera={{ z: 1, x: -700, y: 0 }} />));
  await flush();
  expect(gate).not.toHaveBeenCalled();
  expect(plain(api.viewRect)).toEqual({ l: 700, t: 0, r: 1700, b: 600 });

  // 끄는 동안 건너뛴 뒤 손을 떼자마자(같은 프레임) 한 단계 축소 — 줌(범위 크기 변경)도 판정을 묻는데, 비교 기준은 최신 범위(1400..2400)가
  //  아니라 확정값(700..1700)이다(Codex 독립 리뷰 P2). 판정이 거짓이면 확정을 미루고, 휠을 쉬면(150ms) 그때의 카메라 범위로 정리한다(2026-11-10)
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  api.beginPan({ button: 1, clientX: 500, clientY: 300, preventDefault: () => {} }, beginDrag);
  await act(async () => drag!.move(new MouseEvent("mousemove", { clientX: -200, clientY: 300 })));
  await flush();
  expect(plain(api.viewRect)).toEqual({ l: 700, t: 0, r: 1700, b: 600 });
  gate.mockClear();
  await act(async () => drag!.up(new MouseEvent("mouseup")));
  await act(async () => api.stepZoom(-1));
  await flush();
  const zoomed = plain(sceneViewRect(api.getCamera(), { width: 1000, height: 600 }));
  expect(zoomed!.r - zoomed!.l).toBeCloseTo(1100); // 실제로 축소됐다
  expect(gate).toHaveBeenLastCalledWith(expect.objectContaining({ l: 700, r: 1700 }), expect.anything()); // 확정값과 견준다
  expect(plain(api.viewRect)).toEqual({ l: 700, t: 0, r: 1700, b: 600 }); // 미뤘다
  expect(plain(api.liveView.getSnapshot())).toEqual(zoomed); // 최신 범위는 올렸다
  await act(async () => { vi.advanceTimersByTime(150); });
  vi.useRealTimers();
  expect(plain(api.viewRect)).toEqual(zoomed); // 쉼 정리 — 지금 카메라 범위로(판정 함수가 없으면 범위가 다르면 정리)
  expect(api.liveView.getSnapshot()).toBe(api.viewRect);

  // 끄는 동안 건너뛴 뒤 SceneBoard 가 부르는 확정
  api.beginPan({ button: 1, clientX: 500, clientY: 300, preventDefault: () => {} }, beginDrag);
  await act(async () => drag!.move(new MouseEvent("mousemove", { clientX: -500, clientY: 300 })));
  await flush();
  await act(async () => drag!.up(new MouseEvent("mouseup")));
  await flush();
  expect(plain(api.viewRect)).toEqual(zoomed);
  await act(async () => api.commitLiveView());
  expect(api.viewRect).toBe(api.liveView.getSnapshot());
  expect(plain(api.viewRect)).toEqual(plain(sceneViewRect(api.getCamera(), { width: 1000, height: 600 })));
});

it("끄는 동안은 translate·표식으로만 밀고(격자는 칸 나머지 차이), 손 떼면 transform 으로 접고 저장한다", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.body.appendChild(document.createElement("div"));
  const saved = vi.fn();
  root = createRoot(host);
  await act(async () => root!.render(<Host onCameraChange={saved} />));
  const minimap = vi.fn();
  api.minimapUpdateRef.current = minimap;
  const canvas = api.canvasRef.current!;
  const grid = api.gridRef.current!;
  let drag: { move: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null = null;
  const beginDrag: BeginSceneDrag = (move, up) => { drag = { move, up }; };
  const move = (x: number, y: number) => drag!.move(new MouseEvent("mousemove", { clientX: x, clientY: y }));

  expect(api.beginPan({ button: 1, clientX: 100, clientY: 100, preventDefault: () => {} }, beginDrag)).toBe(true);
  move(140, 70);

  expect(canvas.style.transform).toBe("translate(10px, 20px) scale(2)"); // 끄는 동안 transform 은 그대로
  expect([canvas.style.translate, canvas.hasAttribute("data-layer-move")]).toEqual(["40px -30px", true]);
  // 칸 44px(22×2): x 10 → 50 = 칸 안 10 → 6 · y 20 → −10 = 칸 안 20 → 34
  expect([grid.style.translate, grid.hasAttribute("data-layer-move")]).toEqual(["-4px 14px", true]);
  expect(minimap).toHaveBeenLastCalledWith(true);
  expect(api.getCamera()).toEqual({ z: 2, x: 50, y: -10 });
  expect(api.toCanvas(300, 400)).toEqual({ x: 125, y: 205 }); // 좌표는 걸음마다 맞다
  expect(saved).not.toHaveBeenCalled();

  // 끄는 도중 보드가 다시 그려져도(보이는 범위 갱신 등) 접지 않는다 — 접으면 그 프레임에 화면 전체 정리가 다시 돈다
  await act(async () => root!.render(<Host onCameraChange={saved} />));
  expect([canvas.style.transform, canvas.style.translate, canvas.hasAttribute("data-layer-move")]).toEqual(["translate(10px, 20px) scale(2)", "40px -30px", true]);
  expect(minimap).toHaveBeenLastCalledWith(true);

  // 끄는 도중 다른 카메라 변경(툴바 줌)은 applyTransform 을 거쳐 접힌다 — 다음 걸음은 거기서부터 민다
  act(() => api.stepZoom(1));
  expect([canvas.style.translate, canvas.hasAttribute("data-layer-move"), grid.hasAttribute("data-layer-move")]).toEqual(["", false, false]);
  const zoomed = canvas.style.transform;
  saved.mockClear();
  move(150, 70);
  expect(canvas.style.transform).toBe(zoomed);
  expect(canvas.hasAttribute("data-layer-move")).toBe(true);

  drag!.up(new MouseEvent("mouseup"));
  const end = api.getCamera();
  // 줌이 옮긴 카메라(50,−10 → 55,−11)에서 그대로 이어 10px 더 — 시작 카메라로 다시 셈하면 60 으로 되튀었다(Codex 묶음 리뷰 P3)
  expect(end.x).toBeCloseTo(65);
  expect(end.y).toBeCloseTo(-11);
  expect(canvas.style.transform).toBe(`translate(${end.x}px, ${end.y}px) scale(${end.z})`);
  expect([canvas.style.translate, canvas.hasAttribute("data-layer-move")]).toEqual(["", false]);
  expect([grid.style.translate, grid.hasAttribute("data-layer-move")]).toEqual(["", false]);
  expect(minimap).toHaveBeenLastCalledWith(); // 접을 때는 slide 없이 — 상자 transform·크기를 맞춘다
  expect(saved).toHaveBeenLastCalledWith(end);
});
