// @vitest-environment jsdom
import React, { act, useCallback, useLayoutEffect, useRef, useState, StrictMode, Suspense, startTransition } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Generation, ProgressMessage } from "../src/types";
import { useGenerationProgress } from "../src/lib/useGenerationProgress";
import { mergeFreshGeneration } from "../src/lib/stateReconciliation";

const mocks = vi.hoisted(() => ({
  listener: null as null | ((message: ProgressMessage) => void),
  connected: vi.fn(), getGeneration: vi.fn(), reload: vi.fn(), bumpBoard: vi.fn(), tick: vi.fn(), off: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: { getGeneration: mocks.getGeneration },
  connectProgress: (listener: (message: ProgressMessage) => void) => {
    mocks.listener = listener; mocks.connected(); return mocks.off;
  },
}));
vi.mock("../src/lib/sceneRecentDoneStore", () => ({ isKnownGen: () => true, observeStatus: vi.fn() }));
vi.mock("../src/lib/assetBroadcast", () => ({ postAssetsUpdated: vi.fn() }));
vi.mock("../src/lib/appEvents", () => ({ APP_EVENTS: {}, dispatchAppEvent: vi.fn() }));
vi.mock("../src/lib/librarySync", () => ({ decideLibrarySync: () => "skip",
  trackBareSyncedForReload: vi.fn(), trackOwnSyncedForReload: vi.fn() }));

const initial = { id: "g1", status: "running", shared: false, is_held: false, is_final: false, color: null,
  tags: [], assets: [], execution_phase: "tracking" } as unknown as Generation;
const fresh = (version: number, id = "g1"): Generation => ({ ...initial, id, status: "done",
  execution_phase: "done", assets: [{ id: `asset-${version}` }] }) as unknown as Generation;
type Token = { valid: boolean; inFlight: boolean };
type Commit = { scope: string; noise: number; asset: string | undefined };
const NativeMap = globalThis.Map;
let books: Map<string, Token>[], invalidDeletes: string[];
const isToken = (value: unknown): value is Token => !!value && typeof value === "object"
  && "valid" in value && "inFlight" in value;
// Read-only observation of the actual hook's native Map operations, not a hook transform or test API.
// Delegation preserves Map behavior; invariant A must hold before set replacement/delete/clear.
class ObservedMap<K, V> extends NativeMap<K, V> {
  override set(key: K, value: V): this {
    if (isToken(value)) {
      const prior = this.get(key);
      if (isToken(prior) && prior !== value && prior.valid) invalidDeletes.push("replace");
      const self = this as unknown as Map<string, Token>;
      if (!books.includes(self)) books.push(self);
    }
    return super.set(key, value);
  }
  override delete(key: K): boolean {
    const token = this.get(key);
    if (isToken(token) && token.valid) invalidDeletes.push("delete");
    return super.delete(key);
  }
  override clear(): void {
    for (const token of this.values()) if (isToken(token) && token.valid) invalidDeletes.push("clear");
    super.clear();
  }
}
let root: Root, host: HTMLDivElement, seen: Generation[], commits: Commit[];
let edit: React.Dispatch<React.SetStateAction<Generation[]>>;
let hold: React.Dispatch<React.SetStateAction<boolean>>;
let unrelated: () => void;
let lowNext = false, mounted = false;
let block: Promise<never>;
const book = () => books.at(-1)!;
const token = (id = "g1") => book()?.get(id);
const asset = () => seen[0]?.assets[0]?.id;
function Probe({ scope = "A", enabled = true, seed = [initial], reload = mocks.reload }: {
  scope?: string; enabled?: boolean; seed?: Generation[]; reload?: typeof mocks.reload;
}) {
  const [gens, update] = useState(seed);
  const [blocked, setBlocked] = useState(false);
  const [noise, setNoise] = useState(0);
  // Extra legacy input lets the same regression run against the pre-fix hook; product ignores it.
  const gensRef = useRef(gens);
  gensRef.current = gens;
  edit = update; hold = setBlocked; unrelated = () => setNoise((value) => value + 1);
  const setGens = useCallback<React.Dispatch<React.SetStateAction<Generation[]>>>((action) => {
    if (lowNext) {
      lowNext = false;
      startTransition(() => { update(action); setBlocked(true); });
    } else update(action);
  }, []);
  const args = { enabled, scopeKey: scope, gens, gensRef, setGens, reload,
    bumpBoard: mocks.bumpBoard, setSyncTick: mocks.tick, historyBoardVisible: false, commentsVisible: false };
  useGenerationProgress(args);
  useLayoutEffect(() => { seen = gens; commits.push({ scope, noise, asset: gens[0]?.assets[0]?.id }); });
  if (blocked) throw block;
  return <output>{noise}:{JSON.stringify(gens)}</output>;
}
function render(extra: React.ComponentProps<typeof Probe> & { strict?: boolean } = {}) {
  const node = <Suspense fallback={<span>waiting</span>}><Probe {...extra} /></Suspense>;
  act(() => root.render(extra.strict ? <StrictMode>{node}</StrictMode> : node));
}
function deferred<T = Generation>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function emit(status = "done", id = "g1") {
  mocks.listener!({ type: "progress", generation_id: id, status } as ProgressMessage);
}
function unmount() { if (mounted) { act(() => root.unmount()); mounted = false; } }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Real HTTP forbidden"); }));
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Real WS forbidden"); } });
  books = []; invalidDeletes = []; commits = []; lowNext = false;
  for (const fn of [mocks.connected, mocks.getGeneration, mocks.reload, mocks.bumpBoard, mocks.tick, mocks.off]) fn.mockReset();
  vi.stubGlobal("Map", ObservedMap);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); mounted = true;
  block = new Promise<never>(() => {});
});
afterEach(() => {
  unmount(); host.remove(); vi.unstubAllGlobals();
  expect(globalThis.Map).toBe(NativeMap);
  expect(invalidDeletes).toEqual([]);
});

