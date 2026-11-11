// E4 — 이 창의 카메라만 바꾼 확정(docs/status/캔버스_카메라저장묶기_2026-11-11.md 기준 cameraonly).
//  ① 저장소가 확정 통지에 '카메라만' 표시를 정확히 싣는지(내용·삭제·이관·넘김·인계·확정 전용·버림·다른 창 읽기가 섞이면 거짓)
//  ② 숨김 처리기가 부르는 바로 그 공책 동기화(syncSceneNotebook({fresh:true}))가 업로드 실패로 retry 면, 카메라만 확정은 동기화를
//     예약하지 않으므로 백업이 그 결과를 받아 기존 30초 재시도로 다시 돌려 허브에 최신 카메라가 도착하는지 — 실제 공책 동기화·가짜 허브.
//  숨김 이벤트 → 그 호출은 sceneWriter.test 의 "hidden flushes and requests a fresh sync" 가 본다.
// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHubFeatures } from "../src/lib/hubFeatures";
import { setAccountScope } from "../src/lib/accountScope";
import {
  applySceneOp, delaySceneStoreWritesForTest, failSceneStoreWritesForTest, markSceneWritesHanded, setSceneWriteGate,
  settleSceneStoreForTest, writeSceneStoreAsOtherWindowForTest, writeScenesStore,
} from "../src/lib/sceneStore";
import { listPersistedScenes, subscribeScenesPersisted, updateScene, updateSceneCamera, type Scene, type ScenesByProject } from "../src/lib/scenes";
import { joinSceneNotebook, setSceneNotebookTokenProvider, syncSceneNotebook } from "../src/lib/sceneNotebook";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Row = { id: string; data: string; deleted_at: string | null; base: { history_id: string; rev: number; hash: string } };
/** 공책 허브 흉내 — 받기(notebook?)·올리기(backup)만. 올리기 실패는 상태 없는 연결 실패로 낸다(공책이 재시도로 본다). */
class MiniHub {
  history = "h1"; book = "book1"; rows = new Map<string, Row>(); order: string[] = []; rev = 1; uploads = 0; failUploads = false;
  cardPuts: any[] = []; failCards = false; // 카드-생성물 소속(/api/scenes/cards)
  save(s: Scene) {
    const data = JSON.stringify(s), prior = this.rows.get(s.id);
    const row: Row = { id: s.id, data, deleted_at: null, base: { history_id: this.history, rev: (prior?.base.rev ?? 0) + 1, hash: hash(data) } };
    this.rows.set(s.id, row); if (!this.order.includes(s.id)) this.order.push(s.id); return row;
  }
  handle(path: string, body: any, method?: string): any {
    if (path.startsWith("/api/scenes/cards")) {
      if (method !== "PUT") return { items: [] };
      this.cardPuts.push(body);
      if (this.failCards) throw new TypeError("network down");
      return { ok: true };
    }
    if (path.includes("notebook?")) return { notebook_id: this.book, history_id: this.history, items: [...this.rows.values()], order: { ids: this.order, rev: this.rev, history_id: this.history } };
    if (path.endsWith("/backup")) {
      this.uploads++;
      if (this.failUploads) throw new TypeError("network down");
      const results = body.upserts.map((up: any) => {
        const old = this.rows.get(up.id);
        const saved = old && old.base.hash === hash(up.data) ? old : this.save(JSON.parse(up.data));
        return { id: up.id, status: saved === old ? "same" : "saved", target_id: saved.id, base: saved.base };
      });
      return { history_id: this.history, results, deletes: [], order: { ids: this.order, rev: this.rev, history_id: this.history }, mcp_done: [] };
    }
    throw new Error(`unexpected ${path}`);
  }
}
let hub = new MiniHub();
vi.mock("../src/lib/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/http")>()),
  jsonFetch: async (path: string, init?: RequestInit) => structuredClone(hub.handle(path, init?.body ? JSON.parse(String(init.body)) : undefined, init?.method)),
}));

const bucket = "local::_none";
const scene = (id = "s", name = id): Scene => ({ id, name, cards: [], edges: [], created_at: 1 });
const cam = (z: number) => ({ z, x: z * 10, y: z * 20 });
const saved = (id = "s") => listPersistedScenes(null).find((s) => s.id === id);

