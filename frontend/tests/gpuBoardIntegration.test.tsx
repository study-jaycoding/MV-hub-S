// @vitest-environment jsdom
// GPU 보기 모드를 실제 SceneBoard 로 본다(docs/status/캔버스_GPU판설계_2026-11-11.md 계약 off·mode·readonly·data·transition).
//  jsdom 에는 WebGL 이 없어 GPU 판 칸(GpuBoard)만 가짜로 바꾼다 — 준비 끝·켤 때 검사를 바로 알려 보기 모드(gpu)로 들어간다.
//  모드 관리(useGpuBoardMode)·편집 막기·세션 실행점·덧판은 진짜다.
import { act, Profiler, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";
import type { GpuBoardProps } from "../src/features/canvas/gpu/GpuBoard";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi, models: [] as number[], probe: 1, hold: null as null | "preparing" | "probing", mounts: 0,
  props: null as null | { onUndrawable?: (id: string) => void } }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));
vi.mock("../src/features/canvas/gpu/GpuBoard", async (original) => {
  const real = await original<typeof import("../src/features/canvas/gpu/GpuBoard")>();
  function FakeGpuBoard(props: GpuBoardProps) {
    fixture.models.push(props.model.cards.length);
    fixture.props = props;
    useEffect(() => { fixture.mounts++; }, []);
    useEffect(() => {
      // hold = 그 단계에서 멈춰 둔다(준비가 안 끝남·검사가 안 끝남)
      if (props.phase === "preparing" && fixture.hold !== "preparing") props.dispatch({ type: "prepared", token: props.token });
      if (props.phase === "probing" && fixture.hold !== "probing") props.dispatch({ type: "probe", token: props.token, medianMs: fixture.probe });
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
// 거절 안내 — flashMsg 는 앱 이벤트(ch:flash)로 나간다. 모드 단추 글('보기 모드(GPU)')과 섞이지 않게 이벤트를 센다
let notices: string[] = [];
const onFlash = (e: Event) => notices.push(String((e as CustomEvent).detail));
const refusals = () => notices.filter((n) => n.startsWith("보기 모드"));

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
  fixture.hold = null;
  fixture.mounts = 0;
  fixture.data = {
    genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
  } as unknown as SceneGenDataApi;
  onChange = vi.fn();
  notices = [];
  window.addEventListener("ch:flash", onFlash);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  window.removeEventListener("ch:flash", onFlash);
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

it("잠금은 보드가 다시 올라와도(탭을 떠났다 옴) 이어진다 — 느린 PC 에서 다시 검사하지 않는다", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  fixture.probe = 40;
  await show(cards3);
  await flush();
  expect(fixture.mounts).toBe(1);
  await act(async () => { root.render(<div />); });
  await show(cards3);
  await flush();
  expect(phase()).toBeNull();
  expect(fixture.mounts).toBe(1); // 준비(GPU 판)를 다시 만들지 않는다
  expect(host.querySelector(".scene-gpu-mode")?.textContent).toContain("GPU 못 씀");
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
  expect(refusals()).toHaveLength(1); // 거절이 여럿이어도 안내는 겹치지 않게 한 번
});

it("보기 모드에서도 허용 목록(참조 동기화·실행 결과 표시)은 거절하지 않고, 화면 이동 뒤 카메라는 저장된다", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  const onCameraChange = vi.fn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await act(async () => { root.render(<SceneBoard scene={sceneOf(cards3)} onChange={onChange} actionRef={actionRef as never} onCameraChange={onCameraChange} />); });
    await flush();
    expect(phase()).toBe("gpu");
    await act(async () => {
      actionRef.current!.commitDocument({ type: "synchronizeReferences" } as never);
      actionRef.current!.commitDocument({ type: "showComfyRunning", runs: [] } as never);
    });
    expect(refusals()).toEqual([]);
    await act(async () => { board().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 500, clientY: 300 })); });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(onCameraChange).toHaveBeenCalled();
    expect(phase()).toBe("gpu");
  } finally {
    vi.useRealTimers();
  }
});