describe("actual progress hook: late detail authority", () => {
  it("an empty detail book does not scan the generation list on an unrelated commit", () => {
    const seed = [initial];
    const scan = vi.spyOn(seed, "map");
    render({ seed });
    scan.mockClear();
    act(() => unrelated());
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
  });
  it.each(["running", "processing", "failed", "nsfw"])("non-done %s invalidates old detail, then done can recover", async (status) => {
    const old = deferred(), latest = deferred();
    mocks.getGeneration.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    render(); act(() => emit()); act(() => emit(status));
    await act(async () => old.resolve(fresh(1)));
    expect(seen[0].status).toBe(status); expect(asset()).toBeUndefined();
    expect(mocks.getGeneration).toHaveBeenCalledTimes(1); expect(mocks.reload).not.toHaveBeenCalled();
    act(() => emit()); act(() => edit((prev) => prev.map((g) => ({ ...g, shared: true }))));
    await act(async () => latest.resolve(fresh(2)));
    expect(seen[0].shared).toBe(true); expect(asset()).toBe("asset-2");
  });
  it("three requests preserve only the latest detail authority", async () => {
    const replies = [deferred(), deferred(), deferred()];
    replies.forEach((reply) => mocks.getGeneration.mockReturnValueOnce(reply.promise));
    render(); act(() => emit()); act(() => emit());
    await act(async () => replies[1].resolve(fresh(2)));
    act(() => emit()); await act(async () => replies[0].resolve(fresh(1)));
    expect(asset()).toBe("asset-2");
    await act(async () => replies[2].resolve(fresh(3)));
    expect(asset()).toBe("asset-3"); expect(mocks.getGeneration).toHaveBeenCalledTimes(3);
  });
  it.each([false, true])("ordinary queued detail then done (preparatory commit=%s)", async (preparatoryCommit) => {
    const old = deferred(), latest = deferred();
    mocks.getGeneration.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    render(); act(() => emit()); if (preparatoryCommit) act(unrelated);
    await act(async () => { old.resolve(fresh(1)); await Promise.resolve(); emit(); });
    expect(asset()).toBeUndefined();
    await act(async () => latest.resolve(fresh(2)));
    expect(asset()).toBe("asset-2"); expect(mocks.reload).not.toHaveBeenCalled();
  });
  // Explicit lane stress, not the scheduling used by the real WS callback today.
  const schedules = [false, true].flatMap((strict) => [false, true].flatMap((noise) =>
    [0, 1, 2].map((iteration) => ({ strict, noise, iteration }))));
  it.each(schedules)("queued detail survives unrelated commits until superseded: %j", async ({ strict, noise }) => {
    const old = deferred(), latest = deferred();
    mocks.getGeneration.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    render({ strict }); act(() => emit());
    const oldToken = token();
    await act(async () => { lowNext = true; old.resolve(fresh(1)); await Promise.resolve(); });
    expect(asset()).toBeUndefined(); expect(oldToken?.inFlight).toBe(false);
    if (noise) act(() => flushSync(unrelated));
    expect(book().size).toBe(1); expect(oldToken?.valid).toBe(true);
    act(() => emit()); expect(oldToken?.valid).toBe(false);
    act(() => hold(false)); expect(asset()).toBeUndefined();
    await act(async () => latest.resolve(fresh(2)));
    expect(asset()).toBe("asset-2"); expect(mocks.getGeneration).toHaveBeenCalledTimes(2);
    expect(mocks.reload).not.toHaveBeenCalled();
  });
  it.each(["running", "failed"])("queued detail is invalidated by later %s", async (status) => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise);
    render(); act(() => emit());
    await act(async () => { lowNext = true; reply.resolve(fresh(1)); await Promise.resolve(); });
    act(() => emit(status)); act(() => hold(false));
    expect(seen[0].status).toBe(status); expect(asset()).toBeUndefined();
    if (status === "failed") expect(seen[0].execution_phase).toBe("failed");
  });
  it.each([false, true])("300 distinct in-flight IDs have no fixed-size eviction: strict=%s", async (strict) => {
    const seed = Array.from({ length: 300 }, (_, n) => ({ ...initial, id: `g${n}` }));
    const replies = seed.map(() => deferred()); replies.forEach((reply) => mocks.getGeneration.mockReturnValueOnce(reply.promise));
    render({ strict, seed }); act(() => seed.forEach((g) => emit("done", g.id)));
    expect(book().size).toBe(300);
    await act(async () => replies.forEach((reply, n) => reply.resolve(fresh(n, seed[n].id))));
    expect(seen.filter((g) => g.assets.length)).toHaveLength(300);
    expect(book().size).toBe(300); expect(mocks.getGeneration).toHaveBeenCalledTimes(300);
    expect(mocks.reload).not.toHaveBeenCalled();
    act(() => edit([])); expect(book().size).toBe(0);
  });
});

