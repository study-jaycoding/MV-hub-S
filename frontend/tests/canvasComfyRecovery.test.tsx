// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanvasDocumentPort } from "../src/features/canvas/session";
import { recoverCanvasComfyRuns, useCanvasComfyRuns, notifyCanvasComfyRuns } from "../src/lib/useCanvasComfyRuns";
import { getAccountNamespace, setAccountScope, setConnectionKey } from "../src/lib/accountScope";
import { comfyApi } from "../src/lib/comfyApi";
import { comfyCardRuntime, type ComfyCanvasResolution } from "../src/lib/comfyRunState";
import { comfySceneFingerprints } from "../src/lib/sceneComfyInputs";
import { saveScenes, listScenes, listPersistedScenes, updateScene, writeSceneSnapshot, type Scene, type SceneGroup } from "../src/lib/scenes";
import { delaySceneStoreWritesForTest, failSceneStoreWritesForTest, settleSceneStoreForTest } from "../src/lib/sceneStore";
import { setHubFeatures } from "../src/lib/hubFeatures";
import { useSceneComfyExecution } from "../src/lib/useSceneComfyExecution";
import { useCanvasSession } from "../src/features/canvas/useCanvasSession";
import { beginComfyAttempt, setComfyRunning as setStoredComfyRunning } from "../src/lib/sceneComfyRunningStore";

const windowState = vi.hoisted(() => ({ floating: false }));
vi.mock("../src/lib/popupWindows", async original => ({
  ...await original<typeof import("../src/lib/popupWindows")>(), isCanvasFloating: () => windowState.floating,
}));
const origin = { hub_id: "hub", device_id: "pc" };
let scene: Scene;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
let missingObservations: NonNullable<Parameters<typeof recoverCanvasComfyRuns>[0]["missingObservations"]>;
let clock: number;
const port = () => createCanvasDocumentPort({ flushPending: () => {} });
const resolution = (copy = 0, patch: Partial<ComfyCanvasResolution> = {}): ComfyCanvasResolution => ({
  attempt_id: `a${copy}`, state: "saved", result_revision: 3, origin,
  outputs: [{ output_key: "out", kind: "image", generation_id: `g${copy}`, state: "saved" }], ...patch,
});
const target = () => ({ accountNamespace: getAccountNamespace(), sceneId: scene.id });
const currentScene = () => listScenes(null).find(item => item.id === scene.id)!;
function fakeApi(responses = [resolution()]) {
  return {
    canvasOrigin: vi.fn(async () => origin),
    resolveCanvasRuns: vi.fn(async () => ({ runs: responses })),
    ackCanvasRun: vi.fn(async request => ({ ...resolution(), ...request, state: "linked" as const, outputs: [] })),
  };
}
const run = (api = fakeApi(), document = port(), canWrite = () => true) =>
  recoverCanvasComfyRuns({ canvasDocument: document, api, canWrite, missingObservations, now: () => clock });

