// @vitest-environment jsdom
// GPU 판 칸(features/canvas/gpu/GpuBoard)의 프레임 루프 — 렌더러·아틀라스만 가짜로 두고 진짜 GpuBoard 를 돌린다
//  (docs/status/캔버스_GPU판설계_2026-11-11.md 계약 mode·transition·camera). jsdom 에는 WebGL 이 없다.
//  본다: 켤 때 검사는 표본 30개·모두 유한해야 믿는다 · 검사 결과는 카메라가 쉬고 화면을 끌지 않을 때 알린다 ·
//  렌더만 다시 해서(카메라 그대로) 알림이 와도 '조작 중'이 아니다 · 끝나면 컨텍스트를 놓는다.
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GpuSceneModel } from "../src/features/canvas/gpu/gpuScene";

const fx = vi.hoisted(() => ({ samples: [] as number[] | Error, destroyed: 0, draws: 0, timed: 0, hidden: [] as Array<string | null>,
  decode: null as null | ((src: string, w: number, h: number) => Promise<unknown>) }));
vi.mock("../src/features/canvas/gpu/gpuRenderer", () => ({
  createGpuRenderer: () => ({
    setScene() {}, setHidden(id: string | null) { fx.hidden.push(id); }, setLowLod() {},
    draw() { fx.draws++; },
    timeGpu() { fx.timed++; return fx.samples instanceof Error ? Promise.reject(fx.samples) : Promise.resolve(fx.samples); },
    textureBytes: () => 0, texturePeak: () => 0, lost: () => false,
    destroy() { fx.destroyed++; },
    ensurePage() {}, upload() {}, deletePage() {},
  }),
}));
vi.mock("../src/features/canvas/gpu/cardAtlas", () => ({
  createCardAtlas: (deps: { decode: (src: string, w: number, h: number) => Promise<unknown> }) => (fx.decode = deps.decode, {
    sync() {}, tick: () => ({ uploadedPx: 0, pending: 0, baked: 0 }), lookup: () => ({ page: 0 }),
    textureBytes: () => 0, cpuBytes: () => 0, cpuPeak: () => 0, reset() {}, dispose() {},
  }),
}));
const { GpuBoard, imageSizeOf, decodeImage, useGpuBoardMode } = await import("../src/features/canvas/gpu/GpuBoard");

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
  Object.assign(fx, { samples: Array(30).fill(2), destroyed: 0, draws: 0, timed: 0, hidden: [] });
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