describe("committed scope, cleanup and live-ID lifetime", () => {
  it.each(["scope", "disable", "unmount"].flatMap((kind) => ["resolve", "reject"].map((settlement) => ({ kind, settlement }))))(
    "old response after %j does not write or reload", async ({ kind, settlement }) => {
      const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise);
      render(); act(() => emit()); const oldToken = token();
      if (kind === "unmount") unmount();
      else render(kind === "scope" ? { scope: "B" } : { enabled: false });
      const before = seen;
      expect(oldToken?.valid).toBe(false);
      await act(async () => settlement === "resolve" ? reply.resolve(fresh(1)) : reply.reject(new Error("Synthetic failure")));
      expect(seen).toBe(before); expect(mocks.reload).not.toHaveBeenCalled();
      if (kind === "scope") expect(mocks.off).not.toHaveBeenCalled();
    });
  it.each(["enabled", "reload"])("effect recreation by %s ignores old replies and starts a new book", async (kind) => {
    const old = deferred(), latest = deferred();
    mocks.getGeneration.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    render(); act(() => emit()); const previousBook = book();
    const replacementReload = vi.fn();
    if (kind === "enabled") { render({ enabled: false }); render(); }
    else render({ reload: replacementReload });
    expect(previousBook.size).toBe(0);
    act(() => emit()); expect(book()).not.toBe(previousBook); expect(book().size).toBe(1);
    await act(async () => old.resolve(fresh(1))); expect(asset()).toBeUndefined();
    await act(async () => latest.resolve(fresh(2))); expect(asset()).toBe("asset-2");
    expect(mocks.reload).not.toHaveBeenCalled(); expect(replacementReload).not.toHaveBeenCalled();
  });
  it("committed scope A to B to A cannot revalidate the original token", async () => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise);
    render(); act(() => emit()); const oldToken = token();
    render({ scope: "B" }); render({ scope: "A" });
    await act(async () => reply.resolve(fresh(1)));
    expect(oldToken?.valid).toBe(false); expect(asset()).toBeUndefined();
    expect(mocks.reload).not.toHaveBeenCalled(); expect(mocks.connected).toHaveBeenCalledTimes(1);
  });
  it("an uncommitted scope render cannot poison the captured scope", async () => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise);
    render();
    act(() => startTransition(() => {
      hold(true); root.render(<Suspense fallback={<span>waiting</span>}><Probe scope="B" /></Suspense>);
    }));
    expect(commits.some((entry) => entry.scope === "B")).toBe(false);
    act(() => emit());
    await act(async () => reply.resolve(fresh(1)));
    expect(asset()).toBe("asset-1"); expect(mocks.reload).not.toHaveBeenCalled();
  });
  it("same-scope tab clear invalidates a settled queued merge before list-fetch recovery", async () => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise);
    render(); act(() => emit()); const oldToken = token();
    await act(async () => { lowNext = true; reply.resolve(fresh(1)); await Promise.resolve(); });
    act(() => flushSync(() => edit([])));
    expect(oldToken?.valid).toBe(false); expect(book().size).toBe(0);
    act(() => hold(false)); expect(seen).toEqual([]);
    act(() => edit([fresh(2)])); expect(asset()).toBe("asset-2");
    expect(mocks.reload).not.toHaveBeenCalled(); expect(mocks.connected).toHaveBeenCalledTimes(1);
  });
  it("removing an in-flight card never appends it back; the next commit clears the settled token", async () => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise);
    render(); act(() => emit()); const previousToken = token(); act(() => edit([]));
    expect(previousToken?.inFlight).toBe(true); expect(previousToken?.valid).toBe(true);
    await act(async () => reply.resolve(fresh(1))); expect(seen).toEqual([]);
    act(unrelated); expect(previousToken?.valid).toBe(false); expect(book().size).toBe(0);
    expect(mocks.reload).not.toHaveBeenCalled();
  });
  it("same content preserves the card reference and settled token until the ID is removed", async () => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise);
    render(); act(() => emit()); const same = seen[0]; commits.length = 0;
    await act(async () => reply.resolve({ ...same, assets: [...same.assets] }));
    expect(seen[0]).toBe(same); expect(commits).toHaveLength(0);
    act(unrelated); expect(book().size).toBe(1);
    act(() => edit([])); expect(book().size).toBe(0);
  });
  it.each([false, true])("100 completions with sorting and colors keep one token per live ID: strict=%s", async (strict) => {
    mocks.getGeneration.mockImplementation(() => Promise.resolve(fresh(mocks.getGeneration.mock.calls.length)));
    render({ strict, seed: [initial, { ...initial, id: "g2" }] });
    for (let n = 0; n < 100; n += 1) {
      await act(async () => emit());
      act(() => edit((prev) => [...prev].reverse().map((g) => g.id === "g1" ? { ...g, color: n % 2 ? "red" : "blue" } : g)));
      expect(book().size).toBe(1); expect(token()?.inFlight).toBe(false); expect(token()?.valid).toBe(true);
    }
    expect(seen.find((g) => g.id === "g1")?.assets[0]?.id).toBe("asset-100");
    expect(mocks.connected).toHaveBeenCalledTimes(strict ? 2 : 1);
    act(() => edit([])); expect(book().size).toBe(0);
  });
});