beforeEach(async () => {
  missingObservations = new Map(); clock = 0;
  setAccountScope(""); setConnectionKey("local"); windowState.floating = false;
  setHubFeatures(["comfy_canvas_runs_v1"]);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("real API forbidden"); }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  scene = { id: "background", name: "background", created_at: 1, edges: [], cards: [
    { id: "c", kind: "comfy", x: 0, y: 0, comfyCfg: { content: "{}" } },
  ], comfyCardRuns: { c: { groupId: "group", groupSeq: 1 } } };
  scene.comfyRuns = [{ version: 1, attemptId: "a0", cardId: "c", copyIndex: 0, runGroupId: "group", groupSeq: 1,
    originHubId: "hub", originDeviceId: "pc", localState: "submitted", ...comfySceneFingerprints(scene, "c")! }];
  saveScenes(null, [scene]); await settleSceneStoreForTest();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined; host?.remove();
  vi.useRealTimers(); failSceneStoreWritesForTest(false); delaySceneStoreWritesForTest(0); await settleSceneStoreForTest();
  setHubFeatures([]); setAccountScope(""); setConnectionKey(""); windowState.floating = false;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("보드 없이 카드 반영+applied를 한 번에 확정한 뒤 ACK하고 일치 항목만 지운다", async () => {
  const api = fakeApi();
  api.ackCanvasRun.mockImplementation(async request => {
    const saved = listPersistedScenes(null)[0];
    expect(saved.cards[0].genId).toBe("g0");
    expect(saved.comfyRuns![0]).toMatchObject({ localState: "applied", receipt: { attemptId: "a0", resultRevision: 3, disposition: "attached" } });
    return { ...resolution(), ...request, state: "linked", outputs: [] };
  });
  await run(api);
  expect(currentScene().comfyRuns).toEqual([]);
  expect(currentScene().comfyCardRuns!.c.representative?.attemptId).toBe("a0");
  expect(api.ackCanvasRun).toHaveBeenCalledOnce();
});

it("ACK 응답 유실과 재시작 후 linked 중복 응답은 같은 영수증을 재전송하고 결과를 중복하지 않는다", async () => {
  const api = fakeApi([resolution(), resolution()]);
  api.ackCanvasRun.mockRejectedValue(new TypeError("lost ACK"));
  await run(api);
  expect(currentScene().comfyRuns![0].localState).toBe("applied");
  expect(currentScene().cards[0].genIds).toEqual(["g0"]);
  const saved = JSON.parse(JSON.stringify(currentScene())); saveScenes(null, [saved]); await settleSceneStoreForTest();
  const restarted = fakeApi([resolution(0, { state: "linked", disposition: "attached", outputs: [] })]);
  await run(restarted);
  expect(restarted.ackCanvasRun.mock.calls[0][0]).toEqual(api.ackCanvasRun.mock.calls[0][0]);
  expect(currentScene().comfyRuns).toEqual([]);
  expect(currentScene().cards[0].genIds).toEqual(["g0"]);
});

it.each(["write-failed", "receipt-missing"])("저장 확인 실패(%s)는 ACK를 금지한다", async failure => {
  const api = fakeApi(), document = port();
  if (failure === "write-failed") failSceneStoreWritesForTest(true);
  else {
    const snapshot = document.snapshot;
    document.snapshot = (at, persisted) => persisted ? { ...scene, comfyRuns: [] } : snapshot(at, persisted);
  }
  await run(api, document);
  expect(api.ackCanvasRun).not.toHaveBeenCalled();
});

it("ACK 대기 중 새 revision 영수증이 생기면 옛 ACK가 그 항목을 지우지 않는다", async () => {
  const api = fakeApi();
  api.ackCanvasRun.mockImplementation(async request => {
    updateScene(null, scene.id, { comfyRuns: currentScene().comfyRuns!.map(item => ({ ...item,
      receipt: { ...item.receipt!, resultRevision: 4 } })) });
    await settleSceneStoreForTest();
    return { ...resolution(), ...request, state: "linked", outputs: [] };
  });
  await run(api);
  expect(currentScene().comfyRuns![0].receipt?.resultRevision).toBe(4);
});

it("큰 copy ACK·삭제·재시작 뒤 작은 copy가 와도 대표를 되돌리지 않는다", async () => {
  updateScene(null, scene.id, { comfyRuns: [scene.comfyRuns![0], { ...scene.comfyRuns![0], attemptId: "a2", copyIndex: 2 }] });
  await settleSceneStoreForTest();
  await run(fakeApi([resolution(2)]));
  saveScenes(null, JSON.parse(JSON.stringify(listPersistedScenes(null)))); await settleSceneStoreForTest();
  await run();
  expect(currentScene().cards[0].genId).toBe("g2");
  expect(currentScene().comfyCardRuns!.c.representative?.copyIndex).toBe(2);
});

it.each(["handoff", "account", "connection"])("조회 중 %s 변경은 반영과 ACK를 멈춘다", async change => {
  const api = fakeApi(), document = port();
  const commit = vi.spyOn(document, "commit");
  api.resolveCanvasRuns.mockImplementation(async () => {
    if (change === "handoff") windowState.floating = true;
    if (change === "account") setAccountScope("other");
    if (change === "connection") setConnectionKey("other");
    return { runs: [resolution()] };
  });
  await run(api, document);
  expect(commit).not.toHaveBeenCalled(); expect(api.ackCanvasRun).not.toHaveBeenCalled();
});

it("반영 저장을 기다리는 사이 창을 넘기면 ACK와 추가 쓰기를 하지 않는다", async () => {
  const api = fakeApi(), documentPort = port();
  delaySceneStoreWritesForTest(30);
  const committed = vi.spyOn(documentPort, "commit");
  const pending = run(api, documentPort);
  await vi.waitFor(() => expect(committed).toHaveBeenCalledOnce(), { interval: 1 });
  windowState.floating = true;
  await pending;
  expect(api.ackCanvasRun).not.toHaveBeenCalled();
  expect(committed).toHaveBeenCalledOnce();
  expect(listPersistedScenes(null)[0].cards[0].genId).toBeUndefined();
});

it("다른 원본은 조회·삭제하지 않고 원래 PC 안내를 남긴다", async () => {
  updateScene(null, scene.id, { comfyRuns: [{ ...scene.comfyRuns![0], originDeviceId: "another-pc" }] });
  await settleSceneStoreForTest();
  const api = fakeApi(); await run(api);
  expect(api.resolveCanvasRuns).not.toHaveBeenCalled(); expect(api.ackCanvasRun).not.toHaveBeenCalled();
  expect(currentScene().comfyRuns).toHaveLength(1);
  expect(comfyCardRuntime(currentScene(), "c")).toMatchObject({ status: "failed", message: "원래 PC 에서 확인 필요" });
});

it.each(["needs_collect", "not_found", "failed", "dismissed"] as const)("%s 응답은 생성중을 영구히 남기지 않는다", async state => {
  const api = fakeApi([resolution(0, { state, outputs: [] })]);
  await run(api);
  expect(comfyCardRuntime(currentScene(), "c")?.status).not.toBe("running");
  expect(currentScene().comfyRuns?.length).toBe(state === "needs_collect" || state === "not_found" ? 1 : 0);
  if (state === "not_found") {
    clock = 30_000;
    await run(api);
    expect(comfyCardRuntime(currentScene(), "c")?.status).toBe("failed");
    expect(api.ackCanvasRun).not.toHaveBeenCalled();
  }
});

// 예약만 하고 전송을 시작하지 않은 기록 — 시간이 지나면 정리해도 되는 유일한 기록이다.
async function onlyReserved() {
  updateScene(null, scene.id, { comfyRuns: currentScene().comfyRuns!.map(item => ({ ...item, localState: "reserved" as const })) });
  await settleSceneStoreForTest();
}

it("전송한 기록은 not_found 가 오래 반복돼도 지우지 않고 안내를 남기며, 뒤늦게 접수되면 안내가 풀리고 결과가 붙는다", async () => {
  const missing = resolution(0, { state: "not_found", outputs: [] });
  const api = fakeApi([missing]);
  await run(api);
  clock = 30_000; await run(api);
  clock = 600_000; await run(api);
  expect(currentScene().comfyRuns).toHaveLength(1);
  expect(comfyCardRuntime(currentScene(), "c")).toMatchObject({ status: "failed", message: "실행 접수 여부를 확인하지 못했습니다. 다시 생성하기 전에 확인하세요." });
  api.resolveCanvasRuns.mockResolvedValue({ runs: [resolution(0, { state: "accepted", outputs: [] })] });
  await run(api);
  expect(comfyCardRuntime(currentScene(), "c")?.status).toBe("running");
  api.resolveCanvasRuns.mockResolvedValue({ runs: [resolution()] });
  await run(api);
  expect(currentScene().cards[0].genId).toBe("g0");
});

it("서버가 접수 여부를 모르는(unknown) 실행도 같은 안내로 멈추고 지우지 않는다", async () => {
  const api = fakeApi([resolution(0, { state: "unknown", outputs: [] })]);
  await run(api); clock = 60_000; await run(api);
  expect(currentScene().comfyRuns).toHaveLength(1);
  expect(comfyCardRuntime(currentScene(), "c")).toMatchObject({ status: "failed", message: "실행 접수 여부를 확인하지 못했습니다. 다시 생성하기 전에 확인하세요." });
});

describe("접수 여부를 모르는 기록의 사람 정리", () => {
  let execution: ReturnType<typeof useSceneComfyExecution>;
  async function screen(canvasDocument = port()) {
    function Screen() {
      execution = useSceneComfyExecution({ sceneIdRef: { current: scene.id }, cardsRef: { current: scene.cards }, edgesRef: { current: scene.edges },
        genDataRef: { current: {} }, refParents: {}, flushPending: () => {}, commitDocument: vi.fn(), isDocumentCurrent: () => true,
        canvasDocument, saveComfyToLibrary: vi.fn() });
      return null;
    }
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<Screen />));
  }
  function serverSays(states: ComfyCanvasResolution["state"][]) {
    vi.spyOn(comfyApi, "canvasOrigin").mockResolvedValue(origin);
    return vi.spyOn(comfyApi, "resolveCanvasRuns").mockResolvedValue({ runs: states.map((state, copy) => resolution(copy, { state, outputs: [] })) });
  }
  const submit = () => vi.spyOn(comfyApi, "run").mockResolvedValue({ outputs: [{ kind: "text", text: "ok" }], prompt_id: "p" });

  beforeEach(async () => { await run(fakeApi([resolution(0, { state: "not_found", outputs: [] })])); });

  it.each(["not_found", "unknown"] as const)("서버도 %s 이고 수락하면 기록을 지우고 실행한다", async state => {
    serverSays([state]); const confirm = vi.spyOn(window, "confirm").mockReturnValue(true); const send = submit();
    await screen();
    await act(async () => { await execution.runComfy("c"); });
    expect(confirm).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(currentScene().comfyRuns!.some(item => item.attemptId === "a0")).toBe(false);
  });

  it("취소하면 지우지 않고 실행하지 않는다", async () => {
    serverSays(["not_found"]); vi.spyOn(window, "confirm").mockReturnValue(false); const send = submit();
    await screen();
    await act(async () => { await execution.runComfy("c"); });
    expect(send).not.toHaveBeenCalled();
    expect(currentScene().comfyRuns).toHaveLength(1);
  });

  it("복사본 하나라도 서버에 살아 있으면 묻지도 지우지도 않는다", async () => {
    updateScene(null, scene.id, { comfyRuns: [...currentScene().comfyRuns!, { ...scene.comfyRuns![0], attemptId: "a1", copyIndex: 1 }] });
    await settleSceneStoreForTest();
    serverSays(["not_found", "running"]); const confirm = vi.spyOn(window, "confirm").mockReturnValue(true); const send = submit();
    await screen();
    await act(async () => { await execution.runComfy("c"); });
    expect(confirm).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(currentScene().comfyRuns).toHaveLength(2);
  });

  it("다시 묻기가 실패하거나 다른 창에서 돌고 있으면 지우지 않는다", async () => {
    const resolve = serverSays(["not_found"]); const confirm = vi.spyOn(window, "confirm").mockReturnValue(true); const send = submit();
    resolve.mockRejectedValueOnce(new Error("끊김"));
    await screen();
    await act(async () => { await execution.runComfy("c"); });
    setStoredComfyRunning(["c"], true);
    try { await act(async () => { await execution.runComfy("c"); }); } finally { setStoredComfyRunning(["c"], false); }
    expect(confirm).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(currentScene().comfyRuns).toHaveLength(1);
  });

  it("서버에 묻는 사이 실행이 시작되면 묻지도 지우지도 않는다", async () => {
    const resolve = serverSays(["not_found"]); const confirm = vi.spyOn(window, "confirm").mockReturnValue(true); const send = submit();
    resolve.mockImplementationOnce(async () => {
      setStoredComfyRunning(["c"], true); // 조회가 끝나기 전에 다른 창이 그 카드를 돌린다
      return { runs: [resolution(0, { state: "not_found", outputs: [] })] };
    });
    await screen();
    try { await act(async () => { await execution.runComfy("c"); }); } finally { setStoredComfyRunning(["c"], false); }
    expect(confirm).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(currentScene().comfyRuns).toHaveLength(1);
  });

  it("확인 창에 답하는 사이 실행이 시작되면 지우지 않는다", async () => {
    serverSays(["not_found"]); const send = submit();
    const confirm = vi.spyOn(window, "confirm").mockImplementation(() => { setStoredComfyRunning(["c"], true); return true; });
    await screen();
    try { await act(async () => { await execution.runComfy("c"); }); } finally { setStoredComfyRunning(["c"], false); }
    expect(confirm).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
    expect(currentScene().comfyRuns).toHaveLength(1);
  });

  it("같은 카드에 다른 PC 의 시도가 섞여 있으면 묻지도 지우지도 않는다", async () => {
    updateScene(null, scene.id, { comfyRuns: [...currentScene().comfyRuns!, { ...scene.comfyRuns![0], attemptId: "a1", copyIndex: 1, originDeviceId: "another-pc" }] });
    await settleSceneStoreForTest();
    const resolve = serverSays(["not_found", "not_found"]); const confirm = vi.spyOn(window, "confirm").mockReturnValue(true); const send = submit();
    await screen();
    await act(async () => { await execution.runComfy("c"); });
    expect(resolve).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(currentScene().comfyRuns).toHaveLength(2);
  });

  it("서버에 묻는 사이 같은 카드에 다른 PC 의 시도가 들어오면 묻지도 지우지도 않는다", async () => {
    const resolve = serverSays(["not_found"]); const confirm = vi.spyOn(window, "confirm").mockReturnValue(true); const send = submit();
    resolve.mockImplementationOnce(async () => {
      updateScene(null, scene.id, { comfyRuns: [...currentScene().comfyRuns!, { ...scene.comfyRuns![0], attemptId: "a1", copyIndex: 1, originDeviceId: "another-pc" }] });
      return { runs: [resolution(0, { state: "not_found", outputs: [] })] };
    });
    await screen();
    await act(async () => { await execution.runComfy("c"); });
    expect(confirm).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(currentScene().comfyRuns).toHaveLength(2);
  });

  it("옛 편집 채택으로 다른 묶음이 섞여도 끝까지 지우고 실행한다 — 현재 묶음이 먼저 있어도", async () => {
    updateScene(null, scene.id, { comfyRuns: [...currentScene().comfyRuns!, { ...scene.comfyRuns![0], attemptId: "a1", runGroupId: "older" }] });
    await settleSceneStoreForTest();
    serverSays(["not_found", "not_found"]); const confirm = vi.spyOn(window, "confirm").mockReturnValue(true); const send = submit();
    await screen();
    await act(async () => { await execution.runComfy("c"); });
    expect(confirm).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(currentScene().comfyRuns!.some(item => ["a0", "a1"].includes(item.attemptId))).toBe(false);
  });

  it("기록을 지우는 사이 남은 복사본의 접수가 확인되면 그 기록은 지우지 않는다", async () => {
    updateScene(null, scene.id, { comfyRuns: [...currentScene().comfyRuns!, { ...scene.comfyRuns![0], attemptId: "a1", copyIndex: 1 }] });
    await settleSceneStoreForTest();
    serverSays(["not_found", "not_found"]); vi.spyOn(window, "confirm").mockReturnValue(true); const send = submit();
    const document = port();
    await screen({ ...document, commit: (where, command) => {
      const write = document.commit(where, command);
      updateScene(null, scene.id, { comfyCardRuns: { c: { groupId: "group", groupSeq: 1 } } }); // 복구 응답이 접수를 반영해 안내가 풀렸다
      return write;
    } });
    await act(async () => { await execution.runComfy("c"); });
    expect(send).not.toHaveBeenCalled();
    expect(currentScene().comfyRuns!.map(item => item.attemptId)).toEqual(["a1"]);
  });
});

