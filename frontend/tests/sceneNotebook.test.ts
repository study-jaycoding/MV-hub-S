import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { syncSceneNotebook, subscribeNotebookSyncResult, setSceneNotebookTokenProvider, readSceneNotebook, readNotebookArchive, joinSceneNotebook, completeNotebookMcpTask, type NotebookToken } from "../src/lib/sceneNotebook";
import { setHubFeatures } from "../src/lib/hubFeatures";
import { setAccountScope } from "../src/lib/accountScope";
import { applySceneOp, readWorkingBucket, writeScenesStore, settleSceneStoreForTest, abortSceneStoreWritesForTest, setSceneWriteGate, subscribeNotebookWriteHold } from "../src/lib/sceneStore";
import type { Scene } from "../src/lib/scenes";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const scene = (id = "s", name = id): Scene => ({ id, name, cards: [], edges: [], created_at: 1 });
const bucket = "local::_none";
let token: NotebookToken | null, fake: FakeHub;
let hook: ((path: string, body: any, reply: any) => void | Promise<void>) | null;
vi.mock("../src/lib/http", () => ({ jsonFetch: async (path: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const reply = fake.handle(path, body); await hook?.(path, body, reply); return structuredClone(reply);
} }));
type Base = { history_id: string; rev: number; hash: string };
type Row = { id: string; data: string; deleted_at: string | null; base: Base };
class FakeHub {
  history = "h1"; book: string | null = null; rows = new Map<string, Row>(); order: string[] = []; rev = 1;
  calls: { path: string; body: any }[] = []; receipts = new Map<string, any>(); starts = new Map<string, any>();
  save(s: Scene) {
    const data = JSON.stringify(s), prior = this.rows.get(s.id);
    const row: Row = { id: s.id, data, deleted_at: null, base: { history_id: this.history, rev: (prior?.base.rev ?? 0) + 1, hash: hash(data) } };
    this.rows.set(s.id, row); if (!this.order.includes(s.id)) this.order.push(s.id); return row;
  }
  view() { return { notebook_id: this.book, history_id: this.history, items: [...this.rows.values()], order: { ids: this.order, rev: this.rev, history_id: this.history } }; }
  handle(path: string, body: any): any {
    this.calls.push({ path, body });
    if (path.includes("notebook?")) return structuredClone(this.view());
    if (path.endsWith("/writer")) return { ok: true };
    if (path.endsWith("/start")) {
      const prior = this.starts.get(body.attempt_id);
      if (prior?.done) return prior.done;
      if (this.book) throw { detail: "notebook_already_started" };
      const staged = prior ?? { rows: new Map(), count: body.expected_count };
      if (staged.count !== body.expected_count) throw { detail: "start_attempt_changed" };
      for (const s of body.upserts) staged.rows.set(s.id, s);
      this.starts.set(body.attempt_id, staged);
      if (!body.commit) return { status: "staging" };
      if (staged.rows.size !== body.expected_count) throw { detail: "start_incomplete" };
      if (!body.expected_count && !this.rows.size) throw { detail: "empty_notebook" };
      if (body.expected_count) { this.rows.clear(); this.order = []; for (const s of staged.rows.values()) this.save(JSON.parse(s.data)); this.order = body.order; }
      this.book = "book1"; return staged.done = { status: "committed", notebook_id: this.book, history_id: this.history };
    }
    if (path.endsWith("/backup")) {
      if (this.receipts.has(body.request_id)) return this.receipts.get(body.request_id);
      const previousOrder = JSON.stringify(this.order), results = [], deletes = [];
      for (const up of body.upserts) {
        const old = this.rows.get(up.id), incoming = hash(up.data); let status = "saved", saved;
        if (old && !old.deleted_at && old.base.hash === incoming) { saved = old; status = "same"; }
        else if ((!old && (!up.base || up.base.hash === incoming)) || (old && JSON.stringify(up.base) === JSON.stringify(old.base) && (!old.deleted_at || up.revive))) saved = this.save(JSON.parse(up.data));
        else { const copy = { ...JSON.parse(up.data), id: `copy-${up.id}-${incoming.slice(0, 8)}`, name: `[old] ${up.name}` }; saved = this.rows.get(copy.id) ?? this.save(copy); status = "copied"; }
        results.push({ id: up.id, status, target_id: saved.id, base: saved.base });
      }
      for (const d of body.deletes) {
        const row = this.rows.get(d.id); let status = "deleted";
        if (row && !row.deleted_at) {
          if (JSON.stringify(d.base) === JSON.stringify(row.base)) { row.deleted_at = "today"; row.base = { ...row.base, rev: row.base.rev + 1 }; this.order = this.order.filter((id) => id !== d.id); }
          else status = "kept";
        }
        deletes.push({ id: d.id, status, base: row?.base ?? null, intent_id: d.intent_id });
      }
      if (body.order) {
        const ids = body.order.history_id === this.history && body.order.rev === this.rev ? body.order.ids : [...this.order, ...body.order.ids];
        this.order = [...new Set<string>([...ids, ...this.order])].filter((id) => this.rows.get(id)?.deleted_at === null);
      }
      if (JSON.stringify(this.order) !== previousOrder) this.rev++;
      const mcp_done = (body.mcp_complete ?? []).filter((id: string) => results.some((r) => r.id === r.target_id && ["saved", "same"].includes(r.status) && JSON.parse(this.rows.get(r.id)!.data).mcpAttachmentReceipts?.includes(id)));
      const reply = { history_id: this.history, results, deletes, order: structuredClone(this.view().order), mcp_done };
      this.receipts.set(body.request_id, structuredClone(reply)); return reply;
    }
    throw new Error(`unexpected ${path}`);
  }
}
const edit = (scenes: Scene[]) => applySceneOp((all) => { all[bucket] = scenes; return { write: true, value: null }; });
const state = async () => { const r = await readSceneNotebook("local"); if (!r.ok) throw Error("store"); return r.value; };
async function joined(scenes = [scene()]) {
  fake.book = "book1"; scenes.forEach((s) => fake.save(s)); await writeScenesStore({ [bucket]: [] });
  await joinSceneNotebook("local", fake.book, fake.history, { [bucket]: { scenes,
    bases: Object.fromEntries(scenes.map((s) => [s.id, { history: fake.history, rev: fake.rows.get(s.id)!.base.rev, hash: fake.rows.get(s.id)!.base.hash }])), order: { history: fake.history, rev: fake.rev } } });
}
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  fake = new FakeHub(); hook = null; setAccountScope(null); setHubFeatures(["scene_writer_v1"]);
  token = { account: "local", token: "token", generation: "g1" }; setSceneNotebookTokenProvider(() => token); setSceneWriteGate(() => false);
  vi.stubGlobal("crypto", {});
});
afterEach(async () => { abortSceneStoreWritesForTest(false); await settleSceneStoreForTest(); setSceneWriteGate(() => false); setHubFeatures([]); setAccountScope(null); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("c13 disabled and missing token perform no IO", async () => {
  setHubFeatures([]); expect((await syncSceneNotebook()).status).toBe("disabled"); setHubFeatures(["scene_writer_v1"]); token = null;
  expect((await syncSceneNotebook()).status).toBe("waiting_token"); expect(fake.calls).toEqual([]);
});
it("c01 stages current browser before commit and keeps same-id execution fields", async () => {
  const s = { ...scene(), comfyRuns: { image: { runId: "active" } }, cards: [{ id: "c", kind: "text", x: 0, y: 0, pendingGenerationAttempts: [{ attemptId: "a" }] }] } as unknown as Scene;
  await writeScenesStore({ [bucket]: [s] }); fake.save(scene("old"));
  expect(await syncSceneNotebook()).toMatchObject({ status: "ready", changed: true }); expect([...fake.rows.keys()]).toEqual(["s"]); expect(readWorkingBucket(bucket)).toEqual([s]);
  expect(fake.calls.filter((c) => c.path.endsWith("/start")).map((c) => c.body.commit)).toEqual([false, true]); expect((await state()).starting).toBeNull();
});
it("c08 archives all prior buckets once even when history and notebook change", async () => {
  fake.book = "book1"; fake.save(scene("hub")); await writeScenesStore({ [bucket]: [scene("old")], "local::project": [scene("project")] });
  expect((await syncSceneNotebook()).status).toBe("ready"); const archive = await readNotebookArchive("local", "book1");
  expect(archive.ok && archive.value?.scenes["local::project"][0].id).toBe("project"); expect(fake.calls.some((c) => c.path.endsWith("/backup"))).toBe(false);
  fake.book = "book2"; fake.history = "h2"; fake.rows.forEach((r) => { r.base.history_id = "h2"; });
  expect((await syncSceneNotebook()).status).toBe("ready"); expect((await state()).joined?.notebookId).toBe("book1"); expect(await readNotebookArchive("local", "book1")).toEqual(archive);
});
it("c07 failed join transaction preserves old scenes and does not mark joined", async () => {
  fake.book = "book1"; fake.save(scene("hub")); await writeScenesStore({ [bucket]: [scene("old")] });
  hook = (p) => { if (p.includes("notebook?")) abortSceneStoreWritesForTest(true); };
  expect((await syncSceneNotebook()).status).toBe("retry"); expect(readWorkingBucket(bucket)[0].id).toBe("old");
  abortSceneStoreWritesForTest(false); hook = null; expect((await state()).joined).toBeNull(); expect((await syncSceneNotebook()).status).toBe("ready");
});
it("bootstrap allows staging edits, restarts that snapshot, and holds only commit and join", async () => {
  await writeScenesStore({ [bucket]: [scene()] }); let edited = false, blocked = false;
  hook = (p, body) => {
    if (!p.endsWith("/start")) return;
    if (!body.commit && !edited) { edited = true; expect(edit([scene("late")]).ok).toBe(true); }
    if (body.commit) blocked = !edit([scene("blocked")]).ok;
  };
  expect((await syncSceneNotebook()).status).toBe("ready"); expect(blocked).toBe(true);
  expect([...fake.rows.keys()]).toEqual(["late"]); expect(readWorkingBucket(bucket).map((s) => s.id)).toEqual(["late"]);
  const stages = fake.calls.filter((c) => c.path.endsWith("/start"));
  expect(stages.map((c) => c.body.commit)).toEqual([false, false, true]);
  expect(stages[0].body.attempt_id).not.toBe(stages[1].body.attempt_id);
  expect(edit([scene("after")]).ok).toBe(true);
});
it("bootstrap flush before commit participates in snapshot verification", async () => {
  await writeScenesStore({ [bucket]: [scene()] }); let flushed = false;
  const unsubscribe = subscribeNotebookWriteHold((_account, held) => {
    if (held && !flushed) { flushed = true; expect(edit([scene("flushed")]).ok).toBe(true); }
  });
  try {
    expect((await syncSceneNotebook()).status).toBe("ready");
    expect([...fake.rows.keys()]).toEqual(["flushed"]);
    expect(fake.calls.filter((c) => c.path.endsWith("/start") && c.body.commit)).toHaveLength(1);
  } finally { unsubscribe(); }
});
it("continuous bootstrap edits stop after three snapshots without committing or keeping input held", async () => {
  await writeScenesStore({ [bucket]: [scene()] }); let edits = 0;
  hook = (p, body) => {
    if (p.endsWith("/start") && !body.commit) expect(edit([scene(`edit${++edits}`)]).ok).toBe(true);
  };
  expect(await syncSceneNotebook()).toMatchObject({ status: "retry", reason: "reconcile_limit" });
  expect(edits).toBe(3); expect(fake.book).toBeNull(); expect((await state()).starting).toBeNull();
  expect(edit([scene("after")]).ok).toBe(true);
});
it("handoff fresh sync waits for existing work and uploads a newly settled snapshot", async () => {
  await joined(); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  hook = async (path) => { if (path.includes("notebook?")) { hook = null; enter(); await blocked; } };
  const existing = syncSceneNotebook(); await entered;
  const fresh = syncSceneNotebook({ fresh: true });
  expect(syncSceneNotebook({ fresh: true })).toBe(fresh); expect(fresh).not.toBe(existing);
  const unsubscribe = subscribeNotebookSyncResult(() => { unsubscribe(); expect(edit([scene("s", "settled")]).ok).toBe(true); });
  release();
  expect((await existing).status).toBe("ready"); expect((await fresh).status).toBe("ready");
  expect(JSON.parse(fake.rows.get("s")!.data).name).toBe("settled"); expect(fake.rows.size).toBe(1);
});
it("empty_notebook retries with a new attempt when a local scene appears", async () => {
  await writeScenesStore({ [bucket]: [] }); expect(await syncSceneNotebook()).toMatchObject({ status: "local_only", reason: "empty_notebook" });
  expect((await state()).starting).toBeNull(); edit([scene()]); expect((await syncSceneNotebook()).status).toBe("ready");
});
it("empty browser takes existing hub rows", async () => {
  fake.save(scene("hub")); await writeScenesStore({ [bucket]: [] }); expect((await syncSceneNotebook()).status).toBe("ready"); expect(readWorkingBucket(bucket)[0].id).toBe("hub");
});
it("c07 oversized start releases lease without partial start or lost local data", async () => {
  const huge = { ...scene(), padding: "x".repeat(5 * 1024 * 1024) } as Scene; await writeScenesStore({ [bucket]: [huge, scene("small")] });
  const held: boolean[] = [], unsubscribe = subscribeNotebookWriteHold((_account, value) => { held.push(value); });
  try { expect(await syncSceneNotebook()).toMatchObject({ status: "local_only", reason: "start_too_big" }); }
  finally { unsubscribe(); }
  expect(held).toEqual([]); expect(fake.calls.some((c) => c.path.endsWith("/start"))).toBe(false);
  expect(fake.calls.at(-1)?.body.action).toBe("release"); expect(readWorkingBucket(bucket)).toHaveLength(2); expect(edit([scene()]).ok).toBe(true);
});
it("lost staging response reuses immutable attempt id", async () => {
  await writeScenesStore({ [bucket]: [scene()] }); let failures = 0;
  hook = (p, b) => { if (failures < 3 && p.endsWith("/start") && !b.commit) { failures++; throw Error("lost"); } };
  expect((await syncSceneNotebook()).status).toBe("retry"); expect((await syncSceneNotebook()).status).toBe("ready");
  const stages = fake.calls.filter((c) => c.path.endsWith("/start") && !c.body.commit); expect(stages[0].body.attempt_id).toBe(stages[1].body.attempt_id);
});
it("c09 lost PUT response retries the persisted request id and exact payload", async () => {
  await joined(); edit([scene("s", "edited")]); let failures = 0;
  hook = (p) => { if (failures < 3 && p.endsWith("/backup")) { failures++; throw Error("lost"); } };
  expect((await syncSceneNotebook()).status).toBe("retry"); expect((await state()).writing).not.toBeNull(); expect((await syncSceneNotebook()).status).toBe("ready");
  const calls = fake.calls.filter((c) => c.path.endsWith("/backup")); expect(calls[0].body).toEqual(calls[1].body); expect(fake.rows.size).toBe(1); expect((await state()).writing).toBeNull();
});
it("c04 delete acknowledgement retains tombstone base for undo original id", async () => {
  await joined(); edit([]); expect((await syncSceneNotebook()).status).toBe("ready"); const d = (await state()).buckets[bucket].states.s;
  expect(d.deletion).toBeNull(); expect(d.base?.rev).toBe(2); edit([scene()]); expect((await syncSceneNotebook()).status).toBe("ready"); expect(fake.rows.get("s")!.deleted_at).toBeNull(); expect(fake.rows.size).toBe(1);
});
it.each([false, true])("c04 delayed delete cannot swallow undo/redelete=%s", async (again) => {
  await joined(); edit([]); let changed = false;
  hook = (p, b) => { if (!changed && p.endsWith("/backup") && b.deletes.length) { changed = true; edit([scene()]); if (again) edit([]); } };
  expect((await syncSceneNotebook()).status).toBe("ready"); expect(!!fake.rows.get("s")!.deleted_at).toBe(again);
  if (again) { const ds = fake.calls.flatMap((c) => c.body?.deletes ?? []); expect(ds[0].intent_id).not.toBe(ds[1].intent_id); }
});
it("c09 dirty local and newer remote become separate tabs", async () => {
  await joined(); fake.save(scene("s", "remote")); edit([scene("s", "local")]); expect((await syncSceneNotebook()).status).toBe("ready"); expect(readWorkingBucket(bucket).map((s) => s.name)).toEqual(["remote", "[old] local"]);
});
it("c07 oversize edit becomes excluded local copy before original replacement", async () => {
  await joined(); const huge = { ...scene("s", "huge"), padding: "x".repeat(5 * 1024 * 1024) } as Scene; edit([huge]);
  expect((await syncSceneNotebook()).status).toBe("ready"); const copy = readWorkingBucket(bucket).find((s) => s.localNotebookCopy === "upload_failed")!;
  expect(copy).toBeTruthy(); expect(copy.id).not.toBe("s"); expect((copy as any).padding).toBe((huge as any).padding);
  const n = fake.calls.flatMap((c) => c.body?.upserts ?? []).length; expect((await syncSceneNotebook()).status).toBe("ready"); expect(fake.calls.flatMap((c) => c.body?.upserts ?? [])).toHaveLength(n);
});
it("c09 receive races retry at most three times and preserve the latest edit", async () => {
  await joined(); edit([scene("s", "first")]); let count = 0; hook = (p) => { if (p.includes("notebook?")) edit([scene("s", `edit${++count}`)]); };
  expect(await syncSceneNotebook()).toMatchObject({ status: "retry", reason: "reconcile_limit" }); expect(count).toBe(6); expect(readWorkingBucket(bucket)[0].name).toBe("edit6");
});
it.each(["account", "generation"])("c10 rejects late %s response", async (kind) => {
  await joined(); fake.save(scene("s", "remote")); hook = (p) => { if (p.includes("notebook?")) { if (kind === "account") setAccountScope("other@test"); else token = { ...token!, generation: "g2" }; } };
  expect((await syncSceneNotebook()).status).toBe("waiting_token"); expect(readWorkingBucket(bucket)[0].name).toBe("s");
});
it.each([true, false])("c10 prior joined starts missing notebook without rejoining (hub rows %s)", async (hasRows) => {
  await joined(); const archive = await readNotebookArchive("local", "book1");
  fake.book = null; fake.history = "h2"; fake.rows.clear(); fake.order = [];
  if (hasRows) fake.save(scene("remote"));
  expect((await syncSceneNotebook()).status).toBe("ready");
  expect(fake.calls.filter((c) => c.path.endsWith("/start") && c.body.commit)[0].body.expected_count).toBe(hasRows ? 0 : 1);
  expect(await readNotebookArchive("local", "book1")).toEqual(archive);
  expect((await state()).joined?.history).toBe("h1");
});
it("history replacement with reused rev preserves offline edits as copies", async () => {
  await joined(); fake.history = "h2"; fake.rows.clear(); fake.save(scene("s", "restored")); edit([scene("s", "offline")]);
  expect((await syncSceneNotebook()).status).toBe("ready"); expect(readWorkingBucket(bucket).map((s) => s.name)).toEqual(["restored", "[old] offline"]); expect((await state()).buckets[bucket].states.s.base?.history).toBe("h2");
});
it("malformed row skips only that row and missing name/edges use stored-scene defaults", async () => {
  fake.book = "book1"; fake.save(scene()).data = "{}";
  fake.save({ id: "valid", cards: [], created_at: 1 } as unknown as Scene);
  await writeScenesStore({ [bucket]: [scene("old")] });
  expect((await syncSceneNotebook()).status).toBe("ready");
  expect(readWorkingBucket(bucket)).toMatchObject([{ id: "valid", name: "이름 없는 씬", edges: [] }]);
  expect(fake.rows.has("s")).toBe(true);
});
it("201-scene start uses multiple chunks with one snapshot", async () => {
  const scenes = Array.from({ length: 201 }, (_, i) => scene(`s${i}`)); await writeScenesStore({ [bucket]: scenes }); expect((await syncSceneNotebook()).status).toBe("ready");
  expect(fake.calls.filter((c) => c.path.endsWith("/start")).map((c) => c.body.upserts.length)).toEqual([200, 1, 0]); expect(fake.order).toEqual(scenes.map((s) => s.id));
});
it("pure reorder carries order base", async () => {
  await joined([scene("a"), scene("b")]); edit([scene("b"), scene("a")]); expect((await syncSceneNotebook()).status).toBe("ready"); expect(fake.order).toEqual(["b", "a"]);
});
it("new rows plus reorder advance only our own acknowledged order revision", async () => {
  await joined([scene("a"), scene("b")]); edit([scene("c"), scene("b"), scene("a")]);
  expect((await syncSceneNotebook()).status).toBe("ready"); expect(fake.order).toEqual(["c", "b", "a"]);
});
it("clean fast path notices an edit that arrived during the first GET", async () => {
  await joined(); let changed = false;
  hook = (p) => { if (!changed && p.includes("notebook?")) { changed = true; edit([scene("s", "new")]); } };
  expect((await syncSceneNotebook()).status).toBe("ready"); expect(JSON.parse(fake.rows.get("s")!.data).name).toBe("new");
});

it("c09 mirror starts within ten seconds during continuous edits and settles without a write loop", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
  await joined();
  const { initSceneBackup, countBackupOnlyScenes, importFromBackup } = await import("../src/lib/sceneBackup");
  await initSceneBackup();
  expect(await countBackupOnlyScenes()).toBe(0); expect(await importFromBackup()).toBe(0);
  fake.calls = [];
  for (let i = 0; i < 10; i++) {
    edit([scene("s", `edit${i}`)]); await settleSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(999);
  }
  expect(fake.calls.filter((c) => c.path.endsWith("/backup"))).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(10);
  expect(fake.calls.some((c) => c.path.endsWith("/backup"))).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  const count = fake.calls.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(fake.calls).toHaveLength(count);
  vi.clearAllTimers();
});

it("server start_too_big JSON detail enters local-edit mode", async () => {
  await writeScenesStore({ [bucket]: [] });
  fake.save(scene("hub"));
  hook = (p) => { if (p.endsWith("/start")) throw { status: 413, detail: JSON.stringify({ code: "start_too_big", scene_ids: ["hub"], local_edit_only: true }) }; };
  expect(await syncSceneNotebook()).toMatchObject({ status: "local_only", reason: "start_too_big" });
  expect((await state()).joined).toBeNull(); expect((await state()).starting).toBeNull(); expect(edit([scene()]).ok).toBe(true);
});
it("a provider mutating its token object cannot authorize an old response", async () => {
  await joined(); fake.save(scene("s", "remote"));
  hook = (p) => { if (p.includes("notebook?")) token!.generation = "g2"; };
  expect((await syncSceneNotebook()).status).toBe("waiting_token"); expect(readWorkingBucket(bucket)[0].name).toBe("s");
});
it("copy receive abort preserves original and pending receipt, then retries atomically", async () => {
  await joined(); fake.save(scene("s", "remote")); edit([scene("s", "local")]);
  hook = (p) => { if (p.endsWith("/backup")) abortSceneStoreWritesForTest(true); };
  expect((await syncSceneNotebook()).status).toBe("retry"); expect(readWorkingBucket(bucket).map((s) => s.name)).toEqual(["local"]);
  abortSceneStoreWritesForTest(false); hook = null;
  expect((await state()).writing).not.toBeNull(); expect((await syncSceneNotebook()).status).toBe("ready");
  expect(readWorkingBucket(bucket).map((s) => s.name)).toEqual(["remote", "[old] local"]);
});
it.each(["missing", "rewind", "reused"])("c09 %s row version resubmits old base without trusting a fresh GET", async (kind) => {
  await joined();
  if (kind === "missing") { fake.rows.clear(); fake.order = []; }
  else {
    const row = fake.save(scene("s", "remote")); row.base.rev = kind === "rewind" ? 0 : 1;
  }
  expect((await syncSceneNotebook()).status).toBe("ready");
  if (kind === "missing") expect(readWorkingBucket(bucket).map((s) => s.name)).toEqual(["s"]);
  else expect(readWorkingBucket(bucket).map((s) => s.name)).toEqual(["remote", "[old] s"]);
});
it("lost commit acknowledgement joins the committed notebook without starting twice", async () => {
  await writeScenesStore({ [bucket]: [scene()] }); let failures = 0;
  hook = (p, b) => { if ((p.endsWith("/start") && b.commit) || (failures > 0 && p.includes("notebook?"))) { failures++; throw Error("lost"); } };
  expect((await syncSceneNotebook()).status).toBe("retry"); hook = null; expect((await syncSceneNotebook()).status).toBe("ready");
  expect(fake.calls.filter((c) => c.path.endsWith("/start") && c.body.commit)).toHaveLength(1);
});
it("changed lease generation restarts an uncommitted staged attempt", async () => {
  await writeScenesStore({ [bucket]: [scene()] }); let failures = 0;
  hook = (p, b) => { if (failures < 3 && p.endsWith("/start") && !b.commit) { failures++; throw Error("lost"); } };
  expect((await syncSceneNotebook()).status).toBe("retry"); token = { ...token!, generation: "g2" };
  expect((await syncSceneNotebook()).status).toBe("ready");
  const stages = fake.calls.filter((c) => c.path.endsWith("/start") && !c.body.commit); expect(stages[0].body.attempt_id).not.toBe(stages.at(-1)!.body.attempt_id);
});

it.each(["rewind", "missing", "same-rev-different-hash"])("restore after upload cannot erase the uploaded edit: %s", async (mode) => {
  await joined(); edit([scene("s", "upload")]); let replaced = false;
  hook = (p) => {
    if (!replaced && p.endsWith("/backup")) {
      replaced = true; fake.rows.clear(); fake.order = [];
      if (mode !== "missing") { const row = fake.save(scene("s", "restore")); if (mode === "same-rev-different-hash") row.base.rev = 2; }
    }
  };
  expect((await syncSceneNotebook()).status).toBe("ready");
  expect(readWorkingBucket(bucket).some((s) => s.name.includes("upload"))).toBe(true);
});
it("read-only reconcile detects row loss between first and second GET", async () => {
  await joined(); fake.save(scene("s", "remote")); let gets = 0;
  hook = (p, _b, reply) => {
    if (p.includes("notebook?") && ++gets === 2) {
      fake.rows.clear(); fake.order = []; reply.items = []; reply.order.ids = [];
    }
  };
  expect((await syncSceneNotebook()).status).toBe("ready"); expect(readWorkingBucket(bucket)[0].name).toBe("s");
});

it("partial batch failure retries receipts without duplicating rows or losing order", async () => {
  await joined([]);
  const scenes = Array.from({ length: 201 }, (_, i) => scene(`s${i}`)).reverse(); edit(scenes);
  let failed = false;
  hook = (p, b) => { if (!failed && p.endsWith("/backup") && b.upserts.length === 1) { failed = true; throw Error("lost second batch"); } };
  expect((await syncSceneNotebook()).status).toBe("ready"); expect(fake.rows.size).toBe(201);
  expect(fake.order).toEqual(scenes.map((s) => s.id));
  const first = fake.calls.filter((c) => c.path.endsWith("/backup") && c.body.upserts.length === 200);
  expect(first).toHaveLength(2); expect(first[0].body).toEqual(first[1].body);
});

it.each([false, true])("P0 edit during PUT advances receipt base without copies (new scene %s)", async (fresh) => {
  await joined(fresh ? [] : [scene()]); edit([scene("s", "first")]);
  let once = false;
  hook = (p, body) => { if (!once && p.endsWith("/backup") && body.upserts.length) { once = true; edit([scene("s", "second")]); } };
  expect((await syncSceneNotebook()).status).toBe("ready");
  expect([...fake.rows.keys()]).toEqual(["s"]);
  expect(JSON.parse(fake.rows.get("s")!.data).name).toBe("second");
  expect([...fake.receipts.values()].flatMap((r) => r.results).map((r) => r.status)).toEqual(["saved", "saved"]);
});
it("unchanged old history receives existing hub row without uploading old content", async () => {
  await joined(); fake.history = "h2"; fake.rows.clear(); fake.save(scene("s", "restored"));
  expect((await syncSceneNotebook()).status).toBe("ready");
  expect(fake.calls.flatMap((c) => c.body?.upserts ?? [])).toHaveLength(0);
  expect(readWorkingBucket(bucket)[0].name).toBe("restored");
});
it("upload_failed copy reduced below limit uploads as its independent id", async () => {
  await joined(); edit([scene(), { ...scene("local-copy"), localNotebookCopy: "upload_failed" }]);
  expect((await syncSceneNotebook()).status).toBe("ready");
  expect(fake.rows.has("local-copy")).toBe(true);
  expect(readWorkingBucket(bucket).find((s) => s.id === "local-copy")?.localNotebookCopy).toBeUndefined();
});

it.each(["copied", "too_big"])("MCP %s leaves completion pending", async (kind) => {
  await joined();
  if (kind === "copied") fake.save(scene("s", "remote"));
  const appended = { ...scene("s", "attached"), mcpAttachmentReceipts: ["task"], ...(kind === "too_big" ? { padding: "x".repeat(5 * 1024 * 1024) } : {}) };
  edit([appended]);
  expect(await completeNotebookMcpTask("local", "s", "task")).toBe(false);
  expect([...fake.receipts.values()].flatMap((r) => r.mcp_done)).toEqual([]);
});
it("MCP existing local receipt forces same and confirms only server receipt", async () => {
  await joined([{ ...scene(), mcpAttachmentReceipts: ["task"] }]);
  expect(await completeNotebookMcpTask("local", "s", "task")).toBe(true);
  expect([...fake.receipts.values()].flatMap((r) => r.results).map((r) => r.status)).toEqual(["same"]);
});
it("MCP more than 500 receipts splits completion without losing the newest task", async () => {
  const ids = Array.from({ length: 501 }, (_, i) => `task-${i}`);
  await joined(); edit([{ ...scene(), mcpAttachmentReceipts: ids }]);
  expect(await completeNotebookMcpTask("local", "s", "task-500")).toBe(true);
  expect(fake.calls.filter((c) => c.body?.mcp_complete).map((c) => c.body.mcp_complete.length)).toEqual([500, 1]);
});

it("delete during a new-scene PUT inherits our saved base but retains the deletion intent", async () => {
  await joined([]); edit([scene()]); let once = false;
  hook = (p, body) => { if (!once && p.endsWith("/backup") && body.upserts.length) { once = true; edit([]); } };
  expect((await syncSceneNotebook()).status).toBe("ready");
  expect(readWorkingBucket(bucket)).toEqual([]); expect(fake.rows.get("s")?.deleted_at).toBeTruthy();
  expect([...fake.rows.keys()]).toEqual(["s"]);
});
it("bad hub row preserves its existing local scene while other rows reconcile", async () => {
  await joined([scene("s"), scene("ok")]);
  fake.rows.get("s")!.data = "{}"; fake.save(scene("ok", "remote"));
  expect((await syncSceneNotebook()).status).toBe("ready");
  expect(readWorkingBucket(bucket)).toEqual([scene("ok", "remote"), scene("s")]);
  expect((await state()).buckets[bucket].states.s.base?.hash).toBe(hash(JSON.stringify(scene("s"))));
});

it("missing notebook with unreadable live hub rows still establishes those rows using expected zero", async () => {
  await joined(); fake.book = null; fake.rows.get("s")!.data = "{}";
  expect((await syncSceneNotebook()).status).toBe("ready");
  expect(fake.calls.filter((c) => c.path.endsWith("/start")).every((c) => c.body.expected_count === 0)).toBe(true);
  expect(fake.rows.get("s")!.data).toBe("{}");
  expect(readWorkingBucket(bucket)).toEqual([scene()]);
});