describe("paired baseline metadata and progress ownership", () => {
  it.each([false, true])("fast reply preserves same-batch shared/held/color/tags edits: strict=%s", async (strict) => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise); render({ strict });
    const tags = ["tag-user"];
    await act(async () => {
      emit(); edit((prev) => prev.map((g) => ({ ...g, shared: true, is_held: true, color: "red", tags })));
      reply.resolve(fresh(1));
    });
    expect(seen[0]).toMatchObject({ shared: true, is_held: true, color: "red" });
    expect(seen[0].tags).toBe(tags); expect(asset()).toBe("asset-1");
  });
  it("pending low-priority progress plus urgent edit still accepts fresh progress fields", async () => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise); render();
    await act(async () => {
      edit((prev) => [...prev]); startTransition(() => { emit(); hold(true); });
      edit((prev) => prev.map((g) => ({ ...g, shared: true })));
      reply.resolve(fresh(1)); await Promise.resolve();
    });
    expect(seen[0].shared).toBe(true); expect(seen[0].status).toBe("done"); expect(asset()).toBe("asset-1");
  });
  it.each(["done", "processing", "failed"])("fresh %s retains existing server lifecycle authority", async (status) => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise); render(); act(() => emit());
    act(() => edit((prev) => prev.map((g) => ({ ...g, shared: true }))));
    const phase = status === "done" ? "done" : status === "failed" ? "failed" : "tracking";
    await act(async () => reply.resolve({ ...fresh(1), status, execution_phase: phase } as Generation));
    expect(seen[0]).toMatchObject({ status, execution_phase: phase, shared: true });
  });
  it.each(["removed-undefined", "added-undefined", "null-change", "client-only", "tag-order", "final-flag"])("metadata presence and reference: %s", async (kind) => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise);
    type Ext = Generation & { note?: string | null; depth?: number; _comfyPending?: boolean };
    const base: Ext = { ...initial }, incoming: Ext = { ...fresh(1), note: "server" };
    if (kind === "removed-undefined") base.note = undefined;
    if (kind === "null-change") base.note = "old";
    const a = "a", b = "b";
    if (kind === "tag-order") { base.tags = [a, b]; incoming.tags = [a, b, "c"]; }
    render({ seed: [base] }); act(() => emit());
    act(() => edit((prev) => prev.map((g) => {
      const current: Ext = { ...g };
      if (kind === "removed-undefined") delete current.note;
      if (kind === "added-undefined") current.note = undefined;
      if (kind === "null-change") current.note = null;
      if (kind === "client-only") { current._comfyPending = true; current.depth = 3; }
      if (kind === "tag-order") current.tags = [b, a];
      if (kind === "final-flag") current.is_final = true;
      return current;
    })));
    const tagsBefore = seen[0].tags;
    await act(async () => reply.resolve(incoming));
    const current = seen[0] as Ext;
    if (kind === "removed-undefined") expect(Object.hasOwn(current, "note")).toBe(false);
    if (kind === "added-undefined") { expect(Object.hasOwn(current, "note")).toBe(true); expect(current.note).toBeUndefined(); }
    if (kind === "null-change") expect(current.note).toBeNull();
    if (kind === "client-only") expect(current).toMatchObject({ _comfyPending: true, depth: 3 });
    if (kind === "tag-order") { expect(current.tags).toEqual([b, a]); expect(current.tags).toBe(tagsBefore); }
    if (kind === "final-flag") expect(current.is_final).toBe(true);
  });
  it("wrong detail ID does not replace or append any card", async () => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise); render(); act(() => emit());
    const before = seen;
    await act(async () => reply.resolve(fresh(1, "other")));
    expect(seen).toBe(before); expect(mocks.reload).not.toHaveBeenCalled();
  });
  it("pure merge preserves equal nested references without mutating any input", () => {
    const base = Object.freeze({ ...initial, tags: Object.freeze([]) }) as unknown as Generation;
    const current = Object.freeze({ ...base, shared: true });
    const incoming = Object.freeze({ ...fresh(1), tags: [] });
    const expected = Object.freeze({ ...base, status: "done" }) as Generation;
    const merged = mergeFreshGeneration(base, current, incoming, expected);
    expect(merged.shared).toBe(true); expect(merged.tags).toBe(current.tags);
    expect(merged.assets).toBe(incoming.assets); expect(base.status).toBe("running");
    expect(mergeFreshGeneration(base, current, { ...current }, base)).toBe(current);
  });
});

