// @vitest-environment jsdom
// 메인 창과 휠 클릭으로 띄운 캔버스 창을 한 창처럼(2026-10-30, docs/status/캔버스_두창_함께쓰기_2026-10-30.md) — 배경 씬 쓰기 쉼(①)·
// 되돌리기 기록과 복사한 노드 주고받기(②④)·Comfy '생성중' 실시간 나눔(③)·보기 설정과 생성 폴더 따라가기(⑤).
// 창마다 모듈이 따로라 vi.resetModules 로 다른 창의 모듈을 흉내 낸다(같은 jsdom 창을 서로의 opener 로 쓴다). pagehide 듣기가 남으므로
// pagehide 를 쓰는 시험은 뒤에 둔다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({
  resolveCanvasGenerationLinks: vi.fn(async () => ({ links: [] })),
  getGenerationsBatch: vi.fn(async () => ({ items: {} })),
  repairCanvasGenerationLinks: vi.fn(async () => ({ links: [] })),
  jsonFetch: vi.fn(async () => ({ tasks: [] })),
}));
vi.mock("../src/api", () => ({ api: {
  resolveCanvasGenerationLinks: network.resolveCanvasGenerationLinks,
  getGenerationsBatch: network.getGenerationsBatch,
  repairCanvasGenerationLinks: network.repairCanvasGenerationLinks,
} }));
vi.mock("../src/lib/http", async (original) => ({ ...await original<typeof import("../src/lib/http")>(), jsonFetch: network.jsonFetch }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  Object.values(network).forEach((fn) => fn.mockClear());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.name = "";
  vi.restoreAllMocks();
});

const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
async function until(check: () => boolean) {
  for (let waited = 0; !check(); waited += 10) {
    if (waited > 2000) throw new Error("기다린 값이 오지 않았다");
    await sleep(10);
  }
}
// 이 창이 캔버스 창을 연 것처럼 — 떠 있음이 켜진다(lib/popupWindows 의 openEmbedWindow)
function float(popup: typeof import("../src/lib/popupWindows")) {
  const win = { closed: false, focus: vi.fn(), close: vi.fn(() => { win.closed = true; }), addEventListener: vi.fn(),
    location: { href: "http://localhost/?embed=canvas" } };
  vi.spyOn(window, "open").mockImplementation((() => win) as never);
  popup.openEmbedWindow(popup.EMBED_MODES.canvas);
  expect(popup.isCanvasFloating()).toBe(true);
  return win;
}
const BUCKET = "local::_none";
async function seedScenes(scenes: object[]) {
  const { initSceneStore } = await import("../src/lib/sceneStore");
  let mark: Parameters<typeof initSceneStore>[1] = null;
  await initSceneStore(() => ({ [BUCKET]: scenes as never }), mark, (next) => { mark = next; return true; });
}

describe("① 떠 있는 동안 메인 창은 씬에 쓰는 배경 작업을 쉰다", () => {
  it("생성 결과 붙이기·표식 걷기·새 표식이 씬을 쓰지 않고(결과 목록은 반영) 복구 주기도 서버를 부르지 않는다 — 떠 있지 않으면 지금처럼", async () => {
    vi.resetModules();
    const popup = await import("../src/lib/popupWindows");
    const { useCanvasGenerationLinks } = await import("../src/lib/useCanvasGenerationLinks");
    const attempt = { attemptId: "at1", generationId: "g1", createdAt: Date.now() };
    await seedScenes([{ id: "s1", name: "s1", created_at: 1, edges: [], cards: [{ id: "c1", kind: "generation", x: 0, y: 0, pendingGenerationAttempts: [attempt] }] }]);
    const { listScenes } = await import("../src/lib/scenes");
    const commit = vi.fn(() => ({ queued: true, confirmed: Promise.resolve(true) }));
    const canvasDocument = { commit, snapshot: () => listScenes(null)[0], flush: vi.fn() } as never;
    const setGens = vi.fn();
    let links: ReturnType<typeof useCanvasGenerationLinks> | null = null;
    function Probe() {
      links = useCanvasGenerationLinks({ authReady: true, scenes: listScenes(null), canvasDocument, setGens });
      return null;
    }
    float(popup);
    act(() => root.render(<Probe />));
    await sleep(30);
    expect(network.resolveCanvasGenerationLinks).not.toHaveBeenCalled(); // 복구 주기 — 떠 있는 창이 한다

    const link = { attempt_id: "at1", generation_id: "g1", scene_id: "s1", card_id: "c1" };
    act(() => links!.settleCanvasGeneration(link, { id: "g1" } as never));
    expect(setGens).toHaveBeenCalled(); // 결과 목록은 반영
    act(() => links!.discardCanvasGeneration(link));
    expect(await links!.prepareCanvasGenerationBatch("s1", ["c1"])).toEqual([]);
    expect(commit).not.toHaveBeenCalled();

    popup.closeEmbedWindow(popup.EMBED_MODES.canvas); // 창이 닫혔다 — 떠 있음이 풀린다
    expect(popup.isCanvasFloating()).toBe(false);
    act(() => links!.settleCanvasGeneration(link, { id: "g1" } as never));
    expect(commit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "settleGeneration" }));
  });

  it("MCP 캔버스 카드 붙이기는 떠 있는 동안 작업 목록을 받지도 않는다", async () => {
    vi.resetModules();
    const popup = await import("../src/lib/popupWindows");
    await seedScenes([]);
    const { useMcpCanvasTasks } = await import("../src/lib/mcpCanvasTasks");
    function Probe() {
      useMcpCanvasTasks({ authReady: true, authKey: "k", workspace: { scope: "personal", id: null, name: null }, flushScenePending: vi.fn(), refreshSceneById: vi.fn() });
      return null;
    }
    float(popup);
    act(() => root.render(<Probe />));
    await sleep(30);
    expect(network.jsonFetch).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(host);
    popup.closeEmbedWindow(popup.EMBED_MODES.canvas);
    act(() => root.render(<Probe />));
    await until(() => network.jsonFetch.mock.calls.length > 0); // 떠 있지 않으면 지금처럼 받는다
  });
});

