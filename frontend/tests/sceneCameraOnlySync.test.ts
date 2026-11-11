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
import { joinSceneNotebook, setSceneNotebookTokenProvider, subscribeNotebookSyncResult, syncSceneNotebook } from "../src/lib/sceneNotebook";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Row = { id: string; data: string; deleted_at: string | null; base: { history_id: string; rev: number; hash: string } };
/** 공책 허브 흉내 — 받기(notebook?)·올리기(backup)만. 올리기 실패는 상태 없는 연결 실패로 낸다(공책이 재시도로 본다). */
class MiniHub {
  history = "h1"; book = "book1"; rows = new Map<string, Row>(); order: string[] = []; rev = 1; uploads = 0; failUploads = false;
  hold: Promise<void> | null = null;
  cardPuts: any[] = []; links: any[] = []; failCards = false; // 카드-생성물 소속(/api/scenes/cards)
  save(s: Scene) {
    const data = JSON.stringify(s), prior = this.rows.get(s.id);
    const row: Row = { id: s.id, data, deleted_at: null, base: { history_id: this.history, rev: (prior?.base.rev ?? 0) + 1, hash: hash(data) } };
    this.rows.set(s.id, row); if (!this.order.includes(s.id)) this.order.push(s.id); return row;
  }
  handle(path: string, body: any, method?: string): any {
    if (path.startsWith("/api/scenes/cards")) {
      if (method !== "PUT") return { items: this.links };
      this.cardPuts.push(body);
      if (this.failCards) throw new TypeError("network down");
      this.links.push(...body.backfill, ...body.added, ...body.explicit); // 받은 소속을 기억한다 — 다시 읽어도 같은 백필을 또 보내지 않게
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
  jsonFetch: async (path: string, init?: RequestInit) => {
    const at = hub; // 올리기 응답을 잠시 붙잡는다(진행 중 요청을 실제로 공유시키려고) — 붙잡힌 요청은 그 허브로 끝난다
    if (path.endsWith("/backup") && at.hold) await at.hold;
    return structuredClone(at.handle(path, init?.body ? JSON.parse(String(init.body)) : undefined, init?.method));
  },
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

  it("저장소가 오래 실패해도 '편집 → 화면 이동' 150번이 대기 상한(200)에 닿지 않는다 — 카메라가 바로 앞 내용 연산에 합쳐진다", async () => {
    failSceneStoreWritesForTest(true);
    const refused: number[] = [];
    for (let i = 1; i <= 150; i++) {
      if (!updateScene(null, "s", { name: `edit ${i}` }).ok) refused.push(i);
      if (!updateSceneCamera(null, "s", cam(i)).ok) refused.push(-i);
    }
    expect(refused).toEqual([]); // 합치지 않으면 연산 300개 — 100번째쯤부터 거절된다
    expect(await settleSceneStoreForTest()).toBe(false);
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect([saved()?.name, saved()?.camera]).toEqual(["edit 150", cam(150)]);
    expect(infos).toEqual([false]); // 내용이 섞인 확정
  });

  it("C1 → 옛 카메라를 실은 내용 패치 → C2 — 뒤에 온 C2 가 남는다(실패 중에도 순서 그대로)", async () => {
    failSceneStoreWritesForTest(true);
    updateSceneCamera(null, "s", cam(1));
    updateScene(null, "s", { name: "with old camera", camera: cam(1) });
    updateSceneCamera(null, "s", cam(2));
    updateScene(null, "t", { name: "other scene" }); // 다른 씬 연산이 끼면 다음 카메라는 다시 카메라 슬롯
    updateSceneCamera(null, "s", cam(3));
    expect(await settleSceneStoreForTest()).toBe(false);
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect([saved()?.name, saved()?.camera, saved("t")?.name]).toEqual(["with old camera", cam(3), "other scene"]);
  });

  it("실패한 저장이 다시 도는 사이(떠난 연산) 온 편집·카메라도 복구 뒤 마지막 값으로 남는다", async () => {
    failSceneStoreWritesForTest(true);
    updateScene(null, "s", { name: "first" });
    updateSceneCamera(null, "s", cam(1));
    expect(await settleSceneStoreForTest()).toBe(false);
    delaySceneStoreWritesForTest(30);
    const retry = settleSceneStoreForTest(); // 앞 연산이 저장으로 떠난다(여전히 실패)
    await new Promise((resolve) => setTimeout(resolve, 5));
    updateScene(null, "s", { name: "second" }); // 떠난 연산과는 합치지 않는다 — 새 연산
    updateSceneCamera(null, "s", cam(2));
    expect(await retry).toBe(false);
    delaySceneStoreWritesForTest(0);
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect([saved()?.name, saved()?.camera]).toEqual(["second", cam(2)]);
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
    // 앞 시험에 기대지 않는다 — 허브·씬·첫 백필을 여기서 만든다(단독 실행에서도 같은 결과).
    hub = new MiniHub();
    await writeScenesStore({ [bucket]: [{ ...scene("r"), cards: [{ id: "rc", kind: "generation", x: 0, y: 0, genIds: ["g9"] }] } as unknown as Scene] });
    await settleSceneStoreForTest();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { initSceneCardLinks, markCardGenerationsRemoved, refreshSceneCardLinks } = await import("../src/lib/sceneCardLinks");
    initSceneCardLinks();
    await refreshSceneCardLinks(); // 이 시험의 허브로 서버 소속을 다시 읽는다(앞 시험이 읽어 둔 것을 버린다)
    await vi.advanceTimersByTimeAsync(5000); // 이 씬의 첫 백필(rc:g9)이 끝나게
    expect(hub.cardPuts.flatMap((body) => body.backfill.map((l: { card_id: string; generation_id: string }) => `${l.card_id}:${l.generation_id}`))).toEqual(["rc:g9"]);
    const before = hub.cardPuts.length;
    hub.failCards = true;
    await markCardGenerationsRemoved("r", "rc", ["g0"]); // 사용자가 비움 — 실패 → 30초 재시도
    expect(hub.cardPuts).toHaveLength(before + 1);
    hub.failCards = false;
    updateSceneCamera(null, "r", cam(4));
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(5000);
    expect(hub.cardPuts).toHaveLength(before + 1); // 카메라만 — 훑기 예약 없음
    await vi.advanceTimersByTimeAsync(24_000);
    expect(hub.cardPuts).toHaveLength(before + 1); // 29초 — 원래 기한(30초) 전
    await vi.advanceTimersByTimeAsync(2_000);
    const sent = hub.cardPuts.slice(before + 1);
    expect(sent).toHaveLength(1); // 기한에 한 번
    expect(sent[0].removed).toEqual([expect.objectContaining({ scene_id: "r", card_id: "rc", generation_id: "g0" })]);
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

  // 실제 진행 중 요청 공유 — 바깥(숨김·넘기기)이 시작한 동기화가 도는 사이 백업의 syncNow 가 같은 요청에 올라탄다.
  //  outcomes = 올리기 차례별 결과(붙잡은 첫 올리기, fresh 후속 올리기). 끝난 뒤 30초 재시도가 몇 번 도는지 본다.
  const sharedRound = async (firstFails: boolean, freshFails: boolean | null): Promise<{ afterRound: number; retried: number }> => {
    hub = new MiniHub();
    setHubFeatures(["scene_writer_v1"]);
    setSceneNotebookTokenProvider(() => ({ account: "local", token: "token", generation: "g1" }));
    const a = scene("a");
    hub.save(a);
    await writeScenesStore({ [bucket]: [] });
    await joinSceneNotebook("local", hub.book, hub.history, { [bucket]: {
      scenes: [a], bases: { a: { history: hub.history, rev: hub.rows.get("a")!.base.rev, hash: hub.rows.get("a")!.base.hash } },
      order: { history: hub.history, rev: hub.rev },
    } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { initSceneBackup } = await import("../src/lib/sceneBackup");
    await initSceneBackup();
    await vi.advanceTimersByTimeAsync(70_000); // 앞 시험의 예약·재시도와 첫 맞춤이 끝나게
    let release = () => {};
    hub.hold = new Promise<void>((resolve) => { release = resolve; });
    // 바퀴(동기화 한 번) = 결과 알림 한 번. 바퀴가 끝나는 그 자리에서 다음 바퀴의 올리기 성패를 정한다(fresh 후속은 곧바로 이어 돈다).
    const plan = [...(freshFails === null ? [] : [freshFails]), false]; // 마지막 = 재시도 바퀴(성공)
    const rounds: string[] = [];
    const offResult = subscribeNotebookSyncResult((result) => { rounds.push(result.status); hub.failUploads = plan.shift() ?? false; });
    try {
      hub.failUploads = firstFails;
      updateScene(null, "a", { name: "edited" }); // 올릴 것 — 2초 뒤 백업의 syncNow 가 예약된다
      await settleSceneStoreForTest();
      const outside = syncSceneNotebook(); // 바깥이 먼저 시작 — 올리기에서 붙잡힌다
      await vi.advanceTimersByTimeAsync(2500); // 백업의 syncNow 가 같은 진행 중 요청에 올라탄다
      expect(rounds).toEqual([]); // 아직 붙잡힌 한 바퀴뿐
      const fresh = freshFails === null ? null : syncSceneNotebook({ fresh: true }); // 숨김 처리기의 후속 요청
      hub.hold = null;
      release();
      await vi.advanceTimersByTimeAsync(1000);
      expect((await outside).status).toBe(firstFails ? "retry" : "ready");
      if (fresh) expect((await fresh).status).toBe(freshFails ? "retry" : "ready");
      const afterRound = rounds.length;
      await vi.advanceTimersByTimeAsync(28_000);
      expect(rounds.length).toBe(afterRound); // 기한(30초) 전
      await vi.advanceTimersByTimeAsync(63_000);
      return { afterRound, retried: rounds.length - afterRound };
    } finally {
      offResult();
      setSceneNotebookTokenProvider(() => null);
    }
  };

  it("바깥 동기화와 백업이 같은 진행 중 요청을 공유해 실패 → 올리기 한 번, 30초 재시도 하나", async () => {
    expect(await sharedRound(true, null)).toEqual({ afterRound: 1, retried: 1 });
  });

  it("공유한 요청이 실패하고 fresh 후속 요청도 실패 → 재시도는 여전히 하나(기한 그대로)", async () => {
    expect(await sharedRound(true, true)).toEqual({ afterRound: 2, retried: 1 });
  });

  it("공유한 요청이 실패했지만 fresh 후속 요청이 성공 → 걸린 재시도를 풀어 다시 올리지 않는다", async () => {
    expect(await sharedRound(true, false)).toEqual({ afterRound: 2, retried: 0 });
  });
});