it("미접수는 중복 응답이나 짧은 간격으로 정리하지 않고 30초 뒤 재확인한다", async () => {
  await onlyReserved();
  const missing = resolution(0, { state: "not_found", outputs: [] });
  const api = fakeApi([missing, missing]);
  await run(api);
  clock = 29_999; await run(api);
  expect(currentScene().comfyRuns).toHaveLength(1);
  clock = 30_000; await run(api);
  expect(listPersistedScenes(null)[0].comfyRuns).toEqual([]);
  const reserved = await port().reserveComfyAttempt({ ...target(), originHubId: "hub", originDeviceId: "pc" }, {
    ...comfySceneFingerprints(currentScene(), "c")!, cardId: "c", attemptId: "next", runGroupId: "next", copyIndex: 0,
  });
  expect(reserved.status).toBe("reserved");
});

it("전송·응답 대기 중 attempt는 보호하고 전송이 끝난 뒤부터 유예 시간을 다시 잰다", async () => {
  await onlyReserved();
  const api = fakeApi([resolution(0, { state: "not_found", outputs: [] })]);
  await run(api);
  const finish = beginComfyAttempt(getAccountNamespace(), "a0");
  try {
    clock = 60_000; await run(api);
    expect(api.resolveCanvasRuns).toHaveBeenCalledOnce();
    expect(currentScene().comfyRuns).toHaveLength(1);
  } finally { finish(); }
  await run(api);
  expect(currentScene().comfyRuns).toHaveLength(1);
  clock = 90_000; await run(api);
  expect(currentScene().comfyRuns).toEqual([]);
});

