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
import { isSceneSaveFailing, subscribeScenesPersisted, type Scene, type ScenesByProject } from "../src/lib/scenes";

vi.mock("../src/lib/sceneNotebook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/sceneNotebook")>()),
  syncSceneNotebook: vi.fn(),
}));
import { syncSceneNotebook } from "../src/lib/sceneNotebook";
import { initSceneBackup } from "../src/lib/sceneBackup";

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
