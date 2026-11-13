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
  applySceneOp, delaySceneStoreWritesForTest, failSceneStoreWritesForTest, markSceneWritesHanded, sceneStoreLoadForTest, setSceneLeaseGeneration, setSceneWriteGate,
  settleSceneStoreForTest, writeSceneStoreAsOtherWindowForTest, writeScenesStore,
} from "../src/lib/sceneStore";
import { listPersistedScenes, pendingSceneWritesConfirmed, subscribeScenesPersisted, updateScene, updateSceneCamera, type Scene, type ScenesByProject } from "../src/lib/scenes";
import { joinSceneNotebook, setSceneNotebookTokenProvider, subscribeNotebookSyncResult, syncSceneNotebook } from "../src/lib/sceneNotebook";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Row = { id: string; data: string; deleted_at: string | null; base: { history_id: string; rev: number; hash: string } };
/** 공책 허브 흉내 — 받기(notebook?)·올리기(backup)만. 올리기 실패는 상태 없는 연결 실패로 낸다(공책이 재시도로 본다). */
class MiniHub {
  history = "h1"; book = "book1"; rows = new Map<string, Row>(); order: string[] = []; rev = 1; uploads = 0; failUploads = false;
  hold: Promise<void> | null = null;
  cardPuts: any[] = []; links = new Map<string, any>(); failCards = false; // 카드-생성물 소속(/api/scenes/cards)
  save(s: Scene) {
    const data = JSON.stringify(s), prior = this.rows.get(s.id);
    const row: Row = { id: s.id, data, deleted_at: null, base: { history_id: this.history, rev: (prior?.base.rev ?? 0) + 1, hash: hash(data) } };
    this.rows.set(s.id, row); if (!this.order.includes(s.id)) this.order.push(s.id); return row;
  }
  handle(path: string, body: any, method?: string): any {
    if (path.startsWith("/api/scenes/cards")) {
      if (method !== "PUT") return { restore_generation: "restore-1", items: [...this.links.values()] };
      this.cardPuts.push(body);
      if (this.failCards) throw new TypeError("network down");
      // 서버(repo/scene_cards)와 같은 규칙 — 소속 키마다 한 줄. backfill·added = 없을 때만 넣는다(뺀 표시를 풀지 않는다) ·
      //  explicit = 넣거나 뺀 표시를 푼다 · removed = 뺀 표시(줄은 남는다).
      const keyOf = (l: { scene_id: string; card_id: string; generation_id: string }) => `${l.scene_id}\u0000${l.card_id}\u0000${l.generation_id}`;
      for (const l of [...(body.backfill ?? []), ...(body.added ?? [])]) if (!this.links.has(keyOf(l))) this.links.set(keyOf(l), { ...l, removed_at: null });
      for (const l of body.explicit ?? []) this.links.set(keyOf(l), { ...l, removed_at: null });
      for (const l of body.removed ?? []) this.links.set(keyOf(l), { ...l, removed_at: "2026-11-12T00:00:00Z" });
      return { ok: true, restore_generation: "restore-1" };
    }
    if (path.includes("notebook?")) return { restore_generation: "restore-1", notebook_id: this.book, history_id: this.history, items: [...this.rows.values()], order: { ids: this.order, rev: this.rev, history_id: this.history } };
    if (path.endsWith("/backup")) {
      this.uploads++;
      if (this.failUploads) throw new TypeError("network down");
      const results = body.upserts.map((up: any) => {
        const old = this.rows.get(up.id);
        const saved = old && old.base.hash === hash(up.data) ? old : this.save(JSON.parse(up.data));
        return { id: up.id, status: saved === old ? "same" : "saved", target_id: saved.id, base: saved.base };
      });
      return { restore_generation: "restore-1", history_id: this.history, results, deletes: [], order: { ids: this.order, rev: this.rev, history_id: this.history }, mcp_done: [] };
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

  it("내용 편집이 저장으로 떠난 뒤 온 카메라 기록은 합쳐지지 않으니 카메라 슬롯에 남아 참(편집 확정 거짓 → 카메라 확정 참)", async () => {
    delaySceneStoreWritesForTest(30);
    updateScene(null, "s", { name: "saving" });
    const first = settleSceneStoreForTest();
    await new Promise((resolve) => setTimeout(resolve, 5)); // 편집이 쓰는 중(떠난 연산)
    updateSceneCamera(null, "s", cam(6));
    await first;
    delaySceneStoreWritesForTest(0);
    await settleSceneStoreForTest();
    expect(infos).toEqual([false, true]);
    expect([saved()?.name, saved()?.camera]).toEqual(["saving", cam(6)]);
  });

  // ── 실패한 저장이 되풀이될 때(저장으로 떠난 사이 새 입력) 대기 연산이 쌓이지 않는다(L2) ──
  it("실패하는 저장 도중 편집·카메라가 들어오기를 250번 되풀이해도 대기 연산이 쌓이지 않고, 복구 뒤 마지막 값이 남는다", async () => {
    failSceneStoreWritesForTest(true);
    delaySceneStoreWritesForTest(2);
    updateScene(null, "s", { name: "start" });
    let most = 0;
    const refused: number[] = [];
    for (let i = 1; i <= 250; i++) {
      const attempt = settleSceneStoreForTest(); // 대기 연산이 저장으로 떠난다(실패할 것)
      await Promise.resolve();
      if (!updateScene(null, "s", { name: `edit ${i}` }).ok) refused.push(i); // 떠난 연산엔 못 합친다 — 새 연산
      if (!updateSceneCamera(null, "s", cam(i)).ok) refused.push(-i);
      expect(await attempt).toBe(false);
      most = Math.max(most, sceneStoreLoadForTest().pending);
    }
    expect(refused).toEqual([]);
    expect(most).toBeLessThanOrEqual(2); // 실패가 확정되면 이웃한 같은 씬 패치를 다시 하나로 — 합치지 않으면 250개 넘게 쌓여 200 에서 거절된다
    delaySceneStoreWritesForTest(0);
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect([saved()?.name, saved()?.camera]).toEqual(["edit 250", cam(250)]);
    expect(infos).toEqual([false]);
  }, 30_000);

  it("실패 뒤 합쳐진 연산을 기다리던 쪽(끝까지 기다리는 약속)은 복구된 저장에 함께 답을 받는다", async () => {
    failSceneStoreWritesForTest(true);
    delaySceneStoreWritesForTest(10);
    updateScene(null, "s", { name: "first" });
    const attempt = settleSceneStoreForTest();
    await Promise.resolve();
    updateScene(null, "s", { name: "second" }); // 떠난 연산 뒤 — 새 연산
    const durable = pendingSceneWritesConfirmed(); // 두 연산 모두를 끝까지 기다린다
    let answered: boolean | null = null;
    void durable.then((ok) => { answered = ok; });
    expect(await attempt).toBe(false);
    expect(sceneStoreLoadForTest().pending).toBe(1); // 합쳐졌다
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(answered).toBeNull(); // 일시 실패에는 답하지 않는다
    delaySceneStoreWritesForTest(0);
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(await durable).toBe(true);
    expect(saved()?.name).toBe("second");
  });

  it("실패 뒤 줄이기는 경계를 넘지 않는다 — 다른 씬·확정 전용 연산이 사이에 있으면 그대로 두고 순서대로 재생한다", async () => {
    failSceneStoreWritesForTest(true);
    updateScene(null, "s", { name: "s1" });
    updateScene(null, "t", { name: "t1" });
    updateScene(null, "s", { name: "s2", camera: cam(1) });
    applySceneOp((all: ScenesByProject) => { all[bucket] = (all[bucket] ?? []).map((x) => (x.id === "s" ? { ...x, name: "confirmed only" } : x)); return { write: true, value: null }; }, { confirmedOnly: true });
    updateSceneCamera(null, "s", cam(2));
    updateScene(null, "s", { name: "s3" });
    expect(await settleSceneStoreForTest()).toBe(false);
    // s1 | t1 | s2 | (확정 전용) | 카메라+s3 → 맨 뒤 둘만 이웃한 같은 씬 패치
    expect(sceneStoreLoadForTest().pending).toBe(5);
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect([saved()?.name, saved()?.camera, saved("t")?.name]).toEqual(["s3", cam(2), "t1"]);
    expect(infos).toEqual([false]);
  });

  it("실패 뒤 줄이기는 확정 전용 연산을 합치지 않는다 — 같은 대상의 합칠 수 있는 꼴이어도", async () => {
    failSceneStoreWritesForTest(true);
    const patchOp = (name: string, confirmedOnly: boolean) => applySceneOp(
      (all: ScenesByProject) => { all[bucket] = (all[bucket] ?? []).map((x) => (x.id === "s" ? { ...x, name } : x)); return { write: true, value: null }; },
      { confirmedOnly, merge: {
        slot: `test\u0000${confirmedOnly ? "confirmed" : "plain"}`, family: "test-family", patch: { name },
        join: (a: { name: string }, b: { name: string }) => ({ ...a, ...b }),
        replay: (all: ScenesByProject, p: { name: string }) => { all[bucket] = (all[bucket] ?? []).map((x) => (x.id === "s" ? { ...x, ...p } : x)); },
      } },
    );
    patchOp("plain 1", false);
    patchOp("confirmed only", true);
    patchOp("plain 2", false);
    expect(await settleSceneStoreForTest()).toBe(false);
    expect(sceneStoreLoadForTest().pending).toBe(3); // 확정 전용을 사이에 두고 아무것도 합쳐지지 않는다
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(saved()?.name).toBe("plain 2");
  });

  it.each(["lease", "handover"] as const)("실패 뒤 줄이기는 %s 경계를 넘지 않고 같은 쪽 이웃만 합친다", async (boundary) => {
    failSceneStoreWritesForTest(true);
    setSceneLeaseGeneration("local", "first");
    const patchOp = (name: string, handover = false) => applySceneOp(
      (all: ScenesByProject) => { all[bucket] = all[bucket].map((s) => s.id === "s" ? { ...s, name } : s); return { write: true, value: null }; },
      { handover, merge: {
        slot: `boundary\u0000${name}`, family: "boundary-family", patch: { name },
        join: (a: { name: string }, b: { name: string }) => ({ ...a, ...b }),
        replay: (all: ScenesByProject, patch: { name: string }) => { all[bucket] = all[bucket].map((s) => s.id === "s" ? { ...s, ...patch } : s); },
      } },
    );
    patchOp("first");
    if (boundary === "lease") setSceneLeaseGeneration("local", "second");
    patchOp("boundary", boundary === "handover");
    patchOp("last");
    const durable = pendingSceneWritesConfirmed();
    expect(await settleSceneStoreForTest()).toBe(false);
    expect(sceneStoreLoadForTest().pending).toBe(boundary === "lease" ? 2 : 3);
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(await durable).toBe(true);
    expect(saved()?.name).toBe("last");
  });

  it("실패 뒤 카메라 연산에 내용이 합쳐지면 그 묶음은 '카메라만'이 아니다(내용 슬롯을 따른다)", async () => {
    failSceneStoreWritesForTest(true);
    delaySceneStoreWritesForTest(10);
    updateSceneCamera(null, "s", cam(1));
    const attempt = settleSceneStoreForTest();
    await Promise.resolve();
    updateScene(null, "s", { name: "content after camera" }); // 떠난 카메라 뒤 — 새 내용 연산
    expect(await attempt).toBe(false);
    expect(sceneStoreLoadForTest().pending).toBe(1); // 카메라 + 내용이 한 연산으로
    delaySceneStoreWritesForTest(0);
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(infos).toEqual([false]);
    expect([saved()?.name, saved()?.camera]).toEqual(["content after camera", cam(1)]);
  });

  it("실패 뒤 카메라 연산끼리만 합쳐진 묶음은 복구 때 여전히 '카메라만'", async () => {
    failSceneStoreWritesForTest(true);
    delaySceneStoreWritesForTest(10);
    updateSceneCamera(null, "s", cam(1));
    const attempt = settleSceneStoreForTest();
    await Promise.resolve();
    updateSceneCamera(null, "s", cam(2)); // 떠난 카메라 뒤 — 새 카메라 연산
    expect(await attempt).toBe(false);
    expect(sceneStoreLoadForTest().pending).toBe(1);
    delaySceneStoreWritesForTest(0);
    failSceneStoreWritesForTest(false);
    expect(await settleSceneStoreForTest()).toBe(true);
    expect(infos).toEqual([true]);
    expect(saved()?.camera).toEqual(cam(2));
  });

  it.each([["성공으로", false], ["실패로", true]])(
    "앞 저장이 %s 끝나도, 도는 동안 들어온 입력은 따로 재촉하지 않아도(자동 예약만으로) 저장된다",
    async (_name, firstFails) => {
      delaySceneStoreWritesForTest(30);
      if (firstFails) failSceneStoreWritesForTest(true);
      updateScene(null, "s", { name: "first" });
      await Promise.resolve();
      await Promise.resolve(); // 첫 저장이 출발
      for (let i = 1; i <= 50; i++) {
        updateScene(null, "s", { name: `edit ${i}` });
        await Promise.resolve();
      }
      await new Promise((resolve) => setTimeout(resolve, 200)); // 첫 저장과 기다리던 저장이 끝난다(실패 경우 둘 다 실패)
      failSceneStoreWritesForTest(false);
      delaySceneStoreWritesForTest(0);
      // settleSceneStoreForTest 를 부르지 않는다 — 그 함수는 저장을 직접 건다. 여기서는 '끝난 뒤 다음 저장'·'실패 뒤 재시도 타이머'만 본다.
      await vi.waitFor(() => expect(saved()?.name).toBe("edit 50"), { timeout: 6000, interval: 50 });
      expect(sceneStoreLoadForTest().pending).toBe(0);
    },
    10_000,
  );

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
  async function adoptCurrentScenes() {
    setHubFeatures(["scene_writer_v1"]);
    const scenes = listPersistedScenes(null);
    await joinSceneNotebook("local", hub.book, hub.history, { [bucket]: { scenes, bases: Object.fromEntries(scenes.map((s) => [s.id, { history: hub.history, rev: 1, hash: hash(JSON.stringify(s)) }])), order: { history: hub.history, rev: 1 } } }, undefined, "restore-1");
    localStorage.setItem("mvhub.cardRecovery:local", JSON.stringify({ generation: "restore-1", candidates: [] }));
  }
  it("카메라만 → 2초 뒤 훑기 없음(걸려 있던 실패 재시도는 기한에 그대로) · 내용 확정 → 2초 뒤 훑기", async () => {
    hub = new MiniHub();
    await writeScenesStore({ [bucket]: [{ ...scene("s"), cards: [{ id: "c1", kind: "generation", x: 0, y: 0, genIds: ["g1"] }] } as unknown as Scene] });
    await settleSceneStoreForTest();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const keys = (body: any) => body.backfill.map((l: { card_id: string; generation_id: string }) => `${l.card_id}:${l.generation_id}`);
    const { initSceneCardLinks } = await import("../src/lib/sceneCardLinks");
    await adoptCurrentScenes();
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
    await adoptCurrentScenes();
    initSceneCardLinks();
    await refreshSceneCardLinks(); // 이 시험의 허브로 서버 소속을 다시 읽는다(앞 시험이 읽어 둔 것을 버린다)
    await vi.advanceTimersByTimeAsync(5000); // 이 씬의 첫 백필(rc:g9)이 끝나게
    expect(hub.cardPuts.flatMap((body) => body.backfill.map((l: { card_id: string; generation_id: string }) => `${l.card_id}:${l.generation_id}`))).toEqual(["rc:g9"]);
    const before = hub.cardPuts.length;
    hub.failCards = true;
    await markCardGenerationsRemoved("r", "rc", ["g9"]); // 사용자가 그 생성물을 카드에서 뺌(허브에 있는 연결) — 실패 → 30초 재시도
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
    expect(sent[0].removed).toEqual([expect.objectContaining({ scene_id: "r", card_id: "rc", generation_id: "g9" })]);
    expect([...hub.links.values()]).toEqual([expect.objectContaining({ card_id: "rc", generation_id: "g9", removed_at: expect.any(String) })]); // 허브에 뺀 표시
    // 다시 읽고 내용 저장으로 훑어도 그 연결이 되살아나지 않는다(뺀 표시는 백필이 풀지 못한다)
    await refreshSceneCardLinks();
    updateScene(null, "r", { name: "renamed" });
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(5000);
    expect(hub.cardPuts.slice(before + 2).flatMap((body) => body.backfill)).toEqual([]);
    expect([...hub.links.values()][0].removed_at).not.toBeNull();
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
    } }, undefined, "restore-1");
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
  const sharedRound = async (firstFails: boolean, freshFails: boolean | null): Promise<{ afterRound: number; retried: number; byDeadline: number }> => {
    hub = new MiniHub();
    setHubFeatures(["scene_writer_v1"]);
    setSceneNotebookTokenProvider(() => ({ account: "local", token: "token", generation: "g1" }));
    const a = scene("a");
    hub.save(a);
    await writeScenesStore({ [bucket]: [] });
    await joinSceneNotebook("local", hub.book, hub.history, { [bucket]: {
      scenes: [a], bases: { a: { history: hub.history, rev: hub.rows.get("a")!.base.rev, hash: hub.rows.get("a")!.base.hash } },
      order: { history: hub.history, rev: hub.rev },
    } }, undefined, "restore-1");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { initSceneBackup } = await import("../src/lib/sceneBackup");
    await initSceneBackup();
    await vi.advanceTimersByTimeAsync(70_000); // 앞 시험의 예약·재시도와 첫 맞춤이 끝나게
    let release = () => {};
    hub.hold = new Promise<void>((resolve) => { release = resolve; });
    // 바퀴(동기화 한 번) = 결과 알림 한 번. 바퀴가 끝나는 그 자리에서 다음 바퀴의 올리기 성패를 정한다(fresh 후속은 곧바로 이어 돈다).
    const plan = [...(freshFails === null ? [] : [freshFails]), false]; // 마지막 = 재시도 바퀴(성공)
    const rounds: string[] = [];
    // fresh 후속 바퀴는 올리기에서 10초 붙잡아 늦게 끝낸다 — 재시도 기한이 '첫 실패 뒤 30초'인지 '후속 실패 뒤 30초'인지 가르려고
    let releaseFresh = () => {};
    const offResult = subscribeNotebookSyncResult((result) => {
      rounds.push(result.status);
      hub.failUploads = plan.shift() ?? false;
      if (rounds.length === 1 && freshFails !== null) hub.hold = new Promise<void>((resolve) => { releaseFresh = resolve; });
    });
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
      await vi.advanceTimersByTimeAsync(1000); // 첫 바퀴 끝(실패 시각 = 풀고 0~1초)
      expect((await outside).status).toBe(firstFails ? "retry" : "ready");
      let elapsed = 1000;
      if (fresh) {
        expect(rounds).toHaveLength(1); // 후속 바퀴는 아직 붙잡혀 있다
        await vi.advanceTimersByTimeAsync(10_000);
        hub.hold = null;
        releaseFresh();
        await vi.advanceTimersByTimeAsync(500);
        elapsed += 10_500;
        expect((await fresh).status).toBe(freshFails ? "retry" : "ready");
      }
      const afterRound = rounds.length;
      await vi.advanceTimersByTimeAsync(28_500 - elapsed);
      expect(rounds.length).toBe(afterRound); // 첫 실패 뒤 28.5초 — 기한(30초) 전
      await vi.advanceTimersByTimeAsync(2_700);
      const byDeadline = rounds.length - afterRound; // 첫 실패 뒤 31.2초 — 기한이 후속 실패로 미뤄졌다면(41초) 아직 0
      await vi.advanceTimersByTimeAsync(63_000);
      return { afterRound, retried: rounds.length - afterRound, byDeadline };
    } finally {
      offResult();
      setSceneNotebookTokenProvider(() => null);
    }
  };

  it("바깥 동기화와 백업이 같은 진행 중 요청을 공유해 실패 → 올리기 한 번, 30초 재시도 하나", async () => {
    expect(await sharedRound(true, null)).toEqual({ afterRound: 1, retried: 1, byDeadline: 1 });
  });

  it("공유한 요청이 실패하고 10초 뒤 fresh 후속 요청도 실패 → 재시도는 여전히 하나, 첫 실패 뒤 30초에 돈다(기한을 미루지 않는다)", async () => {
    expect(await sharedRound(true, true)).toEqual({ afterRound: 2, retried: 1, byDeadline: 1 });
  });

  it("공유한 요청이 실패했지만 fresh 후속 요청이 성공 → 걸린 재시도를 풀어 다시 올리지 않는다", async () => {
    expect(await sharedRound(true, false)).toEqual({ afterRound: 2, retried: 0, byDeadline: 0 });
  });
});