describe("⑤ 떠 있는 동안 보기 설정·생성 폴더·자동 태그를 다른 창이 바꾸면 따라간다", () => {
  async function mountFilters() {
    const { useLibraryFilters } = await import("../src/lib/useLibraryFilters");
    const { makeStore } = await import("../src/lib/storage");
    const store = makeStore("ch.lib.");
    const seen = { value: null as ReturnType<typeof useLibraryFilters> | null };
    function Probe() {
      seen.value = useLibraryFilters(store);
      return null;
    }
    act(() => root.render(<Probe />));
    return seen;
  }
  // 다른 창이 저장했다 — 이 창에는 storage 알림이 온다
  const otherWindowSaves = (key: string, value: string) => act(() => {
    localStorage.setItem(`ch.lib.${key}`, value);
    window.dispatchEvent(new StorageEvent("storage", { key: `ch.lib.${key}`, newValue: value }));
  });

  it("캔버스 창은 종류·색·생성 폴더·자동 태그를 따라가고, 보던 자리(탭·폴더)는 따라가지 않는다", async () => {
    vi.resetModules();
    window.name = "contenthub-canvas";
    const seen = await mountFilters();
    otherWindowSaves("typeFilter", "video");
    otherWindowSaves("colorFilter", JSON.stringify(["red"]));
    otherWindowSaves("armedFolder", JSON.stringify({ projectId: "p1", path: "ep01/c010" }));
    otherWindowSaves("armedAutoTags", JSON.stringify(["밤"]));
    otherWindowSaves("filtersV2", JSON.stringify({ tab: "team", project_id: "p9", __v: "2" }));
    expect(seen.value!.typeFilter).toBe("video");
    expect([...seen.value!.colorFilter]).toEqual(["red"]);
    expect(seen.value!.armedFolder).toEqual({ projectId: "p1", path: "ep01/c010" });
    expect([...seen.value!.armedAutoTags]).toEqual(["밤"]);
    expect(seen.value!.filters.tab).toBe("compose");
    expect(seen.value!.filters.project_id).toBeUndefined();
  });

  it("메인 창은 캔버스가 떠 있을 때만 따라간다 — 떠 있지 않은 두 탭은 서로 바꾸지 않는다", async () => {
    vi.resetModules();
    const popup = await import("../src/lib/popupWindows");
    const seen = await mountFilters();
    otherWindowSaves("typeFilter", "video");
    expect(seen.value!.typeFilter).toBe("all");
    act(() => { float(popup); });
    otherWindowSaves("typeFilter", "image");
    expect(seen.value!.typeFilter).toBe("image");
    popup.closeEmbedWindow(popup.EMBED_MODES.canvas);
  });
});

