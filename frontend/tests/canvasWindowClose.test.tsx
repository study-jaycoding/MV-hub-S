// @vitest-environment jsdom
// 떠 있는 캔버스 창을 닫는 순간(2026-10-31, docs/status/캔버스_닫는순간_2026-10-31.md) — 닫는 창의 미확정 변경을 메인 창이 이어 쓰고,
// 메인 창은 저장소를 다시 읽은 뒤에 캔버스를 돌려받고, 프롬프트 값이 메인 창으로 돌아온다.
// 창마다 모듈이 따로라 vi.resetModules 로 다른 창의 모듈을 흉내 낸다. 메모리 대체 저장소는 모듈마다 따로라, 두 창이 같은 저장소를 보는 시험은
// writeSceneStoreAsOtherWindowForTest 로 다른 창의 쓰기를 흉내 낸다.
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneCard, SceneEdge, SceneGroup } from "../src/lib/scenes";
import type { SceneLayerMove } from "../src/lib/useSceneCardMove";
import type { CanvasPromptPort } from "../src/lib/useCanvasPromptReturn";

const EMPTY_SKIPPED = vi.hoisted(() => new Set<string>());
vi.mock("../src/api", () => ({
  api: { locateAssets: async (tokens: string[]) => ({ fixed: [], unresolved: [], missing: [], local: [], open: tokens }) },
}));
vi.mock("../src/lib/sceneBackup", () => ({
  initSceneBackup: async () => false,
  countBackupOnlyScenes: async () => 0,
  importFromBackup: async () => 0,
  subscribeSceneRestore: () => () => {},
  subscribeSceneBackupSkipped: () => () => {},
  subscribeSceneBackupSkippedIds: () => () => {},
  getSceneBackupSkippedIds: () => EMPTY_SKIPPED,
  subscribeSceneBackupForked: () => () => {},
}));
vi.mock("../src/lib/sceneCardLinks", () => ({
  initSceneCardLinks: () => {},
  mergeCardLinksIntoScenes: () => null,
  serverCardLinks: () => [],
  subscribeCardLinksLoaded: () => () => {},
}));

const BUCKET = "local::_none";
const scene = (id: string, text = "") => ({ id, name: id, created_at: 1, edges: [], cards: text ? [{ id: "c", kind: "text", x: 0, y: 0, text }] : [] }) as never;
const textOf = (found: { cards: unknown[] } | undefined) => (found?.cards[0] as { text?: string } | undefined)?.text;

