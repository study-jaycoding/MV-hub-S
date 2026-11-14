// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasArchiveSection, heldRecoveryCounts, useStorageRecovery } from "../src/components/settings/CanvasArchiveSection";
import { downloadStorageRecovery, readStorageRecovery, redundantMirrorHoldIds } from "../src/lib/sceneArchive";
import * as sceneArchive from "../src/lib/sceneArchive";
import * as sceneNotebook from "../src/lib/sceneNotebook";
import { joinSceneNotebook, readRestoreArchives, readSceneNotebook, setSceneNotebookTokenProvider, syncSceneNotebook, writeNotebookProgress, buildSceneNotebookClose, type RestoreArchive } from "../src/lib/sceneNotebook";
import { abortSceneStoreWritesForTest, applySceneOp, holdNotebookWrites, readWorkingBucket, setSceneWriteGate, settleSceneStoreForTest, writeScenesStore, sceneNotebookTransaction } from "../src/lib/sceneStore";
import { setAccountScope } from "../src/lib/accountScope";
import * as accountScope from "../src/lib/accountScope";
import { setHubFeatures } from "../src/lib/hubFeatures";
import * as hubFeatures from "../src/lib/hubFeatures";
import * as sceneStore from "../src/lib/sceneStore";
import * as scenes from "../src/lib/scenes";
import * as sceneBackup from "../src/lib/sceneBackup";
import * as sceneCardLinks from "../src/lib/sceneCardLinks";
import * as sceneWriter from "../src/lib/sceneWriter";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { getLang, setLang, t } from "../src/lib/i18n";
import type { Scene } from "../src/lib/scenes";