let infos: boolean[] = [];
let off = () => {};
beforeEach(async () => {
  setAccountScope(null);
  setHubFeatures([]);
  setSceneWriteGate(() => false);
  await writeScenesStore({ [bucket]: [scene("s"), scene("t")] });
  await settleSceneStoreForTest();
  infos = [];
  off = subscribeScenesPersisted(({ cameraOnly }) => infos.push(cameraOnly));
});
afterEach(async () => {
  off();
  failSceneStoreWritesForTest(false);
  delaySceneStoreWritesForTest(0);
  await settleSceneStoreForTest();
  setHubFeatures([]);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("확정 통지의 '카메라만' 표시(cameraOnly)", () => {
  it("카메라만 쓴 확정은 참, 내용을 쓴 확정은 거짓", async () => {
    updateSceneCamera(null, "s", cam(2));
    await settleSceneStoreForTest();
    updateScene(null, "s", { name: "renamed" });
    await settleSceneStoreForTest();
    expect(infos).toEqual([true, false]);
    expect(saved()?.camera).toEqual(cam(2));
  });

  it("저장 전에 잇달아 온 카메라 기록은 카메라 슬롯끼리 합쳐져 참 — 저장본은 뒤 값", async () => {
    updateSceneCamera(null, "s", cam(2));
    updateSceneCamera(null, "s", cam(3));
    await settleSceneStoreForTest();
    expect(infos).toEqual([true]);
    expect(saved()?.camera).toEqual(cam(3));
  });

  it("카메라와 내용이 한 묶음으로 확정되면 거짓", async () => {
    updateSceneCamera(null, "s", cam(2));
    updateScene(null, "s", { name: "renamed" });
    await settleSceneStoreForTest();
    expect(infos).toEqual([false]);
    expect([saved()?.name, saved()?.camera]).toEqual(["renamed", cam(2)]);
  });

  it("C1 → 쓰는 중 내용 → C2 교차 — 따로 연산으로 순서대로 재생해 저장본에 내용과 C2 가 다 남는다", async () => {
    delaySceneStoreWritesForTest(30);
    updateSceneCamera(null, "s", cam(1));
    const first = settleSceneStoreForTest();
    await new Promise((resolve) => setTimeout(resolve, 5)); // C1 이 쓰는 중(떠난 연산과는 합치지 않는다)
    updateScene(null, "s", { name: "while writing" });
    updateSceneCamera(null, "s", cam(2));
    await first;
    delaySceneStoreWritesForTest(0);
    await settleSceneStoreForTest();
    expect(infos).toEqual([true, false]);
    expect([saved()?.name, saved()?.camera]).toEqual(["while writing", cam(2)]);
  });

  it("저장소 실패한 시도는 알리지 않고, 재시도 성공 때 그 묶음으로 참 — 최신 카메라가 남는다", async () => {
    failSceneStoreWritesForTest(true);
    updateSceneCamera(null, "s", cam(4));
    expect(await settleSceneStoreForTest()).toBe(false);
    expect(infos).toEqual([]);
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(infos).toEqual([true]);
    expect(saved()?.camera).toEqual(cam(4));
  });

  it("확정 전용·인계 연산이 섞이면 거짓", async () => {
    updateSceneCamera(null, "s", cam(2));
    applySceneOp((all: ScenesByProject) => { all[bucket] = [scene("s", "confirmed only"), scene("t")]; return { write: true, value: null }; }, { confirmedOnly: true });
    await settleSceneStoreForTest();
    updateSceneCamera(null, "s", cam(3));
    applySceneOp((all: ScenesByProject) => { all[bucket] = (all[bucket] ?? []).map((x) => (x.id === "t" ? { ...x, name: "handed over" } : x)); return { write: true, value: null }; }, { handover: true });
    await settleSceneStoreForTest();
    expect(infos).toEqual([false, false]);
  });

  it("쓰는 중 메인 창에 넘긴(handed) 카메라 연산은 거짓", async () => {
    delaySceneStoreWritesForTest(30);
    updateSceneCamera(null, "s", cam(5));
    const run = settleSceneStoreForTest();
    await new Promise((resolve) => setTimeout(resolve, 5));
    markSceneWritesHanded();
    await run;
    expect(infos).toEqual([false]);
  });

  it("재생에 실패해 버린(poisoned) 연산이 섞이면 거짓", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    updateSceneCamera(null, "s", cam(2));
    applySceneOp((all: ScenesByProject) => {
      if (calls++ > 0) throw new Error("replay fails");
      all[bucket] = (all[bucket] ?? []).map((x) => (x.id === "t" ? { ...x, name: "poison" } : x));
      return { write: true, value: null };
    });
    await settleSceneStoreForTest();
    expect(infos).toEqual([false]);
  });

  it("다른 창의 확정을 읽은 트랜잭션은 거짓", async () => {
    writeSceneStoreAsOtherWindowForTest((all) => { all[bucket] = [scene("s", "other window"), scene("t")]; });
    updateSceneCamera(null, "s", cam(2));
    await settleSceneStoreForTest();
    expect(infos).toEqual([false]);
  });

  it("옛 버킷 이관을 일으킨 카메라 쓰기는 거짓(순서·버킷 키가 생긴다)", async () => {
    await writeScenesStore({ _none: [scene("old")] }); // 계정 도입 전 버킷만 있다
    await settleSceneStoreForTest();
    infos = [];
    expect(updateSceneCamera(null, "old", cam(2)).ok).toBe(true);
    await settleSceneStoreForTest();
    expect(infos).toEqual([false]);
    expect(saved("old")?.camera).toEqual(cam(2));
  });

  it("씬 삭제가 섞이면 거짓", async () => {
    updateSceneCamera(null, "s", cam(2));
    applySceneOp((all: ScenesByProject) => { all[bucket] = (all[bucket] ?? []).filter((x) => x.id !== "t"); return { write: true, value: null }; });
    await settleSceneStoreForTest();
    expect(infos).toEqual([false]);
  });
});

describe("카드-생성물 연결 훑기 — 카메라만 바꾼 확정은 예약하지 않는다", () => {
  it("카메라만 → 2초 뒤 훑기 없음(걸려 있던 실패 재시도는 기한에 그대로) · 내용 확정 → 2초 뒤 훑기", async () => {
    hub = new MiniHub();
    await writeScenesStore({ [bucket]: [{ ...scene("s"), cards: [{ id: "c1", kind: "generation", x: 0, y: 0, genIds: ["g1"] }] } as unknown as Scene] });
    await settleSceneStoreForTest();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const keys = (body: any) => body.backfill.map((l: { card_id: string; generation_id: string }) => `${l.card_id}:${l.generation_id}`);
    const { initSceneCardLinks } = await import("../src/lib/sceneCardLinks");
    hub.failCards = true;
    initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500); // 첫 백필 실패 → 30초 재시도가 걸린다
    expect(hub.cardPuts).toHaveLength(1);
    hub.failCards = false;
    updateSceneCamera(null, "s", cam(2));
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(5000);
    expect(hub.cardPuts).toHaveLength(1); // 카메라만 — 훑기 예약 없음
    await vi.advanceTimersByTimeAsync(25_000);
    expect(hub.cardPuts).toHaveLength(2); // 걸려 있던 재시도는 기한에 돈다
    expect(keys(hub.cardPuts[1])).toEqual(["c1:g1"]);
    updateScene(null, "s", { cards: [{ id: "c1", kind: "generation", x: 0, y: 0, genIds: ["g1", "g2"] }] as unknown as Scene["cards"] });
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(1900);
    expect(hub.cardPuts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(hub.cardPuts).toHaveLength(3); // 내용 확정은 지금처럼 2초 뒤
    expect(keys(hub.cardPuts[2])).toEqual(["c1:g2"]);
  });

  it("명시적 제거 의도가 실패로 대기 중일 때 카메라만 → 훑기 예약 없이, 걸려 있던 재시도가 그 제거를 보낸다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { initSceneCardLinks, markCardGenerationsRemoved } = await import("../src/lib/sceneCardLinks");
    initSceneCardLinks();
    await vi.advanceTimersByTimeAsync(2500);
    const before = hub.cardPuts.length;
    hub.failCards = true;
    await markCardGenerationsRemoved("s", "c1", ["g0"]); // 사용자가 비움 — 실패 → 30초 재시도
    expect(hub.cardPuts).toHaveLength(before + 1);
    hub.failCards = false;
    updateSceneCamera(null, "s", cam(4));
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(5000);
    expect(hub.cardPuts).toHaveLength(before + 1); // 카메라만 — 훑기 예약 없음
    await vi.advanceTimersByTimeAsync(26_000);
    const sent = hub.cardPuts.slice(before + 1);
    expect(sent.some((body) => body.removed?.some((l: { generation_id: string }) => l.generation_id === "g0"))).toBe(true);
  });
});