async function openWindowStore(scenes: object[]) {
  vi.resetModules();
  const store = await import("../src/lib/sceneStore");
  const data = await import("../src/lib/scenes");
  let mark: Parameters<typeof store.initSceneStore>[1] = null;
  await store.initSceneStore(() => ({ [BUCKET]: scenes as never }), mark, (next) => { mark = next; return true; });
  return { store, data };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.clear();
  // 잠금이 없는 주소에서는 캔버스 창을 띄우지 않는다 — 이 시험의 창은 잠금이 풀리는 일이 없다
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: () => new Promise(() => {}), query: async () => ({ held: [], pending: [] }) } });
});
afterEach(() => {
  window.name = "";
  Reflect.deleteProperty(navigator, "locks");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("닫는 창의 미확정 변경을 메인 창이 이어 쓴다", () => {
  it("미확정 변경만 씬 단위로 넘기고, 메인 창은 작업본·저장소에 넣는다 — 안 바뀐 씬·다른 창이 더한 씬은 그대로", async () => {
    const canvas = await openWindowStore([scene("a", "옛 글"), scene("b", "그대로")]);
    await canvas.store.settleSceneStoreForTest();
    canvas.data.updateScene(null, "a", { cards: [{ id: "c", kind: "text", x: 0, y: 0, text: "새 글" }] as never });
    const writes = canvas.store.unconfirmedSceneWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ bucket: BUCKET, created: [], removed: [], order: null });
    expect(writes[0].changed.map((item) => item.id)).toEqual(["a"]);

    const main = await openWindowStore([scene("a", "옛 글"), scene("b", "그대로"), scene("other", "다른 창")]);
    expect(main.data.adoptCanvasSceneWrites(structuredClone(writes))).toBe(true);
    expect(textOf(main.data.listScenes(null).find((item) => item.id === "a"))).toBe("새 글"); // 동기 — 쓰기가 끝나기 전에 작업본에 있다
    await main.store.settleSceneStoreForTest();
    const saved = main.data.listPersistedScenes(null);
    expect(saved.map((item) => item.id)).toEqual(["a", "b", "other"]);
    expect(textOf(saved[0])).toBe("새 글");
    expect(textOf(saved[1])).toBe("그대로");
    expect(textOf(saved[2])).toBe("다른 창");
  });

  it("미확정이 없으면 넘길 것이 없다 — 이미 확정된 씬을 다시 넘기지 않는다", async () => {
    const canvas = await openWindowStore([scene("a", "옛 글")]);
    canvas.data.updateScene(null, "a", { cards: [{ id: "c", kind: "text", x: 0, y: 0, text: "새 글" }] as never });
    await canvas.store.settleSceneStoreForTest();
    expect(canvas.store.unconfirmedSceneWrites()).toEqual([]);
  });

  it("새 씬·지운 씬·달라진 순서가 반영되고, 새 씬이 저장본에 앞 내용까지만 닿아 있어도 겹치지 않고 뒤 입력까지 남는다", async () => {
    const canvas = await openWindowStore([scene("a"), scene("b")]);
    await canvas.store.settleSceneStoreForTest();
    canvas.data.deleteScene(null, "a");
    const created = canvas.data.createScene(null, "새 씬")!;
    canvas.data.updateScene(null, created.id, { cards: [{ id: "c", kind: "text", x: 0, y: 0, text: "뒤 입력" }] as never });
    const writes = canvas.store.unconfirmedSceneWrites();
    expect(writes[0].created.map((item) => item.id)).toEqual([created.id]);
    expect(writes[0].removed).toEqual(["a"]);
    expect(writes[0].order).toEqual(["b", created.id]);

    const empty = await openWindowStore([scene("a"), scene("b")]); // 그 창의 쓰기가 닿지 않았다
    expect(empty.data.adoptCanvasSceneWrites(structuredClone(writes))).toBe(true);
    await empty.store.settleSceneStoreForTest();
    expect(empty.data.listPersistedScenes(null).map((item) => item.id)).toEqual(["b", created.id]);
    expect(textOf(empty.data.listPersistedScenes(null)[1])).toBe("뒤 입력");

    const reached = await openWindowStore([scene("a"), scene("b"), scene(created.id, "앞 내용")]); // 생성 쓰기만 닿았다
    expect(reached.data.adoptCanvasSceneWrites(structuredClone(writes))).toBe(true);
    await reached.store.settleSceneStoreForTest();
    expect(reached.data.listPersistedScenes(null).map((item) => item.id)).toEqual(["b", created.id]);
    expect(textOf(reached.data.listPersistedScenes(null)[1])).toBe("뒤 입력");
  });

  it("같은 내용을 이미 쓴 저장본 위에서도 결과가 같다", async () => {
    const canvas = await openWindowStore([scene("a", "옛 글")]);
    await canvas.store.settleSceneStoreForTest();
    canvas.data.updateScene(null, "a", { cards: [{ id: "c", kind: "text", x: 0, y: 0, text: "새 글" }] as never });
    const writes = canvas.store.unconfirmedSceneWrites();
    const main = await openWindowStore([scene("a", "새 글")]);
    expect(main.data.adoptCanvasSceneWrites(structuredClone(writes))).toBe(true);
    await main.store.settleSceneStoreForTest();
    expect(textOf(main.data.listPersistedScenes(null)[0])).toBe("새 글");
  });

  it("고친 씬을 다른 창이 지웠으면 되살리지 않고, 작업본에 없고 저장소에만 있는 씬의 고침은 저장소에 확정된다", async () => {
    const canvas = await openWindowStore([scene("gone", "옛 글"), scene("late", "옛 글")]);
    await canvas.store.settleSceneStoreForTest();
    canvas.data.updateScene(null, "gone", { cards: [{ id: "c", kind: "text", x: 0, y: 0, text: "새 글" }] as never });
    canvas.data.updateScene(null, "late", { cards: [{ id: "c", kind: "text", x: 0, y: 0, text: "새 글" }] as never });
    const writes = canvas.store.unconfirmedSceneWrites();

    const main = await openWindowStore([scene("gone", "옛 글")]); // 메인은 'late' 를 아직 모른다
    main.store.writeSceneStoreAsOtherWindowForTest((all) => {
      all[BUCKET] = [scene("late", "옛 글")]; // 다른 창이 gone 을 지우고 late 를 더했다
    });
    expect(main.data.adoptCanvasSceneWrites(structuredClone(writes))).toBe(true);
    await main.store.settleSceneStoreForTest();
    const saved = main.data.listPersistedScenes(null);
    expect(saved.map((item) => item.id)).toEqual(["late"]);
    expect(textOf(saved[0])).toBe("새 글");
  });

  it("메인 저장소가 준비 전이면 받지 않는다", async () => {
    vi.resetModules();
    const data = await import("../src/lib/scenes");
    expect(data.adoptCanvasSceneWrites([{ bucket: BUCKET, created: [], changed: [scene("a", "새 글")], removed: [], order: null }])).toBe(false);
  });

  it("받았다고 답하면 넘긴 연산은 닫는 창에서 쓰이지 않는다 — 재연결을 기다리던 실행도, 받지 못하면 그대로 남아 직접 쓴다", async () => {
    const canvas = await openWindowStore([scene("a", "옛 글")]);
    await canvas.store.settleSceneStoreForTest();
    canvas.store.delaySceneStoreWritesForTest(30); // 실행은 출발했고 트랜잭션은 아직이다
    canvas.data.updateScene(null, "a", { cards: [{ id: "c", kind: "text", x: 0, y: 0, text: "넘긴 글" }] as never });
    await Promise.resolve();
    await Promise.resolve();
    canvas.store.markSceneWritesHanded();
    expect(canvas.store.sceneStoreHasPending()).toBe(false);
    await canvas.store.settleSceneStoreForTest();
    await new Promise((resolve) => setTimeout(resolve, 60));
    canvas.store.delaySceneStoreWritesForTest(0);
    expect(textOf(canvas.data.listPersistedScenes(null)[0])).toBe("옛 글");

    const kept = await openWindowStore([scene("a", "옛 글")]);
    await kept.store.settleSceneStoreForTest();
    kept.data.updateScene(null, "a", { cards: [{ id: "c", kind: "text", x: 0, y: 0, text: "남은 글" }] as never });
    expect(kept.store.unconfirmedSceneWrites()).toHaveLength(1); // 넘길 값을 만들어도 답이 없으면 연산은 그대로다
    expect(kept.store.sceneStoreHasPending()).toBe(true);
    await kept.store.settleSceneStoreForTest();
    expect(textOf(kept.data.listPersistedScenes(null)[0])).toBe("남은 글");
  });
});