describe("③ Comfy '생성중'을 창끼리 나눈다", () => {
  it("다른 창의 실행이 이 창에도 '생성중'이고, 그 창이 끝내거나 닫히면 지워진다 — 자기 몫은 그대로", async () => {
    vi.resetModules();
    const main = await import("../src/lib/sceneComfyRunningStore");
    main.setComfyRunning(["c1"], true); // 띄우기 전에 메인 창에서 건 실행
    vi.resetModules();
    const canvas = await import("../src/lib/sceneComfyRunningStore");
    const stop = canvas.subscribeComfyRunning(() => {}); // 캔버스 창 보드가 본다 — 처음 등록할 때 묻는다
    await until(() => canvas.isComfyRunning("c1"));
    main.setComfyRunning(["c1"], false);
    await until(() => !canvas.isComfyRunning("c1"));
    main.setComfyRunning(["c2"], true);
    canvas.setComfyRunning(["mine"], true);
    await until(() => canvas.isComfyRunning("c2") && main.isComfyRunning("mine"));
    window.dispatchEvent(new Event("pagehide")); // 창이 닫힌 것처럼 — 두 모듈 모두 'gone' 을 보낸다
    await until(() => !canvas.isComfyRunning("c2") && !main.isComfyRunning("mine"));
    expect(canvas.isComfyRunning("mine")).toBe(true);
    expect(main.isComfyRunning("c2")).toBe(true);
    stop();
  });
});

describe("②④ 되돌리기 기록·복사한 노드를 주고받는다", () => {
  const snap = (id: string) => ({ cards: [{ id }], edges: [], groups: [] }) as never;

  it("캔버스 창은 켜질 때 메인 창의 기록·복사한 노드를 받고, 닫을 때 열린 보드의 기록까지 'closed' 보다 먼저 돌려준다", async () => {
    // 메인 창
    vi.resetModules();
    const mainPopup = await import("../src/lib/popupWindows");
    const mainUndo = await import("../src/lib/sceneUndoStore");
    await import("../src/lib/useSceneClipboardDrop");
    mainPopup.shareCanvasMemory();
    const port = (window as unknown as Record<string, { save: () => Record<string, unknown>; load: (m: object) => void }>).__mvhubCanvasMemory;
    mainUndo.saveSceneHistory("s1", { undo: [snap("a")], redo: [], lastCommit: snap("b") });
    port.load({ sceneClipboard: { snapshot: { cards: [{ id: "copied" }], edges: [], inEdges: [] }, marker: "m1" } }); // 메인 창에서 복사해 둔 노드
    Object.defineProperty(window, "opener", { value: window, configurable: true });

    // 캔버스 창
    window.name = "contenthub-canvas";
    vi.resetModules();
    const canvasPopup = await import("../src/lib/popupWindows");
    canvasPopup.announceCanvasWindow(); // 켜질 때 받아 둔다
    const canvasUndo = await import("../src/lib/sceneUndoStore"); // 등록하며 꺼내 간다
    await import("../src/lib/useSceneClipboardDrop");
    expect(canvasUndo.loadSceneHistory("s1")).toEqual({ undo: [snap("a")], redo: [], lastCommit: snap("b") });

    // 캔버스 창에서 고쳤다 — 열린 보드는 기록을 언마운트 때만 store 에 남긴다(그래서 닫을 때 먼저 남긴다)
    canvasUndo.registerLiveSceneHistory(() =>
      canvasUndo.saveSceneHistory("s1", { undo: [snap("a"), snap("b")], redo: [], lastCommit: snap("c") }));
    port.load({ sceneClipboard: { snapshot: { cards: [{ id: "stale" }], edges: [], inEdges: [] }, marker: "m0" } }); // 메인 창 쪽은 옛것이라 치고
    const heard: unknown[] = [];
    const listener = new BroadcastChannel("mvhub-canvas-window");
    listener.onmessage = (event) => heard.push(event.data);
    try {
      window.dispatchEvent(new Event("pagehide")); // 캔버스 창을 닫았다
      // 돌려주기는 동기다 — 'closed' 알림이 닿기 전에 이미 메인 창 store 에 있다
      expect(heard).toEqual([]);
      expect(mainUndo.loadSceneHistory("s1")).toEqual({ undo: [snap("a"), snap("b")], redo: [], lastCommit: snap("c") });
      expect(port.save().sceneClipboard).toEqual({ snapshot: { cards: [{ id: "copied" }], edges: [], inEdges: [] }, marker: "m1" });
      await until(() => heard.includes("closed"));
    } finally {
      listener.close();
      Reflect.deleteProperty(window, "opener");
    }
  });
});