it("덧판이 뜨기 전 첫 휠 — 글 카드 위면 그 자리에서 덧판을 바로 붙인다(속이 넘치면 그 속을 굴림 — jsdom 은 배치가 없어 붙는 것만 본다)", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  await show(cards3);
  await flush();
  expect(host.querySelector(".scene-gpu-overlay")).toBeNull();
  // jsdom 에는 elementFromPoint 가 없다 — 붙은 덧판을 돌려준다(넘치지 않는 속이라 굴리지 않고 줌으로 간다)
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => host.querySelector(".scene-gpu-overlay") });
  try {
    await act(async () => { board().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 20, clientY: 20 })); });
    expect(host.querySelector(".scene-gpu-overlay")).not.toBeNull();
  } finally {
    delete (document as unknown as Record<string, unknown>).elementFromPoint;
  }
});

it("가려진 레퍼런스 카드도 두 번 누르면 크게 보기 창으로 읽는다(덧판은 안 띄움)", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  const onPreview = vi.fn();
  const ref = { id: "r", kind: "reference", x: 0, y: 0, w: 260, h: 195, refs: [{ type: "image", file_path: "/media/a.png", name: "a" }] };
  const front = textCard("t", 100, 50); // 뒤 레퍼런스의 일부를 가린다
  await act(async () => { root.render(<SceneBoard scene={sceneOf([ref, front])} onChange={onChange} actionRef={actionRef as never} onPreview={onPreview} />); });
  await flush();
  expect(phase()).toBe("gpu");
  await act(async () => { board().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 10, clientY: 10 })); });
  expect(onPreview).toHaveBeenCalledTimes(1);
  expect(onPreview.mock.calls[0][0]).toMatchObject({ type: "image" });
  expect(host.querySelector(".scene-gpu-overlay")).toBeNull();
});

it("표식 끔 — 카메라 변화(휠 3번)·씬 전환 뒤 SceneBoard 렌더 수가 변경 전과 같다(dev 06a41a76 사본에서 같은 조작 = 휠 뒤 3·전환까지 9, 11-11 측정)", async () => {
  let commits = 0;
  const view = (id: string) => <Profiler id="sb" onRender={() => { commits++; }}><SceneBoard scene={sceneOf(cards3, id)} onChange={onChange} /></Profiler>;
  await act(async () => { root.render(view("s1")); });
  await flush();
  commits = 0;
  for (let i = 0; i < 3; i++) await act(async () => { board().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 10, clientY: 10 })); });
  await flush();
  const wheel = commits;
  await act(async () => { root.render(view("s2")); });
  await flush();
  expect({ wheel, total: commits }).toEqual({ wheel: 3, total: 9 });
});

it("보기 모드에서 붙여넣기·끌어 놓기·문맥 메뉴는 입구에서 거절 — 서버에 올리지 않는다(fetch 0)", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  await show(cards3);
  await flush();
  expect(phase()).toBe("gpu");
  vi.mocked(fetch).mockClear(); // 띄울 때의 열람 기록 조회는 빼고 센다
  const png = new File(["x"], "a.png", { type: "image/png" });
  const paste = Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
    clipboardData: { items: [{ type: "image/png", getAsFile: () => png }], files: [png], getData: () => "" },
  });
  await act(async () => { window.dispatchEvent(paste); });
  expect(paste.defaultPrevented).toBe(true);
  const drop = Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
    dataTransfer: { types: ["Files"], files: [png], items: [{ kind: "file", type: "image/png", getAsFile: () => png }], getData: () => "" },
  });
  await act(async () => { board().dispatchEvent(drop); });
  expect(drop.defaultPrevented).toBe(true);
  const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  await act(async () => { board().dispatchEvent(menu); });
  expect(menu.defaultPrevented).toBe(true);
  await flush();
  expect(fetch).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("보기 모드");
});

it("검사(probing) 중엔 DOM 판이 그대로 보이고, 카드 누름은 캡처에서 막혀 카드에 닿지 않는다(고르기 0)", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  fixture.hold = "probing";
  await show(cards3);
  await flush();
  expect(phase()).toBe("probing");
  expect(domCards()).toBe(3); // 검사가 끝나야 바꾼다(계약 transition)
  const card = host.querySelector<HTMLElement>('.scene-card[data-id="b"]') ?? host.querySelectorAll<HTMLElement>(".scene-card")[1];
  await act(async () => {
    card.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 320, clientY: 20 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 320, clientY: 20 }));
  });
  await flush();
  expect(host.querySelectorAll(".scene-card.sel")).toHaveLength(0);
  expect(onChange).not.toHaveBeenCalled();
});