describe("긴 프레임 까닭(LoAF)", () => {
  let deliver: ((entries: unknown[]) => void) | null = null;
  beforeEach(() => {
    class FakeObserver {
      static supportedEntryTypes = ["long-animation-frame"];
      constructor(cb: (list: { getEntries: () => unknown[] }) => void) { deliver = (entries) => cb({ getEntries: () => entries }); }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("PerformanceObserver", FakeObserver);
  });
  // scripts 는 간격 시작(from)부터 차례로 돈 것으로 둔다 — shift 로 앞당기면(음수) 간격 밖에서 시작한 일이 된다
  const moveWithLongFrames = async (scripts: Array<{ invoker: string; duration: number }>, gap = 65, shift = 0) => {
    for (let i = 0; i < 3; i++) {
      cam.x += 10;
      act(() => listeners.forEach((l) => l(0)));
      const from = now + 5;
      await frameAt(from);
      await frameAt(from + gap);
      let at = from + shift;
      const timed = scripts.map((x) => { const t = { ...x, startTime: at }; at += x.duration; return t; });
      act(() => deliver!([{ startTime: from + Math.min(0, shift), duration: gap - Math.min(0, shift), scripts: timed }]));
      for (let k = 0; k < 4; k++) await frameAt(now + 16); // 회차 사이를 띄운다 — 앞당긴 일이 앞 회차 간격에 겹치지 않게
    }
    await frameAt(now + 150);
    await frameAt(now + 150);
    cam.x = 0;
  };
  const failures = (d: ReturnType<typeof vi.fn>) => d.mock.calls.map((c) => c[0]).filter((e) => e.type === "failure");

  it("GPU 판과 무관한 일(씬 저장 IndexedDB·응답 JSON)로 늦어진 프레임은 세지 않는다 — 1배 2,060장에서 저장 때문에 잠기던 것", async () => {
    const dispatch = vi.fn();
    mount(dispatch, "gpu");
    await frameAt(1000);
    await moveWithLongFrames([{ invoker: "IDBRequest.onsuccess", duration: 40 }, { invoker: "Response.json.then", duration: 20 }]);
    expect(failures(dispatch)).toEqual([]);
  });

  it.each([
    ["판 그리기(rAF 콜백)만 있는 늦은 프레임", [{ invoker: "FrameRequestCallback", duration: 6 }], 65],
    ["React 렌더(출처가 판일 수 있음)로 늦은 프레임", [{ invoker: "MessagePort.onmessage", duration: 60 }], 65],
    ["저장이 섞였어도 덜고 50ms 넘게 남는 프레임(저장 60 + 나머지 70)", [{ invoker: "IDBRequest.onsuccess", duration: 60 }], 130, 0],
    ["간격 앞에서 시작한 저장은 겹친 만큼만 던다(간격 80·저장 60 중 겹침 20 → 남는 60, 통째로 덜면 20 이라 놓쳤다)", [{ invoker: "IDBRequest.onsuccess", duration: 60 }], 80, -40],
  ])("%s 은 GPU 느림으로 센다 — 3번이면 잠금", async (_name, scripts, gap, shift = 0) => {
    const dispatch = vi.fn();
    mount(dispatch, "gpu");
    await frameAt(1000);
    await moveWithLongFrames(scripts, gap, shift);
    expect(failures(dispatch)).toEqual([{ type: "failure", reason: "slow-frames" }]);
  });
});

describe("덧판 고르기(계약 overlay)", () => {
  const card = (id: string, x: number, y: number, z: number) => ({ id, x, y, w: 100, h: 100, radius: 12, border: [0, 0, 0, 0] as [number, number, number, number], borderWidth: 2, hidden: false, z });
  const modelOf = (...cards: ReturnType<typeof card>[]): GpuSceneModel => ({ ...model, cards });
  function Board(p: { m: GpuSceneModel; hiddenId?: string | null; pinned?: boolean; onHover: (id: string | null) => void; boardRef: React.RefObject<HTMLDivElement | null> }) {
    return (
      <div className="scene-board" ref={p.boardRef}>
        <GpuBoard phase="gpu" token={1} sceneId="s" model={p.m} hiddenId={p.hiddenId ?? null} cameraSource={source} boardRef={p.boardRef}
          dispatch={() => {}} onHover={p.onHover} overlayPinned={!!p.pinned} />
      </div>
    );
  }
  const move = (board: HTMLElement, x: number, y: number) => act(() => { board.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y })); });
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("마우스 아래 맨 앞 카드에 120ms 머물러야 고른다 — 빨리 지나가면 안 고른다", () => {
    const onHover = vi.fn();
    const ref = createRef<HTMLDivElement>();
    act(() => root.render(<Board m={modelOf(card("a", 0, 0, 0), card("b", 300, 0, 1))} onHover={onHover} boardRef={ref} />));
    move(ref.current!, 50, 50);
    act(() => { vi.advanceTimersByTime(100); });
    move(ref.current!, 350, 50); // 120ms 전에 다른 카드로
    act(() => { vi.advanceTimersByTime(119); });
    expect(onHover).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onHover.mock.calls).toEqual([["b"]]);
  });

  it("그 카드보다 앞의 카드와 겹치면 덧판을 띄우지 않는다(null) — 앞 카드를 덮지 않게", () => {
    const onHover = vi.fn();
    const ref = createRef<HTMLDivElement>();
    act(() => root.render(<Board m={modelOf(card("a", 0, 0, 0), card("c", 50, 50, 1))} onHover={onHover} boardRef={ref} />));
    move(ref.current!, 20, 20); // a 만 있는 자리지만 a 는 c 에 일부 가려짐
    act(() => { vi.advanceTimersByTime(120); });
    expect(onHover.mock.calls).toEqual([[null]]);
  });

  it("덧판 안 초점·덧판에서 연 창이 있으면(붙잡힘) 마우스가 떠나도 내리지 않고 다른 카드에 새 덧판도 안 띄운다", () => {
    const onHover = vi.fn();
    const ref = createRef<HTMLDivElement>();
    act(() => root.render(<Board m={modelOf(card("a", 0, 0, 0), card("b", 300, 0, 1))} pinned onHover={onHover} boardRef={ref} />));
    move(ref.current!, 350, 50);
    act(() => { vi.advanceTimersByTime(200); });
    move(ref.current!, 700, 500); // 카드 밖
    act(() => { ref.current!.dispatchEvent(new MouseEvent("mouseleave")); });
    expect(onHover).not.toHaveBeenCalled();
  });

  it("덧판이 붙는(hiddenId) 같은 렌더 단계에서 그 카드 GPU 그림을 감추고 다시 그린다 — 떼면 같은 단계에서 되살린다(깜박임 없음)", () => {
    const ref = createRef<HTMLDivElement>();
    const m = modelOf(card("a", 0, 0, 0));
    act(() => root.render(<Board m={m} onHover={() => {}} boardRef={ref} />));
    const draws = fx.draws;
    act(() => root.render(<Board m={m} hiddenId="a" onHover={() => {}} boardRef={ref} />));
    expect(fx.hidden.at(-1)).toBe("a");
    expect(fx.draws).toBe(draws + 1); // 프레임을 기다리지 않고 layout 단계에서 그렸다
    act(() => root.render(<Board m={m} hiddenId={null} onHover={() => {}} boardRef={ref} />));
    expect(fx.hidden.at(-1)).toBeNull();
    expect(fx.draws).toBe(draws + 2);
  });

  it("화면을 옮긴 직후(150ms 안)·끄는 중(data-panning)엔 덧판을 고르지 않는다", () => {
    const onHover = vi.fn();
    const ref = createRef<HTMLDivElement>();
    act(() => root.render(<Board m={modelOf(card("a", 0, 0, 0))} onHover={onHover} boardRef={ref} />));
    act(() => listeners.forEach((l) => l(0))); // now=1000 에 카메라 변화
    move(ref.current!, 50, 50);
    act(() => { vi.advanceTimersByTime(200); });
    expect(onHover).not.toHaveBeenCalled();
    now = 1300;
    ref.current!.setAttribute("data-panning", "");
    move(ref.current!, 60, 60);
    act(() => { vi.advanceTimersByTime(200); });
    expect(onHover).not.toHaveBeenCalled();
    ref.current!.removeAttribute("data-panning");
    move(ref.current!, 61, 61);
    act(() => { vi.advanceTimersByTime(120); });
    expect(onHover.mock.calls).toEqual([["a"]]);
  });
});