describe("guarded reload settlement", () => {
  it.each(["resolve", "reject"])("missing baseline waits for reload %s before settling", async (settlement) => {
    const reply = deferred(), reloaded = deferred<void>();
    mocks.getGeneration.mockReturnValue(reply.promise); mocks.reload.mockReturnValue(reloaded.promise);
    render({ seed: [] }); act(() => emit());
    await act(async () => reply.resolve(fresh(1))); act(unrelated);
    expect(token()?.inFlight).toBe(true); expect(mocks.reload).toHaveBeenCalledExactlyOnceWith(true, true);
    await act(async () => settlement === "resolve" ? reloaded.resolve() : reloaded.reject(new Error("Synthetic reload failure")));
    expect(token()?.inFlight).toBe(false); act(unrelated); expect(book().size).toBe(0);
  });
  it.each(["resolve", "reject"])("reload synchronous throw after detail %s is invoked once", async (settlement) => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise);
    mocks.reload.mockImplementation(() => { throw new Error("Synthetic synchronous reload failure"); });
    render({ seed: [] }); act(() => emit());
    await act(async () => settlement === "resolve" ? reply.resolve(fresh(1)) : reply.reject(new Error("Synthetic detail failure")));
    expect(mocks.reload).toHaveBeenCalledTimes(1); expect(token()?.inFlight).toBe(false);
    act(unrelated); expect(book().size).toBe(0);
  });
  it("a missing-baseline reload rechecks scope at its microtask boundary", async () => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise);
    render({ seed: [] }); act(() => emit());
    await act(async () => {
      reply.resolve(fresh(1)); await Promise.resolve();
      flushSync(() => root.render(<Suspense fallback={<span>waiting</span>}><Probe scope="B" seed={[]} /></Suspense>));
    });
    expect(mocks.reload).not.toHaveBeenCalled();
  });
  it("in-flight reload tokens are cleared by scope change even if reload never settles", async () => {
    const reply = deferred(); mocks.getGeneration.mockReturnValue(reply.promise);
    mocks.reload.mockReturnValue(new Promise<void>(() => {})); render({ seed: [] }); act(() => emit());
    await act(async () => reply.resolve(fresh(1))); expect(token()?.inFlight).toBe(true);
    const oldToken = token(); render({ scope: "B", seed: [] });
    expect(oldToken?.valid).toBe(false); expect(book().size).toBe(0);
  });
});
