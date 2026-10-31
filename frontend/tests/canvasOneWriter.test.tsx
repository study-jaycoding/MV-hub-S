// @vitest-environment jsdom
// 캔버스가 분리 창에 떠 있는 동안 씬은 그 창만 쓴다(2026-10-31, docs/status/캔버스_분리창_한곳쓰기_2026-10-31.md) — 쓰기 입구 · 열기 전 확정 · 새로 고침 ·
// 원래 창의 사람 동작 · 창 생존(Web Lock). 창마다 모듈이 따로라 vi.resetModules 로 새 창을 흉내 낸다.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const LOCK = "mvhub-canvas-window";
const CHANNEL = "mvhub-canvas-window";
const scene = (id: string, text = "") => ({ id, name: id, created_at: 1, edges: [], cards: text ? [{ id: "c", kind: "text", x: 0, y: 0, text }] : [] }) as never;
const textCard = (text: string) => [{ id: "c", kind: "text", x: 0, y: 0, text }] as never;
const textOf = (found: { cards: unknown[] } | undefined) => (found?.cards[0] as { text?: string } | undefined)?.text;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function openStore(scenes: object[]) {
  vi.resetModules();
  const store = await import("../src/lib/sceneStore");
  const data = await import("../src/lib/scenes");
  let mark: Parameters<typeof store.initSceneStore>[1] = null;
  await store.initSceneStore(() => ({ [BUCKET]: scenes as never }), mark, (next) => { mark = next; return true; });
  await store.settleSceneStoreForTest();
  return { store, data };
}

