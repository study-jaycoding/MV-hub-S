// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCanvasSession } from "../src/features/canvas/useCanvasSession";
import type { SceneCard, SceneEdge, SceneGroup } from "../src/lib/scenes";
import { clearSceneHistory } from "../src/lib/sceneUndoStore";
import { markCardGenerationsRemoved } from "../src/lib/sceneCardLinks";
import { saveSceneComfyToLibrary } from "../src/lib/sceneComfyLibrary";
import { comfyApi } from "../src/lib/comfyApi";
import { setAccountScope } from "../src/lib/accountScope";
import { useSceneComfyExecution } from "../src/lib/useSceneComfyExecution";
import { useSceneCardRecovery } from "../src/lib/useSceneCardRecovery";
import type { Generation } from "../src/types";

const linkState = vi.hoisted(() => ({ rows: [] as { scene_id: string; card_id: string; generation_id: string; removed_at: string | null }[] }));
const apiRun = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/comfyApi", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/lib/comfyApi")>();
  return { ...actual, comfyApi: { ...actual.comfyApi, run: apiRun } };
});
vi.mock("../src/lib/sceneCardLinks", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/sceneCardLinks")>(),
  markCardGenerationsRemoved: vi.fn((scene_id: string, card_id: string, ids: string[]) => {
    for (const generation_id of ids) {
      linkState.rows = linkState.rows.filter(row => row.card_id !== card_id || row.generation_id !== generation_id);
      linkState.rows.push({ scene_id, card_id, generation_id, removed_at: "removed" });
    }
  }),
  reviveCardGenerations: vi.fn((scene_id: string, card_id: string, ids: string[]) => {
    for (const generation_id of ids) {
      linkState.rows = linkState.rows.filter(row => row.card_id !== card_id || row.generation_id !== generation_id);
      linkState.rows.push({ scene_id, card_id, generation_id, removed_at: null });
    }
  }),
  serverCardLinks: () => linkState.rows,
}));
let root: Root, host: HTMLDivElement;
let session: ReturnType<typeof useCanvasSession>;
let readCards: () => SceneCard[];
let liveCardsRef: { current: SceneCard[] };
let execution: ReturnType<typeof useSceneComfyExecution>;
let recovery: ReturnType<typeof useSceneCardRecovery>;
const renderRuns = vi.fn(async () => {});
const claim = vi.fn(async () => {});
const setGenData = vi.fn();
const changed = vi.fn();
const initial: SceneCard[] = [{ id: "other", kind: "generation", x: 0, y: 0, prompt: "before" },
  { id: "comfy", kind: "comfy", x: 0, y: 1, genId: "old", genIds: ["old"], comfyCfg: { content: "workflow", paramValues: { seed: 1 }, outputs: [] } }];
const initialEdges: SceneEdge[] = [{ from: "comfy", to: "other" }];
function Harness({ sceneId, chain = false }: { sceneId: string; chain?: boolean }) {
  const fixture = useRef({ cards: chain ? [...initial, { id: "second", kind: "comfy", x: 100, y: 0, comfyCfg: { content: "second" } } as SceneCard] : initial,
    edges: chain ? [{ from: "comfy", to: "second" }, { from: "second", to: "other" }] : initialEdges });
  const [cards, setCards] = useState(fixture.current.cards);
  const [edges, setEdges] = useState<SceneEdge[]>(fixture.current.edges);
  const [groups, setGroups] = useState<SceneGroup[]>([]);
  const sceneIdRef = useRef(sceneId); sceneIdRef.current = sceneId;
  const cardsRef = useRef(cards); cardsRef.current = cards;
  const edgesRef = useRef(edges); edgesRef.current = edges;
  const groupsRef = useRef(groups); groupsRef.current = groups;
  session = useCanvasSession({ sceneId, initialSnapshot: { ...fixture.current, groups: [] },
    sceneIdRef, cardsRef, edgesRef, groupsRef, setCards, setEdges, setGroups,
    frozenRef: useRef(false), layerMoveRef: useRef(null), clearSelection: vi.fn(), onChange: changed });
  readCards = () => cardsRef.current;
  liveCardsRef = cardsRef;
  const commitDocument = session.commit;
  const currentSession = session;
  execution = useSceneComfyExecution({ sceneIdRef, cardsRef, edgesRef, genDataRef: useRef({}), refParents: {},
    flushPending: () => { currentSession.flush(); }, commitDocument, isDocumentCurrent: () => currentSession.snapshot() !== undefined,
    saveComfyToLibrary: async () => ({ saved: 0, failed: 0 }),
    onRenderCardRuns: renderRuns });
  const flush = session.flush;
  recovery = useSceneCardRecovery({ sceneId, cardsRef, genDataRef: useRef({}), setGenData,
    isDocumentCurrent: () => currentSession.snapshot() !== undefined,
    commitDocument, flushPendingRef: useRef(() => { flush(); }), onCanvasRecoveryClaim: claim,
    onCanvasRecoveryCandidates: async () => [], onCanvasCardHistory: async () => ({ links: [], next: null }),
    readLocalScenes: () => [], onLoadGenerations: async () => ({}) });
  return null;
}
const show = (sceneId = "comfy-session-a", chain = false) => act(() => root.render(<Harness sceneId={sceneId} chain={chain} />));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); localStorage.clear();
  clearSceneHistory("comfy-session-a"); clearSceneHistory("comfy-session-b"); vi.clearAllMocks();
  linkState.rows = [];
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