describe("창 메모리 손잡이", () => {
  const portOf = () => (window as unknown as Record<string, { save: () => Record<string, unknown>; load: (memory: Record<string, unknown>) => string[] | void }>).__mvhubCanvasMemory;
  // announceCanvasWindow 의 통로는 닫을 길이 없어, 진짜 것을 쓰면 뒤 시험의 'ping' 에 "open" 으로 답한다
  beforeEach(() => vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} }));
  afterEach(() => vi.unstubAllGlobals());

  it("닫기 전 확정 → 값 모으기 → 넘기기 순서이고, 받은 칸만 accepted 를 듣는다 · 칸 하나가 던져도 나머지는 넘어간다", async () => {
    vi.resetModules();
    const main = await import("../src/lib/popupWindows");
    const received: unknown[] = [];
    main.registerCanvasMemory("broken", { save: () => null, load: () => { throw new Error("깨진 칸"); } });
    main.registerCanvasMemory("taken", { durable: true, save: () => null, load: (value) => { received.push(value); return true; } });
    main.registerCanvasMemory("refused", { durable: true, save: () => null, load: () => false });
    Object.defineProperty(window, "opener", { value: window, configurable: true });

    window.name = "contenthub-canvas";
    vi.resetModules();
    const canvas = await import("../src/lib/popupWindows");
    const log: string[] = [];
    let value = "입력 전";
    canvas.onCanvasMemoryReturn(() => { log.push("확정"); value = "입력 뒤"; });
    canvas.registerCanvasMemory("broken", { save: () => { throw new Error("저장 실패"); }, load: () => {} });
    canvas.registerCanvasMemory("taken", { durable: true, save: () => value, load: () => {}, accepted: () => log.push("taken 받음") });
    canvas.registerCanvasMemory("refused", { durable: true, save: () => "x", load: () => {}, accepted: () => log.push("refused 받음") });
    canvas.announceCanvasWindow();
    main.shareCanvasMemory(); // 듣기 순서 — 같은 창의 pagehide 라 캔버스 창 쪽이 먼저 돌게 뒤에 단다
    try {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
      expect(received).toEqual(["입력 뒤"]);
      expect(log).toEqual(["확정", "taken 받음"]);
    } finally {
      Reflect.deleteProperty(window, "opener");
    }
  });

  it("보내는 문서가 돌아올 수 있으면(persisted) durable 칸을 넘기지 않는다", async () => {
    vi.resetModules();
    const main = await import("../src/lib/popupWindows");
    const received: unknown[] = [];
    main.registerCanvasMemory("taken", { durable: true, save: () => null, load: (value) => { received.push(value); return true; } });
    main.registerCanvasMemory("plain", { save: () => null, load: (value) => { received.push(value); } });
    Object.defineProperty(window, "opener", { value: window, configurable: true });

    window.name = "contenthub-canvas";
    vi.resetModules();
    const canvas = await import("../src/lib/popupWindows");
    const accepted = vi.fn();
    canvas.registerCanvasMemory("taken", { durable: true, save: () => "씬", load: () => {}, accepted });
    canvas.registerCanvasMemory("plain", { save: () => "화면", load: () => {} });
    canvas.announceCanvasWindow();
    main.shareCanvasMemory();
    try {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      expect(received).toEqual(["화면"]);
      expect(accepted).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, "opener");
    }
  });

  it("받는 창이 닫히는 중이면 durable 칸을 받지 않고, 돌아오면(pageshow) 다시 받는다", async () => {
    vi.resetModules();
    const main = await import("../src/lib/popupWindows");
    const load = vi.fn(() => true);
    main.registerCanvasMemory("taken", { durable: true, save: () => null, load });
    main.shareCanvasMemory();
    window.dispatchEvent(new Event("pagehide"));
    expect(portOf().load({ taken: "씬" })).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pageshow"));
    expect(portOf().load({ taken: "씬" })).toEqual(["taken"]);
  });
});