// navigator.locks 의 필요한 만큼만 — 한 이름을 한 문서가 쥐고, 나머지는 차례를 기다린다.
function fakeLocks() {
  const held: { name: string; finish: () => void }[] = [];
  const queue: { name: string; run: () => unknown; done: (value: unknown) => void }[] = [];
  const pump = () => {
    while (queue.length && !held.some((lock) => lock.name === queue[0].name)) {
      const next = queue.shift()!;
      const lock = { name: next.name, finish: () => {} };
      held.push(lock);
      const release = () => {
        held.splice(held.indexOf(lock), 1);
        next.done(undefined);
        pump();
      };
      lock.finish = release;
      void Promise.resolve().then(next.run).then(release);
    }
  };
  const locks = {
    held, queue,
    query: async () => ({ held: held.map(({ name }) => ({ name })), pending: queue.map(({ name }) => ({ name })) }),
    request: (name: string, run: () => unknown) => new Promise((done) => { queue.push({ name, run, done }); pump(); }),
  };
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
  return locks;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  window.name = "";
  Reflect.deleteProperty(navigator, "locks");
  Reflect.deleteProperty(window, "opener");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("쓰기 입구 — 떠 있는 동안 원래 창은 씬을 쓰지 않는다", () => {
  it("일반 쓰기가 모두 거절되고 작업본·저장소가 그대로이며 저장 실패로 알리지 않는다 · 풀리면 다시 써진다", async () => {
    const { store, data } = await openStore([scene("a", "그대로")]);
    let floating = true;
    store.setSceneWriteGate(() => floating);
    const alarm = vi.fn();
    data.subscribeSceneSaveState(alarm);

    expect(data.updateScene(null, "a", { cards: textCard("덮으면 안 됨") })).toEqual({ ok: false, reason: "paused" });
    expect(data.updateScenesWith(null, (all) => all.map((item) => ({ ...item, name: "바뀜" })))).toBe(false);
    expect(data.createScene(null, "새 씬")).toBeNull();
    expect(data.deleteScene(null, "a")).toBe(false);
    await store.settleSceneStoreForTest();
    expect(store.sceneStoreHasPending()).toBe(false);
    expect(textOf(data.listScenes(null)[0])).toBe("그대로");
    expect(data.listPersistedScenes(null).map((item) => item.name)).toEqual(["a"]);
    expect(alarm).not.toHaveBeenCalled();

    floating = false;
    expect(data.updateScene(null, "a", { cards: textCard("풀린 뒤") }).ok).toBe(true);
    await store.settleSceneStoreForTest();
    expect(textOf(data.listPersistedScenes(null)[0])).toBe("풀린 뒤");
  });

  it("이미 출발한 응답이 떠 있음 뒤에 도착해도 캔버스 문서 쓰기가 들어가지 않는다", async () => {
    const { store, data } = await openStore([scene("a", "그대로")]);
    const { createCanvasDocumentPort, canvasTarget } = await import("../src/features/canvas/session");
    let floating = false;
    store.setSceneWriteGate(() => floating);
    const port = createCanvasDocumentPort({ flushPending: () => {}, write: (sceneId, patch) => data.updateScene(null, sceneId, patch).ok });
    floating = true; // 조회가 끝나기 전에 창이 떴다
    const receipt = port.commit(canvasTarget("a"), { type: "appendTaskCards", cards: [{ id: "new", kind: "text", x: 0, y: 0 }] as never, receiptId: "r" });
    expect(receipt.queued).toBe(false);
    expect(await receipt.confirmed).toBe(false);
    await store.settleSceneStoreForTest();
    expect(data.listPersistedScenes(null)[0].cards).toHaveLength(1);
  });

  it("백업 복구가 거절되면 복구했다고 알리지 않는다", async () => {
    vi.resetModules();
    const store = await import("../src/lib/sceneStore");
    const data = await import("../src/lib/scenes");
    await store.initSceneStore(() => null, null, () => true);
    store.setSceneWriteGate(() => true);
    const backup = await vi.importActual<typeof import("../src/lib/sceneBackup")>("../src/lib/sceneBackup");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [{ id: "a", data: JSON.stringify(scene("a", "백업")) }] }), { headers: { "Content-Type": "application/json" } })));
    const notified = vi.fn();
    const off = backup.subscribeSceneRestore(notified);
    try {
      await backup.initSceneBackup();
      await sleep(0);
      expect(fetch).toHaveBeenCalled();
      expect(notified).not.toHaveBeenCalled();
      expect(data.listScenes(null)).toEqual([]);
    } finally {
      off();
      vi.unstubAllGlobals();
    }
  });

  it("옛 저장소 변경을 떠 있는 동안에는 흡수하지 않는다 — 풀리면 다시 흡수한다", async () => {
    const locks = fakeLocks();
    let end: () => void = () => {};
    void locks.request(LOCK, () => new Promise<void>((resolve) => { end = resolve; }));
    await sleep(0);
    vi.resetModules();
    const { STORAGE_KEYS } = await import("../src/lib/storageKeys");
    localStorage.setItem(STORAGE_KEYS.scenes, JSON.stringify({ [BUCKET]: [scene("a", "가")] }));
    const boot = await import("../src/lib/sceneBoot");
    const popup = await import("../src/lib/popupWindows");
    const data = await import("../src/lib/scenes");
    const store = await import("../src/lib/sceneStore");
    popup.setCanvasReturnRead(async () => true);
    await popup.findFloatingCanvas();
    await boot.bootSceneStore();
    const oldWindowWrites = async () => {
      localStorage.setItem(STORAGE_KEYS.scenes, JSON.stringify({ [BUCKET]: [scene("a", "가"), scene("z", "옛 창")] }));
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEYS.scenes }));
      await sleep(30);
      await store.settleSceneStoreForTest();
    };
    await oldWindowWrites();
    expect(data.listPersistedScenes(null).map((item) => item.id)).toEqual(["a"]);
    end();
    await sleep(400);
    expect(popup.isCanvasFloating()).toBe(false);
    await oldWindowWrites();
    expect(data.listPersistedScenes(null).map((item) => item.id)).toEqual(["a", "z"]);
  });

  it("닫는 창의 인계는 떠 있는 동안에도 받아 저장한다", async () => {
    const canvas = await openStore([scene("a", "옛 글")]);
    canvas.data.updateScene(null, "a", { cards: textCard("새 글") });
    const writes = canvas.store.unconfirmedSceneWrites();
    const main = await openStore([scene("a", "옛 글")]);
    main.store.setSceneWriteGate(() => true);
    expect(main.data.adoptCanvasSceneWrites(structuredClone(writes))).toBe(true);
    await main.store.settleSceneStoreForTest();
    expect(textOf(main.data.listPersistedScenes(null)[0])).toBe("새 글");
  });
});

