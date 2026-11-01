// @vitest-environment jsdom
// 캔버스가 분리 창에 떠 있는 동안 씬은 그 창만 쓴다(2026-10-31, docs/status/캔버스_분리창_한곳쓰기_2026-10-31.md) — 쓰기 입구 · 열기 전 확정 · 새로 고침 ·
// 원래 창의 사람 동작 · 창 생존(Web Lock). 창마다 모듈이 따로라 vi.resetModules 로 새 창을 흉내 낸다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  type Options = { signal?: AbortSignal };
  const pump = () => {
    for (const next of [...queue]) { // 이름마다 따로 줄을 선다
      if (held.some((lock) => lock.name === next.name) || !queue.includes(next)) continue;
      queue.splice(queue.indexOf(next), 1);
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
    request: (name: string, second: Options | (() => unknown), third?: () => unknown) => new Promise((done, fail) => {
      const run = (third ?? second) as () => unknown;
      const entry = { name, run, done };
      (third ? (second as Options).signal : undefined)?.addEventListener("abort", () => {
        if (!queue.includes(entry)) return;
        queue.splice(queue.indexOf(entry), 1);
        fail(new DOMException("aborted", "AbortError"));
      });
      queue.push(entry);
      pump();
    }),
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

describe("다른 창에 밀린 쓰기 — 떠 있음을 안 순간 재생을 멈추고 사본으로 살린다", () => {
  const stored = (data: Awaited<ReturnType<typeof openStore>>["data"]) => textOf(data.listPersistedScenes(null)[0]);
  // 저장이 막혀 밀린 편집을 든 창
  async function behind(text = "이 창 편집") {
    const opened = await openStore([scene("a", "저장본")]);
    let floating = false;
    opened.store.setSceneWriteGate(() => floating);
    opened.store.failSceneStoreWritesForTest(true);
    const receipt = opened.store.captureSceneOps(() => opened.data.updateScene(null, "a", { cards: textCard(text) }));
    await opened.store.settleSceneWrites(50);
    expect(opened.store.sceneStoreHasPending()).toBe(true);
    return { ...opened, receipt, float: (on: boolean) => { floating = on; } };
  }

  it("표시한 연산은 씬에 쓰지 않고 충돌로 옮긴다 — 떠 있는 창의 편집이 남고 이 창의 편집은 theirs 로 남으며 기다리던 쪽은 실패를 받는다", async () => {
    const { store, data, receipt, float } = await behind();
    float(true);
    store.setAsidePendingWrites();
    expect(textOf(data.listScenes(null)[0])).toBe("저장본"); // 표시한 그 자리에서 화면 값에서 빠진다
    store.writeSceneStoreAsOtherWindowForTest((all) => { all[BUCKET] = [scene("a", "떠 있는 창 편집")]; });
    store.failSceneStoreWritesForTest(false);
    await store.settleSceneStoreForTest();
    expect(store.sceneStoreHasPending()).toBe(false);
    expect(stored(data)).toBe("떠 있는 창 편집");
    expect(store.lastSceneStoreWriteForTest().scenes).toEqual([]);
    const [conflict] = store.sceneStoreConflicts();
    expect(conflict).toMatchObject({ bucket: BUCKET, sceneId: "a" });
    expect(textOf(conflict.mine as never)).toBe("떠 있는 창 편집");
    expect(textOf(conflict.theirs as never)).toBe("이 창 편집");
    await expect(receipt.confirmed).resolves.toBe(false);
  });

  it("충돌 저장이 막힌 동안에는 기다리던 쪽에 답하지 않고, 저장된 뒤에 실패를 돌려준다", async () => {
    const { store, data } = await openStore([scene("a", "저장본")]);
    store.failSceneStoreWritesForTest(true);
    const receipt = store.captureSceneOps(() => data.updateScene(null, "a", { cards: textCard("이 창 편집") }));
    store.setAsidePendingWrites();
    let answered = false;
    void receipt.confirmed.then(() => { answered = true; });
    await store.settleSceneWrites(50);
    await sleep(0);
    expect(store.sceneStoreHasPending()).toBe(true);
    expect(answered).toBe(false);
    store.failSceneStoreWritesForTest(false);
    await store.settleSceneStoreForTest();
    await expect(receipt.confirmed).resolves.toBe(false);
    expect(textOf(store.sceneStoreConflicts()[0].theirs as never)).toBe("이 창 편집");
  });

  it("settled — 일시 실패에는 끝나지 않고 재시도가 성공하면 true, confirmed 는 이번 시도에 false 다", async () => {
    const { store, data } = await openStore([scene("a", "저장본")]);
    store.failSceneStoreWritesForTest(true);
    const receipt = store.captureSceneOps(() => data.updateScene(null, "a", { cards: textCard("편집") }));
    let settled: boolean | null = null;
    void receipt.settled.then((ok) => { settled = ok; });
    await store.settleSceneWrites(50);
    await expect(receipt.confirmed).resolves.toBe(false);
    await sleep(0);
    expect(settled).toBeNull();
    store.failSceneStoreWritesForTest(false);
    await store.settleSceneStoreForTest();
    await expect(receipt.settled).resolves.toBe(true);
  });

  it("settled — 접수 거절은 바로 false, 연산이 없으면 바로 true, 충돌로 옮긴 연산은 저장 뒤 false", async () => {
    const { store, data, float } = await behind();
    float(true);
    const refused = store.captureSceneOps(() => data.updateScene(null, "a", { name: "거절" }));
    await expect(refused.settled).resolves.toBe(false);
    await expect(store.captureSceneOps(() => true).settled).resolves.toBe(true);
    float(false);
    store.failSceneStoreWritesForTest(true);
    const moved = store.captureSceneOps(() => data.updateScene(null, "a", { name: "옮길 편집" }));
    store.setAsidePendingWrites();
    store.failSceneStoreWritesForTest(false);
    await store.settleSceneStoreForTest();
    await expect(moved.settled).resolves.toBe(false);
  });

  it("settled — 메인 창에 넘긴 연산은 false 로 끝나 줄이 막히지 않는다", async () => {
    const { store, data } = await openStore([scene("a", "저장본")]);
    store.failSceneStoreWritesForTest(true);
    const handed = store.captureSceneOps(() => data.updateScene(null, "a", { cards: textCard("넘긴 편집") }));
    store.markSceneWritesHanded();
    await expect(handed.settled).resolves.toBe(false);
  });

  it("저장이 막혀 다음 시도가 떠 있음이 끝난 뒤에 와도 재생하지 않고, 그 뒤 새 편집은 합쳐지지 않고 정상 저장되며 숨은 옛 편집을 되살리지 않는다", async () => {
    const { store, data, float } = await behind();
    float(true);
    store.setAsidePendingWrites();
    await store.settleSceneWrites(50); // 충돌 저장도 막혔다 — 표시와 연산이 남는다
    expect(store.sceneStoreHasPending()).toBe(true);
    float(false);
    expect(data.updateScene(null, "a", { name: "돌아온 뒤 이름" }).ok).toBe(true);
    store.failSceneStoreWritesForTest(false);
    await store.settleSceneStoreForTest();
    await store.settleSceneStoreForTest();
    const saved = data.listPersistedScenes(null)[0];
    expect(saved.name).toBe("돌아온 뒤 이름");
    expect(textOf(saved)).toBe("저장본");
    expect(textOf(store.sceneStoreConflicts()[0].theirs as never)).toBe("이 창 편집");
    expect(store.sceneStoreConflicts()[0].theirs?.name).toBe("a"); // 새 편집이 옛 연산에 합쳐지지 않았다
  });

  it("큐가 밀려 떠 있음이 끝난 뒤에 출발한 저장도 표시를 보고 재생하지 않는다", async () => {
    const { store, data } = await openStore([scene("a", "저장본")]);
    store.delaySceneStoreWritesForTest(30);
    data.updateScene(null, "a", { cards: textCard("밀린 편집") });
    await sleep(5);
    let floating = true;
    store.setSceneWriteGate(() => floating);
    store.setAsidePendingWrites();
    floating = false;
    store.delaySceneStoreWritesForTest(0);
    await sleep(50);
    await store.settleSceneStoreForTest();
    expect(stored(data)).toBe("저장본");
    expect(textOf(store.sceneStoreConflicts()[0].theirs as never)).toBe("밀린 편집");
  });

  it("재생을 정한 뒤 표시가 붙은 연산은 저장된 것으로 끝나고 화면 값이 저장본과 맞는다", async () => {
    const { store, data } = await openStore([scene("a", "저장본")]);
    let armed = false;
    const receipt = store.captureSceneOps(() => store.applySceneOp((all) => {
      if (armed) {
        armed = false;
        store.setAsidePendingWrites(); // 트랜잭션이 재생하는 그 사이에 창이 떴다
      }
      all[BUCKET] = [scene("a", "재생된 편집")] as never;
      return { write: true, value: null };
    }));
    armed = true;
    await expect(receipt.confirmed).resolves.toBe(true);
    await store.settleSceneStoreForTest();
    expect(stored(data)).toBe("재생된 편집");
    expect(textOf(data.listScenes(null)[0])).toBe("재생된 편집");
    expect(store.sceneStoreConflicts()).toEqual([]);
  });

  it("닫는 창이 넘긴 연산과 confirmedOnly 연산은 표시하지 않는다 · 일반 연산과 합쳐지지 않는다", async () => {
    const { store, data, float } = await behind();
    float(true);
    store.failSceneStoreWritesForTest(false);
    expect(data.adoptCanvasSceneWrites([{ bucket: BUCKET, created: [], changed: [{ ...(scene("a", "넘긴 글") as object) } as never], removed: [], order: null }])).toBe(true);
    const account = store.captureSceneOps(() => store.applySceneOp((all) => { all[BUCKET] = (all[BUCKET] || []).map((item) => ({ ...item, name: "귀속" })); return { write: true, value: null }; }, { confirmedOnly: true, handover: true }));
    store.setAsidePendingWrites();
    await store.settleSceneStoreForTest();
    expect(stored(data)).toBe("넘긴 글");
    expect(data.listPersistedScenes(null)[0].name).toBe("귀속");
    await expect(account.confirmed).resolves.toBe(true);
    expect(store.sceneStoreConflicts().map((item) => textOf(item.theirs as never))).toEqual(["이 창 편집"]);
  });

  it("내용이 같은 씬은 충돌이 되지 않고, 지운 씬은 theirs=null 이며 다른 충돌을 지우지 않는다", async () => {
    const { store, data } = await openStore([scene("a", "가"), scene("b", "나")]);
    await store.absorbLegacyScenes({ [BUCKET]: [scene("a", "가"), scene("b", "나")] });
    await store.absorbLegacyScenes({ [BUCKET]: [{ ...(scene("a", "가") as object), name: "옛 창" } as never, scene("b", "나")] });
    data.updateScene(null, "a", { name: "이 창" });
    await store.settleSceneStoreForTest();
    await store.absorbLegacyScenes({ [BUCKET]: [{ ...(scene("a", "가") as object), name: "옛 창 또" } as never, scene("b", "나")] });
    const kept = store.sceneStoreConflicts().length;
    expect(kept).toBeGreaterThan(0);
    store.failSceneStoreWritesForTest(true);
    data.updateScene(null, "a", { name: "이 창" }); // 저장본과 같은 내용
    data.deleteScene(null, "b");
    await store.settleSceneWrites(50);
    store.failSceneStoreWritesForTest(false);
    store.setSceneWriteGate(() => true);
    store.setAsidePendingWrites();
    await store.settleSceneStoreForTest();
    const added = store.sceneStoreConflicts().slice(kept);
    expect(added.map(({ sceneId, theirs }) => [sceneId, theirs])).toEqual([["b", null]]);
    expect(store.sceneStoreConflicts()).toHaveLength(kept + 1);
    expect(data.listPersistedScenes(null).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("같은 씬의 충돌 둘은 복구 뒤 사본 둘로 남는다 — 손대지 않은 옛 사본이 있어도 · 원래 씬은 그대로", async () => {
    const { store, data, float } = await behind("첫 편집");
    float(true);
    store.setAsidePendingWrites();
    store.failSceneStoreWritesForTest(false);
    await store.settleSceneStoreForTest();
    float(false);
    expect((await data.recoverSceneConflicts())?.copied).toBe(1);
    await store.settleSceneStoreForTest();
    for (const text of ["둘째 편집", "셋째 편집"]) {
      float(false);
      store.failSceneStoreWritesForTest(true);
      data.updateScene(null, "a", { cards: textCard(text) });
      await store.settleSceneWrites(50);
      float(true);
      store.setAsidePendingWrites();
      store.failSceneStoreWritesForTest(false);
      await store.settleSceneStoreForTest();
    }
    expect(store.sceneStoreConflicts()).toHaveLength(2);
    float(false);
    await data.recoverSceneConflicts();
    await store.settleSceneStoreForTest();
    const scenes = data.listPersistedScenes(null);
    expect(scenes.find((item) => item.id === "a") && textOf(scenes.find((item) => item.id === "a"))).toBe("저장본");
    expect(scenes.filter((item) => item.id !== "a").map(textOf).sort()).toEqual(["둘째 편집", "셋째 편집"]);
  });

  it("전체 내보내기는 표시된 연산을 씬에 재생하지 않고 충돌로 싣는다 — 저장소를 못 읽어도", async () => {
    const { store, float } = await behind();
    float(true);
    store.setAsidePendingWrites();
    await store.settleSceneWrites(50);
    const dump = await store.dumpSceneStore();
    expect(textOf(dump.buckets[BUCKET][0])).toBe("저장본");
    expect(dump.conflicts.map((item) => textOf(item.theirs as never))).toEqual(["이 창 편집"]);
    store.replaceSceneStoreForTest({ other: [] });
    store.replaceSceneStoreForTest(null); // 알아보지 못하는 저장소 — 읽기 실패 경로
    const blind = await store.dumpSceneStore();
    expect(textOf(blind.buckets[BUCKET][0])).toBe("저장본");
    expect(blind.conflicts.map((item) => textOf(item.theirs as never))).toEqual(["이 창 편집"]);
  });

  it("떠 있지 않으면 재시도는 지금처럼 재생한다 · 밀린 것이 없으면 아무 일도 없다", async () => {
    const { store, data } = await behind();
    store.failSceneStoreWritesForTest(false);
    await store.settleSceneStoreForTest();
    expect(stored(data)).toBe("이 창 편집");
    store.setAsidePendingWrites();
    await store.settleSceneStoreForTest();
    expect(store.sceneStoreConflicts()).toEqual([]);
  });

  it("창이 떴다는 것을 안 그 자리에서 메인 창의 걸이가 불린다 — 떠 있음이 풀릴 때는 부르지 않는다", async () => {
    vi.resetModules();
    const popup = await import("../src/lib/popupWindows");
    const started = vi.fn();
    popup.setCanvasFloatStart(started);
    fakeLocks();
    vi.spyOn(window, "open").mockReturnValue({ closed: false, focus: () => {}, addEventListener: () => {} } as unknown as Window);
    popup.openEmbedWindow(popup.EMBED_MODES.canvas);
    expect(popup.isCanvasFloating()).toBe(true);
    expect(started).toHaveBeenCalledOnce();
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

describe("Comfy 실패 사유", () => {
  const comfyCard = { id: "k", kind: "comfy", x: 0, y: 0, comfyCfg: { content: "{}" } };
  const failed = { groupId: "g", groupSeq: 1, settledState: "failed", failureMessage: "없는 노드" };
  const replaceWorkflow = async (type: "replaceComfyWorkflow" | "refreshComfyMetadata") => {
    const { store, data } = await openStore([{ id: "s", name: "s", created_at: 1, edges: [], cards: [comfyCard], comfyCardRuns: { k: failed } }]);
    const { applyCanvasComfyCommand } = await import("../src/features/canvas/comfyCommands");
    const command = type === "replaceComfyWorkflow"
      ? { type, cardId: "k", workflow: { name: "새것", content: "{\"1\":{}}", nodeCount: 1 } } as const
      : { type, cardId: "k", expectedContent: "{}", nodeCount: 1 } as const;
    applyCanvasComfyCommand(command, { sceneId: "s", cardsRef: { current: [comfyCard] }, input: { applyCards: vi.fn() }, history: { propagateGenIdsToHistory: vi.fn() } } as never);
    await store.settleSceneStoreForTest();
    return data.listScenes(null)[0].comfyCardRuns!.k;
  };

  it("워크플로를 바꾸면 지난 워크플로의 구체적 오류를 지운다 · 실패 상태는 그대로다", async () => {
    expect(await replaceWorkflow("replaceComfyWorkflow")).toEqual({ groupId: "g", groupSeq: 1, settledState: "failed" });
  });

  it("같은 워크플로를 다시 읽는 것만으로는 지우지 않는다", async () => {
    expect((await replaceWorkflow("refreshComfyMetadata")).failureMessage).toBe("없는 노드");
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

  const canvasWindowModule = async () => {
    vi.resetModules();
    window.name = "contenthub-canvas";
    return import("../src/lib/popupWindows");
  };

  it("캔버스 창은 저장소를 열기 전에 잠금을 받아 평생 쥔다", async () => {
    const locks = fakeLocks();
    const popup = await canvasWindowModule();
    await expect(popup.claimCanvasWindow()).resolves.toBe(true);
    await sleep(0);
    expect(locks.held.map(({ name }) => name)).toEqual([LOCK]);
  });

  it("새로 고친 창 — 옛 문서가 곧 풀면 받는다", async () => {
    const locks = fakeLocks();
    const old = holdLikeCanvasWindow(locks);
    await sleep(0);
    const popup = await canvasWindowModule();
    const claim = popup.claimCanvasWindow();
    await sleep(0);
    old.end();
    await expect(claim).resolves.toBe(true);
  });

  it("다른 캔버스 창이 살아 있으면 시간 안에 못 받고, 기다리던 요청도 거둔다 — 늦게 받아 저장소를 여는 일이 없다", async () => {
    const locks = fakeLocks();
    const first = holdLikeCanvasWindow(locks);
    await sleep(0);
    const popup = await canvasWindowModule();
    vi.useFakeTimers();
    const claim = popup.claimCanvasWindow();
    await vi.advanceTimersByTimeAsync(2999);
    expect(locks.queue).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(claim).resolves.toBe(false);
    expect(locks.queue).toHaveLength(0);
    vi.useRealTimers();
    first.end();
    await sleep(0);
    expect(locks.held).toEqual([]);
  });

  it("잠금 API 가 없으면 지금처럼 간다(그런 주소의 창은 retireCanvasWindow 가 물러나게 한다)", async () => {
    const popup = await canvasWindowModule();
    await expect(popup.claimCanvasWindow()).resolves.toBe(true);
  });

  it("main.tsx — 잠금을 받기 전에는 알리지도 저장소를 열지도 않는다 · App — 연결 생성 중에는 새로 띄우지 않고 떠 있는 창은 그대로 앞으로 가져온다", () => {
    const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");
    expect(main.indexOf("await claimCanvasWindow()")).toBeGreaterThan(0);
    expect(main.indexOf("await claimCanvasWindow()")).toBeLessThan(main.indexOf("announceCanvasWindow();"));
    expect(main.indexOf("announceCanvasWindow();")).toBeLessThan(main.indexOf("await bootSceneStore()"));
    const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    const live = app.indexOf("if (canvasWindowLive()) return openEmbedWindow(EMBED_MODES.canvas, canvasElsewhere)");
    const plan = app.indexOf("if (sceneActionRef.current?.comfyPlanRunning()) return flash(");
    expect(live).toBeGreaterThan(0);
    expect(plan).toBeGreaterThan(live);
    expect(plan).toBeLessThan(app.indexOf("openingCanvasRef.current = true"));
    expect(app.match(/openEmbedWindow\(EMBED_MODES\.canvas, canvasElsewhere\)/g)).toHaveLength(2);
    const settled = app.indexOf("await settleSceneWrites(3000"); // 저장을 기다리는 사이 시작한 연결 생성도 창을 열기 직전에 다시 본다
    const again = app.indexOf("if (sceneActionRef.current?.comfyPlanRunning()) return flash(", settled);
    expect(again).toBeGreaterThan(settled);
    expect(again).toBeLessThan(app.indexOf("leaveCanvasHandoff({"));
  });

  describe("이 창이 잡지 못한 창을 다시 잡을 때", () => {
    const blankWindow = (href = "about:blank") => {
      const win = { closed: false, close: vi.fn(() => { win.closed = true; }), focus: vi.fn(), addEventListener: vi.fn(), location: { href } };
      return win;
    };
    async function floatingElsewhere() {
      const locks = fakeLocks();
      holdLikeCanvasWindow(locks);
      const main = await mainWindow();
      const other = new BroadcastChannel(CHANNEL);
      other.postMessage("open");
      await act(async () => { await sleep(20); });
      expect(main.popup.isCanvasFloating()).toBe(true);
      return { locks, ...main, finish: () => { other.close(); main.stop(); } };
    }

    it("잠금을 다른 창이 쥐고 있으면 빈 창을 닫고 안내만 한다 — 싣지 않아 분리 창이 둘 뜨지 않는다", async () => {
      const { popup, finish } = await floatingElsewhere();
      const win = blankWindow();
      const open = vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
      const elsewhere = vi.fn();
      popup.openEmbedWindow(popup.EMBED_MODES.canvas, elsewhere);
      await act(async () => { await sleep(0); });
      expect(open.mock.calls[0][0]).toBe("");
      expect(win.close).toHaveBeenCalledOnce();
      expect(elsewhere).toHaveBeenCalledOnce();
      expect(win.location.href).toBe("about:blank");
      expect(win.addEventListener).not.toHaveBeenCalled(); // 판정 전에는 이 창의 창으로 받아들이지 않는다
      popup.openEmbedWindow(popup.EMBED_MODES.canvas, elsewhere);
      expect(open).toHaveBeenCalledTimes(2); // 닫은 창을 등록하지 않았다 — 다음 휠 클릭도 다시 확인한다
      await act(async () => { await sleep(0); });
      finish();
    });

    it("잠금을 읽지 못해도 두 창을 만들지 않는 쪽으로 닫는다", async () => {
      const { popup, locks, finish } = await floatingElsewhere();
      locks.query = async () => { throw new Error("읽지 못함"); };
      const win = blankWindow();
      vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
      const elsewhere = vi.fn();
      popup.openEmbedWindow(popup.EMBED_MODES.canvas, elsewhere);
      await act(async () => { await sleep(0); });
      expect(win.close).toHaveBeenCalledOnce();
      expect(elsewhere).toHaveBeenCalledOnce();
      finish();
    });

    it("쥔 곳이 없으면 사실은 닫혀 있던 것이다 — 그 창에 한 번만 싣고 안내하지 않는다", async () => {
      const { popup, locks, finish } = await floatingElsewhere();
      locks.query = async () => ({ held: [], pending: [] });
      const win = blankWindow();
      const open = vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
      const elsewhere = vi.fn();
      popup.openEmbedWindow(popup.EMBED_MODES.canvas, elsewhere);
      await act(async () => { await sleep(0); });
      expect(win.location.href).toMatch(/embed=canvas/);
      expect(win.close).not.toHaveBeenCalled();
      expect(elsewhere).not.toHaveBeenCalled();
      popup.openEmbedWindow(popup.EMBED_MODES.canvas, elsewhere);
      expect(open).toHaveBeenCalledOnce(); // 이제 이 창이 아는 창이다 — 앞으로 가져올 뿐
      finish();
    });

    it("살아 있는 창을 다시 잡으면 앞으로 가져올 뿐이다", async () => {
      const { popup, finish } = await floatingElsewhere();
      const win = blankWindow("http://127.0.0.1/?embed=canvas&v=1");
      vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
      const elsewhere = vi.fn();
      popup.openEmbedWindow(popup.EMBED_MODES.canvas, elsewhere);
      expect(win.focus).toHaveBeenCalled();
      expect(win.close).not.toHaveBeenCalled();
      expect(elsewhere).not.toHaveBeenCalled();
      finish();
    });

    it("이 창이 연 창이 물러났는데 다른 창이 떠 있으면 낡은 참조를 비워 다음 휠 클릭이 그 창을 확인한다", async () => {
      const { popup, finish } = await floatingElsewhere();
      const mine = blankWindow("http://127.0.0.1/?embed=canvas&v=2");
      const open = vi.spyOn(window, "open").mockReturnValue(mine as unknown as Window);
      popup.openEmbedWindow(popup.EMBED_MODES.canvas);
      mine.closed = true;
      const other = new BroadcastChannel(CHANNEL);
      other.postMessage("closed");
      await act(async () => { await sleep(400); });
      expect(popup.isCanvasFloating()).toBe(true);
      expect(popup.canvasWindowLive()).toBe(true);
      const blank = blankWindow();
      open.mockReturnValue(blank as unknown as Window);
      const elsewhere = vi.fn();
      popup.openEmbedWindow(popup.EMBED_MODES.canvas, elsewhere);
      await act(async () => { await sleep(0); });
      expect(open.mock.calls[1][0]).toBe("");
      expect(elsewhere).toHaveBeenCalledOnce();
      other.close();
      finish();
    });
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

describe("창끼리 나누는 실행 표시 — 창마다 쥐는 잠금", () => {
  const lockOf = (id: string) => `mvhub-window-live-${id}`;
  // 받는 창 — 이 문서가 받은 다른 창의 몫을 그대로 들고 있다
  async function receiver() {
    vi.resetModules();
    const popup = await import("../src/lib/popupWindows");
    const got = new Map<string, unknown>();
    popup.shareWindowLive("comfyRunning", {
      read: () => [],
      apply: (sender, value) => { if (value === undefined) got.delete(sender); else got.set(sender, value); },
    });
    await sleep(0);
    return got;
  }
  const hold = (locks: ReturnType<typeof fakeLocks>, id: string) => {
    let end: () => void = () => {};
    void locks.request(lockOf(id), () => new Promise<void>((resolve) => { end = resolve; }));
    return { end: () => end() };
  };
  const tellLive = (channel: BroadcastChannel, sender: string, value: unknown) => channel.postMessage({ type: "live", name: "comfyRunning", sender, value });

  it("pagehide 없이 끝난 창의 몫만 지우고, 늦게 닿은 알림으로 되살아나지 않는다 · 살아 있는 창의 몫은 남는다", async () => {
    const locks = fakeLocks();
    const dead = hold(locks, "dead");
    hold(locks, "alive");
    const got = await receiver();
    const other = new BroadcastChannel("mvhub-window-live");
    try {
      tellLive(other, "dead", ["c1"]);
      tellLive(other, "alive", ["c2"]);
      await sleep(10);
      expect([...got.keys()]).toEqual(["dead", "alive"]);
      dead.end();
      await sleep(10);
      expect([...got.keys()]).toEqual(["alive"]);
      tellLive(other, "dead", ["c1"]); // 끝나기 전에 보낸 마지막 알림이 늦게 닿았다
      await sleep(10);
      expect([...got.keys()]).toEqual(["alive"]);
    } finally {
      other.close();
    }
  });

  it("잠금을 쥐기 전에는 알리지 않고, 쥔 직후 지금 몫을 알린다", async () => {
    const grants: (() => void)[] = [];
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      query: async () => ({ held: [], pending: [] }),
      request: (_name: string, run: () => unknown) => new Promise((done) => {
        grants.push(() => { void Promise.resolve().then(run).then(done); });
      }),
    } });
    const seen: unknown[] = [];
    const other = new BroadcastChannel("mvhub-window-live");
    other.onmessage = (event) => { if (event.data.type === "live" && JSON.stringify(event.data.value) === '["c1"]') seen.push(event.data.value); }; // 앞 시험의 모듈도 답한다
    try {
      vi.resetModules();
      const popup = await import("../src/lib/popupWindows");
      const announce = popup.shareWindowLive("comfyRunning", { read: () => ["c1"], apply: () => {} });
      announce();
      await sleep(10);
      expect(grants.length).toBeGreaterThan(0);
      expect(seen).toEqual([]);
      grants[0](); // 맨 먼저 청한 것이 자기 잠금이다
      await sleep(10);
      expect(seen).toEqual([["c1"]]);
    } finally {
      other.close();
    }
  });

  it("자기 잠금을 못 쥐면 알리지 않는다 — 받는 창이 빈 잠금을 얻어 살아 있는 창을 끝났다고 보지 않게", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: { query: async () => ({ held: [], pending: [] }), request: () => Promise.reject(new Error("막힘")) } });
    const seen: unknown[] = [];
    const other = new BroadcastChannel("mvhub-window-live");
    other.onmessage = (event) => { if (event.data.type === "live" && JSON.stringify(event.data.value) === '["못 쥠"]') seen.push(event.data.value); }; // 앞 시험의 모듈도 답한다
    try {
      vi.resetModules();
      const popup = await import("../src/lib/popupWindows");
      popup.shareWindowLive("comfyRunning", { read: () => ["못 쥠"], apply: () => {} })();
      await sleep(10);
      expect(seen).toEqual([]);
    } finally {
      other.close();
    }
  });

  it("돌아온 문서의 옛 잠금 요청이 늦게 얻어져도 새 잠금의 해제 손잡이를 덮지 않고 바로 놓인다", async () => {
    const grants: { name: string; grant: () => void; done: Promise<unknown> }[] = [];
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      query: async () => ({ held: [], pending: [] }),
      request: (name: string, run: () => unknown) => {
        let grant!: () => void;
        const done = new Promise((resolve) => { grant = () => { void Promise.resolve().then(run).then(resolve); }; });
        grants.push({ name, grant, done });
        return done;
      },
    } });
    const seen: { sender: string; value: unknown }[] = [];
    const other = new BroadcastChannel("mvhub-window-live");
    other.onmessage = (event) => { if (event.data.type === "live" && JSON.stringify(event.data.value) === '["늦게"]') seen.push(event.data); }; // 앞 시험의 모듈도 답한다
    try {
      vi.resetModules();
      const popup = await import("../src/lib/popupWindows");
      const announce = popup.shareWindowLive("comfyRunning", { read: () => ["늦게"], apply: () => {} });
      announce();
      await sleep(10);
      const before = grants.length;
      const first = grants[0]; // 맨 먼저 청한 것이 자기 잠금이다 — 아직 못 얻었다
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
      await sleep(10);
      grants.slice(before).forEach(({ grant }) => grant()); // 앞 시험의 모듈도 돌아오며 청한다 — 다 내주고 내 알림으로 내 잠금을 찾는다
      await sleep(10);
      const senders = () => [...new Set(seen.map(({ sender }) => sender))];
      expect(senders()).toHaveLength(1);
      const second = grants.find(({ name }) => name === lockOf(senders()[0]))!;
      expect(second).not.toBe(first);
      first.grant();
      await expect(first.done).resolves.toBeUndefined(); // 옛 요청은 얻는 대로 놓인다
      await sleep(10);
      expect(senders()).toHaveLength(1); // 옛 요청이 얻어져도 알리지 않는다
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })); // 다음 복귀 — 지금 잠금을 놓는다
      await expect(second.done).resolves.toBeUndefined();
    } finally {
      other.close();
    }
  });

  it("잠금 요청이 실패해도 끝으로 보지 않고, 잠금 API 가 없어도 지금처럼 나눈다", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: { query: async () => ({ held: [], pending: [] }), request: () => Promise.reject(new Error("막힘")) } });
    const refused = await receiver();
    const other = new BroadcastChannel("mvhub-window-live");
    try {
      tellLive(other, "s", ["c1"]);
      await sleep(10);
      expect(refused.get("s")).toEqual(["c1"]);
      Reflect.deleteProperty(navigator, "locks");
      const plain = await receiver();
      tellLive(other, "t", ["c2"]);
      await sleep(10);
      expect(plain.get("t")).toEqual(["c2"]);
      other.postMessage({ type: "gone", sender: "t" });
      await sleep(10);
      expect(plain.has("t")).toBe(false);
    } finally {
      other.close();
    }
  });

  it("bfcache 에서 돌아온 문서는 새 id 로 다시 알리고, 멈춘 동안 끝난 다른 창도 다시 감시해 지운다", async () => {
    const locks = fakeLocks();
    const seen: { sender: string; value: unknown }[] = [];
    const other = new BroadcastChannel("mvhub-window-live");
    other.onmessage = (event) => { if (event.data.type === "live" && JSON.stringify(event.data.value) === '["mine"]') seen.push(event.data); }; // 앞 시험의 모듈도 답한다
    try {
      const away = hold(locks, "gone-while-away");
      vi.resetModules();
      const popup = await import("../src/lib/popupWindows");
      const got = new Map<string, unknown>();
      const announce = popup.shareWindowLive("comfyRunning", { read: () => ["mine"], apply: (sender, value) => { if (value === undefined) got.delete(sender); else got.set(sender, value); } });
      announce();
      await sleep(10);
      tellLive(other, "gone-while-away", ["c1"]);
      await sleep(10);
      expect(got.has("gone-while-away")).toBe(true);
      const first = seen[0].sender;
      // 멈춘 동안 감시가 끊겼다 — 대기 줄에서 지운다
      locks.queue.splice(0);
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
      await sleep(10);
      expect(seen.at(-1)?.sender).not.toBe(first);
      expect(seen.at(-1)?.value).toEqual(["mine"]);
      expect(locks.held.map(({ name }) => name)).toEqual(expect.arrayContaining([lockOf(seen.at(-1)!.sender)]));
      expect(locks.held.map(({ name }) => name)).not.toContain(lockOf(first));
      away.end();
      await sleep(10);
      expect(got.has("gone-while-away")).toBe(false); // 답을 기다리지 않고 다시 건 감시가 지운다
    } finally {
      other.close();
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
