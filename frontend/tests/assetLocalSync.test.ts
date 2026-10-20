// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assetIdentityForProject, managedAssetUrl, promoteAssetReference, type AssetSyncReceipt } from "../src/shared/contracts/assets";
import { configureOperationContext, invalidateOperationContext } from "../src/app/operationContext";
import { setAccountScope } from "../src/lib/accountScope";
import { setApiPause } from "../src/lib/http";
import { syncSceneAssetReferences } from "../src/lib/sceneAssetRelink";
import { listPersistedScenes, listScenes, saveScenes, type Scene, type SceneRef } from "../src/lib/scenes";
import { loadSceneHistory, saveSceneHistory } from "../src/lib/sceneUndoStore";
import { failSceneStoreWritesForTest, settleSceneStoreForTest } from "../src/lib/sceneStore";
import { prepareSceneComfyInputs } from "../src/lib/sceneComfyInputs";
import { captureSceneGenerationInputSnapshot, isSceneGenerationInputSnapshotCurrent } from "../src/lib/sceneGenerationInputs";
import { assetsApi } from "../src/lib/assetsApi";
import { buildSpotlightCreateBody } from "../src/lib/spotlightSubmit";

const calls = vi.hoisted(() => ({ status: vi.fn(), register: vi.fn(), resolve: vi.fn() }));
vi.mock("../src/api", () => ({ api: { assetSyncStatus: calls.status, registerAssetReference: calls.register,
  resolveManagedAssets: calls.resolve } }));

const sha = "a".repeat(64);
const location = "12345678-1234-1234-1234-123456789012";
const receipt: AssetSyncReceipt = { state: "ready", asset_content_id: `sha256:${sha}`, original_file_path: "asset:captures|a.png",
  file_path: `asset-sync:${location}`, location_id: location, project_id: "p", owner_uid: "owner",
  storage_id: "storage", root_revision: "root-1", server_origin: "http://storage.test", bytes: 10 };
const ref = (): SceneRef => ({ file_path: receipt.original_file_path, type: "image", name: "내 그림",
  asset_content_id: receipt.asset_content_id, target_project_id: "p", content_sha: sha, bytes: 10 });
const scene = (id: string): Scene => ({ id, name: id, cards: [
  { id: "ref", kind: "reference", x: 0, y: 0, refs: [ref()] },
  { id: "gen", kind: "generation", x: 100, y: 0, prompt: "그대로 둘 글", refs: [{ ...ref(), from_card: true }] },
], edges: [{ id: "edge", from: "ref", to: "gen" }] });

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  setAccountScope("A");
  setApiPause(null);
  configureOperationContext({ key: "asset-test", serverOrigin: receipt.server_origin, authority: "local", ready: true });
  failSceneStoreWritesForTest(false);
  calls.status.mockReset().mockResolvedValue({ items: [receipt] });
  calls.register.mockReset();
  calls.resolve.mockReset().mockResolvedValue({ items: [] });
  saveScenes(null, []);
  await settleSceneStoreForTest();
});
afterEach(() => vi.unstubAllGlobals());