describe("열기 — 쓰기가 모두 확정된 뒤에만", () => {
  it("밀린 입력을 내보내 확정한 뒤 true 를 주고, 그 순간 밀린 것이 없다", async () => {
    const { store, data } = await openStore([scene("a", "옛 글")]);
    const flush = vi.fn(() => {
      if (flush.mock.calls.length === 1) data.updateScene(null, "a", { cards: textCard("막 친 글") });
    });
    await expect(store.settleSceneWrites(3000, flush)).resolves.toBe(true);
    expect(store.sceneStoreHasPending()).toBe(false);
    expect(textOf(data.listPersistedScenes(null)[0])).toBe("막 친 글");
  });

  it("기다리는 사이 더 들어온 입력도 확정한다", async () => {
    const { store, data } = await openStore([scene("a", "옛 글")]);
    store.delaySceneStoreWritesForTest(10);
    let round = 0;
    const flush = () => {
      round += 1;
      if (round <= 2) data.updateScene(null, "a", { cards: textCard(`입력 ${round}`) });
    };
    await expect(store.settleSceneWrites(3000, flush)).resolves.toBe(true);
    expect(round).toBeGreaterThanOrEqual(3);
    expect(textOf(data.listPersistedScenes(null)[0])).toBe("입력 2");
    store.delaySceneStoreWritesForTest(0);
  });

  it("끝남을 본 그 자리에서 onSettled 를 부른다 — 이미 예약된 마이크로태스크의 쓰기가 끼어들지 못하고, 실패하면 부르지 않는다", async () => {
    const { store, data } = await openStore([scene("a", "옛 글")]);
    const seen: boolean[] = [];
    const flush = () => queueMicrotask(() => data.updateScene(null, "a", { cards: textCard("끼어든 쓰기") })); // onSettled 를 await 뒤로 미루면 이 쓰기가 먼저 들어온다
    await expect(store.settleSceneWrites(3000, flush, () => seen.push(store.sceneStoreHasPending()))).resolves.toBe(true);
    expect(seen).toEqual([false]);
    await store.settleSceneStoreForTest();

    store.failSceneStoreWritesForTest(true);
    data.updateScene(null, "a", { cards: textCard("저장 안 됨") });
    const onSettled = vi.fn();
    await expect(store.settleSceneWrites(3000, () => {}, onSettled)).resolves.toBe(false);
    expect(onSettled).not.toHaveBeenCalled();
    store.failSceneStoreWritesForTest(false);
    await store.settleSceneStoreForTest();
  });

  it("밀린 것이 없으면 기다리지 않고, 저장이 실패·지연되면 시간 안에 false 를 주며 작업이 남는다", async () => {
    const { store, data } = await openStore([scene("a", "옛 글")]);
    await expect(store.settleSceneWrites(3000)).resolves.toBe(true);

    store.failSceneStoreWritesForTest(true);
    data.updateScene(null, "a", { cards: textCard("저장 안 됨") });
    await expect(store.settleSceneWrites(3000)).resolves.toBe(false);
    expect(textOf(data.listScenes(null)[0])).toBe("저장 안 됨");
    expect(store.sceneStoreHasPending()).toBe(true);
    store.failSceneStoreWritesForTest(false);
    await store.settleSceneStoreForTest();

    store.delaySceneStoreWritesForTest(200);
    data.updateScene(null, "a", { cards: textCard("느린 저장") });
    const started = Date.now();
    await expect(store.settleSceneWrites(20)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(150);
    store.delaySceneStoreWritesForTest(0);
    await store.settleSceneStoreForTest();
  });
});

describe("새로 고침 — 넘겨받은 쓰기가 끝난 뒤에 읽는다", () => {
  async function popupWindows() {
    vi.resetModules();
    return import("../src/lib/popupWindows");
  }
  const opener = (settled: () => Promise<boolean>) =>
    Object.defineProperty(window, "opener", { configurable: true, value: { __mvhubCanvasMemory: { settled, save: () => ({}), load: () => {} } } });

  it("메인 창 손잡이가 넘겨받은 settled 를 내준다", async () => {
    const popup = await popupWindows();
    const settled = vi.fn(async () => false);
    popup.shareCanvasMemory(settled);
    await expect((window as unknown as { __mvhubCanvasMemory: { settled: () => Promise<boolean> } }).__mvhubCanvasMemory.settled()).resolves.toBe(false);
  });

  it("opener 가 끝낼 때까지 기다리고 그 답을 돌려준다 · 없으면 바로 간다 · 답이 없으면 시간 뒤 간다", async () => {
    const popup = await popupWindows();
    await expect(popup.openerSceneWritesSettled()).resolves.toBe(true);

    let finish: (ok: boolean) => void = () => {};
    opener(() => new Promise((resolve) => { finish = resolve; }));
    const waiting = popup.openerSceneWritesSettled();
    let answered: boolean | undefined;
    void waiting.then((ok) => { answered = ok; });
    await sleep(5);
    expect(answered).toBeUndefined();
    finish(false);
    await expect(waiting).resolves.toBe(false);

    vi.useFakeTimers();
    opener(() => new Promise(() => {}));
    const silent = popup.openerSceneWritesSettled();
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(silent).resolves.toBe(true);
  });

  it("opener 가 던지면 그대로 간다", async () => {
    const popup = await popupWindows();
    opener(() => { throw new Error("연 창이 닫혔다"); });
    await expect(popup.openerSceneWritesSettled()).resolves.toBe(true);
  });
});

describe("창 생존 — Web Lock", () => {
  async function mainWindow(read: () => Promise<boolean> = async () => true) {
    vi.resetModules();
    const popup = await import("../src/lib/popupWindows");
    popup.setCanvasReturnRead(read);
    const host = document.createElement("div");
    const root = createRoot(host);
    function Probe() {
      popup.useCanvasFloating();
      return null;
    }
    await act(async () => root.render(<Probe />));
    return { popup, stop: () => act(() => root.unmount()) };
  }
  const holdLikeCanvasWindow = (locks: ReturnType<typeof fakeLocks>) => {
    let end: () => void = () => {};
    void locks.request(LOCK, () => new Promise<void>((resolve) => { end = resolve; }));
    return { end: () => end() };
  };

  it("캔버스 창은 켜지면서 잠금을 쥔다", async () => {
    const locks = fakeLocks();
    vi.resetModules();
    window.name = "contenthub-canvas";
    const popup = await import("../src/lib/popupWindows");
    popup.announceCanvasWindow();
    await sleep(0);
    expect(locks.held.map(({ name }) => name)).toEqual([LOCK]);
  });

  it("'open' 을 받으면 잠금을 기다리고(한 번만), 창이 끝나면 신호 없이도 캔버스가 돌아온다", async () => {
    const locks = fakeLocks();
    const canvas = holdLikeCanvasWindow(locks);
    const read = vi.fn(async () => true);
    const { popup, stop } = await mainWindow(read);
    const other = new BroadcastChannel(CHANNEL);
    try {
      other.postMessage("open");
      other.postMessage("open");
      await act(async () => { await sleep(20); });
      expect(popup.isCanvasFloating()).toBe(true);
      expect(locks.queue).toHaveLength(1);
      canvas.end();
      await act(async () => { await sleep(400); });
      expect(read).toHaveBeenCalledOnce();
      expect(popup.isCanvasFloating()).toBe(false);
      expect(locks.held).toEqual([]);
    } finally {
      other.close();
      stop();
    }
  });

  it("이 창이 연 창이 살아 있으면(새로 고침) 잠금이 풀려도 떠 있음을 유지하고, 새 문서의 'open' 이 다시 기다린다", async () => {
    const locks = fakeLocks();
    const canvas = holdLikeCanvasWindow(locks);
    const read = vi.fn(async () => true);
    const { popup, stop } = await mainWindow(read);
    const win = { closed: false, focus: () => {}, addEventListener: () => {} } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(win);
    popup.openEmbedWindow(popup.EMBED_MODES.canvas);
    const other = new BroadcastChannel(CHANNEL);
    try {
      other.postMessage("open");
      await act(async () => { await sleep(20); });
      canvas.end();
      await act(async () => { await sleep(400); });
      expect(read).not.toHaveBeenCalled();
      expect(popup.isCanvasFloating()).toBe(true);
      expect(locks.queue).toHaveLength(0);
      holdLikeCanvasWindow(locks);
      other.postMessage("open");
      await act(async () => { await sleep(20); });
      expect(locks.queue).toHaveLength(1);
    } finally {
      other.close();
      stop();
    }
  });

  it("창 참조가 없는 메인 — 새 문서의 'open' 이 옛 문서의 잠금 해제보다 먼저 와도 캔버스를 돌려받지 않고 다시 기다린다", async () => {
    const locks = fakeLocks();
    const before = holdLikeCanvasWindow(locks);
    const read = vi.fn(async () => true);
    const { popup, stop } = await mainWindow(read);
    const other = new BroadcastChannel(CHANNEL);
    try {
      other.postMessage("open");
      await act(async () => { await sleep(20); });
      expect(locks.queue).toHaveLength(1);
      other.postMessage("closed");
      holdLikeCanvasWindow(locks); // 새 문서가 잠금을 청한다
      other.postMessage("open"); // 그리고 옛 문서의 해제가 닿기 전에 알린다
      await act(async () => { await sleep(20); });
      before.end();
      await act(async () => { await sleep(420); });
      expect(read).not.toHaveBeenCalled();
      expect(popup.isCanvasFloating()).toBe(true);
      expect(locks.held.map(({ name }) => name)).toEqual([LOCK]);
      expect(locks.queue).toHaveLength(1); // 새 문서의 끝을 다시 기다린다
    } finally {
      other.close();
      stop();
    }
  });

  it("잠금을 묻는 사이 'open' 이 오면 그 답으로 돌려받지 않는다", async () => {
    const locks = fakeLocks();
    const before = holdLikeCanvasWindow(locks);
    const read = vi.fn(async () => true);
    const { popup, stop } = await mainWindow(read);
    const other = new BroadcastChannel(CHANNEL);
    try {
      other.postMessage("open");
      await act(async () => { await sleep(20); });
      before.end();
      await act(async () => { await sleep(20); });
      let answer: (value: { held: unknown[]; pending: unknown[] }) => void = () => {};
      locks.query = () => new Promise((resolve) => { answer = resolve; });
      await act(async () => { await sleep(320); }); // 0.3초 틈이 지나 묻는 중이다
      holdLikeCanvasWindow(locks); // 새 문서 — 잠금을 쥐고 알린다(안 쥐면 기다림이 곧 풀려 타이머가 다음 시험으로 샌다)
      other.postMessage("open");
      await act(async () => { await sleep(20); });
      answer({ held: [], pending: [] }); // 아직 아무도 안 쥐었다는 낡은 답
      await act(async () => { await sleep(50); });
      expect(read).not.toHaveBeenCalled();
      expect(popup.isCanvasFloating()).toBe(true);
    } finally {
      other.close();
      stop();
    }
  });

  it("메인이 새로 켜질 때 쥔 잠금을 보면 첫 그리기 전에 떠 있음·쓰기 멈춤·기다림이 걸리고, 창이 끝나면 풀린다", async () => {
    const locks = fakeLocks();
    const canvas = holdLikeCanvasWindow(locks);
    await sleep(0);
    const { store, data } = await openStore([scene("a", "그대로")]);
    await import("../src/lib/sceneBoot"); // 쓰기 멈춤의 판단을 다는 곳 — 앱과 같은 길
    const popup = await import("../src/lib/popupWindows");
    popup.setCanvasReturnRead(async () => true);
    await popup.findFloatingCanvas();
    expect(popup.isCanvasFloating()).toBe(true);
    expect(data.updateScene(null, "a", { cards: textCard("덮으면 안 됨") })).toEqual({ ok: false, reason: "paused" });
    expect(locks.queue).toHaveLength(1);
    canvas.end();
    await sleep(400);
    expect(popup.isCanvasFloating()).toBe(false);
    expect(data.updateScene(null, "a", { cards: textCard("돌아온 뒤") }).ok).toBe(true);
    await store.settleSceneStoreForTest();
  });

  it("쥔 잠금이 없으면 떠 있음이 아니고, 잠금 API 가 없어도 던지지 않고 신호로 동작한다", async () => {
    fakeLocks();
    const first = await mainWindow();
    await first.popup.findFloatingCanvas();
    expect(first.popup.isCanvasFloating()).toBe(false);
    first.stop();

    Reflect.deleteProperty(navigator, "locks");
    const { popup, stop } = await mainWindow();
    const other = new BroadcastChannel(CHANNEL);
    try {
      await popup.findFloatingCanvas();
      other.postMessage("open");
      await act(async () => { await sleep(20); });
      expect(popup.isCanvasFloating()).toBe(true);
      other.postMessage("closed");
      await act(async () => { await sleep(400); });
      expect(popup.isCanvasFloating()).toBe(false);
    } finally {
      other.close();
      stop();
    }
  });
});

describe("원래 창의 사람 동작", () => {
  async function coordinationIn(follow: boolean) {
    const { store, data } = await openStore([scene("a", "가"), scene("b", "나")]);
    const { useSceneCoordination } = await import("../src/lib/useSceneCoordination");
    let coordination: ReturnType<typeof useSceneCoordination> | null = null;
    const host = document.createElement("div");
    const root = createRoot(host);
    function Screen({ following }: { following: boolean }) {
      coordination = useSceneCoordination(vi.fn(), following);
      return null;
    }
    await act(async () => root.render(<Screen following={false} />));
    await act(async () => { await sleep(0); coordination!.selectScene("a"); });
    if (follow) await act(async () => root.render(<Screen following />));
    return { store, data, coordination: () => coordination!, follow: (following: boolean) => act(async () => root.render(<Screen following={following} />)), stop: () => act(() => root.unmount()) };
  }

  it("떠 있는 동안 selectScene 은 활성 씬도 '마지막 연 씬'도 바꾸지 않는다 · 풀리면 다시 바뀐다", async () => {
    const { data, coordination, follow, stop } = await coordinationIn(true);
    await act(async () => { coordination().selectScene(null); });
    expect(data.getActiveSceneId(null)).toBe("a");
    expect(coordination().activeSceneId).toBe("a");
    await act(async () => { coordination().selectScene("b"); });
    expect(data.getActiveSceneId(null)).toBe("a");
    await follow(false);
    await act(async () => { coordination().selectScene("b"); });
    expect(data.getActiveSceneId(null)).toBe("b");
    stop();
  });

  it("옛 창 충돌 정리는 떠 있는 동안 돌지 않고, 풀리면 돈다", async () => {
    const { store, data, follow, stop } = await coordinationIn(true);
    await follow(false);
    data.updateScene(null, "a", { name: "이 창에서 고침" });
    await store.settleSceneStoreForTest();
    await follow(true);
    await act(async () => {
      await store.absorbLegacyScenes({ [BUCKET]: [{ ...(scene("a", "가") as object), name: "옛 창에서 고침" } as never, scene("b", "나")] });
      await sleep(10);
    });
    expect(data.hasSceneConflicts()).toBe(true);
    expect(data.listPersistedScenes(null).map((item) => item.name)).toEqual(["이 창에서 고침", "b"]);
    await follow(false);
    await act(async () => { await sleep(20); });
    expect(data.hasSceneConflicts()).toBe(false);
    expect(data.listPersistedScenes(null).map((item) => item.name)).toEqual(["이 창에서 고침", "b", "[옛 창] 옛 창에서 고침"]);
    stop();
  });

  it("떠 있는 동안에는 전체 가져오기 단추가 막히고 까닭이 보인다", async () => {
    const locks = fakeLocks();
    void locks.request(LOCK, () => new Promise(() => {}));
    await sleep(0);
    await openStore([scene("a", "가")]);
    const popup = await import("../src/lib/popupWindows");
    await popup.findFloatingCanvas();
    const { CanvasArchiveSection } = await import("../src/components/settings/CanvasArchiveSection");
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<CanvasArchiveSection />));
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("전체 가져오기"))!;
    expect(button.disabled).toBe(true);
    expect(host.textContent).toContain("별도 창에 떠 있는 동안은 가져올 수 없습니다");
    expect([...host.querySelectorAll("button")].find((item) => item.textContent?.includes("전체 내보내기"))!.disabled).toBe(false);
    act(() => root.unmount());
  });
});