describe("숨김 동기화 실패 → 백업의 기존 재시도 → 허브에 최신 카메라(실제 공책 동기화)", () => {
  it("카메라만 확정은 동기화를 예약하지 않고, 숨김 동기화가 retry 면 30초 뒤 다시 돌아 최신 카메라가 도착한다", async () => {
    hub = new MiniHub();
    setHubFeatures(["scene_writer_v1"]);
    const token = { account: "local", token: "token", generation: "g1" };
    setSceneNotebookTokenProvider(() => token);
    const a = scene("a");
    hub.save(a);
    await writeScenesStore({ [bucket]: [] });
    await joinSceneNotebook("local", hub.book, hub.history, { [bucket]: {
      scenes: [a], bases: { a: { history: hub.history, rev: hub.rows.get("a")!.base.rev, hash: hub.rows.get("a")!.base.hash } },
      order: { history: hub.history, rev: hub.rev },
    } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { initSceneBackup } = await import("../src/lib/sceneBackup");
      await initSceneBackup();
      await vi.advanceTimersByTimeAsync(12_000); // 첫 맞춤과 그 뒤 예약이 끝나게
      const uploads = hub.uploads;
      updateSceneCamera(null, "a", cam(3));
      await settleSceneStoreForTest();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(hub.uploads).toBe(uploads); // 카메라만 — 백업이 공책 동기화를 예약하지 않는다
      hub.failUploads = true;
      const hidden = syncSceneNotebook({ fresh: true }); // 숨김 처리기가 부르는 그 호출
      await vi.advanceTimersByTimeAsync(1000);
      expect((await hidden).status).toBe("retry");
      expect(JSON.parse(hub.rows.get("a")!.data).camera).toBeUndefined();
      hub.failUploads = false;
      await vi.advanceTimersByTimeAsync(29_000);
      expect(JSON.parse(hub.rows.get("a")!.data).camera).toBeUndefined(); // 기한 전
      await vi.advanceTimersByTimeAsync(2_000);
      expect(JSON.parse(hub.rows.get("a")!.data).camera).toEqual(cam(3));
    } finally {
      setSceneNotebookTokenProvider(() => null);
    }
  });
});