describe("닫기 전 확정 — 돌려준 되돌리기 기록과 넘긴 씬이 서로 맞다", () => {
  let root: Root;
  let host: HTMLDivElement;
  const card = { id: "card", kind: "generation", x: 0, y: 0, prompt: "before" };

  beforeEach(() => {
    vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    window.name = "contenthub-canvas";
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Reflect.deleteProperty(window, "opener");
    vi.unstubAllGlobals();
  });

  async function openBoard() {
    vi.resetModules();
    const popup = await import("../src/lib/popupWindows");
    await import("../src/lib/sceneUndoStore");
    const { useCanvasSession } = await import("../src/features/canvas/useCanvasSession");
    const sent: Record<string, unknown>[] = [];
    Object.defineProperty(window, "opener", { value: { __mvhubCanvasMemory: { save: () => ({}), load: (memory: Record<string, unknown>) => { sent.push(memory); return []; } } }, configurable: true });
    const box = { session: null as unknown as ReturnType<typeof useCanvasSession>, cards: () => [] as SceneCard[] };
    function Harness() {
      const [cards, setCards] = useState<SceneCard[]>([card as SceneCard]);
      const [edges, setEdges] = useState<SceneEdge[]>([]);
      const [groups, setGroups] = useState<SceneGroup[]>([]);
      const sceneIdRef = useRef("s1");
      const cardsRef = useRef(cards); cardsRef.current = cards;
      const edgesRef = useRef(edges); edgesRef.current = edges;
      const groupsRef = useRef(groups); groupsRef.current = groups;
      const frozenRef = useRef(false);
      const layerMoveRef = useRef<SceneLayerMove | null>(null);
      box.session = useCanvasSession({ sceneId: "s1", initialSnapshot: { cards: [card as SceneCard], edges: [], groups: [] },
        sceneIdRef, cardsRef, edgesRef, groupsRef, setCards, setEdges, setGroups, frozenRef, layerMoveRef, clearSelection: vi.fn(), onChange: vi.fn() });
      box.cards = () => cardsRef.current;
      return null;
    }
    act(() => root.render(<Harness />));
    popup.announceCanvasWindow();
    const historyOf = () => {
      const entries = (sent.at(-1)!.sceneHistories as { entries: [string, { undo: { cards: SceneCard[] }[]; redo: unknown[]; lastCommit: { cards: SceneCard[] } }][] }).entries;
      return entries.find(([id]) => id === "s1")![1];
    };
    return { box, historyOf };
  }

  it("입력 대기 중 닫으면 돌려준 기록의 lastCommit 에 그 글이 있고 되돌리기 단계도 있다", async () => {
    const { box, historyOf } = await openBoard();
    act(() => { box.session.commit({ type: "editCardPrompt", cardId: "card", prompt: "방금 친 글" }); });
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(historyOf().lastCommit.cards[0].prompt).toBe("방금 친 글");
    expect(historyOf().undo.at(-1)!.cards[0].prompt).toBe("before");
  });

  it("끌기 도중 닫아도 끌기가 끝맺어져 위치가 기록되고 옛 다시 실행 갈래가 돌아가지 않는다", async () => {
    const { box, historyOf } = await openBoard();
    act(() => { box.session.commit({ type: "setCardReferences", cardId: "card", references: [] }); });
    act(() => { box.session.commit({ type: "editCardPrompt", cardId: "card", prompt: "한 단계" }); box.session.flush(); });
    act(() => { box.session.undo(); }); // 다시 실행 기록이 남아 있다
    const move = box.session.gestures.beginCardMove(["card"], []);
    act(() => { move.preview({ positions: { card: { x: 40, y: 50 } } }); });
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    expect(historyOf().lastCommit.cards[0]).toMatchObject({ x: 40, y: 50 });
    expect(historyOf().redo).toEqual([]);
  });
});

