// 캔버스 카드 소속 기록 — 안전 불변식 고정.
//  핵심 두 가지:
//   ① 화면에서 사라진 소속을 자동으로 지우지 않는다(다른 브라우저가 방금 담은 걸 죽이는 사고).
//   ② 서버가 '뺐음'으로 표시한 소속을 백필이 되살리지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest node 환경 스텁 — localStorage + window(online 리스너용). sceneBackup.test.ts 와 동일.
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => void mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
(globalThis as Record<string, unknown>).window = globalThis;
if (!(globalThis as Record<string, unknown>).addEventListener) {
  (globalThis as Record<string, unknown>).addEventListener = () => {};
}

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let getLinks: () => Promise<{ items: unknown[] }>;
let putFails = false;
vi.mock("../src/lib/http", () => ({
  jsonFetch: (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "PUT") {
      return putFails ? Promise.reject(new Error("offline")) : Promise.resolve({ ok: true });
    }
    return getLinks();
  },
}));

const puts = () => calls.filter((c) => c.init?.method === "PUT");
const putBody = (c: Call) => JSON.parse(String(c.init?.body));
const addedKeys = (c: Call) =>
  putBody(c).added.map((a: { card_id: string; generation_id: string }) => `${a.card_id}:${a.generation_id}`);

let acctSeq = 0;
async function boot() {
  vi.resetModules();
  const scenes = await import("../src/lib/scenes");
  const links = await import("../src/lib/sceneCardLinks");
  return { scenes, links };
}

/** 생성 카드 하나에 결과 몇 개가 쌓인 씬. */
function sceneWith(id: string, cardId: string, genIds: string[]) {
  return {
    id,
    name: id,
    cards: [{ id: cardId, kind: "generation", x: 0, y: 0, genIds }],
    edges: [],
    created_at: 1,
  };
}

describe("sceneCardLinks (카드 소속 기록)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    mem.clear();
    putFails = false;
    acctSeq += 1;
    localStorage.setItem("ch.activeAccount", `user${acctSeq}@test`);
    getLinks = () => Promise.resolve({ items: [] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("백필 — 브라우저에만 있던 소속을 한 번 올린다", async () => {
    const { scenes, links } = await boot();
    scenes.saveScenes(null, [sceneWith("s1", "c1", ["g1", "g2"])]);
    links.initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(1);
    expect(addedKeys(puts()[0])).toEqual(["c1:g1", "c1:g2"]);
    expect(putBody(puts()[0]).removed).toEqual([]);
  });

  it("이미 서버가 아는 소속은 다시 올리지 않는다(멱등)", async () => {
    getLinks = () =>
      Promise.resolve({ items: [{ scene_id: "s1", card_id: "c1", generation_id: "g1", removed_at: null }] });
    const { scenes, links } = await boot();
    scenes.saveScenes(null, [sceneWith("s1", "c1", ["g1", "g2"])]);
    links.initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);
    expect(addedKeys(puts()[0])).toEqual(["c1:g2"]); // g1 은 이미 있음
  });

  it("★서버가 '뺐음'으로 표시한 소속은 백필이 되살리지 않는다", async () => {
    getLinks = () =>
      Promise.resolve({
        items: [{ scene_id: "s1", card_id: "c1", generation_id: "g1", removed_at: "2026-08-18 00:00:00" }],
      });
    const { scenes, links } = await boot();
    scenes.saveScenes(null, [sceneWith("s1", "c1", ["g1"])]); // 이 브라우저 로컬엔 아직 남아 있음
    links.initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(0);
  });

  it("★화면에서 사라져도 자동으로 제거를 보내지 않는다", async () => {
    const { scenes, links } = await boot();
    scenes.saveScenes(null, [sceneWith("s1", "c1", ["g1"])]);
    links.initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);
    calls = [];
    scenes.saveScenes(null, [sceneWith("s1", "c1", [])]); // 로컬에서 사라짐(낡은 목록일 수 있음)
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(0); // 제거를 보내면 다른 브라우저가 방금 담은 게 죽는다
  });

  it("사용자가 실제로 비우면 그때만 '뺐음'을 보낸다", async () => {
    const { links } = await boot();
    await links.markCardGenerationsRemoved("s1", "c1", ["g1", "g2"]);
    expect(puts().length).toBe(1);
    expect(putBody(puts()[0]).added).toEqual([]);
    expect(putBody(puts()[0]).removed.map((r: { generation_id: string }) => r.generation_id)).toEqual([
      "g1",
      "g2",
    ]);
  });

  it("서버 읽기 실패 시 아무것도 올리지 않는다(무엇이 새 것인지 모르므로)", async () => {
    getLinks = () => Promise.reject(new Error("401"));
    const { scenes, links } = await boot();
    scenes.saveScenes(null, [sceneWith("s1", "c1", ["g1"])]);
    links.initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(0);
  });

  it("올리기 실패는 다음 시도에 그대로 다시 올린다", async () => {
    const { scenes, links } = await boot();
    scenes.saveScenes(null, [sceneWith("s1", "c1", ["g1"])]);
    putFails = true;
    links.initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(1);
    putFails = false;
    await vi.advanceTimersByTimeAsync(31_000); // 백오프 재시도
    expect(addedKeys(puts()[1])).toEqual(["c1:g1"]);
  });

  it("여러 씬·여러 카드를 한 번에 모은다", async () => {
    const { scenes, links } = await boot();
    scenes.saveScenes(null, [sceneWith("s1", "c1", ["g1"]), sceneWith("s2", "c2", ["g2"])]);
    links.initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);
    const body = putBody(puts()[0]);
    expect(body.added.map((a: { scene_id: string }) => a.scene_id)).toEqual(["s1", "s2"]);
  });
});
