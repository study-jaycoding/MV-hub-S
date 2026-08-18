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

  it("제거 전송 실패는 앱을 다시 열어도 대기열에서 재시도한다", async () => {
    putFails = true;
    let loaded = await boot();
    await loaded.links.markCardGenerationsRemoved("s1", "c1", ["g1"]);
    expect(puts().length).toBe(1);

    putFails = false;
    loaded = await boot(); // 모듈 재시작 — 메모리가 아니라 localStorage 대기열에서 복구해야 한다
    loaded.links.initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);

    expect(puts().length).toBe(2);
    expect(putBody(puts()[1]).removed[0]).toEqual({
      scene_id: "s1",
      card_id: "c1",
      generation_id: "g1",
    });
  });

  it("제거 전송이 성공하면 재시작 뒤 중복 전송하지 않는다", async () => {
    let loaded = await boot();
    await loaded.links.markCardGenerationsRemoved("s1", "c1", ["g1"]);
    expect(puts().length).toBe(1);

    loaded = await boot();
    loaded.links.initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(1);
  });

  it("제거 직후 서버 읽기가 낡아도 자동 추가가 같은 소속을 되살리지 않는다", async () => {
    const { scenes, links } = await boot();
    scenes.saveScenes(null, [sceneWith("s1", "c1", ["g1"])]); // 화면 저장이 늦은 최악 조건

    await links.markCardGenerationsRemoved("s1", "c1", ["g1"]);

    expect(puts().length).toBe(1);
    expect(putBody(puts()[0]).removed[0].generation_id).toBe("g1");
    expect(putBody(puts()[0]).added).toEqual([]);
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

  it("서버 읽기 성공 시 화면에 합치라고 알린다(빈 응답이면 안 알림)", async () => {
    getLinks = () =>
      Promise.resolve({ items: [{ scene_id: "s1", card_id: "c1", generation_id: "g1", removed_at: null }] });
    const { scenes, links } = await boot();
    scenes.saveScenes(null, [sceneWith("s1", "c1", [])]);
    let notified = 0;
    links.subscribeCardLinksLoaded(() => (notified += 1));
    links.initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);
    expect(notified).toBe(1);
  });

  it("다른 브라우저에서 뒤늦게 담은 결과를 30초 안에 다시 읽어 알린다", async () => {
    let remoteItems: unknown[] = [];
    getLinks = () => Promise.resolve({ items: remoteItems });
    const { scenes, links } = await boot();
    scenes.saveScenes(null, [sceneWith("s1", "c1", [])]);
    let notified = 0;
    links.subscribeCardLinksLoaded(() => (notified += 1));
    links.initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls.filter((call) => !call.init?.method).length).toBe(1);

    remoteItems = [{ scene_id: "s1", card_id: "c1", generation_id: "g-other", removed_at: null }];
    await vi.advanceTimersByTimeAsync(30_000);

    expect(calls.filter((call) => !call.init?.method).length).toBe(2);
    expect(notified).toBe(1);
    expect(links.serverCardLinks("s1").map((link) => link.generation_id)).toEqual(["g-other"]);
  });

  it("주기 갱신 응답이 같으면 화면 합치기를 반복 호출하지 않는다", async () => {
    getLinks = () =>
      Promise.resolve({
        items: [{ scene_id: "s1", card_id: "c1", generation_id: "g1", removed_at: null }],
      });
    const { links } = await boot();
    let notified = 0;
    links.subscribeCardLinksLoaded(() => (notified += 1));
    links.initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);
    expect(notified).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(notified).toBe(1);
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

// ── 합치기(2단계) — 순수 함수라 타이머·fetch 없이 검사 ─────────────────
describe("mergeCardLinksIntoScenes (씬 열 때 합치기)", () => {
  type Card = { id: string; kind: string; genId?: string | null; genIds?: string[] };
  const scene = (id: string, cards: Card[]) => ({ id, cards });
  const link = (s: string, c: string, g: string, removed_at: string | null = null) => ({
    scene_id: s,
    card_id: c,
    generation_id: g,
    removed_at,
  });
  let merge: typeof import("../src/lib/sceneCardLinks").mergeCardLinksIntoScenes;

  beforeEach(async () => {
    vi.resetModules();
    merge = (await import("../src/lib/sceneCardLinks")).mergeCardLinksIntoScenes;
  });

  it("서버에만 있는 생성물이 카드에 더해진다(다른 브라우저에서 담은 것)", () => {
    const out = merge(
      [scene("s1", [{ id: "c1", kind: "generation", genIds: ["g1"] }])],
      [link("s1", "c1", "g1"), link("s1", "c1", "g2")],
    );
    expect(out?.[0].cards[0].genIds).toEqual(["g1", "g2"]);
  });

  it("서버가 뺐다고 표시한 생성물은 카드에서 빠진다", () => {
    const out = merge(
      [scene("s1", [{ id: "c1", kind: "generation", genIds: ["g1", "g2"] }])],
      [link("s1", "c1", "g2", "2026-08-18 00:00:00")],
    );
    expect(out?.[0].cards[0].genIds).toEqual(["g1"]);
  });

  it("★바뀐 게 없으면 null — 저장→알림→합치기 고리를 끊는다", () => {
    expect(
      merge([scene("s1", [{ id: "c1", kind: "generation", genIds: ["g1"] }])], [link("s1", "c1", "g1")]),
    ).toBeNull();
    expect(merge([scene("s1", [{ id: "c1", kind: "generation", genIds: [] }])], [])).toBeNull();
  });

  it("서버에만 있는 카드 번호는 무시한다(카드는 씬이 소유)", () => {
    expect(
      merge(
        [scene("s1", [{ id: "c1", kind: "generation", genIds: ["g1"] }])],
        [link("s1", "c1", "g1"), link("s1", "cGhost", "g9")],
      ),
    ).toBeNull();
  });

  it("대표가 빠지면 남은 것 중 마지막으로 옮긴다(빈 카드로 보이지 않게)", () => {
    const out = merge(
      [scene("s1", [{ id: "c1", kind: "generation", genId: "g2", genIds: ["g1", "g2"] }])],
      [link("s1", "c1", "g2", "2026-08-18 00:00:00")],
    );
    expect(out?.[0].cards[0].genId).toBe("g1");
    expect(out?.[0].cards[0].genIds).toEqual(["g1"]);
  });

  it("결과가 쌓이지 않는 카드는 건드리지 않는다", () => {
    expect(merge([scene("s1", [{ id: "c1", kind: "text" }])], [link("s1", "c1", "g1")])).toBeNull();
  });

  it("안 바뀐 씬은 원래 객체를 그대로 둔다(불필요한 재렌더 방지)", () => {
    const keep = scene("s2", [{ id: "c2", kind: "generation", genIds: ["gx"] }]);
    const out = merge(
      [scene("s1", [{ id: "c1", kind: "generation", genIds: [] }]), keep],
      [link("s1", "c1", "g1")],
    );
    expect(out?.[1]).toBe(keep);
  });
});
