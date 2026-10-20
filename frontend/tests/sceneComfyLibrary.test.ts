// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveSceneComfyToLibrary, type SaveComfyOptions } from "../src/lib/sceneComfyLibrary";
import { comfyApi } from "../src/lib/comfyApi";
import * as edges from "../src/lib/sceneEdges";
import type { SceneCard } from "../src/lib/scenes";
import { applyCanvasComfyCommand, type CanvasComfyCommand } from "../src/features/canvas/comfyCommands";
import { captureOperationContext, configureOperationContext, isOperationContextCurrent } from "../src/app/operationContext";
import { getAccountNamespace, setAccountScope } from "../src/lib/accountScope";
import { setApiPause, setAuthToken } from "../src/lib/http";
import { saveCompletedComfyResults } from "../src/lib/useSceneComfyExecution";

const config = { name: "executed workflow", content: "{}", params: [{ key: "1|text", label: "Prompt", type: "text" }], paramValues: { "1|text": "executed prompt" } };
const options = (): SaveComfyOptions => ({ silent: true, elapsedSeconds: 4, configSnapshot: config,
  outputs: [{ kind: "image", url: "/executed.png" }],
  inputSnapshot: { media: [{ url: "/input.png", type: "image", name: "executed input", source_gen_id: "source" }],
    textParamKeys: ["1|text"], drivenParamValues: config.paramValues, executedParamValues: config.paramValues, inputFingerprint: "executed" },
});
function context() {
  const operation = captureOperationContext({ scope: "personal", id: null, name: null });
  const cardsRef = { current: [{ id: "c", kind: "comfy", x: 0, y: 0, comfyCfg: { ...config, outputs: [{ kind: "image", url: "/executed.png" }] } }] as SceneCard[] };
  return { sceneIdRef: { current: "scene-before" }, cardsRef, edgesRef: { current: [] }, genDataRef: { current: {} }, refParents: {},
    isOperationCurrent: () => isOperationContextCurrent(operation),
    commitDocument: vi.fn((command: CanvasComfyCommand) => applyCanvasComfyCommand(command, {
      sceneId: "scene-before", cardsRef, input: { applyCards: (cards) => { cardsRef.current = cards; } },
      history: { propagateGenIdsToHistory: vi.fn() },
    })) };
}
beforeEach(() => {
  setApiPause(null); setAuthToken("synthetic-a"); setAccountScope("synthetic-a");
  expect(getAccountNamespace()).toBe("acct:synthetic-a");
  configureOperationContext({ key: "synthetic-a", serverOrigin: "http://synthetic-a.invalid", authority: "local", ready: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); setAuthToken(null); setAccountScope(""); });

it("저장 시작 때 실행한 스냅샷 메타를 보내고 파생 반영·Undo 이력 갱신을 순서대로 한다", async () => {
  const save = vi.spyOn(comfyApi, "saveToLibrary").mockResolvedValue({ saved: [{ url: "/executed.png", generation_id: "saved", existed: false }] });
  const state = context();
  state.cardsRef.current[0].comfyCfg!.name = "current name";
  const result = await saveSceneComfyToLibrary("c", options(), state);
  expect(save.mock.calls[0][0]).toMatchObject({ name: "executed workflow", prompt: "executed prompt", elapsed_seconds: 4,
    inputs: [{ url: "/input.png", source_gen_id: "source" }], outputs: [{ url: "/executed.png", kind: "image" }] });
  expect(result).toEqual({ saved: 1, failed: 0 });
  expect(state.commitDocument).toHaveBeenCalledWith({ type: "saveComfyOutputs", cardId: "c", expectedContent: "{}",
    savedResults: [{ url: "/executed.png", generation_id: "saved", existed: false }], executedOutputs: [{ kind: "image", url: "/executed.png" }] });
  expect(state.cardsRef.current[0]).toMatchObject({ genId: "saved", genIds: ["saved"], comfyCfg: { outputs: [{ saved_generation_id: "saved" }] } });
});
it.each(["scene", "workflow", "input"])("저장 응답 중 %s 변경은 원격 저장 성공을 유지하고 현재 카드 반영은 생략한다", async (change) => {
  let release!: (value: Awaited<ReturnType<typeof comfyApi.saveToLibrary>>) => void;
  const save = vi.spyOn(comfyApi, "saveToLibrary").mockImplementation(() => new Promise((done) => { release = done; }));
  const state = context(); let inputCurrent = true;
  const pending = saveSceneComfyToLibrary("c", { ...options(), isInputCurrent: () => inputCurrent }, state);
  if (change === "scene") state.sceneIdRef.current = "scene-after";
  else if (change === "workflow") state.cardsRef.current = state.cardsRef.current.map((card) => ({ ...card, comfyCfg: { ...card.comfyCfg, content: "changed" } }));
  else inputCurrent = false;
  release({ saved: [{ url: "/executed.png", generation_id: "saved", existed: false }] });
  expect(await pending).toEqual({ saved: 1, failed: 0 }); expect(save).toHaveBeenCalledTimes(1);
  expect(state.commitDocument).not.toHaveBeenCalled();
});
it("수동 메타 수집이 실패해도 출력 저장은 계속하고 워크플로 이름으로 대체한다", async () => {
  vi.spyOn(edges, "comfyTextDriveKeys").mockImplementation(() => { throw new Error("metadata collection failed"); });
  const save = vi.spyOn(comfyApi, "saveToLibrary").mockResolvedValue({ saved: [{ url: "/executed.png", generation_id: "saved", existed: false }] });
  expect(await saveSceneComfyToLibrary("c", { silent: true }, context())).toEqual({ saved: 1, failed: 0 });
  expect(save.mock.calls[0][0]).toMatchObject({ prompt: "executed workflow", inputs: [], outputs: [{ url: "/executed.png", kind: "image" }] });
});
it("원격 저장 실패는 출력 개수를 실패로 돌려주고 카드나 이력을 바꾸지 않는다", async () => {
  vi.spyOn(comfyApi, "saveToLibrary").mockRejectedValue(new Error("save failed"));
  const state = context();
  expect(await saveSceneComfyToLibrary("c", options(), state)).toEqual({ saved: 0, failed: 1 });
  expect(state.commitDocument).not.toHaveBeenCalled();
});

const changeOperation = (change: string) => {
  if (change === "account") setAccountScope("synthetic-b");
  else if (change === "server") configureOperationContext({ key: "synthetic-b", serverOrigin: "http://synthetic-b.invalid", authority: "local", ready: true });
  else setAuthToken("synthetic-b");
};
it.each(["account", "server", "credential"])("작업 문맥이 %s로 바뀐 뒤 늦게 시작한 자동 저장은 새 API를 보내지 않는다", async change => {
  const state = context();
  const save = vi.spyOn(comfyApi, "saveToLibrary").mockResolvedValue({ saved: [] });
  changeOperation(change);
  expect(await saveSceneComfyToLibrary("c", options(), state)).toEqual({ saved: 0, failed: 1 });
  expect(save).not.toHaveBeenCalled(); expect(state.commitDocument).not.toHaveBeenCalled();
});
it.each(["account", "server", "credential", "document"])("작업 문맥 %s 전환 뒤 다음 저장의 범위를 고정하고 같은 계정 문서 변경은 결과를 보관한다", async change => {
  const state = context(); let inputCurrent = true;
  let release!: (result: Awaited<ReturnType<typeof comfyApi.saveToLibrary>>) => void;
  const saved = { saved: [{ url: "/executed.png", generation_id: "saved", existed: false }] };
  const save = vi.spyOn(comfyApi, "saveToLibrary").mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(saved);
  const completed = Array.from({ length: 2 }, () => ({ cardId: "c", outputCount: 1,
    options: { ...options(), isInputCurrent: () => inputCurrent } }));
  const pending = saveCompletedComfyResults(completed, (cardId, opts) => saveSceneComfyToLibrary(cardId, opts, state));
  expect(save).toHaveBeenCalledTimes(1);
  if (change === "document") { state.sceneIdRef.current = "scene-after"; inputCurrent = false; }
  else changeOperation(change);
  release(saved);
  expect(await pending).toEqual(change === "document" ? { saved: 2, failed: 0 } : { saved: 1, failed: 1 });
  expect(save).toHaveBeenCalledTimes(change === "document" ? 2 : 1);
  expect(state.commitDocument).not.toHaveBeenCalled();
});