it("캡처·드롭은 반입 순간의 프로젝트와 공간을 로컬 요청에 고정하고 내용 ID를 보존한다", async () => {
  const reply = { project: "captures", path: "a.png", name: "capture.png", type: "image",
    asset_content_id: receipt.asset_content_id, target_project_id: "p", sync_state: "queued" };
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(reply), { status: 200,
    headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  const target = { target_project_id: "p", target_workspace_id: "w" };
  const result = await assetsApi.uploadCapture(new Blob(["bytes"], { type: "image/png" }), target);
  target.target_project_id = "changed";
  const form = fetcher.mock.calls[0][1].body as FormData;
  expect(form.get("target_project_id")).toBe("p");
  expect(form.get("target_workspace_id")).toBe("w");
  expect(result.asset_content_id).toBe(receipt.asset_content_id);
  await assetsApi.uploadReferenceFiles([new File(["bytes"], "a.png")], { target_workspace_id: "w" });
  expect((fetcher.mock.calls[1][1].body as FormData).get("target_project_id")).toBeNull();
});

it("생성 요청에 정확한 내용 ID·목적지·서버 위치를 프롬프트 역할과 함께 보존한다", () => {
  const reference = { ...promoteAssetReference(ref(), receipt), type: "image" as const, role: "@Image1", name: "원본", thumb: "" };
  const built = buildSpotlightCreateBody({ text: "그림", displayPrompt: "그림", inlineRefs: [reference], trayRefs: [],
    parts: [], model: "nano_banana", optionValues: {}, armedAutoTags: [], activeProjectId: "p" });
  expect(built.error).toBeNull();
  expect(built.body?.references?.[0]).toMatchObject({ file_path: receipt.file_path, asset_content_id: receipt.asset_content_id,
    target_project_id: "p", role: "@Image1", server_location: { location_id: location } });
});

it("같은 바이트의 정식 위치만 바꾸고 원래 역할·이름·썸네일을 보존한다", () => {
  const before = { ...ref(), role: "@Image2", thumb: "/local-thumb" };
  const after = promoteAssetReference(before, receipt);
  expect(after).toMatchObject({ file_path: receipt.file_path, role: "@Image2", name: "내 그림", thumb: "/local-thumb",
    asset_content_id: before.asset_content_id, server_location: { location_id: location } });
  expect(before.file_path).toBe(receipt.original_file_path);
  expect(promoteAssetReference(after, receipt)).toBe(after);
  expect(managedAssetUrl(after.file_path)).toBe(`/api/asset-sync/files/${location}`);
  expect(managedAssetUrl("asset-sync:../../private")).toBeUndefined();
});

it("다른 내용·프로젝트·소유자·서버·루트의 늦은 ACK를 적용하지 않는다", () => {
  const before = ref();
  for (const patch of [{ asset_content_id: `sha256:${"b".repeat(64)}` }, { project_id: "other" }, { bytes: 11 }, { state: "uploading" }])
    expect(promoteAssetReference(before, { ...receipt, ...patch })).toBe(before);
  const ready = promoteAssetReference(before, receipt);
  for (const patch of [{ owner_uid: "other" }, { storage_id: "other" }, { root_revision: "old-root" }, { server_origin: "http://other.test" }])
    expect(promoteAssetReference(ready, { ...receipt, ...patch })).toBe(ready);
  expect(promoteAssetReference({ ...before, target_project_id: undefined }, receipt).file_path).toBe(before.file_path);
});

it("다른 프로젝트 재사용은 원본 URL을 유지하면서 새 대상의 검증된 보관본으로 전환한다", () => {
  const source = promoteAssetReference(ref(), receipt);
  const reused = { ...source, ...assetIdentityForProject(source, "new-project") };
  expect(reused.file_path).toBe(receipt.file_path);
  expect(reused.server_location).toBeUndefined();
  const destination = { ...receipt, project_id: "new-project", root_revision: "new-root",
    location_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", file_path: "asset-sync:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
  expect(promoteAssetReference(reused, destination).file_path).toBe(destination.file_path);
});

it("같은 프로젝트 루트 변경은 기존 위치를 명시적으로 대체하는 ACK만 받는다", () => {
  const ready = promoteAssetReference(ref(), receipt);
  const moved = { ...receipt, root_revision: "root-2", location_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    file_path: "asset-sync:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", supersedes_location_id: receipt.location_id };
  const after = promoteAssetReference(ready, moved);
  expect(after.file_path).toBe(moved.file_path);
  expect(after.asset_content_id).toBe(ready.asset_content_id);
  const stale = { ...receipt, root_revision: "root-stale", location_id: "cccccccccccccccccccccccccccccccc",
    file_path: "asset-sync:cccccccccccccccccccccccccccccccc", supersedes_location_id: receipt.location_id };
  expect(promoteAssetReference(after, stale)).toBe(after);
  expect(promoteAssetReference(after, { ...moved, storage_id: "unrelated-storage" })).toBe(after);
});

it("닫힌 씬과 Undo·Redo까지 영속 전환하며 사용자의 프롬프트는 유지한다", async () => {
  const before = scene("closed");
  saveScenes(null, [before]);
  await settleSceneStoreForTest();
  const snap = { cards: before.cards, edges: before.edges, groups: [] };
  saveSceneHistory(before.id, { undo: [snap], redo: [snap], lastCommit: snap });
  expect(await syncSceneAssetReferences()).toBe(true);
  expect(listPersistedScenes(null)[0].cards[0].refs![0].file_path).toBe(receipt.file_path);
  expect(listScenes(null)[0].cards[1].prompt).toBe("그대로 둘 글");
  expect(loadSceneHistory(before.id)?.undo[0].cards[0].refs![0].file_path).toBe(receipt.file_path);
  expect(loadSceneHistory(before.id)?.redo[0].cards[0].refs![0].file_path).toBe(receipt.file_path);
  const moved = { ...receipt, root_revision: "root-2", location_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    file_path: "asset-sync:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", supersedes_location_id: receipt.location_id };
  calls.status.mockResolvedValue({ items: [moved] });
  expect(await syncSceneAssetReferences()).toBe(true);
  expect(listPersistedScenes(null)[0].cards[0].refs![0].file_path).toBe(moved.file_path);
  expect(loadSceneHistory(before.id)?.undo[0].cards[0].refs![0].file_path).toBe(moved.file_path);
  expect(loadSceneHistory(before.id)?.redo[0].cards[0].refs![0].file_path).toBe(moved.file_path);
});

it("A→B→A 계정 왕복 중 끝난 이전 요청을 버린다", async () => {
  saveScenes(null, [scene("stale")]);
  await settleSceneStoreForTest();
  let resolve!: (value: { items: AssetSyncReceipt[] }) => void;
  calls.status.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const pending = syncSceneAssetReferences();
  setAccountScope("B"); invalidateOperationContext();
  setAccountScope("A"); invalidateOperationContext();
  resolve({ items: [receipt] });
  expect(await pending).toBe(false);
  expect(listScenes(null)[0].cards[0].refs![0].file_path).toBe(receipt.original_file_path);
});

it("다른 PC에 전송 대기열이 없어도 이전 canonical 위치를 검증받아 현재 루트로 전환한다", async () => {
  const before = scene("other-pc");
  before.cards[0].refs = [promoteAssetReference(ref(), receipt)];
  before.cards[1].refs = [];
  saveScenes(null, [before]);
  await settleSceneStoreForTest();
  const moved = { ...receipt, root_revision: "root-3", location_id: "cccccccccccccccccccccccccccccccc",
    file_path: "asset-sync:cccccccccccccccccccccccccccccccc", supersedes_location_id: receipt.location_id };
  calls.status.mockResolvedValue({ items: [] });
  calls.resolve.mockResolvedValue({ items: [moved] });
  expect(await syncSceneAssetReferences()).toBe(true);
  expect(calls.resolve).toHaveBeenCalledWith([receipt.asset_content_id], "p", { [receipt.asset_content_id]: [receipt.location_id] });
  expect(listPersistedScenes(null)[0].cards[0].refs![0].file_path).toBe(moved.file_path);
});

it("현재는 삭제됐지만 Undo에만 남은 레퍼런스도 서버 보관본으로 전환한다", async () => {
  const before = scene("undo-only");
  const current = { ...before, cards: [] };
  saveScenes(null, [current]);
  await settleSceneStoreForTest();
  saveSceneHistory(before.id, { undo: [{ cards: before.cards, edges: before.edges, groups: [] }], redo: [],
    lastCommit: { cards: current.cards, edges: current.edges, groups: [] } });
  expect(await syncSceneAssetReferences()).toBe(true);
  expect(listPersistedScenes(null)[0].cards).toEqual([]);
  expect(loadSceneHistory(before.id)?.undo[0].cards[0].refs![0].file_path).toBe(receipt.file_path);
});

it("쓰기 실패 때 완료로 정산하지 않고 다음 상태 확인으로 확정을 재시도한다", async () => {
  saveScenes(null, [scene("retry")]);
  await settleSceneStoreForTest();
  failSceneStoreWritesForTest(true);
  const first = syncSceneAssetReferences();
  await new Promise(done => setTimeout(done, 20));
  failSceneStoreWritesForTest(false);
  await settleSceneStoreForTest();
  await first;
  expect(await syncSceneAssetReferences()).toBe(true);
  expect(listPersistedScenes(null)[0].cards[0].refs![0].file_path).toBe(receipt.file_path);
});

it("같은 내용의 로컬→서버 전환은 실행 입력을 유지하고 다른 내용 변경은 감지한다", () => {
  const before = scene("run");
  const comfy = { id: "comfy", kind: "comfy" as const, x: 200, y: 0, comfyCfg: { content: "workflow", paramValues: {} } };
  const edges = [...before.edges, { id: "comfy-edge", from: "ref", to: "comfy" }];
  const cards = [...before.cards, comfy];
  const snapshot = captureSceneGenerationInputSnapshot(["gen"], [], new Map(cards.map(card => [card.id, card])), edges);
  const oldComfy = prepareSceneComfyInputs("comfy", {}, cards, edges, {}, {});
  const promote = (asset_content_id: string) => cards.map(card => card.refs ? { ...card,
    refs: card.refs.map(item => ({ ...promoteAssetReference(item, receipt), asset_content_id })) } : card);
  const moved = promote(receipt.asset_content_id);
  expect(isSceneGenerationInputSnapshotCurrent(snapshot, new Map(moved.map(card => [card.id, card])), edges)).toBe(true);
  expect(prepareSceneComfyInputs("comfy", {}, moved, edges, {}, {}).inputFingerprint).toBe(oldComfy.inputFingerprint);
  const replaced = promote(`sha256:${"b".repeat(64)}`);
  expect(isSceneGenerationInputSnapshotCurrent(snapshot, new Map(replaced.map(card => [card.id, card])), edges)).toBe(false);
  expect(prepareSceneComfyInputs("comfy", {}, replaced, edges, {}, {}).inputFingerprint).not.toBe(oldComfy.inputFingerprint);
});
