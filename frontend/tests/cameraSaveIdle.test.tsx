// 카메라 기록 묶기(docs/status/캔버스_카메라저장묶기_2026-11-11.md) — 화면만 옮기는 동안은 기록을 예약만 하고, 마지막 조작 뒤 유휴 시간에
//  한 번 또는 떠날 때 바로, 그 카메라를 잰 대상(owner/target)으로 넘긴다. 실제 훅(useSceneViewport·useSceneDragSession)과 실제 SceneBoard 로 본다.
// @vitest-environment jsdom
import { act, StrictMode, useRef, useState, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import { canvasTarget, type CanvasTarget } from "../src/features/canvas/api";
import { getAccountScope, setAccountScope } from "../src/lib/accountScope";
import { flushCanvasMemoryReturn } from "../src/lib/popupWindows";
import { failSceneStoreWritesForTest } from "../src/lib/sceneStore";
import { listPersistedScenes, saveScenes, type Scene, type SceneCard } from "../src/lib/scenes";
import { useSceneCoordination } from "../src/lib/useSceneCoordination";
import { useSceneDragSession } from "../src/lib/useSceneDragSession";
import { CAMERA_IDLE_SAVE_MS, useSceneViewport } from "../src/lib/useSceneViewport";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));
// 조율 훅의 시작 일(백업 복구·카드 소속)은 이 시험과 무관하다 — 네트워크로 가지 않게 조용히(그 밖의 내보내기는 그대로)
vi.mock("../src/lib/sceneBackup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sceneBackup")>()),
  initSceneBackup: async () => false,
  countBackupOnlyScenes: async () => 0,
}));
vi.mock("../src/lib/sceneCardLinks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sceneCardLinks")>()),
  initSceneCardLinks: () => {},
  mergeCardLinksIntoScenes: () => null,
  serverCardLinks: () => [],
}));

type Camera = { z: number; x: number; y: number };
const noop = () => {};
let host: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[] = [];
const runFrames = () => act(async () => { frames.splice(0).forEach((cb) => cb(0)); });
const idle = (ms = CAMERA_IDLE_SAVE_MS) => act(async () => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = noop; });
  localStorage.clear();
  sessionStorage.clear();
  fixture.data = {
    genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
  } as unknown as SceneGenDataApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── viewport 단독 — owner 는 연결 ref(문자열), 팬은 실제 끌기 세션 ──
let api: ReturnType<typeof useSceneViewport<string>>;
let drag: ReturnType<typeof useSceneDragSession>;
function Host({ sceneId, ownerRef, onCameraChange }: {
  sceneId: string; ownerRef: { current: string | null }; onCameraChange: (camera: Camera, owner: string) => boolean | void;
}) {
  drag = useSceneDragSession();
  api = useSceneViewport<string>({ sceneId, camera: { z: 1, x: 0, y: 0 }, onCameraChange, cameraOwnerRef: ownerRef, cullingEnabled: false });
  return <div ref={api.scrollRef}><div ref={api.gridRef} /><div ref={api.canvasRef} /></div>;
}
const board = () => api.scrollRef.current!;
const wheel = (deltaY = -100) => act(async () => {
  board().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, clientX: 10, clientY: 10 }));
});
const pressPan = () => act(async () => { api.beginPan({ button: 1, clientX: 100, clientY: 100, preventDefault: noop }, drag.begin, drag.settle); });
const movePan = (x: number) => act(async () => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: 100, buttons: 4 })); });
const releasePan = () => act(async () => { window.dispatchEvent(new MouseEvent("mouseup", { button: 1 })); });

function mountHost(sceneId = "s1", owner: string | null = "o1", answer: () => boolean | void = () => true, strict = false) {
  const calls: { camera: Camera; owner: string }[] = [];
  const ownerRef = { current: owner };
  const onCameraChange = (camera: Camera, who: string) => { calls.push({ camera, owner: who }); return answer(); };
  const el = (id: string) => <Host sceneId={id} ownerRef={ownerRef} onCameraChange={onCameraChange} />;
  const render = (id: string) => act(async () => { root.render(strict ? <StrictMode>{el(id)}</StrictMode> : el(id)); });
  return { calls, ownerRef, render, mount: () => render(sceneId) };
}

