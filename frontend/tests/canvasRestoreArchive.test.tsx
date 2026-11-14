// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasArchiveSection, heldRecoveryCounts, useStorageRecovery } from "../src/components/settings/CanvasArchiveSection";
import { downloadStorageRecovery, readStorageRecovery, redundantMirrorHoldIds } from "../src/lib/sceneArchive";
import { joinSceneNotebook, readRestoreArchives, readSceneNotebook, setSceneNotebookTokenProvider, syncSceneNotebook, writeNotebookProgress, buildSceneNotebookClose, type RestoreArchive } from "../src/lib/sceneNotebook";
import { abortSceneStoreWritesForTest, applySceneOp, holdNotebookWrites, readWorkingBucket, setSceneWriteGate, settleSceneStoreForTest, writeScenesStore, sceneNotebookTransaction } from "../src/lib/sceneStore";
import { setAccountScope } from "../src/lib/accountScope";
import { setHubFeatures } from "../src/lib/hubFeatures";
import * as hubFeatures from "../src/lib/hubFeatures";
import * as sceneStore from "../src/lib/sceneStore";
import type { Scene } from "../src/lib/scenes";

const request = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/http", async (original) => ({ ...await original<typeof import("../src/lib/http")>(), jsonFetch: request }));
vi.mock("../src/lib/download", () => ({ downloadText: download }));
vi.mock("../src/lib/popupWindows", async (original) => ({ ...await original<typeof import("../src/lib/popupWindows")>(), useCanvasFloating: () => false, useCanvasFollower: () => false }));
const bucket = "local::_none";
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
  const [recovery] = useStorageRecovery();
  return <i data-held={heldRecoveryCounts(recovery).total} />;
}
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
  await act(async () => setHubFeatures([]));
  expect(host.querySelector("i")?.dataset.held).toBe("1");
  expect(host.textContent).toContain("복원 전에 남겨 둔 것");
});
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
  expect(host.textContent).not.toContain("복원 전에 남겨 둔 것");
  expect(request.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