describe("저장소를 다시 읽은 뒤에 캔버스를 돌려받는다", () => {
  const CHANNEL = "mvhub-canvas-window";
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const popupWindow = () => ({ closed: false, focus: vi.fn(), close: vi.fn(), addEventListener: vi.fn(), location: { href: "http://localhost/?embed=canvas&v=1" } });

  async function floatingMain(read: () => Promise<boolean>) {
    vi.resetModules();
    const popup = await import("../src/lib/popupWindows");
    popup.setCanvasReturnRead(read);
    const win = popupWindow();
    vi.spyOn(window, "open").mockImplementation((() => win) as never);
    const stop = (() => {
      const listener = () => {};
      return subscribeFloating(popup, listener);
    })();
    popup.openEmbedWindow(popup.EMBED_MODES.canvas);
    expect(popup.isCanvasFloating()).toBe(true);
    return { popup, win, stop };
  }
  // useCanvasFloating 을 그리는 것과 같다 — 구독이 있어야 메인 창이 신호를 듣는다
  function subscribeFloating(popup: typeof import("../src/lib/popupWindows"), _listener: () => void) {
    const host = document.createElement("div");
    const root: Root = createRoot(host);
    function Probe() {
      popup.useCanvasFloating();
      popup.useEmbedWindowOpen(popup.EMBED_MODES.assets); // 머리줄처럼 .closed 를 0.5초마다 본다
      return null;
    }
    act(() => root.render(<Probe />));
    return () => act(() => root.unmount());
  }

  it("닫힘 신호 뒤 읽기가 끝나야 풀리고, 신호와 .closed 가 둘 다 와도 읽기는 한 번이다", async () => {
    let finish: (ok: boolean) => void = () => {};
    const read = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { popup, win, stop } = await floatingMain(read);
    const other = new BroadcastChannel(CHANNEL);
    try {
      win.closed = true;
      other.postMessage("closed");
      await act(async () => { await sleep(900); });
      expect(read).toHaveBeenCalledTimes(1);
      expect(popup.isCanvasFloating()).toBe(true);
      await act(async () => { finish(true); await sleep(0); });
      expect(popup.isCanvasFloating()).toBe(false);
    } finally {
      other.close();
      stop();
    }
  });

  it("닫는 창의 마지막 알림이 오지 않아도 풀리는 순간 메인 창 씬이 저장본과 같고 '다른 탭 변경' 알림이 없다 · 그 뒤 메인 저장이 글을 지우지 않는다", async () => {
    const { store, data } = await openWindowStore([scene("s1", "옛 글")]);
    const popup = await import("../src/lib/popupWindows");
    const { useSceneCoordination } = await import("../src/lib/useSceneCoordination");
    popup.setCanvasReturnRead(store.refreshSceneStore);
    const win = popupWindow();
    vi.spyOn(window, "open").mockImplementation((() => win) as never);
    const flash = vi.fn();
    let coordination: ReturnType<typeof useSceneCoordination> | null = null;
    function Screen() {
      coordination = useSceneCoordination(flash, popup.useCanvasFloating());
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Screen />));
    await act(async () => { await sleep(0); coordination!.selectScene("s1"); });
    popup.openEmbedWindow(popup.EMBED_MODES.canvas);
    await act(async () => { await sleep(0); });
    store.writeSceneStoreAsOtherWindowForTest((all) => { all[BUCKET] = [scene("s1", "닫기 직전 글")]; }); // 저장소에는 닿았고 'saved' 는 못 온다
    const other = new BroadcastChannel(CHANNEL);
    try {
      win.closed = true;
      other.postMessage("closed");
      await act(async () => {
        for (let waited = 0; popup.isCanvasFloating() && waited < 2_000; waited += 10) await sleep(10);
      });
      expect(popup.isCanvasFloating()).toBe(false);
      expect(textOf(coordination!.activeScene!)).toBe("닫기 직전 글");
      expect(flash.mock.calls.map(([message]) => String(message)).filter((message) => message.includes("다른 탭에서"))).toEqual([]);
      data.updateScene(null, "s1", { name: "메인에서 이어서" });
      await store.settleSceneStoreForTest();
      expect(textOf(data.listPersistedScenes(null)[0])).toBe("닫기 직전 글");
    } finally {
      other.close();
      act(() => root.unmount());
    }
  });

  it("읽기에 실패하면 풀지 않고 다시 읽어 성공한 뒤 푼다", async () => {
    const read = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("막힘")).mockResolvedValue(true);
    const { popup, win, stop } = await floatingMain(read);
    const other = new BroadcastChannel(CHANNEL);
    try {
      win.closed = true;
      other.postMessage("closed");
      await act(async () => { await sleep(600); });
      expect(read).toHaveBeenCalledTimes(1);
      expect(popup.isCanvasFloating()).toBe(true);
      await act(async () => { await sleep(1_100); });
      expect(read).toHaveBeenCalledTimes(2);
      expect(popup.isCanvasFloating()).toBe(true);
      await act(async () => { await sleep(2_100); });
      expect(read).toHaveBeenCalledTimes(3);
      expect(popup.isCanvasFloating()).toBe(false);
    } finally {
      other.close();
      stop();
    }
  }, 10_000);

  it("읽는 동안 'open' 이 오면 읽기가 끝나도 풀지 않는다 — 새로 고침이었다", async () => {
    let finish: (ok: boolean) => void = () => {};
    const read = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { popup, win, stop } = await floatingMain(read);
    const other = new BroadcastChannel(CHANNEL);
    try {
      win.closed = true;
      other.postMessage("closed");
      await act(async () => { await sleep(400); });
      expect(read).toHaveBeenCalledTimes(1);
      other.postMessage("open");
      await act(async () => { await sleep(20); finish(true); await sleep(0); });
      expect(popup.isCanvasFloating()).toBe(true);
    } finally {
      other.close();
      stop();
    }
  });

  it("읽는 동안 이 창이 다시 띄우면 이전 읽기는 풀지 못하고, 닫힌 창이면 새로 여는 길로 간다", async () => {
    let finish: (ok: boolean) => void = () => {};
    const read = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { popup, win, stop } = await floatingMain(read);
    const other = new BroadcastChannel(CHANNEL);
    try {
      win.closed = true;
      other.postMessage("closed");
      await act(async () => { await sleep(400); });
      expect(popup.canvasWindowLive()).toBe(false); // 값을 다시 넘기는 길(App 의 onOpenCanvas)
      const next = popupWindow();
      const open = vi.spyOn(window, "open").mockImplementation((() => next) as never);
      popup.openEmbedWindow(popup.EMBED_MODES.canvas);
      expect(String(open.mock.calls[0][0])).toContain("embed=canvas"); // 재획득(빈 주소)이 아니다
      await act(async () => { finish(true); await sleep(0); });
      expect(popup.isCanvasFloating()).toBe(true);
      expect(popup.canvasWindowLive()).toBe(true);
    } finally {
      other.close();
      stop();
    }
  });
});

