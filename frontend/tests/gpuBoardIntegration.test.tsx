// @vitest-environment jsdom
// GPU 보기 모드를 실제 SceneBoard 로 본다(docs/status/캔버스_GPU판설계_2026-11-11.md 계약 off·mode·readonly·data·transition).
//  jsdom 에는 WebGL 이 없어 GPU 판 칸(GpuBoard)만 가짜로 바꾼다 — 준비 끝·켤 때 검사를 바로 알려 보기 모드(gpu)로 들어간다.
//  모드 관리(useGpuBoardMode)·편집 막기·세션 실행점·덧판은 진짜다.
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";
import type { GpuBoardProps } from "../src/features/canvas/gpu/GpuBoard";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi, models: [] as number[], probe: 1 }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));
vi.mock("../src/features/canvas/gpu/GpuBoard", async (original) => {
  const real = await original<typeof import("../src/features/canvas/gpu/GpuBoard")>();
  function FakeGpuBoard(props: GpuBoardProps) {
    fixture.models.push(props.model.cards.length);
    useEffect(() => {
      if (props.phase === "preparing") props.dispatch({ type: "prepared", token: props.token });
      if (props.phase === "probing") props.dispatch({ type: "probe", token: props.token, medianMs: fixture.probe });
    }, [props.phase, props.token]);
    return <canvas className="scene-gpu-board" data-phase={props.phase} data-cards={props.model.cards.length} />;
  }
  return { ...real, GpuBoard: FakeGpuBoard };
});

const noop = () => {};
let host: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[] = [];
let onChange: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = noop; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const [w, h] = this.matches(".scene-board") ? [1000, 600] : [0, 0];
    return { x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h, toJSON: noop } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches(".scene-card") ? 130 : 0;
  });
  localStorage.clear();
  sessionStorage.clear();
  fixture.models = [];
  fixture.probe = 1;
  fixture.data = {
    genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
  } as unknown as SceneGenDataApi;
  onChange = vi.fn();
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

const textCard = (id: string, x: number, y: number) => ({ id, kind: "text", x, y, w: 152, h: 130, text: id });
type Action = { commitDocument: (c: never) => boolean; deleteSelected: () => void; zoomFit: () => void };
const actionRef: { current: Action | null } = { current: null };
const sceneOf = (cards: object[], id = "s1") => ({ id, name: id, created_at: 0, groups: [], edges: [], camera: { z: 0.5, x: 0, y: 0 }, cards }) as never;
const show = (cards: object[], id = "s1") => act(async () => {
  root.render(<SceneBoard scene={sceneOf(cards, id)} onChange={onChange} actionRef={actionRef as never} />);
});
const flush = () => act(async () => { for (let i = 0; i < 4; i++) frames.splice(0).forEach((cb) => cb(0)); });
const board = () => host.querySelector<HTMLElement>(".scene-board")!;
const phase = () => board().getAttribute("data-gpu");
const domCards = () => host.querySelectorAll(".scene-card:not(.scene-gpu-overlay)").length;
const key = (k: string, opts: KeyboardEventInit = {}) => act(async () => {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k === "`" ? "Backquote" : k.length === 1 ? `Key${k.toUpperCase()}` : k, bubbles: true, cancelable: true, ...opts }));
});
const cards3 = [textCard("a", 0, 0), textCard("b", 300, 0), textCard("c", 600, 0)];

it("표식이 꺼져 있으면(기본) GPU 칸·모드 단추·data-gpu 가 없고 DOM 판 그대로", async () => {
  await show(cards3);
  await flush();
  expect(host.querySelector(".scene-gpu-board")).toBeNull();
  expect(host.querySelector(".scene-gpu-mode")).toBeNull();
  expect(phase()).toBeNull();
  expect(domCards()).toBe(3);
  expect(fixture.models).toEqual([]);
});

it("표식 켬 — 준비·검사를 거쳐 보기 모드(gpu)가 되면 DOM 카드를 내리고 GPU 판이 그린다, ` 키로 편집 모드로 돌아온다", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  await show(cards3);
  await flush();
  expect(phase()).toBe("gpu");
  expect(domCards()).toBe(0);
  expect(host.querySelector(".scene-gpu-board")?.getAttribute("data-cards")).toBe("3");
  expect(host.querySelector(".scene-gpu-mode")?.textContent).toContain("보기 모드");
  await key("`");
  await flush();
  expect(phase()).toBeNull(); // dom 이면 data-gpu 를 내린다
  expect(domCards()).toBe(3);
  expect(host.querySelector(".scene-gpu-mode")?.textContent).toBe("편집 모드");
  await key("`");
  await flush();
  expect(phase()).toBe("gpu");
});

