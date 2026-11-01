// @vitest-environment jsdom
// 씬을 쓰는 메인 탭은 하나다(docs/status/배포전_남은제한_해결_2026-11-02.md). 둘째 탭은 떠 있는 캔버스를 둔 메인 창과 같은 상태로 쉰다.
// 창마다 모듈이 따로라 vi.resetModules 로 새 문서를 흉내 낸다. 실제 잠금의 순서는 실측이 잰다 — 여기서는 판단만 본다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WRITER = "mvhub-scene-writer";
const WINDOW = "mvhub-canvas-window";
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// navigator.locks 의 필요한 만큼만 — 한 이름을 한 문서가 쥐고, 나머지는 차례를 기다린다.
function fakeLocks() {
  const held: { name: string; finish: () => void }[] = [];
  const queue: { name: string; run: () => unknown; done: (value: unknown) => void }[] = [];
  const pump = () => {
    for (const next of [...queue]) {
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
    request: (name: string, run: () => unknown) => new Promise((done) => {
      queue.push({ name, run, done });
      pump();
    }),
  };
  Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
  return locks;
}

function holdBy(locks: ReturnType<typeof fakeLocks>, name: string) {
  let end = () => {};
  void locks.request(name, () => new Promise<void>((finish) => { end = finish; }));
  return () => end();
}

async function page() {
  vi.resetModules();
  return import("../src/lib/popupWindows");
}

async function until(check: () => boolean) {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > 4000) throw new Error("기다린 값이 오지 않았다");
    await sleep(5);
  }
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "locks");
  Reflect.deleteProperty(window, "__mvhubCanvasMemory");
  vi.restoreAllMocks();
});

describe("쓰는 탭 정하기", () => {
  it("잠금을 받으면 평소와 같고 잠금을 쥔 채 첫 화면이 열린다", async () => {
    const locks = fakeLocks();
    const popup = await page();
    await popup.claimSceneWriter();
    expect(popup.isCanvasFollower()).toBe(false);
    expect(popup.isCanvasFloating()).toBe(false);
    expect(locks.held.map(({ name }) => name)).toEqual([WRITER]);
  });

  it("다른 탭이 쥐고 있으면 0.5초 뒤 쉬는 탭으로 첫 화면이 열리고 차례를 기다린다", async () => {
    const locks = fakeLocks();
    holdBy(locks, WRITER);
    const popup = await page();
    await popup.claimSceneWriter(); // 평생 쥐는 잠금을 기다리면 여기서 안 끝난다
    expect(popup.isCanvasFollower()).toBe(true);
    expect(popup.isCanvasFloating()).toBe(true);
    expect(locks.queue.map(({ name }) => name)).toEqual([WRITER]);
  });

  it("쉬는 탭의 씬 쓰기는 입구에서 거절된다 — 떠 있는 창을 둔 메인 창과 같다", async () => {
    const locks = fakeLocks();
    holdBy(locks, WRITER);
    const popup = await page();
    await popup.claimSceneWriter();
    const store = await import("../src/lib/sceneStore");
    const data = await import("../src/lib/scenes");
    let mark: Parameters<typeof store.initSceneStore>[1] = null;
    await store.initSceneStore(() => ({ "local::_none": [{ id: "a", name: "a", created_at: 1, edges: [], cards: [] }] as never }), mark, (next) => { mark = next; return true; });
    await store.settleSceneStoreForTest();
    await import("../src/lib/sceneBoot"); // 쓰기 문을 단다
    expect(data.updateScene(null, "a", { name: "덮으면 안 됨" })).toEqual({ ok: false, reason: "paused" });
  });

  it("새로 고침 — 옛 문서의 해제가 늦어도 0.5초 안이면 안내 없이 쓰는 탭이다", async () => {
    const locks = fakeLocks();
    const oldDocument = holdBy(locks, WRITER);
    const popup = await page();
    const claimed = popup.claimSceneWriter();
    await sleep(100);
    oldDocument();
    await claimed;
    expect(popup.isCanvasFollower()).toBe(false);
    expect(locks.held.map(({ name }) => name)).toEqual([WRITER]);
  });

  it("잠금이 없는 주소는 지금과 같다", async () => {
    const popup = await page();
    await popup.claimSceneWriter();
    expect(popup.isCanvasFollower()).toBe(false);
    expect(popup.isCanvasFloating()).toBe(false);
  });
});