describe("프롬프트 값 돌려주기(useCanvasPromptReturn)", () => {
  let root: Root;
  let host: HTMLDivElement;
  const model = { type: "video", model: "seedance_2_5", params: { duration: 5 } };
  const draft = { key: "s1:none", draft: "[{\"t\":\"text\",\"v\":\"창의 글\"}]" };
  const value = { promptVisible: false, batchCount: 3, prompt: model, promptDraft: draft };
  const portOf = () => (window as unknown as Record<string, { load: (memory: Record<string, unknown>) => unknown }>).__mvhubCanvasMemory;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function mainView(view: { floating: boolean; atCanvas: boolean }) {
    vi.resetModules();
    const hook = await import("../src/lib/useCanvasPromptReturn");
    const popup = await import("../src/lib/popupWindows");
    popup.shareCanvasMemory();
    const setBatchCount = vi.fn();
    const setPromptVisible = vi.fn();
    const adoptCanvasPrompt = vi.fn();
    const prompt = { current: { shownModel: () => null, canvasDraft: () => "", adoptCanvasPrompt } as CanvasPromptPort };
    function Screen(state: { floating: boolean; atCanvas: boolean }) {
      hook.useCanvasPromptReturn({ ...state, sceneId: "s1", promptVisible: true, batchCount: 1, setBatchCount, setPromptVisible, prompt });
      return null;
    }
    const draw = (state: { floating: boolean; atCanvas: boolean }) => act(async () => root.render(<Screen {...state} />));
    await draw(view);
    return { draw, setBatchCount, setPromptVisible, adoptCanvasPrompt };
  }

  it("캔버스 자리를 보던 메인 창은 떠 있음이 풀릴 때 값을 넣는다 — 닫는 순간에는 아직 넣지 않는다", async () => {
    const { draw, setBatchCount, setPromptVisible, adoptCanvasPrompt } = await mainView({ floating: true, atCanvas: true });
    act(() => { portOf().load({ promptView: value }); });
    expect(setBatchCount).not.toHaveBeenCalled();
    await draw({ floating: false, atCanvas: true });
    expect(setBatchCount).toHaveBeenCalledWith(3);
    expect(setPromptVisible).toHaveBeenCalledWith(false);
    expect(adoptCanvasPrompt).toHaveBeenCalledWith({ ...draft, model });
  });

  it("닫는 순간 다른 탭을 보던 메인 창은 받지 않고, 옛 보관값도 비운다", async () => {
    const { draw, setBatchCount, adoptCanvasPrompt } = await mainView({ floating: true, atCanvas: true });
    act(() => { portOf().load({ promptView: value }); }); // 새로 고침으로 보관됐다
    await draw({ floating: true, atCanvas: false });
    act(() => { portOf().load({ promptView: { ...value, batchCount: 9 } }); }); // 다른 탭에서 닫았다
    await draw({ floating: true, atCanvas: true }); // 틈 안에 캔버스 탭으로 돌아왔다
    await draw({ floating: false, atCanvas: true });
    expect(setBatchCount).not.toHaveBeenCalled();
    expect(adoptCanvasPrompt).not.toHaveBeenCalled();
  });

  it("값을 보관한 뒤 탭을 옮기면 풀릴 때 버린다 — 떠 있는 동안에도 닫힌 뒤에도 값이 바뀌지 않는다", async () => {
    const { draw, setBatchCount, setPromptVisible, adoptCanvasPrompt } = await mainView({ floating: true, atCanvas: true });
    act(() => { portOf().load({ promptView: value }); });
    await draw({ floating: true, atCanvas: false }); // 탭만 옮겼다 — canvasAway 는 풀렸지만 돌아온 것이 아니다
    expect(setBatchCount).not.toHaveBeenCalled();
    await draw({ floating: false, atCanvas: false });
    expect(setBatchCount).not.toHaveBeenCalled();
    expect(setPromptVisible).not.toHaveBeenCalled();
    expect(adoptCanvasPrompt).not.toHaveBeenCalled();
  });

  it("캔버스 창은 pagehide 때 값을 돌려주며 인계 칸에 다시 남긴다 — 새로 고침이면 자기가 받는다", async () => {
    window.name = "contenthub-canvas";
    vi.resetModules();
    const hook = await import("../src/lib/useCanvasPromptReturn");
    const popup = await import("../src/lib/popupWindows");
    const prompt = { current: { shownModel: () => model, canvasDraft: () => draft.draft, adoptCanvasPrompt: vi.fn() } as CanvasPromptPort };
    function Screen() {
      hook.useCanvasPromptReturn({ floating: false, atCanvas: true, sceneId: "s1", promptVisible: false, batchCount: 3,
        setBatchCount: vi.fn(), setPromptVisible: vi.fn(), prompt });
      return null;
    }
    await act(async () => root.render(<Screen />));
    popup.announceCanvasWindow();
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    vi.resetModules();
    const next = await import("../src/lib/popupWindows");
    expect(next.takeCanvasHandoff()).toMatchObject({ promptVisible: false, batchCount: 3, prompt: { model: "seedance_2_5" }, promptDraft: draft, selection: null });
  });
});