describe("카메라 알림 종류·덧판 예약", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());
  const twoCards: GpuSceneModel = { ...model, cards: [{ ...model.cards[0] }] };
  function Board(p: { onHover: (id: string | null) => void; boardRef: React.RefObject<HTMLDivElement | null> }) {
    return (
      <div className="scene-board" ref={p.boardRef}>
        <GpuBoard phase="gpu" token={1} sceneId="s" model={twoCards} hiddenId={null} cameraSource={source} boardRef={p.boardRef} dispatch={() => {}} onHover={p.onHover} overlayPinned={false} />
      </div>
    );
  }
  const move = (el: HTMLElement) => act(() => { el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 50, clientY: 50 })); });

  it("머무는 중 화면이 움직이면(휠·F) 걸어 둔 덧판 예약을 버린다 — 포인터 아래에서 떠난 카드 덧판이 늦게 뜨지 않게", () => {
    const onHover = vi.fn();
    const ref = createRef<HTMLDivElement>();
    act(() => root.render(<Board onHover={onHover} boardRef={ref} />));
    move(ref.current!);
    act(() => { vi.advanceTimersByTime(60); });
    act(() => listeners.forEach((l) => l(0)));
    act(() => { vi.advanceTimersByTime(300); });
    expect(onHover).not.toHaveBeenCalled();
  });

  it("기기 배율 바뀜(-1)은 다시 그리되 조작으로 세지 않는다 — 바로 뒤 마우스 올림도 덧판을 고른다", () => {
    const onHover = vi.fn();
    const ref = createRef<HTMLDivElement>();
    act(() => root.render(<Board onHover={onHover} boardRef={ref} />));
    act(() => listeners.forEach((l) => l(-1)));
    move(ref.current!);
    act(() => { vi.advanceTimersByTime(120); });
    expect(onHover.mock.calls).toEqual([["a"]]);
  });
});