it("닫힌 창의 요청이 유예 중 늦게 접수되면 항목을 남기고 결과를 연결한다", async () => {
  const api = fakeApi([resolution(0, { state: "not_found", outputs: [] })]);
  await run(api);
  clock = 29_999;
  api.resolveCanvasRuns.mockResolvedValue({ runs: [resolution(0, { state: "running", outputs: [] })] });
  await run(api);
  expect(comfyCardRuntime(currentScene(), "c")?.status).toBe("running");
  clock = 31_000;
  api.resolveCanvasRuns.mockResolvedValue({ runs: [resolution()] });
  await run(api);
  expect(currentScene().cards[0].genId).toBe("g0");
});

it("조회 중 실행기가 활성화되면 이미 받은 not_found로도 정리하지 않는다", async () => {
  await onlyReserved();
  const api = fakeApi([resolution(0, { state: "not_found", outputs: [] })]);
  await run(api); clock = 30_000;
  let finish = () => {};
  api.resolveCanvasRuns.mockImplementation(async () => {
    finish = beginComfyAttempt(getAccountNamespace(), "a0");
    return { runs: [resolution(0, { state: "not_found", outputs: [] })] };
  });
  try { await run(api); expect(currentScene().comfyRuns).toHaveLength(1); }
  finally { finish(); }
});