describe("유휴 뒤 한 번(idle)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });

  it("유휴 시간보다 짧은 간격으로 여러 유휴 주기 동안 계속 휠 → 기록 0, 마지막 조작 뒤 유휴 시간에 최신 카메라로 1회(최대 대기 없음)", async () => {
    const h = mountHost();
    await h.mount();
    for (let i = 0; i < 12; i += 1) {
      await wheel(i % 2 ? 100 : -100);
      await idle(1000);
    }
    expect(h.calls).toEqual([]); // 12초 — 유휴 시간(3초)의 네 주기 동안 한 번도 안 넘긴다
    await idle(CAMERA_IDLE_SAVE_MS - 1000 - 1);
    expect(h.calls).toEqual([]);
    await idle(1);
    expect(h.calls).toEqual([{ camera: api.getCamera(), owner: "o1" }]);
    await idle(CAMERA_IDLE_SAVE_MS * 3);
    expect(h.calls).toHaveLength(1); // 접수됐으면 다시 싣지 않는다
  });

  it("변화 없는 보드 스크롤·움직이지 않은 팬은 기록을 예약하지 않는다", async () => {
    const h = mountHost();
    await h.mount();
    await act(async () => { board().dispatchEvent(new Event("scroll")); }); // scrollTop 0 그대로
    await pressPan();
    await releasePan();
    await idle(CAMERA_IDLE_SAVE_MS * 2);
    expect(h.calls).toEqual([]);
  });

  it("휠 예약이 끝나기 직전에 팬을 누르고 유휴 시간보다 오래 쥐어도 팬 도중엔 0 — 놓은 뒤 유휴 시간에 1회", async () => {
    const h = mountHost();
    await h.mount();
    await wheel();
    await idle(CAMERA_IDLE_SAVE_MS - 100);
    await pressPan();
    await idle(CAMERA_IDLE_SAVE_MS * 2);
    await movePan(140);
    await runFrames();
    await idle(CAMERA_IDLE_SAVE_MS * 2);
    expect(h.calls).toEqual([]);
    await releasePan();
    await idle(CAMERA_IDLE_SAVE_MS - 1);
    expect(h.calls).toEqual([]);
    await idle(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].camera.x).toBeCloseTo(api.getCamera().x);
  });

  it("팬 중 창을 떠나면(blur) 팬은 끝나도 바로 쓰지 않는다 — 유휴 뒤 1회", async () => {
    const h = mountHost();
    await h.mount();
    await pressPan();
    await movePan(150);
    await runFrames();
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    expect(h.calls).toEqual([]);
    await idle();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].camera.x).toBe(50);
  });

  it("StrictMode(설정→정리→재설정)에서도 유휴 뒤 정상 기록", async () => {
    const h = mountHost("s1", "o1", () => true, true);
    await h.mount();
    await wheel();
    await idle();
    expect(h.calls).toEqual([{ camera: api.getCamera(), owner: "o1" }]);
  });
});

describe("대상 고정(target)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });

  it("owner 는 씬이 바뀔 때만 설치한다 — 같은 씬에서 연결 ref 만 바뀌면 설치된 owner 로, 씬이 바뀐 뒤엔 새 owner 로", async () => {
    const h = mountHost();
    await h.mount();
    h.ownerRef.current = "o2"; // 렌더에서 채우는 연결 ref 만 바뀜(씬 그대로)
    await h.render("s1");
    await wheel();
    await idle();
    expect(h.calls.map((c) => c.owner)).toEqual(["o1"]);
    await h.render("s2"); // 씬이 바뀌면 그때의 ref(o2)를 설치한다
    await wheel();
    await idle();
    expect(h.calls.map((c) => c.owner)).toEqual(["o1", "o2"]);
  });

  it("owner 를 설치하기 전(연결 ref 가 비었음)의 조작은 기록을 예약하지 않는다", async () => {
    const h = mountHost("s1", null);
    await h.mount();
    await wheel();
    await idle(CAMERA_IDLE_SAVE_MS * 2);
    expect(h.calls).toEqual([]);
  });

  it("유휴 타이머의 접수 거절(허브 일시정지·쓰기 권한 없음) — 시간만으로는 다시 안 싣고, 다음 조작 뒤 최신 카메라로 1회", async () => {
    let accept = false;
    const h = mountHost("s1", "o1", () => accept);
    await h.mount();
    await wheel();
    await idle();
    expect(h.calls).toHaveLength(1); // 거절
    await idle(CAMERA_IDLE_SAVE_MS * 5);
    expect(h.calls).toHaveLength(1); // 시도 고리 없음
    accept = true;
    await wheel(); // 다음 조작
    await idle();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toEqual({ camera: api.getCamera(), owner: "o1" });
  });

  it("유휴 거절 뒤 남긴 대기는 조작 없이도 떠남에서 한 번 더 넘긴다", async () => {
    let accept = false;
    const h = mountHost("s1", "o1", () => accept);
    await h.mount();
    await wheel();
    await idle(); // 거절 — 같은 owner 라 대기 유지
    accept = true;
    act(() => { api.leaveCamera(); });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toEqual({ camera: api.getCamera(), owner: "o1" });
  });

  it("유휴 거절로 대기가 남은 채 씬이 바뀌면 그 대기는 옛 owner 로 한 번 더 떠남을 시도하고 버린다 — 새 씬에는 0", async () => {
    let accept = false;
    const h = mountHost("s1", "o1", () => accept);
    await h.mount();
    await wheel();
    await idle(); // 거절 — 대기 유지
    h.ownerRef.current = "o2";
    await h.render("s2");
    accept = true;
    await idle(CAMERA_IDLE_SAVE_MS * 3);
    expect(h.calls.map((c) => c.owner)).toEqual(["o1", "o1"]); // 유휴 거절 + 떠남(거절이어도 지움)
    expect(h.calls.some((c) => c.owner === "o2")).toBe(false);
  });
});