it("준비를 취소한 뒤 편집이 이어지는 동안은 다시 준비하지 않는다 — 마지막 입력 뒤 1초 조용해야 처음부터(새 GPU 판 1번)", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  fixture.hold = "preparing";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await show(cards3);
    await flush();
    expect(phase()).toBe("preparing");
    expect(fixture.mounts).toBe(1);
    const press = () => act(async () => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); });
    await press(); // 준비 취소
    expect(phase()).toBeNull();
    for (let i = 0; i < 3; i++) {
      await act(async () => { vi.advanceTimersByTime(900); });
      await press(); // 편집이 이어진다 — 기다림을 늘인다
      expect(phase()).toBeNull();
    }
    await act(async () => { vi.advanceTimersByTime(1100); });
    expect(phase()).toBe("preparing");
    expect(fixture.mounts).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it("보기 모드에서 리스트를 두 번 누르면 모은 항목을 읽기 창으로 연다(글 리스트 = 글 보기 창) — 카드 안 펼치기(편집)는 하지 않는다", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  const list = { id: "L", kind: "list", x: 0, y: 300, w: 260, h: 200 };
  const scene = { ...(sceneOf([textCard("a", 0, 0), textCard("b", 300, 0), list]) as object), edges: [{ id: "e1", from: "a", to: "L" }, { id: "e2", from: "b", to: "L" }] };
  await act(async () => { root.render(<SceneBoard scene={scene as never} onChange={onChange} actionRef={actionRef as never} />); });
  await flush();
  expect(phase()).toBe("gpu");
  await act(async () => { board().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 50, clientY: 175 })); });
  expect(host.querySelector(".scene-modelmodal-backdrop")).not.toBeNull();
  expect(host.querySelector("[data-list-expanded]")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

it("검사(probing) 중 DOM 리스트를 두 번 눌러도 카드 안 펼치기(순서 바꾸기 편집)가 열리지 않고, 줄 누름도 순서 바꾸기를 시작하지 않는다", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  fixture.hold = "probing";
  const list = { id: "L", kind: "list", x: 0, y: 300, w: 260, h: 200 };
  const scene = { ...(sceneOf([textCard("a", 0, 0), textCard("b", 300, 0), list]) as object), edges: [{ id: "e1", from: "a", to: "L" }, { id: "e2", from: "b", to: "L" }] };
  await act(async () => { root.render(<SceneBoard scene={scene as never} onChange={onChange} actionRef={actionRef as never} />); });
  await flush();
  expect(phase()).toBe("probing");
  const listEl = [...host.querySelectorAll<HTMLElement>(".scene-card")].find((el) => el.querySelector(".scene-listnode"))!;
  expect(listEl).toBeTruthy();
  await act(async () => {
    listEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 50, clientY: 175 }));
  });
  await flush();
  expect(host.querySelector("[data-list-expanded]")).toBeNull();
  const row = listEl.querySelector<HTMLElement>("[data-reid]");
  if (row) await act(async () => { row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); });
  await flush();
  expect(onChange).not.toHaveBeenCalled();
});