it("적용 영수증이 있는 항목은 not_found를 반복해도 지우지 않는다", async () => {
  const api = fakeApi(); api.ackCanvasRun.mockRejectedValue(new Error("lost"));
  await run(api);
  api.resolveCanvasRuns.mockResolvedValue({ runs: [resolution(0, { state: "not_found", outputs: [] })] });
  await run(api); clock = 60_000; await run(api);
  expect(currentScene().comfyRuns![0].localState).toBe("applied");
});

it("미회수 뒤 서버 회수 완료를 다시 조회하면 같은 카드로 정산된다", async () => {
  await run(fakeApi([resolution(0, { state: "needs_collect", outputs: [] })]));
  await run();
  expect(currentScene().cards[0].genId).toBe("g0");
  expect(comfyCardRuntime(currentScene(), "c")?.status).toBe("done");
});

it("2.5초 복구 주기: 숨은 창과 떠 있는 동안 메인 창은 쉬고 다시 깨어난다", async () => {
  vi.useFakeTimers();
  const api = fakeApi([resolution(0, { state: "running", outputs: [] })]);
  vi.spyOn(comfyApi, "canvasOrigin").mockImplementation(api.canvasOrigin);
  vi.spyOn(comfyApi, "resolveCanvasRuns").mockImplementation(api.resolveCanvasRuns);
  const documentPort = port();
  function Screen() { useCanvasComfyRuns({ authReady: true, canvasDocument: documentPort }); return null; }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  windowState.floating = true;
  await act(async () => { root!.render(<Screen />); await vi.advanceTimersByTimeAsync(5000); });
  expect(api.canvasOrigin).not.toHaveBeenCalled();
  windowState.floating = false;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  expect(api.canvasOrigin).not.toHaveBeenCalled();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => { notifyCanvasComfyRuns(); await vi.advanceTimersByTimeAsync(0); });
  expect(api.resolveCanvasRuns).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(2499); });
  expect(api.resolveCanvasRuns).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(api.resolveCanvasRuns).toHaveBeenCalledTimes(2);
});