describe("떠남(leave)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });

  it("rAF 를 기다리는 팬 걸음이 있는 채 씬이 바뀌면 마지막 걸음까지 반영해 옛 owner 에 1회 — 새 씬은 팬이 끝난 상태로 시작해 휠 기록이 정상", async () => {
    const h = mountHost();
    await h.mount();
    await pressPan();
    await movePan(140); // rAF 를 아직 안 돌렸다
    h.ownerRef.current = "o2";
    await h.render("s2");
    expect(h.calls).toEqual([{ camera: { z: 1, x: 40, y: 0 }, owner: "o1" }]);
    expect(frames.filter((f) => f !== noop)).toHaveLength(0); // 밀린 걸음은 떠남이 반영했고 버린 프레임만 남았다
    await wheel();
    await idle();
    expect(h.calls.map((c) => c.owner)).toEqual(["o1", "o2"]);
  });

  it("rAF 를 기다리는 팬 중 언마운트 → 마지막 걸음까지 1회, 그 뒤 타이머·콜백 쓰기 0", async () => {
    const h = mountHost();
    await h.mount();
    await pressPan();
    await movePan(130);
    act(() => root.unmount());
    expect(h.calls).toEqual([{ camera: { z: 1, x: 30, y: 0 }, owner: "o1" }]);
    await idle(CAMERA_IDLE_SAVE_MS * 3);
    window.dispatchEvent(new MouseEvent("mouseup", { button: 1 }));
    expect(h.calls).toHaveLength(1);
    root = createRoot(host); // afterEach 가 내릴 뿌리
  });

  it("떠남 콜백을 잇달아 불러도 1회 · 첫 떠남이 거절이어도 대기를 지워 같은 owner 재호출 커밋 0", async () => {
    const h = mountHost();
    await h.mount();
    await wheel();
    act(() => { api.leaveCamera(); });
    act(() => { api.leaveCamera(); });
    await idle();
    expect(h.calls).toHaveLength(1);

    let accept = false;
    const r = mountHost("t1", "p1", () => accept);
    act(() => root.unmount());
    root = createRoot(host);
    await r.mount();
    await wheel();
    let first = "";
    act(() => { first = api.leaveCamera(); });
    expect(first).toBe("refused");
    accept = true;
    act(() => { api.leaveCamera(); });
    await idle();
    expect(r.calls).toHaveLength(1);
  });

  it("페이지가 숨으면 밀린 기록을 바로 넘긴다", async () => {
    const h = mountHost();
    await h.mount();
    await wheel();
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    hidden.mockRestore();
    expect(h.calls).toHaveLength(1);
    await idle();
    expect(h.calls).toHaveLength(1);
  });
});

// ── 실제 SceneBoard — 래퍼·actionRef·memory return 연결 ──
const card = (id: string, x: number) => ({ id, kind: "text", x, y: 110, text: id });
const sceneOf = (id: string) => ({ id, name: id, created_at: 0, edges: [], cards: [card(`${id}-a`, 110)], groups: [] }) as never;
type Actions = { flushCamera: () => void; flushPending: () => void };