it("검사(probing) 중 보이는 DOM 카드의 단추 클릭(Generate)은 실행되지 않는다 — 누름만 막고 click 이 지나가 유료 생성이 걸리던 틈(리뷰 2차)", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  fixture.hold = "preparing";
  const onGenerateCard = vi.fn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const gen = { id: "g", kind: "generation", x: 0, y: 0, w: 260, h: 260 };
    await act(async () => { root.render(<SceneBoard scene={sceneOf([gen])} onChange={onChange} actionRef={actionRef as never} onGenerateCard={onGenerateCard as never} />); });
    await flush();
    // 편집 단계(준비 취소)에서 카드를 고른다
    const cardEl = host.querySelector<HTMLElement>(".scene-card")!;
    await act(async () => {
      cardEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
    });
    await flush();
    const button = () => [...host.querySelectorAll<HTMLElement>("button")].find((b) => /Generate/.test(b.textContent || ""));
    expect(button()).toBeTruthy(); // 이 카드만 고르면 Generate 막대
    // 조용히 1초 → 준비 → 검사에서 멈춤
    fixture.hold = "probing";
    await act(async () => { vi.advanceTimersByTime(1100); });
    await flush();
    expect(phase()).toBe("probing");
    const b = button();
    expect(b).toBeTruthy(); // DOM 판이 그대로 보인다
    await act(async () => {
      b!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      b!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await flush();
    expect(onGenerateCard).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("검사(probing) 중 DOM 카드의 문맥 메뉴는 캡처에서 막혀 카드 처리기에 닿지 않는다(안내 한 번)", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  fixture.hold = "probing";
  await show(cards3);
  await flush();
  expect(phase()).toBe("probing");
  const cardEl = host.querySelector<HTMLElement>(".scene-card")!;
  const reached = vi.fn();
  cardEl.addEventListener("contextmenu", reached);
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  await act(async () => { cardEl.dispatchEvent(ev); });
  expect(ev.defaultPrevented).toBe(true);
  expect(reached).not.toHaveBeenCalled();
  expect(refusals()).toHaveLength(1);
});

it("미지원 노드를 지운 씬은 모드 단추로 다시 켤 수 있다 — 지금도 있으면 까닭만 알린다", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  const comfy = { id: "cf", kind: "comfy", x: 0, y: 300, w: 200, h: 200 };
  await show([...cards3, comfy]);
  await flush();
  expect(phase()).toBeNull();
  const button = () => host.querySelector<HTMLButtonElement>(".scene-gpu-mode")!;
  await act(async () => { button().click(); });
  await flush();
  expect(phase()).toBeNull();
  expect(notices.some((n) => n.includes("못 그리는 노드"))).toBe(true);
  await show(cards3); // 같은 씬에서 Comfy 노드를 지웠다(씬 막음 기록만 남음)
  await flush();
  expect(phase()).toBeNull();
  await act(async () => { button().click(); });
  await flush();
  expect(phase()).toBe("gpu");
});

it("리스트 읽기 창의 항목은 그림과 같은 해석 — genId 없이 변형(genIds)만 있는 생성 카드도 결과물로 연다", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  const g1 = { id: "g1", status: "done", prompt: "p", assets: [{ id: "a1", generation_id: "g1", type: "image", file_path: "/media/g1.png", thumbnail_path: null }] };
  fixture.data = { ...fixture.data, genData: { g1 }, genDataRef: { current: { g1 } } } as unknown as SceneGenDataApi;
  const onPreview = vi.fn();
  const gen = { id: "G", kind: "generation", x: 0, y: 0, w: 260, h: 260, genIds: ["g1"] };
  const list = { id: "L", kind: "list", x: 0, y: 400, w: 260, h: 200 };
  const scene = { ...(sceneOf([gen, list]) as object), edges: [{ id: "e1", from: "G", to: "L" }] };
  await act(async () => { root.render(<SceneBoard scene={scene as never} onChange={onChange} actionRef={actionRef as never} onPreview={onPreview} />); });
  await flush();
  expect(phase()).toBe("gpu");
  await act(async () => { board().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 50, clientY: 250 })); });
  expect(onPreview).toHaveBeenCalledTimes(1);
  expect(onPreview.mock.calls[0][0]).toMatchObject({ url: "/media/g1.png", genId: "g1" });
});

it("GPU 판이 그림을 그릴 수 없다고 알린 카드가 있는 동안 DOM 판에 두고, 그 카드를 지우면 모드 단추로 다시 켤 수 있다", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  await show(cards3);
  await flush();
  expect(phase()).toBe("gpu");
  await act(async () => { fixture.props!.onUndrawable!("b"); });
  await flush();
  expect(phase()).toBeNull();
  const button = () => host.querySelector<HTMLButtonElement>(".scene-gpu-mode")!;
  await act(async () => { button().click(); }); // 그 카드가 그대로면 까닭만
  await flush();
  expect(phase()).toBeNull();
  await show([cards3[0], cards3[2]]); // 그 카드를 지웠다
  await flush();
  await act(async () => { button().click(); });
  await flush();
  expect(phase()).toBe("gpu");
});

it("보기 모드에서 결과 되찾기(recoverCardGeneration)는 사용자 명령이라 거절한다", async () => {
  localStorage.setItem("mvhub.canvas.gpuBoard", "1");
  await show(cards3);
  await flush();
  let ok = true;
  await act(async () => { ok = actionRef.current!.commitDocument({ type: "recoverCardGeneration", cardId: "a", generationId: "g1", createdAtById: {} } as never); });
  expect(ok).toBe(false);
  await flush();
  expect(onChange).not.toHaveBeenCalled();
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
  // 카메라가 그대로인 다시 그리기는 알리지 않는다 — 받는 쪽이 '조작 중'으로 셌다(11-11 리뷰)
  await act(async () => { root.render(<Harness />); });
  expect(calls).toEqual([]);
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