it.each([["direct", false], ["plan", false], ["direct", true], ["plan", true]] as const)("%s 진입점: 다른 원본=%s인 항목만 새 요청을 막지 않는다", async (entry, foreign) => {
  if (foreign) scene.comfyRuns![0].originDeviceId = "another-pc";
  scene.cards.push({ id: "out", kind: "generation", x: 200, y: 0 }); scene.edges = [{ from: "c", to: "out" }];
  saveScenes(null, [scene]); await settleSceneStoreForTest();
  vi.spyOn(comfyApi, "canvasOrigin").mockResolvedValue(origin);
  const submit = vi.spyOn(comfyApi, "run").mockResolvedValue({ outputs: [{ kind: "text", text: "ok" }], prompt_id: "p" });
  let execution!: ReturnType<typeof useSceneComfyExecution>;
  const documentPort = port();
  function Screen() {
    execution = useSceneComfyExecution({ sceneIdRef: { current: scene.id }, cardsRef: { current: scene.cards }, edgesRef: { current: scene.edges },
      genDataRef: { current: {} }, refParents: {}, flushPending: () => {}, commitDocument: vi.fn(), isDocumentCurrent: () => true,
      canvasDocument: documentPort, saveComfyToLibrary: vi.fn() });
    return null;
  }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Screen />));
  await act(async () => { if (entry === "direct") await execution.runComfy("c"); else await execution.orchestrateGenerate("out"); });
  expect(submit).toHaveBeenCalledTimes(foreign ? 1 : 0);
  expect(currentScene().comfyRuns).toContainEqual(scene.comfyRuns![0]);
});

