import { setHubFeatures } from "../src/lib/hubFeatures";
// 저장 계약의 메모리 어댑터 시험. 실제 IDB 다중 창/디스크 중단은 격리 브라우저 실측에서 별도로 확인한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortSceneStoreWritesForTest, applySceneOp, delaySceneStoreWritesForTest, initSceneStore,
  readConfirmedBucket, readWorkingBucket, setSceneLeaseGeneration, setSceneWriteGate,
  settleSceneStoreForTest, unconfirmedSceneWrites, writeSceneStoreAsOtherWindowForTest, writeScenesStore,
  sceneNotebookTransaction, notebookKey, sceneStoreKeysForTest, captureSceneOps,
  absorbLegacyScenes, sceneStoreConflicts,
} from "../src/lib/sceneStore";
import {
  acknowledgeNotebookIntent, addNotebookSceneIfAbsent, applyNotebookOrder, joinSceneNotebook,
  preserveUnuploadableNotebookScene, readNotebookArchive, readSceneNotebook,
  removeNotebookSceneIfUnchanged, replaceNotebookSceneIfUnchanged, writeNotebookProgress,
  type NotebookSceneState, type SceneBase,
} from "../src/lib/sceneNotebook";
import { adoptCanvasSceneWrites, type Scene, type ScenesByProject } from "../src/lib/scenes";

const bucket = "local::_none";
const other = "other::_none";
const scene = (id = "s", name = id): Scene => ({ id, name, cards: [], edges: [], created_at: 1 });
const base = (rev = 1, hash = `hash-${rev}`, history = "h"): SceneBase => ({ history, rev, hash });
const edit = (fn: (all: ScenesByProject) => void) => applySceneOp((all) => { fn(all); return { write: true, value: null }; });
const drop = () => edit((all) => { all[bucket] = all[bucket].filter((s) => s.id !== "s"); });
const revive = () => edit((all) => { all[bucket] = [...all[bucket], scene()]; });
async function snapshot(account = "local") {
  const result = await readSceneNotebook(account);
  if (!result.ok) throw new Error("snapshot failed");
  return result.value;
}
const state = async (): Promise<NotebookSceneState> => (await snapshot()).buckets[bucket].states.s;
async function seeded(value = scene()) {
  await writeScenesStore({ [bucket]: [], [other]: [scene("other")] });
  expect(await addNotebookSceneIfAbsent(bucket, value, base())).toBe(true);
}
const hub = (value = scene("hub"), history = "h") => ({ [bucket]: { scenes: [value], bases: { [value.id]: base(1, "hash-1", history) }, order: { history, rev: 1 } } });