describe("SceneBoard 연결", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  const boardEl = () => host.querySelector<HTMLElement>(".scene-board")!;
  const wheelBoard = () => act(async () => {
    boardEl().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 10, clientY: 10 }));
  });
  function mountBoard(answer: () => boolean = () => true) {
    const calls: { camera: Camera; target: CanvasTarget }[] = [];
    const actionRef = { current: null } as MutableRefObject<Actions | null>;
    let switchTo!: (id: string) => void;
    function Parent() {
      const [id, setId] = useState("S");
      switchTo = setId;
      const scene = useRef<Record<string, unknown>>({});
      scene.current[id] ??= sceneOf(id);
      return (
        <SceneBoard scene={scene.current[id] as never} actionRef={actionRef as never} onChange={() => {}}
          onCameraChange={(camera, target) => { calls.push({ camera, target }); return answer(); }} />
      );
    }
    return { calls, actionRef, switchTo: (id: string) => act(async () => switchTo(id)), mount: () => act(async () => { root.render(<Parent />); }) };
  }

  it("actionRef.flushCamera(App 이 씬 전환·분리 창 열기 전에 부름)가 밀린 기록을 그 판의 target 으로 바로 넘긴다", async () => {
    const b = mountBoard();
    await b.mount();
    await wheelBoard();
    expect(b.calls).toEqual([]);
    act(() => b.actionRef.current!.flushCamera());
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0].target).toMatchObject({ sceneId: "S", accountNamespace: canvasTarget("S").accountNamespace });
    await idle();
    expect(b.calls).toHaveLength(1);
  });

  it("허브 넘기기·분리 창 돌려주기(flushCanvasMemoryReturn)가 밀린 기록을 넘긴다", async () => {
    const b = mountBoard();
    await b.mount();
    await wheelBoard();
    act(() => flushCanvasMemoryReturn());
    expect(b.calls.map((c) => c.target.sceneId)).toEqual(["S"]);
  });

  it("selectScene 을 거치지 않고 씬 prop 이 바뀌어도(보조 경로) 떠나는 씬 target 으로 1회 — 틈에 버리지 않는다, 새 씬은 새 target", async () => {
    const b = mountBoard();
    await b.mount();
    await wheelBoard();
    await b.switchTo("T");
    expect(b.calls.map((c) => c.target.sceneId)).toEqual(["S"]);
    await wheelBoard();
    await idle();
    expect(b.calls.map((c) => c.target.sceneId)).toEqual(["S", "T"]);
  });

  it("계정이 바뀐 대기는 쓰지 않고 지운다(창 쓰기 권한 거절과 달리 다시 싣지 않음)", async () => {
    const before = getAccountScope();
    const b = mountBoard();
    await b.mount();
    await wheelBoard();
    setAccountScope("someone-else@example.test");
    try {
      await idle();
      expect(b.calls).toEqual([]);
    } finally {
      setAccountScope(before);
    }
    await idle(CAMERA_IDLE_SAVE_MS * 2);
    act(() => b.actionRef.current!.flushCamera());
    expect(b.calls).toEqual([]); // 지운 대기는 돌아온 뒤에도 쓰지 않는다
  });

  it("내용 되돌리기(Ctrl+Z)는 카메라 대기를 지우지 않는다", async () => {
    const b = mountBoard();
    await b.mount();
    await wheelBoard();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", code: "KeyZ", ctrlKey: true })); });
    await idle();
    expect(b.calls).toHaveLength(1);
  });
});

// ── 조율 훅 — selectScene 순서·접수 뒤 저장소 재시도 ──
describe("조율(selectScene)·저장소", () => {
  const sceneRow = (id: string): Scene => ({ id, name: id, cards: [{ id: `${id}-a`, kind: "text", x: 0, y: 0, text: id } as unknown as SceneCard], edges: [], created_at: 1 }) as Scene;
  let coordination: ReturnType<typeof useSceneCoordination> | null = null;
  function Coordination() {
    coordination = useSceneCoordination();
    return null;
  }
  const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });

  it("selectScene 은 옛 보드가 유효할 때 카메라 → 입력 순으로 넘긴 뒤 활성 씬을 바꾼다", async () => {
    saveScenes(null, [sceneRow("s1"), sceneRow("s2")]);
    await act(async () => root.render(<Coordination />));
    await settle();
    await act(async () => coordination!.selectScene("s1"));
    const order: string[] = [];
    coordination!.sceneActionRef.current = {
      flushCamera: () => order.push(`camera@${coordination!.activeSceneId}`),
      flushPending: () => order.push(`input@${coordination!.activeSceneId}`),
    } as never;
    await act(async () => coordination!.selectScene("s2"));
    expect(order).toEqual(["camera@s1", "input@s1"]);
    expect(coordination!.activeSceneId).toBe("s2");
    coordination!.sceneActionRef.current = null;
    coordination = null;
  });

  it("접수된 카메라는 IndexedDB 가 실패해도 추가 조작 없이 저장소 재시도로 확정된다", async () => {
    saveScenes(null, [sceneRow("s1")]);
    await act(async () => root.render(<Coordination />));
    await settle();
    failSceneStoreWritesForTest(true);
    try {
      const receipt = coordination!.canvasDocument.commit(canvasTarget("s1"), { type: "recordCamera", camera: { z: 2, x: 7, y: 9 } });
      expect(receipt.queued).toBe(true);
      expect(await receipt.confirmed).toBe(false); // 이번 시도는 실패
    } finally {
      failSceneStoreWritesForTest(false);
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2300)); }); // 저장소 재시도(2초)
    await settle();
    expect(listPersistedScenes(null).find((s) => s.id === "s1")?.camera).toEqual({ z: 2, x: 7, y: 9 });
    coordination = null;
  }, 10_000);
});