it.each([false, true])("체인 중간 종료=%s: 접수된 단계는 서버 정산, 미제출 단계는 시작하지 않는다", async close => {
  scene = { ...scene, comfyRuns: [], comfyCardRuns: {}, cards: [...scene.cards,
    { id: "second", kind: "comfy", x: 100, y: 0, comfyCfg: { content: "{}" } },
    { id: "out", kind: "generation", x: 200, y: 0 }], edges: [{ from: "c", to: "second" }, { from: "second", to: "out" }] };
  saveScenes(null, [scene]); await settleSceneStoreForTest();
  let alive = true, execution!: ReturnType<typeof useSceneComfyExecution>;
  let complete!: (result: Awaited<ReturnType<typeof comfyApi.run>>) => void;
  const submit = vi.spyOn(comfyApi, "run").mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
    .mockResolvedValue({ outputs: [{ kind: "text", text: "second" }], prompt_id: "p2" });
  vi.spyOn(comfyApi, "canvasOrigin").mockResolvedValue(origin);
  const save = vi.fn(), render = vi.fn(), commit = vi.fn(); const documentPort = port();
  function Screen() {
    execution = useSceneComfyExecution({ sceneIdRef: { current: scene.id }, cardsRef: { current: scene.cards }, edgesRef: { current: scene.edges },
      genDataRef: { current: {} }, refParents: {}, flushPending: () => {}, commitDocument: commit, isDocumentCurrent: () => alive,
      canvasDocument: documentPort, saveComfyToLibrary: save, onRenderCardRuns: render });
    return null;
  }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Screen />));
  let pending!: Promise<void>;
  await act(async () => { pending = execution.orchestrateGenerate("out"); await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce()); });
  if (close) alive = false;
  await act(async () => { complete({ outputs: [{ kind: "text", text: "first" }], prompt_id: "p1" }); await pending; });
  expect(submit).toHaveBeenCalledTimes(close ? 1 : 2);
  expect(render).toHaveBeenCalledTimes(close ? 0 : 1);
  expect(save).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  const attempts = currentScene().comfyRuns!;
  expect(attempts.map(item => item.cardId)).toEqual(close ? ["c"] : ["c", "second"]);
  const api = fakeApi(attempts.map(item => resolution(0, { attempt_id: item.attemptId })));
  await run(api);
  expect(currentScene().cards[0].genId).toBe("g0");
  expect(currentScene().comfyRuns).toEqual([]);
});