describe("쓰던 탭이 끝날 때", () => {
  async function follower() {
    const locks = fakeLocks();
    const writer = holdBy(locks, WRITER);
    const popup = await page();
    await popup.claimSceneWriter();
    return { locks, writer, popup };
  }

  it("저장소를 다시 읽은 뒤에만 풀린다 — 실패하면 쓰기를 멈춘 채 다시 읽는다", async () => {
    const { writer, popup } = await follower();
    const read = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    popup.setSceneWriterRead(read);
    writer();
    await until(() => read.mock.calls.length === 1);
    expect(popup.isCanvasFloating()).toBe(true);
    await until(() => !popup.isCanvasFollower());
    expect(read).toHaveBeenCalledTimes(2);
    expect(popup.isCanvasFloating()).toBe(false);
  });

  it("분리 창이 살아 있으면 승격 뒤에도 떠 있음이 남는다", async () => {
    const { locks, writer, popup } = await follower();
    holdBy(locks, WINDOW);
    await popup.findFloatingCanvas();
    popup.setSceneWriterRead(async () => true);
    writer();
    await until(() => !popup.isCanvasFollower());
    expect(popup.isCanvasFloating()).toBe(true);
  });

  it("분리 창이 닫혀도 쉬는 탭은 풀리지 않는다", async () => {
    const { locks, popup } = await follower();
    const canvas = holdBy(locks, WINDOW);
    await popup.findFloatingCanvas();
    popup.setCanvasReturnRead(async () => true);
    const seen = vi.fn();
    canvas();
    await sleep(500); // 닫힘을 알고 돌려받는 틈이 지나도
    seen(popup.isCanvasFloating());
    expect(seen).toHaveBeenCalledWith(true);
    expect(popup.isCanvasFollower()).toBe(true);
  });
});

describe("쉬는 탭은 닫히는 분리 창의 인계를 받지 않는다", () => {
  it("그 창이 직접 쓴다 — 받으면 인계 예외로 저장소를 써 쓰는 탭의 편집을 덮는다", async () => {
    const locks = fakeLocks();
    holdBy(locks, WRITER);
    const popup = await page();
    await popup.claimSceneWriter();
    const load = vi.fn(() => true);
    popup.registerCanvasMemory("sceneWrites", { durable: true, save: () => null, load });
    popup.registerCanvasMemory("promptView", { save: () => null, load: vi.fn() });
    popup.shareCanvasMemory();
    const port = (window as unknown as Record<string, { load: (memory: object) => string[] }>).__mvhubCanvasMemory;
    expect(port.load({ sceneWrites: [1], promptView: { x: 1 } })).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("화면 글자", () => {
  const source = (path: string) => readFileSync(resolve(__dirname, "..", "src", path), "utf8");

  it("캔버스 자리·탭 제목·분리 창 열기·라이브러리에서 열기·MCP·전체 가져오기가 다른 탭 안내를 쓴다", () => {
    const app = source("App.tsx");
    expect(app).toContain("t(canvasOtherTab ? CANVAS_OTHER_TAB");
    expect(app).toContain("if (isCanvasFollower()) return flash(CANVAS_OTHER_TAB)");
    expect(app).toContain("flash(CANVAS_OTHER_TAB);");
    expect(source("components/TopBar.tsx")).toContain("canvasOtherTab ? CANVAS_OTHER_TAB");
    expect(source("components/mcp/McpConnection.tsx")).toContain("isCanvasFollower() ?");
    expect(source("components/settings/CanvasArchiveSection.tsx")).toContain("otherTab ?");
    expect(source("lib/i18n.ts")).toContain("캔버스는 다른 탭에서 열려 있습니다");
  });
});
