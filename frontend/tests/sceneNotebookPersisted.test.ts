// 공책 자기 재예약 끊기(E2, docs/status/캔버스_카메라저장묶기_2026-11-11.md) — 공책이 내부 기준·영수증(b·d·r·ob·nj)과 진행 기록(ns·nw)만
//  정리한 확정은 저장 성공으로 알리되 '공책 내부 정리만' 표시를 싣고, sceneBackup 은 그때 다음 공책 동기화를 다시 예약하지 않는다.
//  로컬 편집·다른 창 확정·실제 씬/순서 변화·충돌·보관본은 지금처럼 예약한다. 저장소는 메모리 어댑터(실제 IDB 다중 창은 격리 실측 몫).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHubFeatures } from "../src/lib/hubFeatures";
import {
  applySceneOp, failSceneStoreWritesForTest, notebookKey as key, sceneNotebookTransaction, setSceneWriteGate,
  settleSceneStoreForTest, writeSceneStoreAsOtherWindowForTest, writeScenesStore,
} from "../src/lib/sceneStore";
import { isSceneSaveFailing, subscribeScenesPersisted, updateSceneCamera, type Scene, type ScenesByProject } from "../src/lib/scenes";
import { setAccountScope } from "../src/lib/accountScope";

// 숨김·넘기기가 시작한 공책 동기화의 결과를 흉내 내려고 결과 구독자를 잡아 둔다(E4)
const resultFns = vi.hoisted(() => [] as Array<(result: unknown, account: string) => void>);
vi.mock("../src/lib/sceneNotebook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sceneNotebook")>()),
  syncSceneNotebook: vi.fn(),
  subscribeNotebookSyncResult: (fn: (result: unknown, account: string) => void) => { resultFns.push(fn); return () => {}; },
}));
// 공책 기능이 꺼진 뒤 옛 백업 PUT 이 나가는지 센다(나가면 안 되는 시험)
const http = vi.hoisted(() => ({ jsonFetch: vi.fn(async () => { throw new Error("no network in test"); }) }));
vi.mock("../src/lib/http", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/http")>()), jsonFetch: http.jsonFetch }));
import { syncSceneNotebook } from "../src/lib/sceneNotebook";
import { getSceneBackupSkippedIds, initSceneBackup, MAX_SCENE_BYTES } from "../src/lib/sceneBackup";

const bucket = "local::_none";
const scene = (id = "s", name = id): Scene => ({ id, name, cards: [], edges: [], created_at: 1 });
const edit = (name: string) => applySceneOp((all: ScenesByProject) => { all[bucket] = [scene("s", name)]; return { write: true, value: null }; });
/** 공책 트랜잭션 — 진행 기록·기준 메타만 고치는 결정(씬은 그대로) */
const notebook = (decide: (all: ScenesByProject, meta: Record<string, unknown>) => void) =>
  sceneNotebookTransaction([key("ns", "local"), key("nw", "local")], (all, meta) => { decide(all, meta); return { value: null, changed: true }; });
const progress = (id: string) => ({ id, history: "h", notebookId: "n", requests: [] });

let infos: boolean[] = [];
let off = () => {};
beforeEach(async () => {
  setHubFeatures(["scene_writer_v1"]);
  setSceneWriteGate(() => false);
  await writeScenesStore({ [bucket]: [scene()] });
  await settleSceneStoreForTest();
  infos = [];
  off = subscribeScenesPersisted(({ notebookMetaOnly }) => infos.push(notebookMetaOnly));
});
afterEach(async () => {
  off();
  failSceneStoreWritesForTest(false);
  await settleSceneStoreForTest();
  setHubFeatures([]);
});

describe("확정 통지의 '공책 내부 정리만' 표시", () => {
  it("진행 기록 ns·nw 각각 만들기·고치기·지우기는 표시 참", async () => {
    for (const name of ["ns", "nw"]) {
      await notebook((_all, meta) => { meta[key(name, "local")] = progress("p1"); });
      await notebook((_all, meta) => { meta[key(name, "local")] = progress("p2"); });
      await notebook((_all, meta) => { delete meta[key(name, "local")]; });
    }
    expect(infos).toEqual([true, true, true, true, true, true]);
  });

  it("업로드 완료 — 기준 b·순서 ob 갱신 + nw 지우기는 표시 참", async () => {
    await notebook((_all, meta) => { meta[key("nw", "local")] = progress("p1"); });
    await notebook((_all, meta) => {
      meta[key("b", bucket, "s")] = { history: "h", rev: 2, hash: "x" };
      meta[key("ob", bucket)] = { base: { history: "h", rev: 2 }, dirty: null };
      delete meta[key("nw", "local")];
    });
    expect(infos).toEqual([true, true]);
  });

  it("같은 공책 트랜잭션이 밀린 로컬 편집을 함께 확정하면 표시 거짓", async () => {
    edit("local edit"); // 아직 저장소에 안 간 연산 — 공책 트랜잭션이 함께 확정한다
    await notebook((_all, meta) => { meta[key("nw", "local")] = progress("p1"); });
    await settleSceneStoreForTest();
    expect(infos[0]).toBe(false);
  });

  it("같은 공책 트랜잭션이 로컬 삭제·되살리기 의도를 함께 확정하면 표시 거짓", async () => {
    applySceneOp((all: ScenesByProject) => { all[bucket] = []; return { write: true, value: null }; }); // 삭제
    applySceneOp((all: ScenesByProject) => { all[bucket] = [scene("s", "revived")]; return { write: true, value: null }; }); // 되살림
    await notebook((_all, meta) => { meta[key("nw", "local")] = progress("p1"); });
    await settleSceneStoreForTest();
    expect(infos[0]).toBe(false);
  });

  it("허브 수신으로 실제 씬이 바뀌면 표시 거짓", async () => {
    await notebook((all) => { all[bucket] = [scene("s", "from hub")]; });
    expect(infos).toEqual([false]);
  });

  it("충돌 목록·합류 보관본(na)을 쓰면 표시 거짓", async () => {
    await notebook((_all, meta) => { meta.conflicts = [{ id: "c" }]; });
    await notebook((_all, meta) => { meta[key("na", "local")] = { notebookId: "n", scenes: {} }; });
    expect(infos).toEqual([false, false]);
  });

  it("다른 창이 씬을 고친 뒤 이 창의 진행 기록 트랜잭션 — 다른 창 확정을 읽었으니 표시 거짓", async () => {
    writeSceneStoreAsOtherWindowForTest((all) => { all[bucket] = [scene("s", "other window")]; });
    await notebook((_all, meta) => { meta[key("nw", "local")] = progress("p1"); });
    expect(infos).toEqual([false]);
  });

  it("공책 메타 저장이 실패한 뒤 성공하면(표시 참) 저장 실패 표시가 풀린다", async () => {
    failSceneStoreWritesForTest(true);
    await notebook((_all, meta) => { meta[key("nw", "local")] = progress("p1"); });
    expect(isSceneSaveFailing()).toBe(true);
    failSceneStoreWritesForTest(false);
    await notebook((_all, meta) => { meta[key("nw", "local")] = progress("p2"); });
    expect(infos.at(-1)).toBe(true);
    expect(isSceneSaveFailing()).toBe(false);
  });
});

describe("sceneBackup — 공책 내부 정리만 한 확정은 다시 예약하지 않는다", () => {
  const sync = vi.mocked(syncSceneNotebook);
  const ok = { status: "ok", changed: false, visibleChanged: false } as never;
  let installed = false;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sync.mockReset();
    sync.mockResolvedValue(ok);
    if (!installed) {
      installed = true;
      await initSceneBackup(); // 공책 모드 — 한 번 맞추고 예약(구독은 모듈에 한 번만 걸린다)
    }
    await vi.advanceTimersByTimeAsync(12_000);
    sync.mockClear();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("로컬 편집 하나 → 동기화(진행 기록 쓰기 → 기준 갱신 + 진행 기록 지우기) → 추가 편집 없이 새 예약이 생기지 않는다", async () => {
    sync.mockImplementation(async () => {
      await notebook((_all, meta) => { meta[key("nw", "local")] = progress("p1"); });
      await notebook((_all, meta) => { meta[key("b", bucket, "s")] = { history: "h", rev: 2, hash: "x" }; delete meta[key("nw", "local")]; });
      return ok;
    });
    edit("edited");
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(2500);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sync).toHaveBeenCalledTimes(1); // 진행 기록 확정이 다시 예약하지 않는다(전에는 쓸 때마다 2초 뒤 또 돌았다)
  });

  it("동기화 중 새 로컬 편집은 다음 동기화에 반드시 포함된다", async () => {
    let first = true;
    sync.mockImplementation(async () => {
      if (first) {
        first = false;
        edit("edited while syncing");
        await settleSceneStoreForTest();
        await notebook((_all, meta) => { meta[key("nw", "local")] = progress("p1"); });
      }
      return ok;
    });
    edit("edited");
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(2500);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("동기화가 실패(retry)하면 추가 편집 없이 기존 재시도 타이머로 다시 돈다", async () => {
    sync.mockResolvedValueOnce({ status: "retry", changed: false, visibleChanged: false } as never);
    edit("edited");
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(2500);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sync.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// E4 — 공책 허브에서 이 창의 카메라만 바꾼 확정은 공책 동기화를 새로 예약하지 않는다. 숨김·넘기기가 시작한 동기화의 결과는 백업이 받아
//  실패면 기존 재시도 하나, 성공이면 그 재시도를 풀고 크기 상한을 다시 센다(docs/status/캔버스_카메라저장묶기_2026-11-11.md cameraonly).
describe("sceneBackup — 카메라만 바꾼 확정·바깥에서 시작한 공책 동기화(E4)", () => {
  const sync = vi.mocked(syncSceneNotebook);
  const ok = { status: "ready", changed: false, visibleChanged: false } as never;
  const retry = { status: "retry", changed: false, visibleChanged: false };
  const ready = { status: "ready", changed: false, visibleChanged: false };
  const outside = (result: unknown, account = "local") => resultFns.forEach((fn) => fn(result, account));
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sync.mockReset();
    sync.mockResolvedValue(ok);
    await initSceneBackup(); // 구독은 모듈에 한 번만 걸린다(앞 describe 와 같은 모듈)
    await vi.advanceTimersByTimeAsync(40_000); // 앞 시험의 예약·재시도가 다 끝나게
    sync.mockClear();
    http.jsonFetch.mockClear();
  });
  afterEach(() => { vi.useRealTimers(); setHubFeatures(["scene_writer_v1"]); setAccountScope(null); });

  it("카메라만 확정 → 15초 동안 공책 동기화 예약 0", async () => {
    updateSceneCamera(null, "s", { z: 2, x: 1, y: 1 });
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sync).not.toHaveBeenCalled();
  });

  it("내용 예약 뒤 카메라만 확정 → 그 예약이 원래 시각(내용 확정 2초 뒤)에 돈다", async () => {
    edit("edited");
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(1000);
    updateSceneCamera(null, "s", { z: 3, x: 1, y: 1 });
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(1100);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("실패 재시도가 걸린 뒤 카메라만 확정 → 재시도 타이머가 그대로 돈다", async () => {
    sync.mockResolvedValueOnce(retry as never);
    edit("edited");
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(2500);
    expect(sync).toHaveBeenCalledTimes(1);
    updateSceneCamera(null, "s", { z: 4, x: 1, y: 1 });
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("다른 창 확정을 읽은 카메라 확정은 예약한다(다른 창 통지 경로 그대로)", async () => {
    writeSceneStoreAsOtherWindowForTest((all) => { all[bucket] = [scene("s", "other window")]; });
    updateSceneCamera(null, "s", { z: 5, x: 1, y: 1 });
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(2500);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("바깥 동기화 retry → 기한(30초)에 한 번 다시 돈다 — 두 번째 retry 가 와도 타이머 하나·기한 그대로", async () => {
    outside(retry);
    await vi.advanceTimersByTimeAsync(10_000);
    outside(retry);
    await vi.advanceTimersByTimeAsync(19_900);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("바깥 동기화 retry 뒤 같은 계정의 ready → 재시도를 푼다(30초 뒤 공책 왕복 0)", async () => {
    outside(retry);
    await vi.advanceTimersByTimeAsync(1000);
    outside(ready);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sync).not.toHaveBeenCalled();
  });

  it("다른 계정의 ready 는 이 계정의 재시도를 풀지 않는다", async () => {
    outside(retry);
    await vi.advanceTimersByTimeAsync(1000);
    outside(ready, "acct:someone-else");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("waiting_token·다른 계정의 retry 는 재시도로 치지 않는다", async () => {
    outside({ status: "waiting_token", changed: false, visibleChanged: false });
    outside(retry, "acct:someone-else");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sync).not.toHaveBeenCalled();
  });

  it("바깥 retry 뒤 계정이 바뀌면 옛 타이머는 새 계정 동기화를 시작하지 않는다", async () => {
    outside(retry);
    setAccountScope("other@test");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sync).not.toHaveBeenCalled();
    expect(http.jsonFetch).not.toHaveBeenCalled();
  });

  it("바깥 retry 뒤 같은 계정에서 공책 기능이 꺼지면 타이머가 돌아도 공책 요청·옛 백업 PUT 0", async () => {
    outside(retry);
    setHubFeatures([]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sync).not.toHaveBeenCalled();
    expect(http.jsonFetch).not.toHaveBeenCalled();
  });

  it("자기 동기화와 같은 진행 중 요청을 공유한 retry 는 재시도 하나", async () => {
    sync.mockImplementationOnce(async () => { outside(retry); return retry as never; }); // 결과 알림은 자기 syncNow 가 기다리는 동안 온다
    edit("edited");
    await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(2500);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_500);
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("크기 상한 직전 씬 — 카메라만 확정은 다시 세지 않고(표시 늦음), 바깥 동기화 ready 뒤 다시 센다", async () => {
    const base = JSON.stringify(scene("s", ""));
    await writeScenesStore({ [bucket]: [scene("s", "a".repeat(MAX_SCENE_BYTES - base.length - 4))] }); // 상한 4바이트 앞
    await settleSceneStoreForTest();
    expect(getSceneBackupSkippedIds().has("s")).toBe(false);
    updateSceneCamera(null, "s", { z: 1, x: 0, y: 0 }); // 카메라 글자로 상한을 넘는다
    await settleSceneStoreForTest();
    expect(getSceneBackupSkippedIds().has("s")).toBe(false); // 계약대로 늦다
    outside(ready);
    expect(getSceneBackupSkippedIds().has("s")).toBe(true);
    await writeScenesStore({ [bucket]: [scene()] });
    await settleSceneStoreForTest();
  });
});