it("켤 때 검사가 느리면(중앙값 > 12ms) 그 세션은 잠기고 DOM 그대로 — 단추로도 못 켠다", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  fixture.probe = 40;
  await show(cards3);
  await flush();
  expect(phase()).toBeNull();
  expect(domCards()).toBe(3);
  expect(host.querySelector(".scene-gpu-mode")?.textContent).toContain("GPU 못 씀");
  await key("`");
  await flush();
  expect(phase()).toBeNull();
});

it("보기 모드에서 사용자 변경은 입력 진입점·세션 실행점 모두 거절 — 문서 쓰기 0, 안내 한 번", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  await show(cards3);
  await flush();
  expect(phase()).toBe("gpu");
  onChange.mockClear();
  // 단축키 — 되돌리기·다시하기·전체 선택·묶기·노드 선택기·지우기
  for (const [k, o] of [["z", { ctrlKey: true }], ["z", { ctrlKey: true, shiftKey: true }], ["a", { ctrlKey: true }], ["g", { ctrlKey: true }], ["Tab", {}], ["Delete", {}]] as const)
    await key(k, o);
  expect(host.querySelector(".scene-nodepick")).toBeNull();
  // 보드 누름(왼쪽) — 고르기·범위 선택을 시작하지 않는다
  await act(async () => { board().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 50, clientY: 50 })); });
  // 부모 명령 — 지우기·편집 명령은 입구와 실행점에서 거절
  await act(async () => { actionRef.current!.deleteSelected(); });
  let committed = true;
  await act(async () => { committed = actionRef.current!.commitDocument({ type: "createNode", id: "n1", kind: "text", position: { x: 0, y: 0 } } as never); });
  expect(committed).toBe(false);
  await flush();
  expect(onChange).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("보기 모드");
});

it("보기 모드에서도 씬 수신(다른 창·비동기 결과)은 반영된다 — GPU 판의 그릴 모델이 따라온다", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  await show(cards3);
  await flush();
  expect(phase()).toBe("gpu");
  await show([...cards3, textCard("d", 900, 0)]);
  await flush();
  expect(host.querySelector(".scene-gpu-board")?.getAttribute("data-cards")).toBe("4");
  expect(phase()).toBe("gpu");
});

it("보기 모드에서 Esc·F(화면 맞춤)는 받는다 — 화면 맞춤은 카메라를 옮긴다", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  await show(cards3);
  await flush();
  const before = host.querySelector<HTMLElement>(".scene-canvas")!.style.transform;
  await key("f");
  await flush();
  expect(host.querySelector<HTMLElement>(".scene-canvas")!.style.transform).not.toBe(before);
  expect(phase()).toBe("gpu");
});

it("카메라 출처 — 휠·화면 맞춤·한 단계 확대가 모두 알리고(화면 맞춤은 미끄러짐 시간과 함께), 받은 카메라 == 화면 transform", async () => {
  const { useSceneViewport } = await import("../src/lib/useSceneViewport");
  const calls: number[] = [];
  let api: ReturnType<typeof useSceneViewport> | null = null;
  function Harness() {
    const v = useSceneViewport({ sceneId: "s", camera: { z: 1, x: 0, y: 0 }, cullingEnabled: true });
    api = v;
    useEffect(() => v.cameraSource.subscribe((ms) => calls.push(ms)), [v.cameraSource]);
    return <div className="scene-board" ref={v.scrollRef}><div className="scene-canvas" ref={v.canvasRef} /></div>;
  }
  await act(async () => { root.render(<Harness />); });
  calls.length = 0;
  await act(async () => { host.querySelector(".scene-board")!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 10, clientY: 10 })); });
  expect(calls.at(-1)).toBe(0);
  const cam = api!.cameraSource.getSnapshot();
  expect(host.querySelector<HTMLElement>(".scene-canvas")!.style.transform).toBe(`translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`);
  await act(async () => { api!.frameRects([{ x: 0, y: 0, w: 100, h: 100 }], 1); });
  expect(calls).toContain(250);
  const n = calls.length;
  await act(async () => { api!.stepZoom(1); });
  expect(calls.length).toBeGreaterThan(n);
});

it("미지원 노드(Comfy 등)가 있는 씬은 보기 모드에 들어가지 않는다 — 단추에 까닭", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  await show([...cards3, { id: "cf", kind: "comfy", x: 0, y: 300, w: 200, h: 200 }]);
  await flush();
  expect(phase()).toBeNull();
  expect(host.querySelector(".scene-gpu-mode")?.textContent).toContain("미지원");
});