describe("그림 파일 머리 크기(imageSizeOf)", () => {
  const bytes = (n: number, set: Array<[number, number[]]>) => { const b = new Uint8Array(n); for (const [i, v] of set) b.set(v, i); return b; };
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  it("PNG·GIF·WebP(VP8X) 크기를 읽는다", () => {
    expect(imageSizeOf(bytes(24, [[0, [0x89, ...ascii("PNG")]], [16, [0, 0, 1, 44]], [20, [0, 0, 9, 96]]]))).toEqual({ w: 300, h: 2400 });
    expect(imageSizeOf(bytes(10, [[0, ascii("GIF89a")], [6, [100, 0, 50, 0]]]))).toEqual({ w: 100, h: 50 });
    expect(imageSizeOf(bytes(30, [[0, ascii("RIFF")], [8, ascii("WEBPVP8X")], [24, [199, 0, 0]], [27, [99, 0, 0]]]))).toEqual({ w: 200, h: 100 });
  });
  it("JPEG 는 SOF 의 크기, EXIF 방향 6(90도)이면 가로세로를 바꾼다 — 모르는 형식은 null", () => {
    // FFD8 · APP1 Exif(II, IFD0 에 0x0112=6) · SOF0(높이 100, 폭 400)
    const app1 = [0xff, 0xe1, 0, 34, ...ascii("Exif"), 0, 0, ...ascii("II"), 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
    const sof = [0xff, 0xc0, 0, 17, 8, 0, 100, 1, 144, 3];
    const jpeg = new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageSizeOf(jpeg)).toEqual({ w: 100, h: 400 });
    const plain = new Uint8Array([0xff, 0xd8, ...sof, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageSizeOf(plain)).toEqual({ w: 400, h: 100 });
    expect(imageSizeOf(new Uint8Array(40))).toBeNull();
  });
});

describe("디코드 크기(decodeImage)", () => {
  const calls: Array<{ source: unknown; opts: ImageBitmapOptions }> = [];
  // jsdom 의 Blob 에는 arrayBuffer 가 없다 — 머리 읽기에 쓰는 slice().arrayBuffer() 만 흉내 낸다
  const serve = (bytes: Uint8Array, type: string) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => ({ type, size: bytes.length, slice: (a: number, b: number) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }) }) })));
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("createImageBitmap", vi.fn(async (source: unknown, opts: ImageBitmapOptions) => {
      calls.push({ source, opts });
      return { width: opts.resizeWidth ?? 0, height: opts.resizeHeight ?? 0, close() {} };
    }));
  });

  it("머리로 크기를 아는 그림은 처음 디코드부터 두 변을 상자 안으로(폭만 주는 디코드 없음) — 1:8 긴 PNG", async () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    png.set([0, 0, 4, 0], 16); // 1024
    png.set([0, 0, 32, 0], 20); // 8192
    serve(png, "image/png");
    await decodeImage("/a-long.png", 2048, 2048);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({ resizeWidth: 256, resizeHeight: 2048 });
  });

  it("원본 크기를 디코드 없이 알 수 없는 그림은 디코드하지 않는다(null = 빗금) — 원본 디코드가 예산 밖 메모리를 쓰지 않게", async () => {
    serve(new Uint8Array(64), "image/tiff");
    expect(await decodeImage("/a-unknown.tiff", 2048, 2048)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("BMP 도 머리로 크기를 읽는다(아래로 쌓인 BMP 의 음수 높이 포함)", () => {
    const bmp = new Uint8Array(30);
    bmp.set([0x42, 0x4d], 0);
    bmp.set([0x40, 1, 0, 0], 18); // 320
    bmp.set([0x10, 0xff, 0xff, 0xff], 22); // -240
    expect(imageSizeOf(bmp)).toEqual({ w: 320, h: 240 });
  });
});

describe("배율 상한 판정(실제 모드 훅)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => { vi.useRealTimers(); cam.z = 1; });
  let seen: { phase: string; reason: string | null } = { phase: "", reason: null };
  function ModeHarness() {
    const g = useGpuBoardMode({ flag: true, sceneId: "s", unsupported: false, busy: false, cameraSource: source });
    seen = { phase: g.mode.phase, reason: g.mode.reason };
    return null;
  }
  const advance = (ms: number) => act(() => { now += ms; vi.advanceTimersByTime(ms); });

  it("처음부터 배율이 상한(2.5)을 넘고 카메라 알림이 없어도 쉼 판정으로 DOM(확대)에 둔다 — 준비에 멈추지 않는다", () => {
    cam.z = 3;
    act(() => root.render(<ModeHarness />));
    advance(170);
    expect(seen).toEqual({ phase: "dom", reason: "zoom" });
  });

  it("화면 맞춤 미끄러짐으로 상한을 넘으면 미끄러짐이 끝난 뒤에야 바꾼다", () => {
    act(() => root.render(<ModeHarness />));
    expect(seen.phase).toBe("preparing");
    cam.z = 3;
    act(() => listeners.forEach((l) => l(250)));
    advance(300); // 미끄러짐(250) 도중 + 50 — 아직 바꾸지 않는다
    expect(seen.phase).toBe("preparing");
    advance(120);
    expect(seen).toEqual({ phase: "dom", reason: "zoom" });
  });

  it("미끄러짐 중에 기기 배율 알림(-1)이 와도 미끄러짐이 끝나기 전엔 바꾸지 않는다", () => {
    act(() => root.render(<ModeHarness />));
    cam.z = 3;
    act(() => listeners.forEach((l) => l(250)));
    advance(20);
    act(() => listeners.forEach((l) => l(-1)));
    advance(200); // 시작 220ms — 미끄러짐(250) 중
    expect(seen.phase).toBe("preparing");
    advance(200);
    expect(seen).toEqual({ phase: "dom", reason: "zoom" });
  });
});

it("내려가면 렌더러를 놓는다(destroy — 컨텍스트 놓기는 렌더러 시험이 본다)", () => {
  mount(vi.fn());
  act(() => root.render(<div />));
  expect(fx.destroyed).toBe(1);
});