beforeEach(() => { setHubFeatures(["scene_writer_v1"]); setSceneWriteGate(() => false); });
it("c13 feature off writes no notebook metadata during edit/delete/undo", async () => {
  setHubFeatures([]);
  await writeScenesStore({ [bucket]: [scene()] });
  drop(); revive(); drop(); await settleSceneStoreForTest();
  expect(sceneStoreKeysForTest().filter((key) => /^\["(?:b|d|r|ob|nj)",/.test(key))).toEqual([]);
});
it("c13 feature off does not scan existing notebook base values", async () => {
  await seeded(); setHubFeatures([]);
  const clone = vi.spyOn(globalThis, "structuredClone");
  drop(); await settleSceneStoreForTest();
  expect(clone.mock.calls.some(([value]) => value && typeof value === "object" && "hash" in value && value.hash === "hash-1")).toBe(false);
  clone.mockRestore();
});
it.each(["guard", "collision"])("hub %s rejection does not fail the queued user edit", async (kind) => {
  await seeded(); delaySceneStoreWritesForTest(10);
  const receive = sceneNotebookTransaction([], () => { throw new Error("local_copy_collision"); }, () => kind !== "guard");
  const edited = captureSceneOps(() => edit((all) => { all[bucket] = [scene("s", "new edit")]; }));
  expect(await receive).toEqual({ ok: false });
  expect(await edited.confirmed).toBe(true);
  expect(readConfirmedBucket(bucket)[0].name).toBe("new edit");
});
afterEach(async () => {
  abortSceneStoreWritesForTest(false);
  delaySceneStoreWritesForTest(0);
  setSceneWriteGate(() => false);
  await settleSceneStoreForTest();
  setHubFeatures([]);
  vi.unstubAllGlobals();
});

describe("c04: 씬과 삭제/되살리기 의도가 한 번에 저장된다", () => {
  it("randomUUID 없는 HTTP/옛 런타임에서도 삭제 의도 id가 달라진다", async () => {
    vi.stubGlobal("crypto", {});
    await seeded(); drop(); const first = await state();
    revive(); drop(); const second = await state();
    expect(first.deletion?.intentId).toBeTruthy();
    expect(second.deletion?.intentId).not.toBe(first.deletion?.intentId);
  });
  it("동기 삭제 뒤 재부팅 조회에도 판과 삭제 의도가 남는다", async () => {
    await seeded();
    expect(drop().ok).toBe(true);
    expect(readWorkingBucket(bucket)).toEqual([]);
    const deleted = await state();
    expect(deleted).toMatchObject({ text: null, base: base(), deletion: { base: base() }, revival: null });
    expect(deleted.deletion?.intentId).toBeTruthy();
    expect((await initSceneStore(() => null, null, () => true)).kind).toBe("ready");
    expect(await state()).toEqual(deleted);
    expect(await addNotebookSceneIfAbsent(bucket, scene(), base())).toBe(false);
  });

  it("삭제→되돌리기→재삭제를 같은 묶음에서 구별하고 늦은 삭제 확인을 거절한다", async () => {
    await seeded();
    drop();
    const first = await state();
    revive();
    drop();
    expect(await acknowledgeNotebookIntent(bucket, "s", "delete", first, base(2))).toBe(false);
    const latest = await state();
    expect(latest.deletion?.intentId).not.toBe(first.deletion?.intentId);
    expect(latest.base).toEqual(base());
    expect(latest.revival).toBeNull();
    expect(await acknowledgeNotebookIntent(bucket, "s", "delete", latest, base(2))).toBe(true);
    expect((await state()).deletion).toBeNull();
  });

  it("내용이 원래와 같아도 되살림이 남고, 삭제 응답이 되살림/판을 바꾸지 못한다", async () => {
    await seeded();
    drop();
    const deleted = await state();
    revive();
    const restored = await state();
    expect(restored.text).toBe(JSON.stringify(scene()));
    expect(restored.revival?.intentId).toBeTruthy();
    expect(restored.deletion).toBeNull();
    expect(await acknowledgeNotebookIntent(bucket, "s", "delete", deleted, base(2))).toBe(false);
    expect(await removeNotebookSceneIfUnchanged(bucket, "s", restored, base(2))).toBe(false);
    expect(await acknowledgeNotebookIntent(bucket, "s", "revive", restored, base(3))).toBe(true);
    expect(await state()).toMatchObject({ base: base(3), deletion: null, revival: null });
  });

  it("확인된 삭제를 나중에 되돌려도 되살림 의도가 생긴다", async () => {
    await seeded(); drop();
    expect(await acknowledgeNotebookIntent(bucket, "s", "delete", await state(), base(2))).toBe(true);
    revive();
    expect((await state()).revival?.base).toEqual(base(2));
  });

  it("늦은 되살림 응답은 재삭제를 확인하지 않는다", async () => {
    await seeded(); drop(); revive();
    const restored = await state();
    drop();
    expect(await acknowledgeNotebookIntent(bucket, "s", "revive", restored, base(3))).toBe(false);
    expect((await state()).deletion).toBeTruthy();
  });

  it("트랜잭션 중단 시 씬 삭제·의도·순서가 모두 미확정이고 재시도는 함께 확정한다", async () => {
    await seeded();
    const before = await snapshot();
    abortSceneStoreWritesForTest(true);
    drop();
    expect(await settleSceneStoreForTest()).toBe(false);
    expect(readConfirmedBucket(bucket)).toEqual([scene()]);
    expect(await readSceneNotebook("local")).toEqual({ ok: false });
    abortSceneStoreWritesForTest(false);
    const after = await snapshot();
    expect(after.buckets[bucket].states.s.deletion).toBeTruthy();
    expect(after.buckets[bucket].order.dirty).not.toBe(before.buckets[bucket].order.dirty);
  });
});

describe("조건부 수신: 실제로 적용된 것만 판을 바꾼다", () => {
  it("paused에서도 허브 원문과 실행 표식은 보존되고 입력/읽기 사본은 저장소와 분리된다", async () => {
    await seeded();
    const before = await state();
    const incoming = { ...scene(), name: "hub", comfyRuns: [{ attemptId: "run" }], cards: [{ id: "c", kind: "text", x: 0, y: 0, pendingGenerationAttempts: [{ attemptId: "a", generationId: "g", createdAt: 1 }] }] } as Scene;
    setSceneWriteGate(() => true);
    const applying = replaceNotebookSceneIfUnchanged(bucket, before, incoming, base(2));
    incoming.name = "caller changed";
    expect(await applying).toBe(true);
    const saved = readConfirmedBucket(bucket)[0];
    expect(saved.name).toBe("hub");
    expect(saved.comfyRuns?.[0].attemptId).toBe("run");
    expect(saved.cards[0].pendingGenerationAttempts?.[0].generationId).toBe("g");
    const read = await snapshot(); read.buckets[bucket].scenes[0].name = "reader changed";
    expect(readConfirmedBucket(bucket)[0].name).toBe("hub");
    expect(Object.isFrozen(readWorkingBucket(bucket)[0])).toBe(true);
  });

  it("새 편집/다른 창의 변경이 있으면 받은 씬과 판 모두 건너뛴다", async () => {
    await seeded(); const before = await state();
    writeSceneStoreAsOtherWindowForTest((all) => { all[bucket] = [scene("s", "other window")]; });
    expect(await replaceNotebookSceneIfUnchanged(bucket, before, scene("s", "hub"), base(2))).toBe(false);
    expect(await state()).toMatchObject({ text: JSON.stringify(scene("s", "other window")), base: base() });
  });

  it("같은 글자라도 history/지문이 달라졌으면 옛 삭제를 거절한다", async () => {
    await seeded(); const before = await state();
    expect(await replaceNotebookSceneIfUnchanged(bucket, before, scene(), base(1, "changed", "restored"))).toBe(true);
    expect(await removeNotebookSceneIfUnchanged(bucket, "s", before, base(2))).toBe(false);
    expect(readWorkingBucket(bucket)).toEqual([scene()]);
  });

  it("허브 삭제는 로컬 지움 의도를 만들지 않으며, 낡은 absent 추가가 되살리지 못한다", async () => {
    await seeded();
    expect(await removeNotebookSceneIfUnchanged(bucket, "s", await state(), base(2))).toBe(true);
    expect(await state()).toMatchObject({ text: null, deletion: null, base: base(2) });
    expect(await addNotebookSceneIfAbsent(bucket, scene(), base())).toBe(false);
    expect(await addNotebookSceneIfAbsent(bucket, scene(), base(3), await state())).toBe(true);
  });

  it("순서의 ABA 변경은 예전 확인으로 미전송 표시를 지우지 않는다", async () => {
    await seeded();
    await addNotebookSceneIfAbsent(bucket, scene("t"), base());
    const first = (await snapshot()).buckets[bucket];
    edit((all) => { all[bucket] = [...all[bucket]].reverse(); });
    edit((all) => { all[bucket] = [...all[bucket]].reverse(); });
    expect(await applyNotebookOrder(bucket, ["s", "t"], first.order, ["t", "s"], { history: "h", rev: 2 })).toBe(false);
    const latest = (await snapshot()).buckets[bucket];
    expect(latest.order.dirty).toBeTruthy();
    expect(await applyNotebookOrder(bucket, ["s", "t"], latest.order, ["t", "t", "missing"], { history: "h", rev: 2 })).toBe(true);
    expect(readConfirmedBucket(bucket).map((s) => s.id)).toEqual(["t", "s"]);
    expect((await snapshot()).buckets[bucket].order).toEqual({ base: { history: "h", rev: 2 }, dirty: null });
  });
});

describe("c08: 계정당 처음 합류 한 번과 허브 전 사본", () => {
  it("옛 미해결 충돌을 보관하고 합류 계정의 localStorage만 더는 흡수하지 않는다", async () => {
    const legacy = { [bucket]: [scene()], [other]: [scene("other")] };
    await initSceneStore(() => legacy, null, () => true);
    edit((all) => { all[bucket] = [scene("s", "local change")]; });
    await settleSceneStoreForTest();
    const oldTab = { [bucket]: [scene("s", "legacy change")], [other]: [scene("other")] };
    await absorbLegacyScenes(oldTab);
    expect(sceneStoreConflicts()).toHaveLength(1);
    expect(await joinSceneNotebook("local", "book", "h", hub())).toBe(true);
    expect(sceneStoreConflicts()).toEqual([]);
    expect(await readNotebookArchive("local", "book")).toMatchObject({ ok: true, value: { conflicts: [{ bucket, sceneId: "s", theirs: scene("s", "legacy change") }] } });
    const later = { [bucket]: [scene("s", "yet another legacy edit")], [other]: [scene("other", "other account edit")] };
    await absorbLegacyScenes(later);
    expect(readConfirmedBucket(bucket)).toEqual([scene("hub")]);
    expect(readConfirmedBucket(other)).toEqual([scene("other", "other account edit")]);
    expect(sceneStoreConflicts()).toEqual([]);
    await initSceneStore(() => later, null, () => true);
    expect(readConfirmedBucket(bucket)).toEqual([scene("hub")]);
    expect(sceneStoreConflicts()).toEqual([]);
  });

  it("같은 계정의 모든 버킷만 보관/교체하며 다른 계정과 기존 사본은 유지한다", async () => {
    await writeScenesStore({ [bucket]: [scene("old")], "local::project": [scene("project")], [other]: [scene("other")] });
    setSceneWriteGate(() => true);
    expect(await joinSceneNotebook("local", "book", "h", hub())).toBe(true);
    const archived = await readNotebookArchive("local", "book");
    expect(archived).toMatchObject({ ok: true, value: { scenes: { [bucket]: [scene("old")], "local::project": [scene("project")] } } });
    expect(readConfirmedBucket(other)).toEqual([scene("other")]);
    expect((await snapshot()).buckets[bucket].states.hub.base).toEqual(base());
    expect((await snapshot()).buckets["local::project"]).toBeUndefined();
    expect(await joinSceneNotebook("local", "restored-book", "restored", hub(scene("new"), "restored"))).toBe(false);
    expect(await readNotebookArchive("local", "book")).toEqual(archived);
    expect(await readNotebookArchive("local", "restored-book")).toEqual({ ok: true, value: null });
    expect(await joinSceneNotebook("other", "book", "h", { [other]: { scenes: [], bases: {}, order: { history: "h", rev: 1 } } })).toBe(true);
  });

  it("중단 시 사본/합류/판/씬이 반쯤 남지 않고 다음 합류가 성공한다", async () => {
    await seeded(); const before = await snapshot();
    abortSceneStoreWritesForTest(true);
    expect(await joinSceneNotebook("local", "book", "h", hub())).toBe(false);
    abortSceneStoreWritesForTest(false);
    expect(await snapshot()).toEqual(before);
    expect(await readNotebookArchive("local", "book")).toEqual({ ok: true, value: null });
    expect(await joinSceneNotebook("local", "book", "h", hub())).toBe(true);
  });

  it("경합한 첫 합류 중 하나만 적용하며 앞선 미확정 편집도 사본에 남긴다", async () => {
    await seeded();
    edit((all) => { all[bucket] = [scene("s", "last edit")]; });
    const a = joinSceneNotebook("local", "a", "h", hub(scene("a")));
    const b = joinSceneNotebook("local", "b", "h", hub(scene("b")));
    expect(await Promise.all([a, b])).toEqual([true, false]);
    expect(await readNotebookArchive("local", "a")).toMatchObject({ ok: true, value: { scenes: { [bucket]: [scene("s", "last edit")] } } });
    expect(await readNotebookArchive("local", "b")).toEqual({ ok: true, value: null });
  });

  it("저장 큐가 기다리는 동안 접수된 편집도 합류 보관본에 들어간다", async () => {
    await seeded();
    delaySceneStoreWritesForTest(20);
    const joined = joinSceneNotebook("local", "book", "h", hub());
    await Promise.resolve();
    edit((all) => { all[bucket] = [scene("s", "during wait")]; });
    expect(await joined).toBe(true);
    expect(await readNotebookArchive("local", "book")).toMatchObject({ ok: true, value: { scenes: { [bucket]: [scene("s", "during wait")] } } });
    expect(readConfirmedBucket(bucket)).toEqual([scene("hub")]);
  });

  it("다른 계정 버킷/판 누락이 있는 응답은 통째로 거절한다", async () => {
    await seeded();
    expect(await joinSceneNotebook("local", "book", "h", { ...hub(), [other]: hub()[bucket] })).toBe(false);
    expect(await joinSceneNotebook("local", "book", "h", { [bucket]: { ...hub()[bucket], bases: {} } })).toBe(false);
    expect(readConfirmedBucket(bucket)).toEqual([scene()]);
  });

  it("합류 표시는 없어도 보관 칸에 이미 사본이 있으면 절대 덮지 않는다", async () => {
    await seeded();
    const archive = { notebookId: "book", scenes: { [bucket]: [scene("precious")] } };
    await sceneNotebookTransaction([], (_all, meta) => {
      meta[notebookKey("na", "local", "book")] = archive;
      return { changed: true, value: true };
    });
    expect(await joinSceneNotebook("local", "book", "h", hub())).toBe(true);
    expect(await readNotebookArchive("local", "book")).toEqual({ ok: true, value: archive });
  });
});

describe("c07: 못 올리는 씬을 로컬 사본으로 먼저 보존", () => {
  it("사본과 원래 id 교체는 원자적이고, 새 id에 실행 연결을 활성화하지 않는다", async () => {
    const original = { ...scene(), comfyRuns: [{ attemptId: "run" }], cards: [{ id: "c", kind: "text", x: 0, y: 0, pendingGenerationAttempts: [{ attemptId: "a", generationId: "g", createdAt: 1 }] }] } as Scene;
    await seeded(original); const before = await state();
    abortSceneStoreWritesForTest(true);
    expect(await preserveUnuploadableNotebookScene(bucket, "s", before, "copy", scene("s", "hub"), base(2))).toBe(false);
    abortSceneStoreWritesForTest(false);
    expect(readConfirmedBucket(bucket)).toEqual([original]);
    expect(await state()).toEqual(before);
    expect(await preserveUnuploadableNotebookScene(bucket, "s", before, "copy", scene("s", "hub"), base(2))).toBe(true);
    const [canonical, copy] = readConfirmedBucket(bucket);
    expect(canonical.name).toBe("hub");
    expect(copy).toMatchObject({ id: "copy", name: "[옛 창] s", localNotebookCopy: "upload_failed", backupForkOf: { id: "s", comfyRuns: original.comfyRuns } });
    expect(copy.comfyRuns).toBeUndefined();
    expect(copy.cards[0].pendingGenerationAttempts).toBeUndefined();
    expect(copy.backupForkOf?.pendingGenerationAttempts?.c[0].generationId).toBe("g");
    expect((await snapshot()).buckets[bucket].states.copy.base).toBeNull();
    expect(await preserveUnuploadableNotebookScene(bucket, "s", before, "copy", scene(), base(3))).toBe(false);
    expect(readConfirmedBucket(bucket)[1]).toEqual(copy);
  });

  it("사본 id 충돌/늦은 응답이면 원래 id를 덮지 않는다", async () => {
    await seeded();
    await addNotebookSceneIfAbsent(bucket, scene("copy"), base());
    const before = await state();
    expect(await preserveUnuploadableNotebookScene(bucket, "s", before, "copy", null, base(2))).toBe(false);
    edit((all) => { all[bucket] = all[bucket].map((s) => s.id === "s" ? { ...s, name: "newer" } : s); });
    expect(await preserveUnuploadableNotebookScene(bucket, "s", before, "free-id", null, base(2))).toBe(false);
    expect(readConfirmedBucket(bucket)[0].name).toBe("newer");
  });
});

describe("4차①: 분리 창 인계 세대", () => {
  it.each([false, true])("matching or disabled lease does not pre-clone copy bodies (enabled %s)", async (enabled) => {
    await seeded(); setHubFeatures(enabled ? ["scene_writer_v1"] : []); setSceneLeaseGeneration("local", "same");
    const clone = vi.spyOn(globalThis, "structuredClone");
    adoptCanvasSceneWrites([{ bucket, leaseGeneration: enabled ? "same" : "old", changed: [scene("s", "fresh")], created: [], removed: [], order: null }]);
    expect(clone.mock.calls.some(([value]) => value && typeof value === "object" && "id" in value && value.id === "s")).toBe(false);
    clone.mockRestore();
    await settleSceneStoreForTest(); expect(readConfirmedBucket(bucket)).toEqual([scene("s", "fresh")]);
  });
  it("같은 세대의 인계는 paused에도 동기로 적용하고 확정한다", async () => {
    await seeded(); setSceneLeaseGeneration("local", "same");
    setSceneWriteGate(() => true);
    expect(adoptCanvasSceneWrites([{ bucket, leaseGeneration: "same", changed: [scene("s", "fresh")], created: [], removed: [], order: null }])).toBe(true);
    expect(readWorkingBucket(bucket)).toEqual([scene("s", "fresh")]);
    await settleSceneStoreForTest();
    expect(readConfirmedBucket(bucket)).toEqual([scene("s", "fresh")]);
  });

  it("편집을 접수한 세대를 싣고 닫을 때 새 세대로 바꿔 붙이지 않는다", async () => {
    await seeded();
    setSceneLeaseGeneration("local", "old");
    edit((all) => { all[bucket] = [scene("s", "floating edit")]; });
    setSceneLeaseGeneration("local", "new");
    expect(unconfirmedSceneWrites()[0].leaseGeneration).toBe("old");
  });

  it("옛 인계의 편집/삭제/순서는 원래 씬을 바꾸지 않고 로컬 사본만 만든다", async () => {
    await seeded(); setSceneLeaseGeneration("local", "new");
    setSceneWriteGate(() => true);
    expect(adoptCanvasSceneWrites([{ bucket, leaseGeneration: "old", changed: [scene("s", "old edit")], created: [], removed: ["s"], order: [] }])).toBe(true);
    await settleSceneStoreForTest();
    expect(readConfirmedBucket(bucket)[0]).toEqual(scene());
    expect(readConfirmedBucket(bucket)[1]).toMatchObject({ name: "[옛 창] old edit", localNotebookCopy: "stale_handover" });
    expect((await state()).deletion).toBeNull();
  });

  it("받을 때는 같았지만 저장 큐 대기 중 세대가 바뀌면 원래 씬을 덮지 않는다", async () => {
    await seeded(); setSceneLeaseGeneration("local", "old");
    delaySceneStoreWritesForTest(20);
    expect(adoptCanvasSceneWrites([{ bucket, leaseGeneration: "old", changed: [scene("s", "old edit")], created: [], removed: [], order: null }])).toBe(true);
    expect(readWorkingBucket(bucket)[0].name).toBe("old edit");
    setSceneLeaseGeneration("local", "new");
    await settleSceneStoreForTest();
    expect(readWorkingBucket(bucket)[0]).toEqual(scene());
    expect(readWorkingBucket(bucket)[1].name).toBe("[옛 창] old edit");
  });
});

it("시작/요청 대기는 계정별이며 늦은 완료가 다음 요청을 지우지 않는다", async () => {
  await seeded();
  expect(await writeNotebookProgress("local", "write", null, { id: "a", payload: [1] })).toBe(true);
  expect(await writeNotebookProgress("local", "write", { id: "a", payload: [1] }, { id: "b" })).toBe(true);
  expect(await writeNotebookProgress("local", "write", { id: "a", payload: [1] }, null)).toBe(false);
  expect(await writeNotebookProgress("other", "start", null, { id: "start" })).toBe(true);
  expect((await snapshot()).writing).toEqual({ id: "b" });
  expect((await snapshot()).starting).toBeNull();
  expect((await snapshot("other")).starting).toEqual({ id: "start" });
  expect((await initSceneStore(() => null, null, () => true)).kind).toBe("ready");
  expect((await snapshot()).writing).toEqual({ id: "b" });
  expect((await snapshot("other")).starting).toEqual({ id: "start" });
});