it.each([false, true])("Comfy 뒤 후속 생성은 시작 세션 commit 수락 때만 진행한다(전환=%s)", async change => {
  show();
  let release!: (result: Awaited<ReturnType<typeof comfyApi.run>>) => void;
  const run = apiRun.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = execution.orchestrateGenerate("other"); });
  expect(run).toHaveBeenCalledTimes(1);
  if (change) { show("comfy-session-b"); show(); }
  await act(async () => { release({ outputs: [{ kind: "image", url: "/run.png" }], prompt_id: "run" }); await pending; });
  expect(renderRuns).toHaveBeenCalledTimes(change ? 0 : 1);
});

it.each(["current", "reopen", "account", "unmount"])("중간 Comfy 응답 뒤 다음 외부 실행 전에 시작 문서 세대를 확인한다(%s)", async change => {
  show("comfy-session-a", true);
  let release!: (result: Awaited<ReturnType<typeof comfyApi.run>>) => void;
  apiRun.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValue({ outputs: [], prompt_id: "second" });
  let pending!: Promise<void>;
  await act(async () => { pending = execution.orchestrateGenerate("other"); });
  expect(apiRun).toHaveBeenCalledTimes(1);
  if (change === "reopen") { show("comfy-session-b", true); show("comfy-session-a", true); }
  else if (change === "account") { setAccountScope("another-account"); show("comfy-session-a", true); }
  else if (change === "unmount") act(() => root.unmount());
  await act(async () => { release({ outputs: [], prompt_id: "first" }); await pending; });
  expect(apiRun).toHaveBeenCalledTimes(change === "current" ? 2 : 1);
  expect(renderRuns).toHaveBeenCalledTimes(change === "current" ? 1 : 0);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("runtime 명령에 섞인 workflow와 paramValues는 문서 편집으로 통과하지 않는다", () => {
  show();
  const patch = { status: "done" as const, content: "injected", paramValues: { seed: 999 } };
  act(() => { session.commit({ type: "updateComfyRuntime", cardId: "comfy", patch }); });
  expect(readCards()[1].comfyCfg).toMatchObject({ content: "workflow", paramValues: { seed: 1 }, status: "done" });
});

it("파라미터 입력과 다른 카드 편집 뒤 저장 응답은 현재 카드에 병합하고 Undo가 결과를 보존한다", () => {
  show();
  act(() => { session.commit({ type: "editComfyParam", cardId: "comfy", key: "seed", value: 2 }); });
  act(() => { session.commit({ type: "editCardPrompt", cardId: "other", prompt: "latest" }); });
  act(() => { session.commit({ type: "saveComfyOutputs", cardId: "comfy", expectedContent: "workflow",
    savedResults: [{ url: "/new.png", generation_id: "new" }], executedOutputs: [{ kind: "image", url: "/new.png" }] }); });
  expect(readCards()[0].prompt).toBe("latest");
  expect(readCards()[1]).toMatchObject({ genId: "new", genIds: ["old", "new"], comfyCfg: { paramValues: { seed: 2 } } });
  act(() => { session.undo(); });
  expect(readCards()[0].prompt).toBe("before");
  expect(readCards()[1].genIds).toEqual(["old", "new"]);
  act(() => { session.redo(); }); expect(readCards()[0].prompt).toBe("latest");
});

it("workflow 교체는 제거 전이와 사용자 Undo를 소유하며 다시 파싱한 옛 메타를 거절한다", () => {
  show();
  act(() => { session.commit({ type: "replaceComfyWorkflow", cardId: "comfy", workflow: { name: "new", content: "next", nodeCount: 2 } }); });
  expect(readCards()[1]).toMatchObject({ genId: null, genIds: [], comfyCfg: { content: "next", paramValues: {}, outputs: [], status: "idle" } });
  expect(markCardGenerationsRemoved).toHaveBeenCalledWith("comfy-session-a", "comfy", ["old"]);
  act(() => { expect(session.commit({ type: "refreshComfyMetadata", cardId: "comfy", expectedContent: "workflow", nodeCount: 99 })).toBe(false); });
  expect(readCards()[1].comfyCfg!.nodeCount).toBe(2);
  act(() => { session.undo(); });
  expect(readCards()[1]).toMatchObject({ genId: "old", genIds: ["old"], comfyCfg: { content: "workflow", paramValues: { seed: 1 } } });
  act(() => { session.redo(); }); expect(readCards()[1].genIds).toEqual([]);
});

it("동일 workflow 설정 저장은 현재 실행 결과를 보존하고 modal의 오래된 상태를 받지 않는다", () => {
  show();
  act(() => { session.commit({ type: "updateComfyRuntime", cardId: "comfy", patch: { status: "running", runId: 2 } }); });
  const cfg = { content: "workflow", name: "renamed", paramValues: { seed: 3 }, status: "idle" as const, outputs: [] };
  act(() => { session.commit({ type: "saveComfyConfig", cardId: "comfy", cfg }); });
  expect(readCards()[1]).toMatchObject({ genIds: ["old"], comfyCfg: { name: "renamed", runId: 2, status: "running", paramValues: { seed: 3 } } });
  expect(markCardGenerationsRemoved).not.toHaveBeenCalled();
});

it("배치 실행은 live 표시이고 옛 실행의 완료는 거절하며 저장 마킹을 유지한다", () => {
  show();
  act(() => { session.commit({ type: "showComfyRunning", runs: [{ cardId: "comfy", runId: 3 }] }); });
  expect(changed).not.toHaveBeenCalled();
  act(() => { expect(session.commit({ type: "updateComfyRuntime", cardId: "comfy", expectedRunId: 2, patch: { status: "failed" } })).toBe(false); });
  act(() => { session.commit({ type: "saveComfyOutputs", cardId: "comfy", expectedContent: "workflow",
    savedResults: [{ url: "/new.png", generation_id: "new" }], executedOutputs: [{ kind: "image", url: "/new.png" }] }); });
  act(() => { session.commit({ type: "updateComfyRuntime", cardId: "comfy", expectedRunId: 3,
    patch: { status: "done", outputs: [{ kind: "image", url: "/new.png" }] } }); });
  expect(readCards()[1].comfyCfg!.outputs![0].saved_generation_id).toBe("new");
});

it("복구는 최신 목록을 시각순으로 병합하고 새 연결의 Undo와 대표를 보존한다", () => {
  show();
  act(() => { session.commit({ type: "recoverCardGeneration", cardId: "comfy", generationId: "new",
    createdAtById: { old: "2026-02", new: "2026-01" } }); });
  expect(readCards()[1]).toMatchObject({ genId: "new", genIds: ["new", "old"] });
  act(() => { session.undo(); }); expect(readCards()[1].genIds).toEqual(["old"]);
  act(() => { session.redo(); }); expect(readCards()[1].genIds).toEqual(["new", "old"]);
});

it.each(["reopen", "account", "unmount"])("저장 응답은 시작 commit을 고정해 %s 뒤 새 세션에 반영하지 않는다", async change => {
  show();
  const oldCommit = session.commit;
  let release!: (result: Awaited<ReturnType<typeof comfyApi.saveToLibrary>>) => void;
  vi.spyOn(comfyApi, "saveToLibrary").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const options = { sceneIdRef: { current: "comfy-session-a" }, cardsRef: liveCardsRef,
    edgesRef: { current: [] }, genDataRef: { current: {} }, refParents: {}, commitDocument: oldCommit, isOperationCurrent: () => true };
  const pending = saveSceneComfyToLibrary("comfy", { silent: true, outputs: [{ kind: "image", url: "/late.png" }] }, options);
  if (change === "reopen") { show("comfy-session-b"); show(); }
  else if (change === "account") { setAccountScope("another-account"); show(); }
  else act(() => root.unmount());
  // 최신 옵션을 바꾸어도 진행 중 함수는 시작 때 받은 commit을 유지해야 한다.
  options.commitDocument = vi.fn(() => true);
  await act(async () => { release({ saved: [{ url: "/late.png", generation_id: "late", existed: false }] }); await pending; });
  expect(readCards()[1].genIds).toEqual(["old"]);
  expect(options.commitDocument).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it.each(["current", "reopen", "account", "unmount"])("복구 helper 응답은 시작 세션에서만 반영한다(%s)", async change => {
  show();
  await act(async () => { recovery.openCanvasRecovery("comfy"); });
  let release!: () => void;
  claim.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = recovery.claimCanvasRecovery({ id: "recovered", created_at: "2026-10-18" } as Generation); });
  expect(claim).toHaveBeenCalledTimes(1);
  if (change === "reopen") { show("comfy-session-b"); show(); }
  else if (change === "account") { setAccountScope("another-account"); show(); }
  else if (change === "unmount") act(() => root.unmount());
  await act(async () => { release(); await pending; });
  expect(readCards()[1].genIds).toEqual(change === "current" ? ["old", "recovered"] : ["old"]);
  expect(setGenData).toHaveBeenCalledTimes(change === "current" ? 1 : 0);
});
