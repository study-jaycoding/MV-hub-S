// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canRetryLocalNotebook, SceneWriterClient, type WriterStatus } from "../src/lib/sceneWriter";
import * as scenes from "../src/lib/scenes";
import type { NotebookSyncResult } from "../src/lib/sceneNotebook";
import * as sceneNotebook from "../src/lib/sceneNotebook";
import { joinSceneNotebook, setSceneNotebookTokenProvider, syncSceneNotebook } from "../src/lib/sceneNotebook";
import { initSceneStore, resetSceneStoreForTest, setSceneWriteGate, settleSceneStoreForTest } from "../src/lib/sceneStore";
import { setHubFeatures } from "../src/lib/hubFeatures";
import { setAccountScope } from "../src/lib/accountScope";
import { createHash } from "node:crypto";
import { HttpError } from "../src/lib/http";

const ready = { status: "ready" as const, changed: false };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function harness() {
  let account = "A", eligible = true, serial = 0;
  let server: WriterStatus = { boot_id: "boot1", account_epoch: 1, writer: null, handoff: null };
  const calls: Record<string, unknown>[] = [];
  const deps = {
    account: () => account, eligible: () => eligible,
    send: vi.fn(async (_account: string, body: Record<string, unknown>): Promise<WriterStatus> => {
      calls.push(body);
      const action = body.action;
      if (action === "claim" || action === "force") {
        if (action === "claim" && server.writer) throw { detail: "writer_busy" };
        serial++;
        server = { ...server, token: `token${serial}`, writer: { browser_id: "browser", tab_id: "tab", generation: `g${serial}`, expires_in_ms: 90000 }, handoff: null };
      }
      if (action === "renew" || action === "release") {
        if (body.token !== server.token) throw { detail: "writer_required" };
        if (action === "release") server = { ...server, writer: null, token: undefined };
      }
      if (action === "request") return { ...server, request_id: "request" };
      return structuredClone(server);
    }),
    sync: vi.fn(async (_fresh?: boolean): Promise<NotebookSyncResult> => ready), settle: vi.fn(async () => true), lost: vi.fn(),
    generation: vi.fn(), changed: vi.fn(), notice: vi.fn(), names: () => "큰 씬", localCount: () => 2,
    canRetryLocal: vi.fn((_reason: string | undefined, _sceneIds: string[]) => true),
  };
  const client = new SceneWriterClient(deps, "browser", "tab");
  const other = () => { server = { ...server, token: "other", writer: { browser_id: "other", tab_id: "other", generation: "other", expires_in_ms: 90000 } }; };
  return { client, deps, calls, other, server: () => server, setServer: (value: WriterStatus) => { server = value; }, account: (value: string) => { account = value; }, eligible: (value: boolean) => { eligible = value; } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("hub scene writer", () => {
  async function joinedWriter() {
    const initial = ["a", "b", "c"].map(id => ({ id, name: id, cards: [], edges: [], created_at: 1 }));
    setAccountScope(null); setHubFeatures(["scene_writer_v1"]); setSceneWriteGate(() => false);
    await initSceneStore(() => ({ "local::_none": initial }), null, () => true);
    await joinSceneNotebook("local", "book", "history", { "local::_none": {
      scenes: initial, bases: Object.fromEntries(initial.map(scene => [scene.id, { history: "history", rev: 1,
        hash: createHash("sha256").update(JSON.stringify(scene)).digest("hex") }])), order: { history: "history", rev: 1 },
    } }, undefined, "restore-1");
    const h = harness(); h.account("local");
    setSceneNotebookTokenProvider(() => h.client.token());
    h.client.configure(true); await h.client.refresh();
    return h;
  }
  async function closeStore() {
    await settleSceneStoreForTest(); setSceneNotebookTokenProvider(() => null);
    setHubFeatures([]); setSceneWriteGate(() => false); resetSceneStoreForTest();
  }
  it("pagehide sends the last rename, deletion and tab order together with the release token", async () => {
    const h = await joinedWriter();
    try {
      scenes.updateScene(null, "a", { name: "last rename" });
      scenes.deleteScene(null, "b");
      scenes.updateScenesWith(null, current => [current.find(s => s.id === "c")!, current.find(s => s.id === "a")!]);
      const send = vi.fn(); h.client.releaseBeacon(send);
      expect(send).toHaveBeenCalledOnce();
      const [body, path, account] = send.mock.calls[0];
      expect(path).toBe("/api/scenes/notebook/close"); expect(account).toBe("local");
      const payload = JSON.parse(body);
      expect(payload.token).toBe("token1");
      expect(payload.upserts.map((up: { data: string }) => JSON.parse(up.data))).toEqual([expect.objectContaining({ id: "a", name: "last rename" })]);
      expect(payload.deletes).toEqual([expect.objectContaining({ id: "b", base: expect.objectContaining({ history_id: "history", rev: 1 }) })]);
      expect(payload.order.ids).toEqual(["c", "a"]);
      expect(h.client.token()).toBeNull();
      expect((await syncSceneNotebook()).status).toBe("waiting_token");
    } finally { await closeStore(); }
  });
  it("a UTF-8 close body over 64 KiB releases only and preserves the local edit for reopening", async () => {
    const h = await joinedWriter();
    try {
      const name = "한".repeat(23_000);
      scenes.updateScene(null, "a", { name });
      const send = vi.fn(); h.client.releaseBeacon(send);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0].slice(1)).toEqual(["/api/scenes/writer", "local"]);
      expect(JSON.parse(send.mock.calls[0][0])).toEqual({ action: "release", token: "token1" });
      await settleSceneStoreForTest();
      expect(scenes.listPersistedScenes(null).find(s => s.id === "a")?.name).toBe(name);
      expect(h.client.token()).toBeNull();
    } finally { await closeStore(); }
  });
  it("a late synchronization response after the combined close cannot restore upload authority", async () => {
    const h = await joinedWriter();
    try {
      scenes.updateScene(null, "a", { name: "last rename" });
      const late = deferred<typeof ready>(); h.deps.sync.mockReturnValueOnce(late.promise);
      const run = h.client.refresh(); await vi.advanceTimersByTimeAsync(0);
      const send = vi.fn(); h.client.releaseBeacon(send);
      expect(send.mock.calls[0][1]).toBe("/api/scenes/notebook/close");
      const generationCalls = h.deps.generation.mock.calls.length;
      late.resolve(ready); await run;
      expect(h.client.token()).toBeNull(); expect(h.deps.generation).toHaveBeenCalledTimes(generationCalls);
      expect((await syncSceneNotebook()).status).toBe("waiting_token");
    } finally { await closeStore(); }
  });
  it("an expired token during first sync exits the locked screen with recovery actions", async () => {
    const h = harness(); h.client.configure(true);
    h.deps.sync.mockResolvedValueOnce({ status: "waiting_token", changed: false });
    await h.client.refresh();
    expect(h.client.view.mode).toBe("away"); expect(h.client.view.error).toBeTruthy();
    expect(h.calls.at(-1)).toMatchObject({ action: "release", token: "token1" });
  });
  it("feature off and profile follower never contact the hub", async () => {
    const h = harness(); await h.client.refresh(); expect(h.calls).toEqual([]);
    h.client.configure(true); h.eligible(false); await h.client.refresh(); expect(h.calls).toEqual([]);
  });
  it("claims then settles inputs and synchronizes before opening editing", async () => {
    const h = harness(), syncing = deferred<typeof ready>();
    h.deps.sync.mockReturnValueOnce(syncing.promise); h.client.configure(true);
    const run = h.client.refresh(); await vi.advanceTimersByTimeAsync(0);
    expect(h.client.view.mode).toBe("syncing"); expect(h.deps.settle).toHaveBeenCalledOnce();
    syncing.resolve(ready); await run; expect(h.client.view.mode).toBe("writer"); expect(h.client.token()?.generation).toBe("g1");
  });
  it("three initial reconcile failures release authority and allow an explicit retry", async () => {
    const h = harness(); h.client.configure(true);
    h.deps.sync.mockResolvedValue({ status: "retry", changed: false, reason: "reconcile_limit" });
    await h.client.refresh();
    expect(h.deps.sync).toHaveBeenCalledTimes(3); expect(h.client.token()).toBeNull();
    expect(h.client.view).toMatchObject({ mode: "away", handed: false }); expect(h.client.view.error).toContain("전체 내보내기");
    expect(h.calls.at(-1)).toMatchObject({ action: "release", token: "token1" });
    await h.client.refresh(); expect(h.deps.sync).toHaveBeenCalledTimes(3);
    h.deps.sync.mockResolvedValue(ready); await h.client.take();
    expect(h.client.view.mode).toBe("writer"); expect(h.client.view.error).toBeUndefined();
    expect(h.client.token()?.token).toBe("token2");
  });
  it("initial status hides the board briefly, then allows local editing if the hub hangs", async () => {
    const h = harness(), response = deferred<WriterStatus>(); h.client.configure(true);
    h.deps.send.mockReturnValueOnce(response.promise); const run = h.client.refresh(false);
    expect(h.client.view.mode).toBe("checking"); await vi.advanceTimersByTimeAsync(1499);
    expect(h.client.view.mode).toBe("checking"); await vi.advanceTimersByTimeAsync(1);
    expect(h.client.view.mode).toBe("uncertain"); response.resolve(h.server()); await run;
    expect(h.client.view.mode).toBe("writer");
  });
  it("normal handoff blocks, flushes, uploads, then releases with the captured token", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh();
    const events: string[] = [];
    h.deps.changed.mockImplementation((view) => { events.push(view.mode); });
    h.deps.settle.mockImplementation(async () => { events.push("flush"); return true; });
    h.deps.sync.mockImplementation(async () => { events.push("upload"); return ready; });
    h.setServer({ ...h.server(), handoff: { request_id: "req", generation: "g1", browser_id: "other", tab_id: "other" } });
    await h.client.refresh();
    expect(events).toEqual(["giving", "flush", "upload", "away"]);
    expect(h.deps.sync).toHaveBeenLastCalledWith(true);
    expect(h.calls.at(-1)).toMatchObject({ action: "release", token: "token1" });
    expect(h.client.view.handed).toBe(true);
    await h.client.refresh(); expect(h.calls.at(-1)?.action).toBe("status");
    h.other(); await h.client.refresh(); await h.client.refresh();
    expect(h.client.view).toMatchObject({ mode: "away", handed: true });
    expect(h.deps.lost).toHaveBeenCalledOnce();
  });
  it("failed input flush never releases or reports a normal handoff", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh(); h.deps.settle.mockResolvedValueOnce(false);
    h.setServer({ ...h.server(), handoff: { request_id: "r", generation: "g1", browser_id: "other", tab_id: "other" } });
    await h.client.refresh(); expect(h.calls.some((x) => x.action === "release")).toBe(false); expect(h.client.view.handed).toBe(false);
  });
  it("a late upload after five seconds cannot release", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh();
    const wait = deferred<typeof ready>(); h.deps.sync.mockReturnValueOnce(wait.promise);
    h.setServer({ ...h.server(), handoff: { request_id: "r", generation: "g1", browser_id: "other", tab_id: "other" } });
    const run = h.client.refresh(); await vi.advanceTimersByTimeAsync(5001); await run;
    wait.resolve(ready); await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.some((x) => x.action === "release")).toBe(false); expect(h.client.view.handed).toBe(false);
  });
  it("request polls for five seconds and only force receives the forced notice", async () => {
    const h = harness(); h.other(); h.client.configure(true);
    const run = h.client.take(); await vi.advanceTimersByTimeAsync(4999);
    expect(h.calls.some((x) => x.action === "force")).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await run;
    expect(h.calls.filter((x) => x.action === "status")).toHaveLength(6);
    expect(h.calls.at(-1)).toMatchObject({ action: "force", request_id: "request" });
    expect(h.deps.notice.mock.calls[0][0]).toContain("강제로 넘겨받았습니다\n");
  });
  it("released owner is claimed without force and normal notice follows a clean sync", async () => {
    const h = harness(); h.client.configure(true); await h.client.take();
    expect(h.deps.notice).toHaveBeenCalledWith("넘겨받았습니다"); expect(h.calls.some((x) => x.action === "force")).toBe(false);
  });
  it("an owner releasing exactly at the deadline is claimed normally after a final status", async () => {
    const h = harness(); h.other(); h.client.configure(true);
    const original = h.deps.send.getMockImplementation()!; let lookups = 0;
    h.deps.send.mockImplementation((account, body) => {
      if (body.action === "status" && ++lookups === 6) h.setServer({ ...h.server(), writer: null, token: undefined });
      return original(account, body);
    });
    const run = h.client.take(); await vi.advanceTimersByTimeAsync(5000); await run;
    expect(h.calls.filter((c) => c.action === "status")).toHaveLength(6);
    expect(h.calls.at(-1)?.action).toBe("claim"); expect(h.calls.some((c) => c.action === "force")).toBe(false);
    expect(h.deps.notice).toHaveBeenCalledWith("넘겨받았습니다");
  });
  it("a third party winning claim does not open editing or claim success", async () => {
    const h = harness(); h.client.configure(true);
    const original = h.deps.send.getMockImplementation()!;
    h.deps.send.mockImplementation(async (account, body) => { if (body.action === "claim") h.other(); return original(account, body); });
    await h.client.take(); expect(h.client.view.mode).toBe("away"); expect(h.deps.notice).not.toHaveBeenCalled();
  });
  it("account A to B to A invalidates the original late claim", async () => {
    const h = harness(), response = deferred<WriterStatus>();
    h.client.configure(true); h.deps.send.mockReturnValueOnce(response.promise);
    const run = h.client.refresh(); h.account("B"); h.client.configure(true); h.account("A"); h.client.configure(true);
    response.resolve(h.server()); await run;
    expect(h.calls).toEqual([]); expect(h.client.token()).toBeNull();
  });
  it("BFCache/suspension clears upload authority and renew is first on return", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh(); h.calls.length = 0;
    h.client.releaseBeacon(() => {});
    h.client.resume(); expect(h.client.token()).toBeNull(); await h.client.refresh(false);
    expect(h.calls[0].action).toBe("renew"); expect(h.client.token()?.token).toBe("token1");
  });
  it.each([true, false])("BFCache return blocks editing until close receipts reconcile (released=%s)", async (released) => {
    const h = harness(); h.client.configure(true); await h.client.refresh();
    h.client.releaseBeacon(() => {});
    if (released) h.setServer({ ...h.server(), writer: null, token: undefined });
    const syncing = deferred<typeof ready>(); h.deps.sync.mockReturnValueOnce(syncing.promise);
    h.client.resume(); const run = h.client.refresh(false);
    expect(h.client.view.mode).toBe("syncing");
    expect(h.client.token()).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client.view.mode).toBe("syncing");
    expect(h.deps.sync).toHaveBeenCalledTimes(2);
    syncing.resolve(ready); await run;
    expect(h.client.view.mode).toBe("writer");
    expect(h.client.token()?.token).toBe(released ? "token2" : "token1");
  });
  it.each(["renew", "status"])("BFCache offline %s allows local editing then reconciles after hub recovery", async (phase) => {
    const h = harness(); h.client.configure(true); await h.client.refresh();
    h.client.releaseBeacon(() => {}); h.calls.length = 0; h.deps.sync.mockClear();
    const send = h.deps.send.getMockImplementation()!;
    let offline = true;
    h.deps.send.mockImplementation(async (account, body) => {
      if (offline && body.action === phase) throw new TypeError("Failed to fetch");
      return send(account, body);
    });
    if (phase === "status") h.setServer({ ...h.server(), writer: null, token: undefined });
    h.client.resume(); await h.client.refresh(false);
    expect(h.client.view.mode).toBe("uncertain"); expect(h.client.token()).toBeNull();
    expect(h.deps.lost).not.toHaveBeenCalled(); expect(h.deps.sync).not.toHaveBeenCalled();
    expect(h.calls.some(c => c.action === "release")).toBe(false);
    offline = false;
    h.setServer({ ...h.server(), writer: null, token: undefined }); h.calls.length = 0;
    await h.client.refresh(false);
    expect(h.calls.map(c => c.action)).toEqual(["renew", "status", "claim"]);
    expect(h.deps.sync).toHaveBeenCalledOnce(); expect(h.client.view.mode).toBe("writer");
  });
  it("BFCache HTTP 500 still releases and reports failed initial reconciliation", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh();
    h.client.releaseBeacon(() => {}); h.calls.length = 0;
    h.deps.send.mockRejectedValueOnce(new HttpError(500, "server error"));
    h.client.resume(); await h.client.refresh(false);
    expect(h.calls).toEqual([{ action: "release", browser_id: "browser", tab_id: "tab", token: "token1" }]);
    expect(h.client.view).toMatchObject({ mode: "away", error: expect.stringContaining("전체 내보내기") });
    expect(h.client.token()).toBeNull();
  });
  it("BFCache network failure after claim still fails the initial reconciliation", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh();
    h.client.releaseBeacon(() => {}); h.setServer({ ...h.server(), writer: null, token: undefined });
    h.deps.settle.mockRejectedValueOnce(new TypeError("post-claim failure"));
    await h.client.refresh(false);
    expect(h.calls.at(-1)).toMatchObject({ action: "release", token: "token2" });
    expect(h.client.view.mode).toBe("away");
  });
  it("focus checks retain authority without renew or sync; the twenty second timer only renews", async () => {
    let clock = 100; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const h = harness(); h.client.configure(true); await h.client.refresh();
    h.calls.length = 0; h.deps.sync.mockClear();
    for (let i = 0; i < 5; i++) { h.client.resume(); expect(h.client.token()?.token).toBe("token1"); await h.client.refresh(false); }
    expect(h.calls.map((c) => c.action)).toEqual(Array(5).fill("status")); expect(h.deps.sync).not.toHaveBeenCalled();
    h.calls.length = 0; clock += 20000; await h.client.refresh(false, true);
    expect(h.calls.map((c) => c.action)).toEqual(["renew"]); expect(h.deps.sync).not.toHaveBeenCalled();
    h.calls.length = 0; clock += 89000; h.client.resume(); expect(h.client.token()).toBeNull(); await h.client.refresh(false);
    expect(h.calls.map((c) => c.action)).toEqual(["renew"]); expect(h.client.token()?.token).toBe("token1");
    expect(h.deps.sync).not.toHaveBeenCalled();
  });
  it("hub restart loses old authority, claims a new token and synchronizes again", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh();
    h.deps.changed.mockClear();
    h.setServer({ boot_id: "boot2", account_epoch: 1, writer: null, handoff: null });
    h.client.resume(); await h.client.refresh(); expect(h.deps.lost).not.toHaveBeenCalled();
    expect(h.deps.changed.mock.calls.every(([view]) => view.mode === "writer")).toBe(true);
    expect(h.client.token()?.token).toBe("token2"); expect(h.deps.sync).toHaveBeenCalledTimes(2);
  });
  it("network loss leaves the previous writer locally editable but stops token uploads", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh();
    h.deps.send.mockRejectedValueOnce(new TypeError("offline")); await h.client.refresh();
    expect(h.client.view.mode).toBe("uncertain"); expect(h.client.token()).toBeNull(); expect(h.deps.lost).not.toHaveBeenCalled();
  });
  it("lost lease isolates pending writes and remains away while hub is offline", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh(); h.other(); await h.client.refresh();
    h.deps.send.mockRejectedValueOnce(new TypeError("offline")); await h.client.refresh();
    expect(h.client.view.mode).toBe("away"); expect(h.deps.lost).toHaveBeenCalled();
    await h.client.refresh(); await h.client.refresh(); expect(h.deps.lost).toHaveBeenCalledOnce();
  });
  it("release beacon contains the old token in its body and invalidates late responses", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh(); const send = vi.fn();
    h.client.releaseBeacon(send); expect(JSON.parse(send.mock.calls[0][0])).toEqual({ action: "release", token: "token1" }); expect(h.client.token()).toBeNull();
  });
  it("disabling sends a release for the captured account and original token", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh(); h.deps.send.mockClear();
    h.account("B"); h.client.configure(false); await vi.advanceTimersByTimeAsync(0);
    expect(h.deps.send).toHaveBeenCalledWith("A", { action: "release", token: "token1" });
    expect(h.client.view.mode).toBe("disabled"); expect(h.client.token()).toBeNull();
  });
  it("an upload network failure also keeps local editing available", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh();
    h.deps.sync.mockResolvedValueOnce({ status: "retry", changed: false, reason: "network_failed" });
    await h.client.refresh(); expect(h.client.view.mode).toBe("uncertain"); expect(h.client.token()).toBeNull();
  });
  it("the losing tab cannot steal a later release intended for a third browser", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh(); h.other(); await h.client.refresh();
    h.setServer({ ...h.server(), writer: null }); h.calls.length = 0; await h.client.refresh();
    expect(h.calls.map((c) => c.action)).toEqual(["status"]); expect(h.client.view.mode).toBe("away");
  });
  it("oversize start stays local across edits and focus until every scene fits", async () => {
    const h = harness(); h.client.configure(true);
    h.deps.canRetryLocal.mockImplementation(canRetryLocalNotebook);
    const small: scenes.Scene = { id: "large", name: "large", created_at: 1, cards: [], edges: [] };
    let current = [{ ...small, name: "한".repeat(2 * 1024 * 1024) }];
    vi.spyOn(scenes, "listScenes").mockImplementation(() => current);
    h.deps.sync.mockResolvedValueOnce({ status: "local_only", changed: false, reason: "start_too_big", sceneIds: ["large"] });
    await h.client.refresh(); expect(h.client.view.mode).toBe("local_only"); expect(h.client.token()).toBeNull();
    expect(h.deps.notice).toHaveBeenCalledWith("5MB가 넘는 씬이 있어 다른 브라우저와 같이 쓰지 못합니다 — 이 브라우저에만 저장됩니다: 큰 씬");
    h.calls.length = 0; h.deps.changed.mockClear();
    for (let i = 0; i < 3; i++) {
      current = [{ ...current[0], created_at: i }];
      h.client.localChanged(); h.client.resume(); await h.client.refresh();
      expect(h.client.view.mode).toBe("local_only");
    }
    expect(h.calls).toEqual([]); expect(h.deps.changed).not.toHaveBeenCalled();
    expect(h.deps.sync).toHaveBeenCalledOnce(); expect(h.deps.notice).toHaveBeenCalledOnce();
    expect(h.deps.canRetryLocal).toHaveBeenLastCalledWith("start_too_big", ["large"]);
    // 첫 초과 씬을 줄여도 이후 추가한 씬이 크면 다시 잠그지 않는다.
    current = [small, { ...current[0], id: "new-large" }];
    h.client.localChanged(); await h.client.refresh(); expect(h.calls).toEqual([]);
    current = [small];
    const staging = deferred<typeof ready>(); h.deps.sync.mockReturnValueOnce(staging.promise);
    h.client.localChanged(); const retry = h.client.refresh(); await vi.advanceTimersByTimeAsync(0);
    expect(h.client.view.mode).toBe("local_only");
    expect(h.deps.changed.mock.calls.some(([view]) => ["taking", "syncing"].includes(view.mode))).toBe(false);
    for (let i = 0; i < 3; i++) { h.client.localChanged(); void h.client.refresh(); }
    expect(h.calls.filter(call => call.action === "claim")).toHaveLength(1);
    staging.resolve(ready); await retry; await vi.advanceTimersByTimeAsync(0);
    expect(h.client.view.mode).toBe("writer"); expect(h.calls.filter(call => call.action === "claim")).toHaveLength(1);
  });
  it("first-start confirmation releases the lease and cannot be retried by edits, focus, timer or take", async () => {
    const h = harness(); h.client.configure(true);
    h.deps.sync.mockResolvedValueOnce({ status: "local_only", changed: false, reason: "start_confirmation" });
    await h.client.refresh();
    expect(h.client.view.mode).toBe("local_only"); expect(h.client.token()).toBeNull();
    expect(h.calls.some((call) => call.action === "release")).toBe(true);
    h.calls.length = 0;
    for (let i = 0; i < 3; i++) { h.client.localChanged(); h.client.resume(); await h.client.refresh(); await h.client.take(); }
    expect(h.calls).toEqual([]); expect(h.deps.sync).toHaveBeenCalledOnce();
    expect(canRetryLocalNotebook("start_confirmation")).toBe(false);
  });
  it.each(["same", "boot", "account epoch", "peer lease"])("first-start approval is bound to the observed server and account epoch: %s", async (change) => {
    const h = harness(); h.client.configure(true);
    h.deps.sync.mockResolvedValueOnce({ status: "local_only", changed: false, reason: "start_confirmation" });
    await h.client.refresh();
    const approval = { kind: "confirm" as const, id: "offer", account: "A", count: 1, localFingerprint: "local", bookFingerprint: "book" };
    vi.spyOn(sceneNotebook, "prepareNotebookStart").mockResolvedValue(approval);
    if (change === "boot") h.setServer({ ...h.server(), boot_id: "restarted" });
    if (change === "account epoch") h.setServer({ ...h.server(), account_epoch: 3 });
    if (change === "peer lease") {
      h.other();
      const send = h.deps.send.getMockImplementation()!;
      h.deps.send.mockImplementation(async (account, body) => {
        if (body.action === "status") h.setServer({ ...h.server(), writer: null, token: undefined });
        return send(account, body);
      });
    }
    await h.client.startNotebook("offer");
    expect(h.deps.sync).toHaveBeenLastCalledWith(false, change === "same" ? approval : undefined);
  });
  it("empty notebook retries only when the first local scene appears", async () => {
    const h = harness(); h.client.configure(true);
    h.deps.canRetryLocal.mockImplementation(canRetryLocalNotebook);
    const current = vi.spyOn(scenes, "listScenes").mockReturnValue([]);
    h.deps.sync.mockResolvedValueOnce({ status: "local_only", changed: false, reason: "empty_notebook" });
    await h.client.refresh(); h.calls.length = 0;
    h.client.localChanged(); await h.client.refresh(); expect(h.calls).toEqual([]);
    current.mockReturnValue([{ id: "first", name: "first", created_at: 1, cards: [], edges: [] }]);
    h.client.localChanged(); await h.client.refresh(); expect(h.client.view.mode).toBe("writer");
  });
  it("local size eligibility includes JSON overhead and uses UTF-8 byte length", () => {
    const scene = { id: "large", name: "", created_at: 1, cards: [], edges: [] };
    const bytes = new TextEncoder().encode(JSON.stringify(scene)).byteLength;
    const atLimit = { ...scene, name: "x".repeat(5 * 1024 * 1024 - bytes) };
    const current = vi.spyOn(scenes, "listScenes").mockReturnValue([atLimit]);
    expect(canRetryLocalNotebook("start_too_big")).toBe(true);
    current.mockReturnValue([{ ...atLimit, name: atLimit.name + "x" }]);
    expect(canRetryLocalNotebook("start_too_big")).toBe(false);
    current.mockReturnValue([{ ...scene, name: "한".repeat(2 * 1024 * 1024) }]);
    expect(canRetryLocalNotebook("start_too_big")).toBe(false);
  });
  it("a floating window which cannot be collected prevents uploads and editing", async () => {
    const h = harness(); h.client.configure(true); h.deps.settle.mockResolvedValueOnce(false);
    await h.client.refresh(); expect(h.client.token()).toBeNull(); expect(h.deps.sync).not.toHaveBeenCalled();
    expect(h.client.view).toMatchObject({ mode: "away", error: "분리 캔버스 창을 닫아 주세요" });
    await h.client.refresh(); expect(h.client.view.mode).toBe("away");
    await h.client.take(); expect(h.client.view.mode).toBe("writer");
  });
  it("a signal received while checking is queried again rather than lost", async () => {
    const h = harness(), reply = deferred<WriterStatus>(); h.client.configure(true);
    h.deps.send.mockReturnValueOnce(reply.promise); const run = h.client.refresh(); void h.client.refresh();
    reply.resolve(h.server()); await run; await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.filter((c) => c.action === "status")).toHaveLength(1); // first status was the delayed mock
    expect(h.calls.some((c) => c.action === "renew")).toBe(false);
  });
  it("a hung final status lookup stops takeover without guessing force success", async () => {
    const h = harness(); h.other(); h.client.configure(true);
    const original = h.deps.send.getMockImplementation()!;
    h.deps.send.mockImplementation((account, body) => body.action === "status" ? new Promise(() => {}) : original(account, body));
    const run = h.client.take(); await vi.advanceTimersByTimeAsync(6500); await run;
    expect(h.calls.some((c) => c.action === "force")).toBe(false);
    expect(h.client.view.mode).toBe("away"); expect(h.client.view.error).toBeTruthy();
  });
  it("late release acknowledgement after the deadline is never labelled a normal handoff", async () => {
    const h = harness(); h.client.configure(true); await h.client.refresh();
    const original = h.deps.send.getMockImplementation()!, late = deferred<WriterStatus>();
    h.deps.send.mockImplementation((account, body) => body.action === "release" ? late.promise : original(account, body));
    h.setServer({ ...h.server(), handoff: { request_id: "r", generation: "g1", browser_id: "other", tab_id: "other" } });
    const run = h.client.refresh(); await vi.advanceTimersByTimeAsync(5001); late.resolve(h.server()); await run;
    expect(h.client.view.handed).toBe(false);
  });
  it("floating window keeps its opening generation, has no hub token, and keeps local writes without a main", async () => {
    vi.resetModules();
    window.name = "contenthub-canvas"; localStorage.clear(); sessionStorage.clear();
    sessionStorage.setItem("mvhub.sceneLeaseGeneration", "opened-generation");
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const channels = new Map<string, { onmessage?: (event: MessageEvent) => void }>();
    vi.stubGlobal("BroadcastChannel", class {
      onmessage?: (event: MessageEvent) => void;
      constructor(name: string) { channels.set(name, this); }
      postMessage() {} close() {}
    });
    const opener = { closed: false }; vi.stubGlobal("opener", opener);
    const store = await import("../src/lib/sceneStore");
    const scenes = await import("../src/lib/scenes");
    const features = await import("../src/lib/hubFeatures");
    const popup = await import("../src/lib/popupWindows");
    const runtime = await import("../src/lib/sceneWriter");
    try {
      await store.initSceneStore(() => ({ "local::_none": [{ id: "s", name: "s", created_at: 1, cards: [], edges: [] }] }), null, () => true);
      features.setHubFeatures(["scene_writer_v1"]); runtime.startSceneWriter();
      scenes.updateScene(null, "s", { name: "분리 창 편집" });
      expect(store.unconfirmedSceneWrites()[0].leaseGeneration).toBe("opened-generation");
      await store.settleSceneStoreForTest();
      channels.get("mvhub-scene-lease")!.onmessage!(new MessageEvent("message", { data: { account: "local", paused: true } }));
      expect(runtime.getSceneWriterView()).toMatchObject({ mode: "away", floating: true });
      expect(popup.isCanvasFloating()).toBe(true);
      opener.closed = true; await vi.advanceTimersByTimeAsync(1000);
      expect(popup.isCanvasFloating()).toBe(false);
      expect(runtime.getSceneWriterView()).toMatchObject({ mode: "local_only", floating: true });
      expect(scenes.listScenes(null)[0].name).toBe("분리 창 편집");
      runtime.signalSceneWriter(); expect(network).not.toHaveBeenCalled();
    } finally {
      features.setHubFeatures([]); window.name = ""; store.resetSceneStoreForTest(); vi.unstubAllGlobals();
    }
  });
  it("hidden flushes and requests a fresh sync, then pagehide makes one keepalive close POST", async () => {
    vi.resetModules(); window.name = ""; localStorage.clear(); sessionStorage.clear();
    const events: string[] = [];
    const sync = vi.fn(async () => { events.push("sync"); return ready; });
    const closeBody = JSON.stringify({ token: "runtime-token", upserts: [{ id: "a", name: "flushed" }] });
    const buildClose = vi.fn(() => { events.push("close-body"); return closeBody; });
    const jsonFetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/scenes/notebook/close") return {};
      if (path !== "/api/scenes/writer") throw new Error(`unexpected ${path}`);
      const action = JSON.parse(String(init?.body)).action;
      return { boot_id: "boot", account_epoch: 1, handoff: null, ...(action === "status"
        ? { writer: null } : { token: "runtime-token", writer: { browser_id: "browser", tab_id: "tab", generation: "g", expires_in_ms: 90000 } }) };
    });
    vi.doMock("../src/lib/http", async () => ({ ...await vi.importActual<typeof import("../src/lib/http")>("../src/lib/http"), jsonFetch, getApiPause: () => false }));
    vi.doMock("../src/lib/popupWindows", async () => ({ ...await vi.importActual<typeof import("../src/lib/popupWindows")>("../src/lib/popupWindows"),
      hasProfileSceneWriter: () => true, isCanvasWindow: () => false, collectCanvasForWriter: async () => true,
      subscribeProfileSceneWriter: () => () => {}, setHubCanvasPaused: () => {},
    }));
    vi.doMock("../src/lib/sceneNotebook", async () => ({ ...await vi.importActual<typeof import("../src/lib/sceneNotebook")>("../src/lib/sceneNotebook"),
      syncSceneNotebook: sync, buildSceneNotebookClose: buildClose,
    }));
    vi.doMock("../src/lib/sceneStore", async () => ({ ...await vi.importActual<typeof import("../src/lib/sceneStore")>("../src/lib/sceneStore"),
      settleSceneWrites: async (_ms: number, flush?: () => void) => { flush?.(); return true; },
    }));
    const listeners = new Map<string, EventListenerOrEventListenerObject>();
    vi.spyOn(window, "addEventListener").mockImplementation((name, callback) => { if (callback) listeners.set(`window:${name}`, callback); });
    vi.spyOn(document, "addEventListener").mockImplementation((name, callback) => { if (callback) listeners.set(`document:${name}`, callback); });
    vi.stubGlobal("BroadcastChannel", class { postMessage() {} close() {} });
    const beacon = vi.fn(); Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    const features = await import("../src/lib/hubFeatures");
    try {
      features.setHubFeatures(["scene_writer_v1"]);
      const runtime = await import("../src/lib/sceneWriter");
      runtime.setSceneWriterFlush(() => events.push("flush")); runtime.startSceneWriter();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.getSceneWriterView().mode).toBe("writer");
      events.length = 0; sync.mockClear(); jsonFetch.mockClear();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      (listeners.get("document:visibilitychange") as EventListener)(new Event("visibilitychange"));
      expect(events).toEqual(["flush", "sync"]); expect(sync).toHaveBeenCalledWith({ fresh: true });
      events.length = 0;
      (listeners.get("window:pagehide") as EventListener)(new Event("pagehide"));
      expect(events).toEqual(["flush", "close-body"]);
      expect(jsonFetch).toHaveBeenCalledOnce(); expect(beacon).not.toHaveBeenCalled();
      expect(jsonFetch).toHaveBeenCalledWith("/api/scenes/notebook/close", expect.objectContaining({
        method: "POST", body: closeBody, keepalive: true, headers: { "X-MVHub-Expect-Account": "local" },
      }));
    } finally {
      vi.doUnmock("../src/lib/http"); vi.doUnmock("../src/lib/popupWindows");
      vi.doUnmock("../src/lib/sceneNotebook"); vi.doUnmock("../src/lib/sceneStore");
      Reflect.deleteProperty(navigator, "sendBeacon"); vi.unstubAllGlobals(); vi.resetModules();
    }
  });
});