const request = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/http", async (original) => ({ ...await original<typeof import("../src/lib/http")>(), jsonFetch: request }));
vi.mock("../src/lib/download", () => ({ downloadText: download }));
vi.mock("../src/lib/popupWindows", async (original) => ({ ...await original<typeof import("../src/lib/popupWindows")>(), useCanvasFloating: () => false, useCanvasFollower: () => false }));
const bucket = "local::_none";
it.each([
  ["보관본을 읽지 못했습니다. 이 브라우저의 자료는 유지했습니다.", "Couldn't read the archive. This browser's data was kept."],
  ["보관본 읽기 실패", "Archive read failed"],
])("archive read error translates through t(): %s", (ko, en) => {
  const previous = getLang();
  try {
    setLang("en");
    expect(t(ko)).toBe(en);
    setLang("ko");
    expect(t(ko)).toBe(ko);
  } finally { setLang(previous); }
});
const scene = (id: string, name = id): Scene => ({ id, name, cards: [], edges: [], created_at: 1 });
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const lease = { account: "local", token: "token", generation: "lease" };
const emptyBook = () => ({ restore_generation: "new", notebook_id: null, history_id: "h", items: [], order: { ids: [], rev: 0, history_id: "h" } });
let root: Root | undefined, host: HTMLDivElement;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); request.mockReset(); download.mockClear();
  setAccountScope(null); setHubFeatures(["scene_writer_v1"]); setSceneWriteGate(() => false);
  setSceneNotebookTokenProvider(() => lease);
  await writeScenesStore({ [bucket]: [] });
  const scenes = [scene("a"), scene("b")];
  await joinSceneNotebook("local", "book", "h", { [bucket]: { scenes, bases: Object.fromEntries(scenes.map((s) => [s.id, { history: "h", rev: 1, hash: hash(JSON.stringify(s)) }])), order: { history: "h", rev: 1 } } }, undefined, "old");
  request.mockImplementation(async (_path, init) => { if (init?.method && init.method !== "GET") throw Error("unexpected write"); return emptyBook(); });
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => {
  if (root) act(() => root!.unmount()); root = undefined; host.remove();
  abortSceneStoreWritesForTest(false); await settleSceneStoreForTest();
  setSceneNotebookTokenProvider(() => null); setSceneWriteGate(() => false); setHubFeatures([]); setAccountScope(null);
});
async function changed() {
  applySceneOp((all) => { all[bucket] = [scene("a", "unsent")]; return { write: true, value: null }; });
  await writeNotebookProgress("local", "write", null, { id: "old-write", restoreGeneration: "old", requests: [{ restore_generation: "old" }] });
  await writeNotebookProgress("local", "start", null, { id: "old-start", restoreGeneration: "old" });
}
it("archives text, deletion, start and pending control data atomically before empty adoption", async () => {
  await changed();
  expect((await syncSceneNotebook()).status).toBe("ready");
  expect(readWorkingBucket(bucket)).toEqual([]);
  const archives = await readRestoreArchives("local");
  expect(archives.ok && archives.value).toHaveLength(1);
  if (!archives.ok) throw Error("read failed");
  expect(archives.value[0].scenes[bucket][0].name).toBe("unsent");
  expect(archives.value[0].controls['["d","local::_none","b"]']).toBeTruthy();
  expect(archives.value[0].controls['["nw","local"]']).toMatchObject({ id: "old-write" });
  expect(archives.value[0].controls['["ns","local"]']).toMatchObject({ id: "old-start" });
  expect(request.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  const next = await readSceneNotebook("local");
  expect(next.ok && next.value).toMatchObject({ starting: null, writing: null, joined: { restoreGeneration: "new" } });
});
it("archive failure preserves the old text, generation and queues", async () => {
  await changed(); abortSceneStoreWritesForTest(true);
  expect((await syncSceneNotebook()).status).toBe("retry");
  expect(readWorkingBucket(bucket)[0].name).toBe("unsent");
  abortSceneStoreWritesForTest(false);
  const state = await readSceneNotebook("local");
  expect(state.ok && state.value).toMatchObject({ joined: { restoreGeneration: "old" }, writing: { id: "old-write" } });
  expect((await readRestoreArchives("local"))).toMatchObject({ ok: true, value: [] });
});
it("untagged progress is archived even when the join already has the current generation", async () => {
  request.mockResolvedValue({ ...emptyBook(), restore_generation: "old" });
  await writeNotebookProgress("local", "write", null, { id: "untagged", requests: [] });
  expect((await syncSceneNotebook()).status).toBe("ready");
  const archives = await readRestoreArchives("local");
  expect(archives.ok && archives.value[0].controls['["nw","local"]']).toMatchObject({ id: "untagged" });
  expect(request.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
});
it("a generationless hub cannot adopt local content or send close while archiving", async () => {
  request.mockResolvedValue({ ...emptyBook(), restore_generation: undefined });
  expect((await syncSceneNotebook()).status).toBe("retry");
  expect(readWorkingBucket(bucket)).toHaveLength(2);
  const release = holdNotebookWrites("local");
  expect(buildSceneNotebookClose(lease)).toBeNull(); release();
});
it("recovery UI shows counts and exports originals with control data; another account cannot export them", async () => {
  await changed(); await syncSceneNotebook();
  localStorage.setItem('mvhub.editRecovery:["local","doc"]', JSON.stringify({ blocked: true, originals: [{ raw: "original" }] }));
  localStorage.setItem("mvhub.cardRecovery:local", JSON.stringify({ generation: "new", candidates: [{ removals: [{ id: "old" }], revives: [], backfill: [] }] }));
  root = createRoot(host); await act(async () => root!.render(<CanvasArchiveSection />));
  expect(host.textContent).toContain("복원 전에 남겨 둔 것");
  expect(host.textContent).toContain("캔버스 보관본 1개 · 편집 문서 1개 · 카드 정리 대기 1개");
  expect(host.textContent).toContain("자동으로 다시 보내지 않습니다.");
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "보관본 내려받기")!;
  await act(async () => button.click());
  const exported = JSON.parse(download.mock.calls[0][1]);
  expect(exported.buckets[bucket][0].name).toBe("unsent");
  expect(exported.recovery.canvases[0].controls['["nw","local"]'].id).toBe("old-write");
  const captured = await readStorageRecovery();
  setAccountScope("other@example.com");
  expect(() => downloadStorageRecovery(captured)).toThrow("계정");
  await act(async () => root!.render(<CanvasArchiveSection />));
  expect(host.textContent).not.toContain("복원 전에 남겨 둔 것");
});
function HeldProbe() {
  const [recovery, , failed] = useStorageRecovery();
  return <i data-held={heldRecoveryCounts(recovery).total} data-failed={failed} />;
}
async function confirmReadFailure() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(250);
    else await new Promise((resolve) => setTimeout(resolve, 260));
  });
}
it("two account round trips rejected by the archive guard retry without showing failure", async () => {
  const readMeta = sceneStore.readSceneStoreMeta;
  const account = vi.spyOn(accountScope, "getAccountNamespace").mockReturnValue("local");
  const guardResults: boolean[] = [];
  const tx = vi.spyOn(sceneStore, "readSceneStoreMeta").mockImplementation((key, stillCurrent) =>
    readMeta(key, () => {
      if (guardResults.length >= 2) return stillCurrent!();
      account.mockReturnValue("acct:other@test");
      try {
        const current = stillCurrent!();
        guardResults.push(current);
        return current;
      } finally { account.mockReturnValue("local"); }
    }));
  const archives = vi.spyOn(sceneNotebook, "readRestoreArchives");
  const failures: boolean[] = [];
  function Probe() { const [, , failed] = useStorageRecovery(); failures.push(failed); return <i data-failed={failed} />; }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(guardResults).toEqual([false, false]);
    expect(archives).toHaveBeenCalledTimes(2);
    expect(failures).not.toContain(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(archives).toHaveBeenCalledTimes(3);
    expect(await archives.mock.results[2].value).toMatchObject({ ok: true, value: [] });
    expect(failures).not.toContain(true);
  } finally { archives.mockRestore(); tx.mockRestore(); account.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it.each([false, true])("recovery confirms a general failure only once before showing it (retry succeeds: %s)", async (succeeds) => {
  const recovery = await readStorageRecovery();
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockRejectedValue(new Error("read failed"));
  if (succeeds) read.mockRejectedValueOnce(new Error("temporary guard failure")).mockResolvedValue(recovery);
  const failures: boolean[] = [];
  function Probe() { const [, , failed] = useStorageRecovery(); failures.push(failed); return <i data-failed={failed} />; }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    expect(read).toHaveBeenCalledTimes(1);
    expect(failures).not.toContain(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(host.querySelector("i")?.dataset.failed).toBe(String(!succeeds));
    if (succeeds) expect(failures).not.toContain(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(read).toHaveBeenCalledTimes(2);
    read.mockResolvedValue(recovery);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(host.querySelector("i")?.dataset.failed).toBe("false");
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    read.mockRejectedValueOnce(new Error("new first failure"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(host.querySelector("i")?.dataset.failed).toBe("false");
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(5);
    expect(host.querySelector("i")?.dataset.failed).toBe("false");
  } finally { read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("writer mode changes retain this account recovery through a failed read but never expose it to another account", async () => {
  const recovery = { ...await readStorageRecovery(), cards: { candidates: [{ removals: [{ id: "held" }], revives: [], backfill: [] }] } };
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue(recovery);
  const writer = vi.spyOn(sceneWriter, "useSceneWriter").mockReturnValue({ mode: "disabled", handed: false, localCount: 0 });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    expect(host.querySelector("i")?.dataset.held).toBe("1");
    read.mockRejectedValue(new Error("read failed"));
    writer.mockReturnValue({ mode: "local_only", handed: false, localCount: 0 });
    await act(async () => root!.render(<HeldProbe />));
    await confirmReadFailure();
    expect(host.querySelector("i")?.dataset).toMatchObject({ held: "1", failed: "true" });
    setAccountScope("other@test");
    read.mockImplementation(() => new Promise(() => {}));
    await act(async () => root!.render(<HeldProbe />));
    expect(host.querySelector("i")?.dataset).toMatchObject({ held: "0", failed: "false" });
  } finally { read.mockRestore(); writer.mockRestore(); }
});
it.each(["success", "failure"])("writer mode retains a read failure while waiting for readiness and the next %s", async (outcome) => {
  const initial = await readStorageRecovery();
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockRejectedValue(new Error("initial read failed"));
  const ready = vi.spyOn(sceneStore, "sceneStoreReady").mockReturnValue(true);
  const writer = vi.spyOn(sceneWriter, "useSceneWriter").mockReturnValue({ mode: "disabled", handed: false, localCount: 0 });
  let resolve!: (value: typeof initial) => void, reject!: (reason: Error) => void;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    await confirmReadFailure();
    expect(host.querySelector("i")?.dataset.failed).toBe("true");
    ready.mockReturnValue(false);
    read.mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    writer.mockReturnValue({ mode: "local_only", handed: false, localCount: 0 });
    await act(async () => root!.render(<HeldProbe />));
    expect(host.querySelector("i")?.dataset.failed).toBe("true");
    expect(read).toHaveBeenCalledTimes(2);
    ready.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(read).toHaveBeenCalledTimes(3);
    expect(host.querySelector("i")?.dataset.failed).toBe("true");
    await act(async () => {
      if (outcome === "success") resolve(initial);
      else reject(new Error("next read failed"));
    });
    expect(host.querySelector("i")?.dataset.failed).toBe(String(outcome === "failure"));
  } finally { read.mockRestore(); ready.mockRestore(); writer.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("archive reads with pending camera edits do not trigger another recovery read", async () => {
  const read = vi.spyOn(sceneArchive, "readStorageRecovery");
  const notifications: sceneStore.SceneFlushInfo[] = [];
  const off = scenes.subscribeScenesPersisted((info) => notifications.push(info));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      expect(scenes.updateSceneCamera(null, "a", { z: 2, x: 3, y: 4 }).ok).toBe(true);
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(scenes.listPersistedScenes(null).find((s) => s.id === "a")?.camera).toEqual({ z: 2, x: 3, y: 4 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(notifications).toEqual([{ notebookMetaOnly: false, cameraOnly: true }]);
  } finally { off(); read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("manual refresh waits for the 250ms window and then the fresh result", async () => {
  const initial = await readStorageRecovery();
  let finish!: (value: typeof initial) => void;
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValueOnce(initial)
    .mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  let refresh!: () => Promise<void>;
  function Probe() { [, refresh] = useStorageRecovery(); return null; }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    let done = false;
    const pending = refresh().then(() => { done = true; });
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(done).toBe(false);
    await act(async () => { finish(initial); await pending; });
    expect(done).toBe(true);
  } finally { read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("initial read and synchronous save notification share a window; manual refresh consumes queued notifications", async () => {
  const value = await readStorageRecovery();
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue(value);
  const subscribe = vi.spyOn(scenes, "subscribeSceneSaveState").mockImplementation((fn) => { fn(true); return () => {}; });
  function RefreshProbe() {
    const [, refresh] = useStorageRecovery();
    return <button onClick={() => void refresh()}>refresh</button>;
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<RefreshProbe />));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(100); });
    await act(async () => host.querySelector("button")!.click());
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => host.querySelector("button")!.click());
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(249); });
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(read).toHaveBeenCalledTimes(4);
  } finally { subscribe.mockRestore(); read.mockRestore(); vi.useRealTimers(); }
});
it("recovery keeps automatic read starts at least 250ms apart with 300ms reads", async () => {
  const initial = await readStorageRecovery();
  const starts: number[] = [];
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockImplementation(() => {
    starts.push(Date.now());
    return new Promise((resolve) => setTimeout(() => resolve(initial), 300));
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    for (let i = 0; i < 24; i++) {
      await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(50); });
    }
    expect(starts).toHaveLength(5);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(250);
    await act(async () => root!.unmount()); root = undefined;
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(starts).toHaveLength(5);
  } finally { read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("recovery serializes a synchronous notification inside the read", async () => {
  const initial = await readStorageRecovery();
  let active = 0, peak = 0, notify = true;
  const finishes: (() => void)[] = [];
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValueOnce(initial).mockImplementation(() => {
    peak = Math.max(peak, ++active);
    if (notify) { notify = false; window.dispatchEvent(new Event("focus")); }
    return new Promise((resolve) => finishes.push(() => { active--; resolve(initial); }));
  });
  let refresh!: () => Promise<void> | undefined;
  function Probe() { [, refresh] = useStorageRecovery(); return null; }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    let pending!: Promise<void> | undefined;
    await act(async () => { pending = refresh(); await vi.advanceTimersByTimeAsync(250); });
    expect(peak).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(initial.account);
    await act(async () => { finishes.shift()!(); await pending; });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => finishes.shift()!());
    expect(peak).toBe(1);
    expect(active).toBe(0);
  } finally { read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it.each(["before effect", "after unmount"])("recovery refresh returns a resolved promise %s", async (phase) => {
  const initial = await readStorageRecovery();
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue(initial);
  let refresh!: () => Promise<void> | undefined;
  let beforeEffect: Promise<void> | undefined, captured = false;
  function Probe() {
    [, refresh] = useStorageRecovery();
    if (!captured) { captured = true; beforeEffect = refresh(); }
    return null;
  }
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    await act(async () => root!.unmount()); root = undefined;
    const result = phase === "before effect" ? beforeEffect : refresh();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  } finally { read.mockRestore(); }
}, 15_000);
it.each(["success", "failure", "unmount"])("manual refresh waits for the queued read: %s", async (outcome) => {
  const initial = await readStorageRecovery();
  const latest = { ...initial, cards: { candidates: [{ removals: [{ id: "held" }], revives: [], backfill: [] }] } };
  const reads: { resolve: (value: typeof initial) => void; reject: (reason: Error) => void }[] = [];
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockImplementation(() => new Promise((resolve, reject) => reads.push({ resolve, reject })));
  let refresh!: () => Promise<void> | undefined;
  function RefreshProbe() {
    const [recovery, refreshRecovery, failed] = useStorageRecovery();
    refresh = refreshRecovery;
    return <i data-held={heldRecoveryCounts(recovery).total} data-failed={failed} />;
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<RefreshProbe />));
    let completed = 0;
    const first = Promise.resolve(refresh()).then(() => { completed++; });
    const second = Promise.resolve(refresh()).then(() => { completed++; });
    expect(read).toHaveBeenCalledTimes(1);
    expect(completed).toBe(0);
    if (outcome === "unmount") { await act(async () => root!.unmount()); root = undefined; }
    await act(async () => reads[0].resolve(initial));
    if (outcome === "unmount") {
      await Promise.all([first, second]);
      expect(read).toHaveBeenCalledTimes(1);
    } else {
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(read).toHaveBeenCalledTimes(2);
      expect(completed).toBe(0);
      await act(async () => {
        if (outcome === "success") reads[1].resolve(latest);
        else reads[1].reject(new Error("fresh read failed"));
        if (outcome === "success") await Promise.all([first, second]);
      });
      if (outcome === "failure") {
        expect(completed).toBe(0);
        expect(host.querySelector("i")?.dataset.failed).toBe("false");
        await confirmReadFailure();
        await act(async () => { reads[2].reject(new Error("confirmed read failure")); await Promise.all([first, second]); });
      }
      expect(host.querySelector("i")?.dataset).toMatchObject({ held: outcome === "success" ? "1" : "0", failed: String(outcome === "failure") });
    }
    expect(completed).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(read).toHaveBeenCalledTimes(outcome === "unmount" ? 1 : outcome === "failure" ? 3 : 2);
  } finally { read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it.each(["success", "failure"])("manual refresh waits through the first general failure until retry %s", async (outcome) => {
  const initial = await readStorageRecovery();
  const reads: { resolve: (value: typeof initial) => void; reject: (reason: Error) => void }[] = [];
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockImplementation(() => new Promise((resolve, reject) => reads.push({ resolve, reject })));
  let refresh!: () => Promise<void> | undefined;
  function Probe() {
    const [, refreshRecovery, failed] = useStorageRecovery();
    refresh = refreshRecovery;
    return <i data-failed={failed} />;
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    await act(async () => reads[0].resolve(initial));
    let completed = false;
    const pending = Promise.resolve(refresh()).then(() => { completed = true; });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => reads[1].reject(new Error("first read failed")));
    expect(completed).toBe(false);
    expect(host.querySelector("i")?.dataset.failed).toBe("false");
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(reads).toHaveLength(3);
    expect(completed).toBe(false);
    await act(async () => {
      if (outcome === "success") reads[2].resolve(initial);
      else reads[2].reject(new Error("confirmed read failure"));
      await pending;
    });
    expect(completed).toBe(true);
    expect(host.querySelector("i")?.dataset.failed).toBe(String(outcome === "failure"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(reads).toHaveLength(3);
  } finally { read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it.each(["success", "failure"])("manual refresh waits through a discarded read %s after an account round trip", async (outcome) => {
  const initial = await readStorageRecovery();
  const latest = { ...initial, cards: { candidates: [{ removals: [{ id: "held" }], revives: [], backfill: [] }] } };
  const account = vi.spyOn(accountScope, "getAccountNamespace").mockReturnValue(initial.account);
  const reads: { resolve: (value: typeof initial) => void; reject: (error: Error) => void }[] = [];
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockImplementation(() => new Promise((resolve, reject) => reads.push({ resolve, reject })));
  let refresh!: () => Promise<void>;
  function Probe() {
    const [recovery, refreshRecovery] = useStorageRecovery();
    refresh = refreshRecovery;
    return <i data-held={heldRecoveryCounts(recovery).total} />;
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    await act(async () => reads[0].resolve(initial));
    let completed = false;
    const pending = refresh().then(() => { completed = true; });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    // then/catch의 계정 검사에서만 다른 계정이고 finally 전에는 원래 계정으로 돌아온다.
    account.mockReturnValueOnce("acct:other@test");
    await act(async () => {
      if (outcome === "success") reads[1].resolve(latest);
      else reads[1].reject(new Error("discarded general failure"));
    });
    expect(host.querySelector("i")?.dataset.held).toBe("0");
    expect(completed).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(reads).toHaveLength(3);
    expect(completed).toBe(false);
    await act(async () => { reads[2].resolve(latest); await pending; });
    expect(completed).toBe(true);
    expect(host.querySelector("i")?.dataset.held).toBe("1");
  } finally { account.mockRestore(); read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("manual refresh waits through an account-change discard for the replacement read", async () => {
  const initial = await readStorageRecovery();
  const reads: { resolve: (value: typeof initial) => void; reject: (reason: Error) => void }[] = [];
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockImplementation(() => new Promise((resolve, reject) => reads.push({ resolve, reject })));
  let refresh!: () => Promise<void> | undefined;
  function Probe() { [, refresh] = useStorageRecovery(); return null; }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    await act(async () => reads[0].resolve(initial));
    let completed = false;
    const pending = Promise.resolve(refresh()).then(() => { completed = true; });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(reads).toHaveLength(2);
    await act(async () => {
      setAccountScope("other@test");
      reads[1].reject(new Error(sceneArchive.RECOVERY_ACCOUNT_CHANGED));
      setAccountScope(null);
    });
    expect(completed).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(reads).toHaveLength(3);
    expect(completed).toBe(false);
    await act(async () => { reads[2].resolve(initial); await pending; });
    expect(completed).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(reads).toHaveLength(3);
  } finally { read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it.each(["success", "failure"])("manual refresh survives writer mode changes until the new read %s", async (outcome) => {
  const initial = await readStorageRecovery();
  const reads: { resolve: (value: typeof initial) => void; reject: (error: Error) => void }[] = [];
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockImplementation(() => new Promise((resolve, reject) => reads.push({ resolve, reject })));
  const writer = vi.spyOn(sceneWriter, "useSceneWriter").mockReturnValue({ mode: "disabled", handed: false, localCount: 0 });
  let refresh!: () => Promise<void> | undefined;
  function Probe() { [, refresh] = useStorageRecovery(); return null; }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    // 이번 refresh가 시작한 읽기 도중 effect를 바꿔, 옛 finally도 대기 목록을 들고 있게 한다.
    await act(async () => reads[0].resolve(initial));
    let done = false;
    const result = Promise.resolve(refresh()).then(() => { done = true; });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(reads).toHaveLength(2);
    writer.mockReturnValue({ mode: "local_only", handed: false, localCount: 0 });
    await act(async () => root!.render(<Probe />));
    expect(reads).toHaveLength(3);
    expect(done).toBe(false);
    await act(async () => reads[1].resolve(initial));
    expect(done).toBe(false);
    await act(async () => {
      if (outcome === "success") reads[2].resolve(initial);
      else reads[2].reject(new Error("new read failed"));
      if (outcome === "success") await result;
    });
    if (outcome === "failure") {
      expect(done).toBe(false);
      await confirmReadFailure();
      await act(async () => { reads[3].reject(new Error("confirmed new read failure")); await result; });
    }
    expect(done).toBe(true);
  } finally { read.mockRestore(); writer.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("manual refresh cancels while not ready and later waits only for an actual read", async () => {
  const initial = await readStorageRecovery();
  const ready = vi.spyOn(sceneStore, "sceneStoreReady").mockReturnValue(false);
  let resolve!: (value: typeof initial) => void;
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockImplementation(() => new Promise((done) => { resolve = done; }));
  let refresh!: () => Promise<void> | undefined;
  function Probe() { [, refresh] = useStorageRecovery(); return null; }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    await act(async () => { await vi.advanceTimersByTimeAsync(1750); });
    expect(read).not.toHaveBeenCalled();
    let done = false;
    const result = Promise.resolve(refresh()).then(() => { done = true; });
    await act(async () => {});
    expect(done).toBe(true);
    await result;
    ready.mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(read).not.toHaveBeenCalled();
    done = false;
    const actual = Promise.resolve(refresh()).then(() => { done = true; });
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    await act(async () => { resolve(initial); await actual; });
    expect(done).toBe(true);
  } finally { read.mockRestore(); ready.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it.each(["idle", "inflight", "unmount"])("manual refresh ends when its queued read finds the store not ready: %s", async (path) => {
  const initial = await readStorageRecovery();
  const resolves: ((value: typeof initial) => void)[] = [];
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockImplementation(() => new Promise((resolve) => resolves.push(resolve)));
  const ready = vi.spyOn(sceneStore, "sceneStoreReady").mockReturnValue(path === "inflight");
  let refresh!: () => Promise<void> | undefined;
  function Probe() { [, refresh] = useStorageRecovery(); return null; }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    ready.mockReturnValue(false);
    let done = false;
    const refreshed = Promise.resolve(refresh()).then(() => { done = true; });
    await act(async () => { if (path === "inflight") { resolves[0](initial); await vi.advanceTimersByTimeAsync(250); } });
    expect(done).toBe(true);
    const before = resolves.length;
    if (path === "unmount") { await act(async () => root!.unmount()); root = undefined; }
    else {
      ready.mockReturnValue(true);
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(resolves).toHaveLength(before + 1);
      expect(done).toBe(true);
      await act(async () => resolves[before](initial));
    }
    await refreshed;
    expect(done).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(read).toHaveBeenCalledTimes(path === "unmount" ? before : before + 1);
  } finally { read.mockRestore(); ready.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("an account round trip retains a notification until its account returns", async () => {
  const initial = await readStorageRecovery();
  const latest = { ...initial, cards: { candidates: [{ removals: [{ id: "held" }], revives: [], backfill: [] }] } };
  const account = vi.spyOn(accountScope, "getAccountNamespace").mockReturnValue("local");
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue(initial);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    read.mockResolvedValue(latest);
    act(() => {
      account.mockReturnValue("acct:other@test");
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(250);
      account.mockReturnValue("local");
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(host.querySelector("i")?.dataset.held).toBe("1");
  } finally { account.mockRestore(); read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it.each(["success", "failure"])("an account round trip retries a discarded read %s without another event", async (outcome) => {
  const initial = await readStorageRecovery();
  const latest = { ...initial, cards: { candidates: [{ removals: [{ id: "held" }], revives: [], backfill: [] }] } };
  const account = vi.spyOn(accountScope, "getAccountNamespace").mockReturnValue("local");
  let resolve!: (value: typeof initial) => void, reject!: (error: Error) => void;
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; })).mockResolvedValue(latest);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    account.mockReturnValue("acct:other@test");
    await act(async () => { if (outcome === "success") resolve(initial); else reject(new Error("discarded")); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(host.querySelector("i")?.dataset).toMatchObject({ held: "0", failed: "false" });
    account.mockReturnValue("local");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(host.querySelector("i")?.dataset.held).toBe("1");
  } finally { account.mockRestore(); read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("SettingsPanel shares one recovery read between its summary and archive section", async () => {
  request.mockImplementation(async (path) => { if (String(path).includes("/scenes/notebook")) return emptyBook(); throw new Error("unrelated settings unavailable"); });
  const initial = await readStorageRecovery();
  const held = { ...initial, cards: { candidates: [{ removals: [{ id: "held" }], revives: [], backfill: [] }] } };
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue(held);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<SettingsPanel onClose={() => {}} />));
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("기본 설정"))!.click());
    expect(read).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("복원 보류 1");
    expect(document.body.textContent).toContain("카드 정리 대기 1개");
    read.mockRejectedValue(new Error("shared read failed"));
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(2);
    await confirmReadFailure();
    expect(read).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain("보관본 읽기 실패");
    expect(document.body.textContent).toContain("보관본을 읽지 못했습니다.");
    expect(document.body.textContent).toContain("복원 보류 1");
    read.mockResolvedValue(initial);
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(4);
    expect(document.body.textContent).not.toContain("복원 보류 1");
    expect(document.body.textContent).not.toContain("카드 정리 대기 1개");
    expect(document.body.textContent).not.toContain("보관본 읽기 실패");
    expect(document.body.textContent).not.toContain("보관본을 읽지 못했습니다.");
  } finally { read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("account mismatch adopts the actual account despite continuous notifications without another host render", async () => {
  const initial = await readStorageRecovery();
  const account = vi.spyOn(accountScope, "getAccountNamespace").mockReturnValue("local");
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue({ ...initial, edits: [{}] } as typeof initial);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(host.querySelector("i")?.dataset.held).toBe("1");
    account.mockReturnValue("acct:other@test");
    let finish!: (value: typeof initial) => void;
    read.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    for (let i = 0; i < 15; i++) {
      await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(100); });
    }
    expect(read).toHaveBeenCalledTimes(2);
    expect(host.querySelector("i")?.dataset.held).toBe("0");
    read.mockResolvedValue({ ...initial, account: "acct:other@test" });
    await act(async () => { finish({ ...initial, account: "acct:other@test" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const reads = read.mock.calls.length;
    const checks = account.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(account).toHaveBeenCalledTimes(checks);
    expect(read).toHaveBeenCalledTimes(reads);
  } finally { account.mockRestore(); read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("account round trip before a queued render does not poll and keeps the pending notification", async () => {
  const initial = await readStorageRecovery();
  const account = vi.spyOn(accountScope, "getAccountNamespace").mockReturnValue("local");
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue(initial);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    read.mockResolvedValue({ ...initial, edits: [{}] } as typeof initial);
    act(() => {
      account.mockReturnValue("acct:other@test");
      for (let i = 0; i < 3; i++) window.dispatchEvent(new Event("focus"));
      const checks = account.mock.calls.length;
      // 같은 React 배치 안에서 렌더를 미룬 채 계정 B로 1초를 보낸다.
      vi.advanceTimersByTime(1000);
      expect(account).toHaveBeenCalledTimes(checks);
      expect(read).toHaveBeenCalledTimes(1);
      account.mockReturnValue("local"); // React flushes the queued render only after this batch.
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(host.querySelector("i")?.dataset.held).toBe("1");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(read).toHaveBeenCalledTimes(2);
  } finally { account.mockRestore(); read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("ready notification starts a read without polling and retains normal coalescing", async () => {
  const initial = await readStorageRecovery();
  const ready = vi.spyOn(sceneStore, "sceneStoreReady").mockReturnValue(false);
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue(initial);
  let external!: () => void;
  const offExternal = vi.spyOn(sceneStore, "subscribeSceneStoreExternal").mockImplementation((fn) => { external = fn; return () => {}; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    const checks = ready.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1750); });
    expect(ready).toHaveBeenCalledTimes(checks);
    expect(read).not.toHaveBeenCalled();
    ready.mockReturnValue(true);
    await act(async () => { external(); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { external(); external(); });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(read).toHaveBeenCalledTimes(3);
  } finally { ready.mockRestore(); read.mockRestore(); offExternal.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("same window card recovery updates held counts without focus or scene notifications", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(host.querySelector("i")?.dataset.held).toBe("0");
    localStorage.setItem("ch.sceneCardRevives.v1.local", JSON.stringify([{ scene_id: "a", card_id: "c", generation_id: "g" }]));
    request.mockResolvedValue({ restore_generation: "old", items: [] });
    await act(async () => { await sceneCardLinks.refreshSceneCardLinks(); await vi.advanceTimersByTimeAsync(250); });
    expect(JSON.parse(localStorage.getItem("mvhub.cardRecovery:local")!).candidates).toHaveLength(1);
    expect(host.querySelector("i")?.dataset.held).toBe("1");
  } finally { vi.useRealTimers(); }
}, 15_000);
it.each([false, true])("manual refresh cancels when its account differs (already waiting: %s)", async (waiting) => {
  const account = vi.spyOn(accountScope, "getAccountNamespace").mockReturnValue("local");
  const ready = vi.spyOn(sceneStore, "sceneStoreReady").mockReturnValue(false);
  const read = vi.spyOn(sceneArchive, "readStorageRecovery");
  let refresh!: () => Promise<void> | undefined;
  function Probe() { [, refresh] = useStorageRecovery(); return null; }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    let done = false;
    if (!waiting) account.mockReturnValue("acct:other@test");
    let result!: Promise<void>;
    act(() => { result = Promise.resolve(refresh()).then(() => { done = true; }); });
    account.mockReturnValue("acct:other@test");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(done).toBe(true);
    await result;
    expect(read).not.toHaveBeenCalled();
  } finally { account.mockRestore(); ready.mockRestore(); read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("account switch never renders the previous account read failure", async () => {
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockRejectedValue(new Error("account A failed"));
  const rendered: boolean[] = [];
  function Probe() {
    const [, , failed] = useStorageRecovery();
    rendered.push(failed);
    return null;
  }
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    await confirmReadFailure();
    expect(rendered.at(-1)).toBe(true);
    read.mockImplementation(() => new Promise(() => {}));
    rendered.length = 0;
    setAccountScope("other@test");
    await act(async () => root!.render(<Probe />));
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.every((failed) => !failed)).toBe(true);
  } finally { read.mockRestore(); }
});
it.each([
  ["same", 0], ["camera", 0], ["all generations match", 0], ["different", 1],
  ["missing", 1], ["ledger elsewhere", 2], ["mixed", 1], ["older differs", 2],
  ["broken JSON", 1], ["wrong body id", 1], ["execution record", 1], ["comfyRuns only", 1],
  ["legacy", 1], ["unknown", 1], ["other account", 1], ["not ready", 1], ["working copy only", 1],
])("redundant mirror hold: %s", async (kind, expected) => {
  const original = { generation: "old", scenes: [{ id: "a", text: JSON.stringify(scene("a")) }], ledger: [] as [string, { b: string }][] };
  const originals = [original];
  const blockedIds = ["a"];
  if (kind === "camera") original.scenes[0].text = JSON.stringify({ ...scene("a"), camera: { x: 20, y: 30, z: 2 } });
  if (kind === "different") original.scenes[0].text = JSON.stringify(scene("a", "unique"));
  if (kind === "missing") { original.scenes[0] = { id: "gone", text: JSON.stringify(scene("gone")) }; blockedIds[0] = "gone"; }
  if (kind === "mixed") { original.scenes.push({ id: "gone", text: JSON.stringify(scene("gone")) }); blockedIds.push("gone"); }
  if (kind === "ledger elsewhere") originals.push({ generation: "older", scenes: [], ledger: [["a", { b: "old-base" }]] });
  if (kind === "older differs" || kind === "all generations match") originals.push({ generation: "older", scenes: [{ id: "a", text: JSON.stringify(scene("a", kind === "older differs" ? "unique" : "a")) }], ledger: [] });
  if (kind === "broken JSON") original.scenes[0].text = "{";
  if (kind === "wrong body id") original.scenes[0].text = JSON.stringify(scene("b"));
  if (kind === "execution record") original.scenes[0].text = JSON.stringify({ ...scene("a"), comfyCardRuns: { c: { groupId: "g", groupSeq: 1 } } });
  if (kind === "comfyRuns only") original.scenes[0].text = JSON.stringify({ ...scene("a"), comfyRuns: [{ version: 1, attemptId: "attempt", runGroupId: "g", groupSeq: 1, copyIndex: 0, cardId: "c", originHubId: "h", originDeviceId: "d", localState: "submitted", configFp: "cfg", inputFp: "input" }] });
  if (kind === "working copy only") original.scenes[0].text = JSON.stringify(scene("a", "pending"));
  const raw = JSON.stringify({ generation: "new", blockedIds, raws: {}, originals });
  localStorage.setItem("mvhub.mirrorRecovery:local", raw);
  const recovery = await readStorageRecovery();
  if (kind === "working copy only") {
    abortSceneStoreWritesForTest(true);
    applySceneOp((all) => { all[bucket] = [scene("a", "pending")]; return { write: true, value: null }; });
    expect(readWorkingBucket(bucket)[0].name).toBe("pending");
  }
  if (kind === "legacy") setHubFeatures([]);
  if (kind === "other account") {
    await writeScenesStore({ [bucket]: [scene("a")], "acct:other@test::_none": [scene("a")] });
    setAccountScope("other@test");
  }
  const unknown = kind === "unknown" ? vi.spyOn(hubFeatures, "hubFeaturesKnown").mockReturnValue(false) : null;
  const notReady = kind === "not ready" ? vi.spyOn(sceneStore, "sceneStoreReady").mockReturnValue(false) : null;
  try {
    expect(heldRecoveryCounts(recovery).canvas).toBe(expected);
    expect(recovery.mirror).toEqual(JSON.parse(raw));
    expect(localStorage.getItem("mvhub.mirrorRecovery:local")).toBe(raw);
  } finally { unknown?.mockRestore(); notReady?.mockRestore(); }
});

it.each([
  ["legacy", "resolved"], ["notebook", "resolved"], ["legacy", "ledger"], ["notebook", "ledger"],
])("no extra recovery download for %s hub with only %s originals", async (hub, kind) => {
  setHubFeatures(hub === "notebook" ? ["scene_writer_v1"] : []);
  const original = { generation: "old", scenes: kind === "resolved" ? [{ id: "a", text: JSON.stringify(scene("a")) }] : [], ledger: kind === "ledger" ? [["a", { b: "old" }]] : [] };
  const raw = JSON.stringify({ generation: "new", blockedIds: [], raws: {}, originals: [original] });
  localStorage.setItem("mvhub.mirrorRecovery:local", raw);
  root = createRoot(host); await act(async () => root!.render(<CanvasArchiveSection />));
  expect(host.textContent).not.toContain("복원 전에 남겨 둔 것");
  expect(host.textContent).not.toContain("보관본 내려받기");
  expect(localStorage.getItem("mvhub.mirrorRecovery:local")).toBe(raw);
});

it.each([false, true])("an id without its own original does not expose recovery download (other original: %s)", async (hasOtherOriginal) => {
  const original = { generation: "old", scenes: hasOtherOriginal ? [{ id: "b", text: JSON.stringify(scene("b")) }] : [], ledger: [] };
  const raw = JSON.stringify({ generation: "new", blockedIds: ["a"], raws: {}, originals: [original] });
  localStorage.setItem("mvhub.mirrorRecovery:local", raw);
  root = createRoot(host); await act(async () => root!.render(<CanvasArchiveSection />));
  expect(host.textContent).not.toContain("보관본 내려받기");
  expect(redundantMirrorHoldIds(await readStorageRecovery()).size).toBe(0);
  expect(localStorage.getItem("mvhub.mirrorRecovery:local")).toBe(raw);
});

it("redundant holds leave folded count zero and originals downloadable, then feature change restores the warning", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
  const original = { generation: "old", scenes: [{ id: "a", text: JSON.stringify(scene("a")) }], ledger: [] };
  const raw = JSON.stringify({ generation: "new", blockedIds: ["a"], raws: {}, originals: [original] });
  localStorage.setItem("mvhub.mirrorRecovery:local", raw);
  root = createRoot(host); await act(async () => root!.render(<><HeldProbe /><CanvasArchiveSection /></>));
  expect(host.querySelector("i")?.dataset.held).toBe("0");
  expect(host.textContent).not.toContain("복원 전에 남겨 둔 것");
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "보관본 내려받기");
  expect(button).toBeDefined();
  await act(async () => button!.click());
  const exported = JSON.parse(download.mock.calls.at(-1)![1]);
  expect(exported.recovery.mirror).toEqual(JSON.parse(raw));
  expect(exported.buckets[bucket]).toEqual([scene("a")]);
  expect(localStorage.getItem("mvhub.mirrorRecovery:local")).toBe(raw);
  await act(async () => { setHubFeatures([]); await vi.advanceTimersByTimeAsync(250); });
  expect(host.querySelector("i")?.dataset.held).toBe("1");
  expect(host.textContent).toContain("복원 전에 남겨 둔 것");
  } finally { vi.useRealTimers(); }
});
it.each(["persisted", "external"])("held counts follow %s scene notifications without reopening settings", async (notification) => {
  const original = { generation: "old", scenes: [{ id: "a", text: JSON.stringify(scene("a")) }], ledger: [] };
  const raw = JSON.stringify({ generation: "new", blockedIds: ["a"], raws: {}, originals: [original] });
  localStorage.setItem("mvhub.mirrorRecovery:local", raw);
  // Each notification must refresh independently, even when the other channel is silent.
  const offPersisted = vi.fn(), offExternal = vi.fn();
  const subscribePersisted = scenes.subscribeScenesPersisted, subscribeExternal = sceneStore.subscribeSceneStoreExternal;
  const persisted = vi.spyOn(scenes, "subscribeScenesPersisted").mockImplementation((fn) => {
    const off = notification === "persisted" ? subscribePersisted(fn) : () => {};
    return () => { off(); offPersisted(); };
  });
  const external = vi.spyOn(sceneStore, "subscribeSceneStoreExternal").mockImplementation((fn) => {
    const off = notification === "external" ? subscribeExternal(fn) : () => {};
    return () => { off(); offExternal(); };
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<><HeldProbe /><CanvasArchiveSection /></>));
    expect(host.querySelector("i")?.dataset.held).toBe("0");
    for (const [name, held] of [["changed", "1"], ["a", "0"]]) {
      await act(async () => {
        const result = await sceneNotebookTransaction([], (all) => {
          all[bucket] = [scene("a", name), scene("b")];
          return { changed: true, value: null };
        });
        expect(result.ok).toBe(true);
        await settleSceneStoreForTest();
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(host.querySelector("i")?.dataset.held).toBe(held);
      expect(host.textContent?.includes("복원 전에 남겨 둔 것")).toBe(held === "1");
      expect(localStorage.getItem("mvhub.mirrorRecovery:local")).toBe(raw);
    }
    act(() => root!.unmount()); root = undefined;
    expect(offPersisted).toHaveBeenCalledTimes(2);
    expect(offExternal).toHaveBeenCalledTimes(2);
  } finally { persisted.mockRestore(); external.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("slow recovery reads run one at a time and apply progress before the queued read completes", async () => {
  const initial = await readStorageRecovery();
  const one = { ...initial, cards: { candidates: [{ removals: [{ id: "one" }], revives: [], backfill: [] }] } };
  const two = { ...one, cards: { candidates: [{ removals: [{ id: "one" }, { id: "two" }], revives: [], backfill: [] }] } };
  const resolves: ((value: typeof initial) => void)[] = [];
  let active = 0, peak = 0;
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockImplementation(() => {
    peak = Math.max(peak, ++active);
    return new Promise<typeof initial>((resolve) => resolves.push(resolve)).finally(() => { active--; });
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    for (let n = 0; n < 6; n++) await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => resolves[0](one));
    expect(host.querySelector("i")?.dataset.held).toBe("1");
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => resolves[1](two));
    expect(host.querySelector("i")?.dataset.held).toBe("2");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  } finally { read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it.each(["success", "failure"])("recovery ignores a stale read %s after the latest response", async (staleResult) => {
  const initial = await readStorageRecovery();
  const latest = { ...initial, cards: { candidates: [{ removals: [{ id: "held" }], revives: [], backfill: [] }] } };
  const reads: { resolve: (value: typeof initial) => void; reject: (reason: Error) => void }[] = [];
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockImplementation(() => new Promise((resolve, reject) => reads.push({ resolve, reject })));
  const writer = vi.spyOn(sceneWriter, "useSceneWriter").mockReturnValue({ mode: "disabled", handed: false, localCount: 0 });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    writer.mockReturnValue({ mode: "local_only", handed: false, localCount: 0 });
    await act(async () => root!.render(<HeldProbe />));
    expect(reads).toHaveLength(2);
    await act(async () => reads[1].resolve(latest));
    expect(host.querySelector("i")?.dataset).toMatchObject({ held: "1", failed: "false" });
    await act(async () => {
      if (staleResult === "success") reads[0].resolve(initial);
      else reads[0].reject(new Error("stale failure"));
    });
    expect(host.querySelector("i")?.dataset).toMatchObject({ held: "1", failed: "false" });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(reads).toHaveLength(3);
    await act(async () => reads[2].reject(new Error("current failure")));
    expect(host.querySelector("i")?.dataset.failed).toBe("false");
    await confirmReadFailure();
    await act(async () => reads[3].reject(new Error("confirmed current failure")));
    expect(host.querySelector("i")?.dataset).toMatchObject({ held: "1", failed: "true" });
  } finally { read.mockRestore(); writer.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it.each(["success", "failure"])("a not-ready notification preserves the pending recovery read %s", async (result) => {
  const recovery = { ...await readStorageRecovery(), cards: { candidates: [{ removals: [{ id: "held" }], revives: [], backfill: [] }] } };
  let resolve!: (value: typeof recovery) => void, reject!: (reason: Error) => void;
  const pending = new Promise<typeof recovery>((ok, fail) => { resolve = ok; reject = fail; });
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockReturnValue(pending);
  const ready = vi.spyOn(sceneStore, "sceneStoreReady").mockReturnValue(true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    ready.mockReturnValue(false);
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(1);
    ready.mockReturnValue(true);
    await act(async () => {
      if (result === "success") resolve(recovery);
      else reject(new Error("pending failure"));
    });
    expect(host.querySelector("i")?.dataset).toMatchObject({ held: result === "success" ? "1" : "0", failed: result === "failure" ? "true" : "false" });
  } finally { read.mockRestore(); ready.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("recovery does not poll an unopened store and reads on its next notification", async () => {
  const recovery = await readStorageRecovery();
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue(recovery);
  const ready = vi.spyOn(sceneStore, "sceneStoreReady").mockReturnValue(false);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    const checks = ready.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(ready).toHaveBeenCalledTimes(checks);
    expect(read).not.toHaveBeenCalled();
    ready.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(249); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(read).toHaveBeenCalledTimes(2);
    ready.mockReturnValue(false);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    act(() => root!.unmount()); root = undefined;
    ready.mockClear().mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(ready).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
  } finally { read.mockRestore(); ready.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it.each(["success", "failure", "notification"])("an old account effect discards %s and notifications switch only the recovery hook", async (kind) => {
  const recovery = await readStorageRecovery();
  const account = vi.spyOn(accountScope, "getAccountNamespace").mockReturnValue("local");
  let resolve!: (value: typeof recovery) => void, reject!: (error: Error) => void;
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockImplementation(() => new Promise((ok, fail) => { resolve = ok; reject = fail; }));
  let renders = 0;
  function Probe() { renders++; return <HeldProbe />; }
  const writer = vi.spyOn(sceneWriter, "useSceneWriter");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    const beforeRenders = renders, beforeHooks = writer.mock.calls.length;
    const finishOld = resolve;
    account.mockReturnValue("acct:other@test");
    await act(async () => {
      if (kind === "success") resolve(recovery);
      else if (kind === "failure") reject(new Error("account changed"));
      else { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(250); }
    });
    if (kind === "notification") {
      expect(read).toHaveBeenCalledTimes(2);
      expect(writer.mock.calls.length).toBeGreaterThan(beforeHooks);
      await act(async () => { finishOld({ ...recovery, edits: [{}] } as typeof recovery); });
      expect(host.querySelector("i")?.dataset).toMatchObject({ held: "0", failed: "false" });
      expect(read).toHaveBeenCalledTimes(2);
    } else {
      expect(read).toHaveBeenCalledTimes(1);
      expect(writer).toHaveBeenCalledTimes(beforeHooks);
    }
    expect(renders).toBe(beforeRenders);
  } finally { account.mockRestore(); read.mockRestore(); writer.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it.each(["none", "export success", "export failure"])("recovery retry clears its error and preserves %s message", async (otherMessage) => {
  const recovery = await readStorageRecovery();
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockRejectedValue(new Error("read failed"));
  const exportAll = vi.spyOn(sceneArchive, "downloadSceneArchive");
  const readError = "보관본을 읽지 못했습니다. 이 브라우저의 자료는 유지했습니다.";
  const exportMessage = otherMessage === "export success" ? "캔버스 2개를 파일로 내려받았습니다." : "내보내기 실패";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<><HeldProbe /><CanvasArchiveSection /></>));
    await confirmReadFailure();
    expect(host.querySelector("i")?.dataset.failed).toBe("true");
    expect(host.textContent).toContain(readError);
    if (otherMessage !== "none") {
      if (otherMessage === "export success") exportAll.mockResolvedValue(2);
      else exportAll.mockRejectedValue(new Error(exportMessage));
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "전체 내보내기");
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(host.textContent).toContain(exportMessage);
      expect([...host.querySelectorAll('[role="status"]')].some((node) => node.textContent === readError)).toBe(true);
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(host.textContent).toContain(readError);
      expect(host.textContent).toContain(exportMessage);
    }
    read.mockResolvedValue(recovery);
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(250); });
    expect(host.querySelector("i")?.dataset.failed).toBe("false");
    expect(host.textContent).not.toContain(readError);
    if (otherMessage !== "none") expect(host.textContent).toContain(exportMessage);
  } finally { read.mockRestore(); exportAll.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("account change clears the previous recovery error while the new read is pending", async () => {
  const recovery = { ...await readStorageRecovery(), account: "acct:other@test" };
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockRejectedValue(new Error("account A read failed"));
  const readError = "보관본을 읽지 못했습니다. 이 브라우저의 자료는 유지했습니다.";
  try {
    root = createRoot(host); await act(async () => root!.render(<><HeldProbe /><CanvasArchiveSection /></>));
    await confirmReadFailure();
    expect(host.querySelector("i")?.dataset.failed).toBe("true");
    expect(host.textContent).toContain(readError);
    let resolve!: (value: typeof recovery) => void;
    const pending = new Promise<typeof recovery>((done) => { resolve = done; });
    read.mockClear().mockReturnValue(pending);
    await act(async () => {
      setAccountScope("other@test");
      root!.render(<><HeldProbe /><CanvasArchiveSection /></>);
    });
    expect(read).toHaveBeenCalled();
    expect(host.querySelector("i")?.dataset.failed).toBe("false");
    expect(host.textContent).not.toContain(readError);
    await act(async () => resolve(recovery));
    expect(host.querySelector("i")?.dataset.failed).toBe("false");
  } finally { read.mockRestore(); }
}, 15_000);
it.each([
  [true, false, 0], [false, true, 0], [false, false, 1],
] as const)("persisted recovery reads respect cameraOnly=%s notebookMetaOnly=%s", async (cameraOnly, notebookMetaOnly, expected) => {
  const recovery = await readStorageRecovery();
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue(recovery);
  let persisted!: Parameters<typeof scenes.subscribeScenesPersisted>[0];
  const subscription = vi.spyOn(scenes, "subscribeScenesPersisted").mockImplementation((fn) => { persisted = fn; return () => {}; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    read.mockClear();
    await act(async () => { persisted({ cameraOnly, notebookMetaOnly }); await vi.advanceTimersByTimeAsync(500); });
    expect(read).toHaveBeenCalledTimes(expected);
  } finally { read.mockRestore(); subscription.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("recovery refresh and unchanged tuple stay stable across renders", async () => {
  const recovery = await readStorageRecovery();
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue(recovery);
  let state!: ReturnType<typeof useStorageRecovery>;
  function Probe() { state = useStorageRecovery(); return null; }
  try {
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    const first = state;
    await act(async () => root!.render(<Probe />));
    expect(state[1]).toBe(first[1]);
    expect(state).toBe(first);
    read.mockRejectedValue(new Error("read failed"));
    await act(async () => { await first[1](); });
    await confirmReadFailure();
    expect(state[1]).toBe(first[1]);
    expect(state).not.toBe(first);
    expect(state[2]).toBe(true);
  } finally { read.mockRestore(); }
}, 15_000);
it("scene notification bursts share a bounded recovery read and cancel it on unmount", async () => {
  const recovery = await readStorageRecovery();
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue(recovery);
  let persisted!: () => void, external!: () => void;
  const offPersisted = vi.spyOn(scenes, "subscribeScenesPersisted").mockImplementation((fn) => { persisted = () => fn({ notebookMetaOnly: false, cameraOnly: false }); return () => {}; });
  const offExternal = vi.spyOn(sceneStore, "subscribeSceneStoreExternal").mockImplementation((fn) => { external = fn; return () => {}; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    read.mockClear();
    await act(async () => external());
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(1);
    read.mockClear();
    for (let n = 0; n < 5; n++) {
      await act(async () => { persisted(); external(); await vi.advanceTimersByTimeAsync(49); });
    }
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { persisted(); await vi.advanceTimersByTimeAsync(5); });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); external(); });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    read.mockClear();
    await act(async () => { external(); await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new Event("storage")); });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => { external(); persisted(); });
    expect(read).toHaveBeenCalledTimes(3);
    act(() => root!.unmount()); root = undefined;
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(3);
  } finally { read.mockRestore(); offPersisted.mockRestore(); offExternal.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it.each([false, true])("a successful recovery response clears only the read error (other message: %s)", async (otherMessage) => {
  const recovery = await readStorageRecovery();
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockRejectedValue(new Error("read failed"));
  const exportAll = vi.spyOn(sceneArchive, "downloadSceneArchive").mockResolvedValue(2);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<><HeldProbe /><CanvasArchiveSection /></>));
    await confirmReadFailure();
    expect(host.querySelector("i")?.dataset.failed).toBe("true");
    if (otherMessage) {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "전체 내보내기");
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(host.textContent).toContain("캔버스 2개를 파일로 내려받았습니다.");
    }
    read.mockResolvedValue(recovery);
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(250); });
    expect(host.querySelector("i")?.dataset).toMatchObject({ held: "0", failed: "false" });
    expect(host.textContent).not.toContain("보관본을 읽지 못했습니다.");
    if (otherMessage) expect(host.textContent).toContain("캔버스 2개를 파일로 내려받았습니다.");
  } finally { read.mockRestore(); exportAll.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("recovery account error uses the human-readable constant", async () => {
  await expect(readStorageRecovery("acct:other@test")).rejects.toMatchObject({ message: sceneArchive.RECOVERY_ACCOUNT_CHANGED });
  expect(sceneArchive.RECOVERY_ACCOUNT_CHANGED).toBe("계정이 바뀌어 보관본을 다시 읽어야 합니다.");
});
it("deferred recovery rejects a changed expected account before reading archives", async () => {
  const expected = accountScope.getAccountNamespace();
  const archives = vi.spyOn(sceneNotebook, "readRestoreArchives").mockResolvedValue({ ok: true, value: [], fresh: true });
  try {
    const pending = Promise.resolve().then(() => readStorageRecovery(expected));
    setAccountScope("other@test");
    await expect(pending).rejects.toThrow(sceneArchive.RECOVERY_ACCOUNT_CHANGED);
    expect(archives).not.toHaveBeenCalled();
    await expect(readStorageRecovery()).resolves.toMatchObject({ account: "acct:other@test" });
    expect(archives).toHaveBeenCalledWith("acct:other@test");
  } finally { archives.mockRestore(); setAccountScope(null); }
}, 15_000);
it("focus keeps real mirror holds after an external refresh fails, then external refresh restores freshness", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let recovery: Awaited<ReturnType<typeof readStorageRecovery>> | null = null;
  function Probe() { [recovery] = useStorageRecovery(); return null; }
  const hold = (name: string) => localStorage.setItem("mvhub.mirrorRecovery:local", JSON.stringify({
    generation: "new", blockedIds: ["a"], raws: {},
    originals: [{ scenes: [{ id: "a", text: JSON.stringify(scene("a", name)) }], ledger: [] }],
  }));
  try {
    hold("a");
    root = createRoot(host); await act(async () => root!.render(<Probe />));
    expect([...redundantMirrorHoldIds(recovery)]).toEqual(["a"]);
    sceneStore.writeSceneStoreAsOtherWindowForTest((all) => { all[bucket] = [scene("a", "B")]; });
    const clone = vi.spyOn(globalThis, "structuredClone").mockImplementationOnce(() => { throw Error("external read failed"); });
    try { expect(await sceneStore.refreshSceneStoreForTest()).toBe(false); }
    finally { clone.mockRestore(); }
    expect(sceneStore.readConfirmedBucket(bucket)[0].name).toBe("a");
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(250); });
    expect([...redundantMirrorHoldIds(recovery)]).toEqual([]);
    expect(recovery).toMatchObject({ baseFresh: false });
    hold("B");
    await act(async () => {
      expect(await sceneStore.refreshSceneStoreForTest()).toBe(true);
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(recovery).toMatchObject({ baseFresh: true });
    expect([...redundantMirrorHoldIds(recovery)]).toEqual(["a"]);
  } finally { vi.useRealTimers(); }
}, 15_000);
it("recovery reads edit candidates after archives finish", async () => {
  const key = 'mvhub.editRecovery:["local","doc"]';
  localStorage.setItem(key, JSON.stringify({ blocked: true, originals: [{ raw: "before" }] }));
  const readArchives = sceneNotebook.readRestoreArchives;
  const archives = vi.spyOn(sceneNotebook, "readRestoreArchives").mockImplementation(async (account) => {
    const result = await readArchives(account);
    localStorage.setItem(key, JSON.stringify({ blocked: true, originals: [{ raw: "after" }] }));
    return result;
  });
  try { expect((await readStorageRecovery()).edits).toEqual([{ docKey: "doc", originals: [{ raw: "after" }] }]); }
  finally { archives.mockRestore(); }
});
it("recovery avoids the redundant account check after metadata guards", async () => {
  const account = vi.spyOn(accountScope, "getAccountNamespace");
  try {
    expect((await readStorageRecovery("local")).account).toBe("local");
    // 시작·메타 읽기 전후만 확인하고, 나머지는 잡아 둔 계정으로 읽는다.
    expect(account).toHaveBeenCalledTimes(3);
  } finally { account.mockRestore(); }
});
it("recovery keeps all parts in the captured account when it changes after the metadata guard", async () => {
  for (const account of ["local", "acct:other@test"]) {
    localStorage.setItem(`mvhub.mirrorRecovery:${account}`, JSON.stringify({ generation: account, blockedIds: [], originals: [] }));
    localStorage.setItem(`mvhub.cardRecovery:${account}`, JSON.stringify({ candidates: [{ removals: [account], revives: [], backfill: [] }] }));
    localStorage.setItem(`mvhub.editRecovery:${JSON.stringify([account, "doc"])}`, JSON.stringify({ blocked: true, originals: [{ raw: account }] }));
  }
  const readArchives = sceneNotebook.readRestoreArchives;
  const archives = vi.spyOn(sceneNotebook, "readRestoreArchives").mockImplementation(async (account) => {
    const result = await readArchives(account);
    setAccountScope("other@test");
    return result;
  });
  try {
    const result = await readStorageRecovery("local");
    expect(accountScope.getAccountNamespace()).toBe("acct:other@test");
    expect(result).toMatchObject({
      account: "local", canvases: [], mirror: { generation: "local" },
      cards: { candidates: [{ removals: ["local"], revives: [], backfill: [] }] },
      edits: [{ docKey: "doc", originals: [{ raw: "local" }] }],
    });
  } finally { archives.mockRestore(); setAccountScope(null); }
});
it.each([false, true])("recovery read distinguishes an account change from storage failure (changed: %s)", async (changed) => {
  let finish!: (value: Awaited<ReturnType<typeof readRestoreArchives>>) => void;
  const archives = vi.spyOn(sceneNotebook, "readRestoreArchives").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  try {
    const result = readStorageRecovery();
    if (changed) setAccountScope("other@test");
    finish(changed ? { ok: false, stale: true } : { ok: false });
    await expect(result).rejects.toThrow(changed ? sceneArchive.RECOVERY_ACCOUNT_CHANGED : "보관본을 읽지 못했습니다.");
  } finally { archives.mockRestore(); setAccountScope(null); }
}, 15_000);
it("an account-change recovery error retries without showing failure after an account round trip", async () => {
  const recovery = { ...await readStorageRecovery(), cards: { candidates: [{ removals: [{ id: "own" }], revives: [], backfill: [] }] } };
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockResolvedValue(recovery);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    root = createRoot(host); await act(async () => root!.render(<HeldProbe />));
    expect(host.querySelector("i")?.dataset.held).toBe("1");
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    read.mockImplementationOnce(async () => {
      setAccountScope("other@test");
      const error = new Error(sceneArchive.RECOVERY_ACCOUNT_CHANGED);
      setAccountScope(null);
      throw error;
    });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(host.querySelector("i")?.dataset).toMatchObject({ held: "1", failed: "false" });
    read.mockResolvedValue({ ...recovery, cards: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(read).toHaveBeenCalledTimes(3);
    expect(host.querySelector("i")?.dataset).toMatchObject({ held: "0", failed: "false" });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(read).toHaveBeenCalledTimes(3);
  } finally { read.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("an unchanged import clears recovery read failure through the hook", async () => {
  const recovery = await readStorageRecovery();
  const read = vi.spyOn(sceneArchive, "readStorageRecovery").mockRejectedValue(new Error("read failed"));
  const importArchive = vi.spyOn(sceneArchive, "importSceneArchiveText").mockResolvedValue({ added: 0, recovered: 0 });
  try {
    root = createRoot(host); await act(async () => root!.render(<CanvasArchiveSection />));
    await confirmReadFailure();
    expect(host.textContent).toContain("보관본을 읽지 못했습니다.");
    read.mockResolvedValue(recovery);
    const input = host.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [{ text: async () => "archive" }] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
    expect(importArchive).toHaveBeenCalledWith("archive");
    expect(host.textContent).toContain("파일의 캔버스가 이미 모두 있습니다");
    expect(host.textContent).not.toContain("보관본을 읽지 못했습니다.");
  } finally { read.mockRestore(); importArchive.mockRestore(); }
}, 15_000);
it.each(["same-window", "storage"])("%s mirror changes refresh two recovery views with one read per view per window", async (source) => {
  setHubFeatures([]);
  const original = { generation: "old", scenes: [{ id: "a", text: JSON.stringify(scene("a")) }], ledger: [] };
  localStorage.setItem("mvhub.mirrorRecovery:local", JSON.stringify({ generation: "new", blockedIds: ["a"], originals: [original], raws: {} }));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const read = vi.spyOn(sceneArchive, "readStorageRecovery");
  const persisted = vi.spyOn(scenes, "subscribeScenesPersisted").mockReturnValue(() => {});
  try {
    root = createRoot(host); await act(async () => root!.render(<><HeldProbe /><HeldProbe /></>));
    expect([...host.querySelectorAll("i")].map((node) => node.dataset.held)).toEqual(["1", "1"]);
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => {
      if (source === "same-window") await sceneBackup.resumeImportedMirror("local", "new", new Map([["a", JSON.stringify(scene("a"))]]));
      else {
        const key = "mvhub.mirrorRecovery:local", oldValue = localStorage.getItem(key)!;
        const newValue = JSON.stringify({ ...JSON.parse(oldValue), blockedIds: [] });
        localStorage.setItem(key, newValue);
        for (let n = 0; n < 10; n++) window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue, storageArea: localStorage }));
      }
    });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(sceneBackup.readMirrorRecovery()?.blockedIds).toEqual([]);
    expect([...host.querySelectorAll("i")].map((node) => node.dataset.held)).toEqual(["0", "0"]);
    expect(read).toHaveBeenCalledTimes(4);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(read).toHaveBeenCalledTimes(4);
  } finally { read.mockRestore(); persisted.mockRestore(); vi.useRealTimers(); }
}, 15_000);
it("the folded settings line reads the same held count as the recovery group, only for this account", async () => {
  await changed(); await syncSceneNotebook();
  localStorage.setItem('mvhub.editRecovery:["local","doc"]', JSON.stringify({ blocked: true, originals: [{ raw: "original" }] }));
  localStorage.setItem("mvhub.cardRecovery:local", JSON.stringify({ generation: "new", candidates: [{ removals: [{ id: "old" }], revives: [], backfill: [] }] }));
  root = createRoot(host); await act(async () => root!.render(<><CanvasArchiveSection /><HeldProbe /></>));
  expect(host.textContent).toContain("캔버스 보관본 1개 · 편집 문서 1개 · 카드 정리 대기 1개");
  expect(host.querySelector("i")!.dataset.held).toBe("3");
  setAccountScope("other@example.com");
  await act(async () => root!.render(<><CanvasArchiveSection /><HeldProbe /></>));
  expect(host.querySelector("i")!.dataset.held).toBe("0");
});
it("recovery UI stays hidden when there are no pending candidates", async () => {
  root = createRoot(host); await act(async () => root!.render(<CanvasArchiveSection />));
  expect(host.textContent).not.toContain("복원 전에 남겨 둔 것");
});
it.each([false, true])("legacy empty archives stay readable/exportable but do not count (with real control: %s)", async (hasProgress) => {
  const empty: RestoreArchive = { id: "empty", createdAt: "2026-11-14", notebookId: "", fromGeneration: null,
    toGeneration: "new", scenes: { [bucket]: [] }, conflicts: [], controls: { '["ns","local"]': undefined, '["nw","local"]': undefined } };
  const archives = [empty, { ...empty, id: "json-empty", controls: {} }];
  if (hasProgress) archives.push({ ...empty, id: "progress", controls: { '["ns","local"]': { id: "old-start" } } });
  const archiveKey = '["nr","local"]';
  expect((await sceneNotebookTransaction([archiveKey], (_all, meta) => {
    meta[archiveKey] = archives;
    return { changed: true, value: null };
  })).ok).toBe(true);
  const before = await readRestoreArchives("local");
  const recovery = await readStorageRecovery();
  expect(recovery.canvases).toEqual(archives);
  expect(heldRecoveryCounts(recovery)).toEqual({ canvas: hasProgress ? 1 : 0, edit: 0, card: 0, total: hasProgress ? 1 : 0 });
  root = createRoot(host); await act(async () => root!.render(<><CanvasArchiveSection /><HeldProbe /></>));
  expect(host.querySelector("i")!.dataset.held).toBe(hasProgress ? "1" : "0");
  expect(host.textContent?.includes("복원 전에 남겨 둔 것")).toBe(hasProgress);
  downloadStorageRecovery(recovery);
  expect(JSON.parse(download.mock.calls[0][1]).recovery.canvases).toEqual(JSON.parse(JSON.stringify(archives)));
  expect(await readRestoreArchives("local")).toEqual(before);
});
it.each(["scene", "conflict", "control", "null-control"])("held recovery keeps an archive containing only %s", (kind) => {
  const archive: RestoreArchive = { id: "held", createdAt: "2026-11-14", notebookId: "", fromGeneration: null,
    toGeneration: "new", scenes: { [bucket]: kind === "scene" ? [scene("s")] : [] },
    conflicts: kind === "conflict" ? [{ bucket, sceneId: "s", mine: scene("s"), theirs: null }] : [],
    controls: kind === "control" ? { '["ns","local"]': { id: "start" } } : kind === "null-control" ? { '["ns","local"]': null } : {} };
  expect(heldRecoveryCounts({ account: "local", canvases: [archive], mirror: null, edits: [], cards: null }).canvas).toBe(1);
});
it.each([
  ["missing scenes", { controls: {} }],
  ["missing controls", { scenes: {} }],
  ["null archive", null],
  ["null scenes", { scenes: null, controls: {} }],
  ["null controls", { scenes: {}, controls: null }],
  ["array scenes", { scenes: [], controls: {} }],
  ["array controls", { scenes: {}, controls: [] }],
  ["number scenes", { scenes: 0, controls: {} }],
  ["boolean controls", { scenes: {}, controls: false }],
  ["invalid bucket", { scenes: { [bucket]: null }, controls: {} }],
  ["null conflicts", { scenes: {}, controls: {}, conflicts: null }],
  ["object conflicts", { scenes: {}, controls: {}, conflicts: {} }],
])("held recovery conservatively counts malformed archive: %s", (_name, value) => {
  const archive = value as unknown as RestoreArchive;
  expect(heldRecoveryCounts({ account: "local", canvases: [archive], mirror: null, edits: [], cards: null }).canvas).toBe(1);
});
it("clean upgrade and ledger-only isolation do not show a recovery group", async () => {
  const scenes = [scene("a"), scene("b")];
  await sceneNotebookTransaction([], (_all, meta) => {
    const { restoreGeneration: _previous, ...joined } = meta['["nj","local"]'] as { restoreGeneration?: string; notebookId: string; history: string };
    meta['["nj","local"]'] = joined;
    return { changed: true, value: null };
  });
  request.mockResolvedValue({ ...emptyBook(), notebook_id: "book", order: { ids: ["a", "b"], rev: 1, history_id: "h" },
    items: scenes.map((s) => ({ id: s.id, data: JSON.stringify(s), deleted_at: null, base: { history_id: "h", rev: 1, hash: hash(JSON.stringify(s)) } })) });
  await syncSceneNotebook();
  localStorage.setItem("mvhub.mirrorRecovery:local", JSON.stringify({ generation: "new", blockedIds: [], raws: {}, originals: [{ generation: null, scenes: [], ledger: [["a", { b: "old" }]] }] }));
  localStorage.setItem("mvhub.cardRecovery:local", JSON.stringify({ generation: "new", candidates: [] }));
  expect(await readRestoreArchives("local")).toMatchObject({ ok: true, value: [] });
  root = createRoot(host); await act(async () => root!.render(<CanvasArchiveSection />));
  expect(host.textContent).not.toContain("복원 전에 남겨 둔 것");
});
it("a held mirror deletion ledger remains visible even without a scene original", async () => {
  localStorage.setItem("mvhub.mirrorRecovery:local", JSON.stringify({ generation: "new", blockedIds: ["gone"], raws: {}, originals: [{ generation: "old", scenes: [], ledger: [["gone", { b: "old" }]] }] }));
  root = createRoot(host); await act(async () => root!.render(<CanvasArchiveSection />));
  expect(host.textContent).toContain("복원 전에 남겨 둔 것");
  expect(host.textContent).toContain("캔버스 보관본 1개");
});
it("an unstarted hub with matching bodies and different order has no orange recovery group", async () => {
  const scenes = [scene("a"), scene("b")];
  await sceneNotebookTransaction([], (all, meta) => {
    delete meta['["nj","local"]']; all[bucket] = [...scenes].reverse();
    return { changed: true, value: null };
  });
  request.mockResolvedValue({ ...emptyBook(), order: { ids: ["a", "b"], rev: 0, history_id: "h" },
    items: scenes.map((s) => ({ id: s.id, data: JSON.stringify(s), deleted_at: null, base: { history_id: "h", rev: 1, hash: hash(JSON.stringify(s)) } })) });
  await syncSceneNotebook();
  expect(await readRestoreArchives("local")).toMatchObject({ ok: true, value: [] });
  expect(readWorkingBucket(bucket).map((s) => s.id)).toEqual(["b", "a"]);
  root = createRoot(host); await act(async () => root!.render(<CanvasArchiveSection />));
  expect(host.textContent).not.toContain("복원 전에 남겨 둔 것");
});
it("full import resumes the held mirror and hides the orange group without deleting originals", async () => {
  setHubFeatures([]);
  const original = { generation: "old", scenes: [{ id: "a", text: JSON.stringify(scene("a")) }], ledger: [] };
  localStorage.setItem("mvhub.mirrorRecovery:local", JSON.stringify({ generation: "new", blockedIds: ["a"], raws: {}, originals: [original] }));
  request.mockResolvedValue({ restore_generation: "new", items: [{ id: "a", data_hash: hash(JSON.stringify(scene("a"))) }] });
  root = createRoot(host); await act(async () => root!.render(<CanvasArchiveSection />));
  expect(host.textContent).toContain("캔버스 보관본 1개");
  const file = { text: async () => JSON.stringify({ format: "mvhub-scenes-full", schemaVersion: 1, buckets: { [bucket]: [scene("a")] }, conflicts: [] }) };
  const input = host.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await settleSceneStoreForTest(); });
  const recovery = await readStorageRecovery();
  expect(recovery.mirror?.blockedIds).toEqual([]);
  expect(recovery.mirror?.originals).toEqual([original]);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
  expect(host.textContent).not.toContain("복원 전에 남겨 둔 것");
  expect(request.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