it.each(["image", "text"] as const)("열린 보드로 복구된 %s 결과는 기존 편집을 Undo해도 보존한다", async kind => {
  scene.cards.push({ id: "other", kind: "generation", x: 100, y: 0, prompt: "before" });
  saveScenes(null, [scene]); await settleSceneStoreForTest();
  let session!: ReturnType<typeof useCanvasSession>;
  let received!: (scene: Scene) => void;
  let readCards!: () => Scene["cards"];
  function Screen() {
    const [source, setSource] = useState(scene); received = setSource;
    const [cards, setCards] = useState(scene.cards), [edges, setEdges] = useState(scene.edges), [groups, setGroups] = useState<SceneGroup[]>([]);
    const cardsRef = useRef(cards); cardsRef.current = cards;
    const edgesRef = useRef(edges); edgesRef.current = edges;
    const groupsRef = useRef(groups); groupsRef.current = groups;
    session = useCanvasSession({ sceneId: scene.id, sourceScene: source, initialSnapshot: { cards: scene.cards, edges: scene.edges, groups: [] },
      cardsRef, edgesRef, groupsRef, setCards, setEdges, setGroups, sceneIdRef: useRef(scene.id), frozenRef: useRef(false),
      layerMoveRef: useRef(null), clearSelection: () => {}, onChange: snapshot => writeSceneSnapshot(target(), snapshot) });
    readCards = () => cardsRef.current;
    return null;
  }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Screen />));
  await act(async () => { session.commit({ type: "editCardPrompt", cardId: "other", prompt: "after" }); session.flush(); await settleSceneStoreForTest(); });
  const documentPort = createCanvasDocumentPort({ flushPending: () => { session.flush(); }, changed: () => received(currentScene()) });
  const api = fakeApi([resolution(0, kind === "text" ? { outputs: [{ output_key: "text", kind: "text", text: "preserved", state: "text" }] } : {})]);
  await act(async () => { await run(api, documentPort); });
  if (kind === "image") expect(readCards()[0].genId).toBe("g0");
  await act(async () => { session.undo(); await settleSceneStoreForTest(); });
  expect(readCards()[1].prompt).toBe("before");
  if (kind === "image") expect(readCards()[0].genIds).toContain("g0");
  else expect(readCards()[0].comfyCfg?.outputs).toEqual([{ kind: "text", text: "preserved" }]);
});

it("배치 일부만 실패해도 성공 copy는 정산하고 미회수 copy만 남긴다", async () => {
  scene = { ...scene, comfyRuns: [], comfyCardRuns: {}, cards: [{ ...scene.cards[0], batchCount: 2 }] };
  saveScenes(null, [scene]); await settleSceneStoreForTest();
  const submit = vi.spyOn(comfyApi, "run").mockRejectedValueOnce(new Error("partial failure"))
    .mockResolvedValue({ outputs: [{ kind: "text", text: "done" }], prompt_id: "p" });
  vi.spyOn(comfyApi, "canvasOrigin").mockResolvedValue(origin);
  const save = vi.fn(), documentPort = port(); let execution!: ReturnType<typeof useSceneComfyExecution>;
  function Screen() {
    execution = useSceneComfyExecution({ sceneIdRef: { current: scene.id }, cardsRef: { current: scene.cards }, edgesRef: { current: [] },
      genDataRef: { current: {} }, refParents: {}, flushPending: () => {}, commitDocument: vi.fn(), isDocumentCurrent: () => true,
      canvasDocument: documentPort, saveComfyToLibrary: save });
    return null;
  }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Screen />));
  await act(async () => { expect(await execution.runComfy("c")).toBe(false); });
  const attempts = currentScene().comfyRuns!;
  expect(attempts).toHaveLength(2);
  const api = fakeApi(attempts.map(item => resolution(item.copyIndex, { attempt_id: item.attemptId,
    ...(item.copyIndex === 0 ? { state: "needs_collect", outputs: [] } : {}) })));
  await run(api);
  expect(submit).toHaveBeenCalledTimes(2); expect(save).not.toHaveBeenCalled();
  expect(currentScene().comfyRuns).toHaveLength(1);
  expect(currentScene().cards[0].genId).toBe("g1");
  expect(comfyCardRuntime(currentScene(), "c")?.settledState).toBe("needs_collect");
});
