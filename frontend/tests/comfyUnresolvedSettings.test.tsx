// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComfyUnresolvedRunsSection } from "../src/components/settings/ComfyUnresolvedRunsSection";
import { comfyApi, ComfyUnresolvedRunError, type ComfyUnresolvedRun } from "../src/lib/comfyApi";
import { APP_EVENTS } from "../src/lib/appEvents";
import { HttpError } from "../src/lib/http";
import { getLang, setLang } from "../src/lib/i18n";
import { executeSceneComfy } from "../src/lib/sceneComfyExecutor";
import type { SceneCard } from "../src/lib/scenes";
import { useComfyUnresolvedRuns } from "../src/lib/useComfyUnresolvedRuns";
import { useCanvasComfyRuns } from "../src/lib/useCanvasComfyRuns";
import { createCanvasDocumentPort } from "../src/features/canvas/session";
import { listScenes, saveScenes, type Scene } from "../src/lib/scenes";
import { settleSceneStoreForTest } from "../src/lib/sceneStore";
import { setHubFeatures } from "../src/lib/hubFeatures";
import { comfySceneFingerprints } from "../src/lib/sceneComfyInputs";
import type { ComfyCanvasResolution } from "../src/lib/comfyRunState";

// 이 훅의 useState setter 호출 자체를 계측한다. unmount 뒤 React가 삼키는 것과 구분한다.
const setterTrace = vi.hoisted(() => ({ enabled: false, calls: 0 }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState<T>(initial: T | (() => T)) {
    const result = actual.useState(initial);
    if (!setterTrace.enabled) return result;
    return [result[0], (next: T) => { setterTrace.calls += 1; result[1](next); }];
  } };
});

const record = (patch: Partial<ComfyUnresolvedRun> = {}): ComfyUnresolvedRun => ({
  job_id: "synthetic-record", phase: "unknown", prompt_id: null, target_kind: "cloud", base_host: "synthetic.invalid",
  created_at: 1, last_status_code: null, last_error_class: null, outputs: [], can_collect: false, can_resave: false,
  can_dismiss: true, device_matches_current: true, target_matches_current: true, ...patch,
});
let root: Root, host: HTMLDivElement, oldLang: ReturnType<typeof getLang>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected real API"); }));
  oldLang = getLang(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => { root.unmount(); setLang(oldLang); }); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  setterTrace.enabled = false;
  setHubFeatures([]);
});
const render = async () => { await act(async () => root.render(<ComfyUnresolvedRunsSection />)); };
const button = (text: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(text))!;

it.each(["collect", "resave", "dismiss"])("새 허브 %s 뒤 원래 attempt를 재조회하여 카드에 정산한다", async action => {
  setHubFeatures(["comfy_canvas_runs_v1"]); act(() => setLang("ko"));
  const scene: Scene = { id: "scene", name: "scene", created_at: 1, edges: [], cards: [
    { id: "c", kind: "comfy", x: 0, y: 0, comfyCfg: { content: "{}" } },
  ], comfyCardRuns: { c: { groupId: "group", groupSeq: 1 } } };
  scene.comfyRuns = [{ version: 1, attemptId: "original-attempt", runGroupId: "group", groupSeq: 1, copyIndex: 0, cardId: "c",
    originHubId: "hub", originDeviceId: "pc", localState: "submitted", ...comfySceneFingerprints(scene, "c")! }];
  saveScenes(null, [scene]); await settleSceneStoreForTest();
  let state: ComfyCanvasResolution["state"] = "needs_collect";
  vi.spyOn(comfyApi, "canvasOrigin").mockResolvedValue({ hub_id: "hub", device_id: "pc" });
  const resolve = vi.spyOn(comfyApi, "resolveCanvasRuns").mockImplementation(async () => ({ runs: [{
    attempt_id: "original-attempt", state, result_revision: state === "needs_collect" ? 1 : 2,
    outputs: state === "saved" ? [{ output_key: "one", kind: "image", generation_id: "saved-gen", state: "saved" }] : [],
    origin: { hub_id: "hub", device_id: "pc" },
  }] }));
  vi.spyOn(comfyApi, "ackCanvasRun").mockImplementation(async request => ({ ...request, state: "linked", outputs: [],
    origin: { hub_id: "hub", device_id: "pc" } }));
  vi.spyOn(comfyApi, "unresolvedRuns").mockImplementation(async () => ({ cap: 200, used: state === "needs_collect" ? 1 : 0,
    runs: state !== "needs_collect" ? [] : [record({ job_id: "original-job", phase: "collected", can_collect: action === "collect",
      can_resave: action === "resave", outputs: [{ url: "/media/comfy/one.png", kind: "image", name: "one", downloaded: true, acked: false, unavailable: null }] })] }));
  const collect = vi.spyOn(comfyApi, "collectRun").mockImplementation(async () => { state = "saved"; return { outputs: [], prompt_id: "original-prompt" }; });
  const resave = vi.spyOn(comfyApi, "saveToLibrary").mockImplementation(async () => { state = "saved"; return { saved: [] }; });
  const dismiss = vi.spyOn(comfyApi, "dismissRuns").mockImplementation(async () => { state = "dismissed"; return { dismissed: 1 }; });
  const documentPort = createCanvasDocumentPort({ flushPending: () => {} });
  function Screen() { useCanvasComfyRuns({ authReady: true, canvasDocument: documentPort }); return <ComfyUnresolvedRunsSection />; }
  await act(async () => root.render(<Screen />));
  if (action === "dismiss") await act(async () => host.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
  await act(async () => { button(action === "collect" ? "결과 회수 ·" : action === "resave" ? "내 작업에 저장 ·" : "기록 정리").click(); });
  await vi.waitFor(() => expect(listScenes(null)[0].comfyRuns).toEqual([]));
  expect(resolve.mock.calls.every(([ids]) => ids.includes("original-attempt"))).toBe(true);
  expect(listScenes(null)[0].cards[0].genId).toBe(action === "dismiss" ? undefined : "saved-gen");
  if (action === "collect") expect(collect).toHaveBeenCalledExactlyOnceWith("original-job");
  if (action === "resave") expect(resave).toHaveBeenCalledOnce();
  if (action === "dismiss") expect(dismiss).toHaveBeenCalledExactlyOnceWith(["original-job"]);
});

it.each(["en", "ko"] as const)("%s unknown has no collect/submit and requires explicit dismiss confirmation", async (lang) => {
  act(() => setLang(lang));
  vi.spyOn(comfyApi, "unresolvedRuns").mockResolvedValue({ runs: [record()], cap: 200, used: 1 });
  const dismiss = vi.spyOn(comfyApi, "dismissRuns").mockResolvedValue({ dismissed: 1 });
  const collect = vi.spyOn(comfyApi, "collectRun"); const run = vi.spyOn(comfyApi, "run");
  await render();
  expect(host.textContent).toContain(lang === "en" ? "Submission unknown" : "제출 여부 불명");
  expect(host.textContent).not.toContain(lang === "en" ? "Collect results ·" : "결과 회수 ·");
  const dismissButton = button(lang === "en" ? "Dismiss record" : "기록 정리");
  expect(dismissButton.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
  expect(dismissButton.disabled).toBe(false);
  await act(async () => dismissButton.click());
  expect(dismiss).toHaveBeenCalledExactlyOnceWith(["synthetic-record"]);
  expect(collect).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it("saved results survive deleted cards and use local save only, excluding acknowledged outputs", async () => {
  act(() => setLang("en"));
  vi.spyOn(comfyApi, "unresolvedRuns").mockResolvedValue({ cap: 200, used: 1, runs: [record({ phase: "collected", can_resave: true, outputs: [
    { url: "/media/comfy/one.png", kind: "image", name: "one", downloaded: true, acked: false, unavailable: null },
    { url: "/media/comfy/two.png", kind: "image", name: "two", downloaded: true, acked: true, unavailable: null },
  ] })] });
  const save = vi.spyOn(comfyApi, "saveToLibrary").mockResolvedValue({ saved: [] });
  const run = vi.spyOn(comfyApi, "run"); const collect = vi.spyOn(comfyApi, "collectRun");
  await render();
  await act(async () => button("Save to My Work").click());
  expect(save).toHaveBeenCalledExactlyOnceWith({ outputs: [{ url: "/media/comfy/one.png", kind: "image" }] });
  expect(run).not.toHaveBeenCalled(); expect(collect).not.toHaveBeenCalled();
});

it("late list from previous account cannot overwrite current account list", async () => {
  let finish!: (value: { runs: ComfyUnresolvedRun[]; used: number; cap: number }) => void;
  vi.spyOn(comfyApi, "unresolvedRuns").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue({ cap: 200, used: 0, runs: [] });
  await render();
  await act(async () => window.dispatchEvent(new Event(APP_EVENTS.accountUpdated)));
  await act(async () => finish({ cap: 200, used: 1, runs: [record()] }));
  expect(host.textContent).not.toContain("synthetic-record");
});

it("input replacement cannot overwrite an unresolved remote-run error", async () => {
  const cards = [{ id: "c", kind: "comfy", x: 0, y: 0, comfyCfg: { content: "workflow", paramValues: {} } }] as SceneCard[];
  let current = true;
  const error = new ComfyUnresolvedRunError(new HttpError(502, "synthetic lost result"), "job");
  await expect(executeSceneComfy({ cardId: "c", cards, edges: [], genData: {}, refParents: {}, varySeed: false,
    isRunCurrent: () => current,
  }, { run: async () => { current = false; throw error; } })).rejects.toBe(error);
});

it("late manual list cannot resurrect a record after a completed dismiss refresh", async () => {
  act(() => setLang("en"));
  let finishOld!: (value: { runs: ComfyUnresolvedRun[]; used: number; cap: number }) => void;
  const old = { cap: 200, used: 1, runs: [record()] };
  vi.spyOn(comfyApi, "unresolvedRuns").mockResolvedValueOnce(old)
    .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValue({ cap: 200, used: 0, runs: [] });
  const dismiss = vi.spyOn(comfyApi, "dismissRuns").mockResolvedValue({ dismissed: 1 });
  await render();
  await act(async () => button("Retry").click());
  await act(async () => host.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
  await act(async () => button("Dismiss record").click());
  expect(dismiss).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("synthetic-record");
  await act(async () => finishOld(old));
  expect(host.textContent).not.toContain("synthetic-record");
});

it.each([false, true])("late GET success/failure cannot replace the latest GET result (%s)", async (oldFails) => {
  act(() => setLang("en"));
  let resolveOld!: (value: { runs: ComfyUnresolvedRun[]; used: number; cap: number }) => void;
  let rejectOld!: (error: Error) => void;
  const listing = vi.spyOn(comfyApi, "unresolvedRuns").mockResolvedValueOnce({ cap: 200, used: 0, runs: [] })
    .mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }));
  if (oldFails) listing.mockResolvedValue({ cap: 200, used: 1, runs: [record({ job_id: "latest-record" })] });
  else listing.mockRejectedValue(new Error("latest GET failure"));
  await render();
  await act(async () => button("Retry").click());
  await act(async () => button("Retry").click());
  await act(async () => { if (oldFails) rejectOld(new Error("old GET failure")); else resolveOld({ cap: 200, used: 1, runs: [record()] }); });
  if (oldFails) {
    expect(host.textContent).toContain("latest-record");
    expect(host.textContent).not.toContain("old GET failure");
  } else {
    expect(host.textContent).toContain("latest GET failure");
    expect(host.textContent).not.toContain("synthetic-record");
  }
});

it.each(["duplicate_action", "newer_refresh"])("direct hook boundary reclaims busy without invalidating a live refresh: %s", async (mode) => {
  // 실제 섹션 버튼은 busy 동안 disabled다. 이 교차 순서는 훅의 공개 함수 경계 직접 대조다.
  let state!: ReturnType<typeof useComfyUnresolvedRuns>;
  function Harness() { state = useComfyUnresolvedRuns(); return null; }
  let finishActionRefresh!: (value: { runs: ComfyUnresolvedRun[]; used: number; cap: number }) => void;
  const listing = vi.spyOn(comfyApi, "unresolvedRuns").mockResolvedValueOnce({ cap: 200, used: 1, runs: [record()] })
    .mockImplementationOnce(() => new Promise((resolve) => { finishActionRefresh = resolve; }))
    .mockResolvedValue({ cap: 200, used: 1, runs: [record({ job_id: "latest-record" })] });
  const dismiss = vi.spyOn(comfyApi, "dismissRuns").mockResolvedValue({ dismissed: 1 });
  await act(async () => root.render(<Harness />));
  let action!: Promise<void>;
  await act(async () => { action = state.dismiss(record()); });
  expect(state.busy).toBe(true);
  if (mode === "duplicate_action") await act(async () => state.dismiss(record()));
  else await act(async () => state.refresh());
  await act(async () => { finishActionRefresh({ cap: 200, used: 0, runs: [] }); await action; });
  expect(state.busy).toBe(false);
  expect(dismiss).toHaveBeenCalledOnce();
  expect(listing).toHaveBeenCalledTimes(mode === "duplicate_action" ? 2 : 3);
  expect(state.runs.map((run) => run.job_id)).toEqual(mode === "duplicate_action" ? [] : ["latest-record"]);
});

it.each([false, true])("unmount blocks the late GET setter itself, rejected=%s", async (rejected) => {
  setterTrace.enabled = true;
  let resolve!: (value: { runs: []; cap: number; used: number }) => void;
  let reject!: (error: Error) => void;
  vi.spyOn(comfyApi, "unresolvedRuns").mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  function Harness() { useComfyUnresolvedRuns(); return null; }
  await act(async () => root.render(<Harness />));
  act(() => root.unmount());
  const before = setterTrace.calls;
  await act(async () => {
    if (rejected) reject(new Error("synthetic late failure"));
    else resolve({ runs: [], cap: 200, used: 0 });
  });
  expect(setterTrace.calls).toBe(before);
  expect(fetch).not.toHaveBeenCalled();
});

it("dismiss 409 still refreshes the latest row, releases busy and allows a fresh retry", async () => {
  let state!: ReturnType<typeof useComfyUnresolvedRuns>;
  function Harness() { state = useComfyUnresolvedRuns(); return null; }
  const refreshed = record({ phase: "collected" });
  const listing = vi.spyOn(comfyApi, "unresolvedRuns").mockResolvedValueOnce({ runs: [record()], cap: 200, used: 1 })
    .mockResolvedValueOnce({ runs: [refreshed], cap: 200, used: 1 })
    .mockResolvedValue({ runs: [], cap: 200, used: 0 });
  const dismiss = vi.spyOn(comfyApi, "dismissRuns").mockRejectedValueOnce(new HttpError(409, "synthetic claim changed"))
    .mockResolvedValue({ dismissed: 1 });
  await act(async () => root.render(<Harness />));
  await act(async () => state.dismiss(state.runs[0]));
  expect(state.busy).toBe(false);
  expect(state.runs).toEqual([refreshed]);
  expect(state.error).toBe("synthetic claim changed");
  await act(async () => state.dismiss(state.runs[0]));
  expect(state.busy).toBe(false); expect(state.error).toBe(""); expect(state.runs).toEqual([]);
  expect(listing).toHaveBeenCalledTimes(3); expect(dismiss).toHaveBeenCalledTimes(2);
  expect(fetch).not.toHaveBeenCalled();
});

// 2026-11-04 Jay '단추도 라임으로 디자인 맞춰서' — 다른 설정 단추와 같은 공용 단추다
it("'다시 조회' 는 설정 공용 라임 단추(settings-action)이고 누르면 목록을 다시 읽는다", async () => {
  act(() => setLang("ko"));
  const listing = vi.spyOn(comfyApi, "unresolvedRuns").mockResolvedValue({ cap: 200, used: 0, runs: [] });
  await render();
  const again = button("다시 조회");
  expect(again.classList.contains("settings-action")).toBe(true);
  const before = listing.mock.calls.length;
  await act(async () => again.click());
  expect(listing).toHaveBeenCalledTimes(before + 1);
});

it("running phase uses English when the UI language is English", async () => {
  act(() => setLang("en"));
  vi.spyOn(comfyApi, "unresolvedRuns").mockResolvedValue({ cap: 200, used: 1, runs: [record({ phase: "running" })] });
  await render();
  expect(host.textContent).toContain("Running");
  expect(host.textContent).not.toContain("실행 중");
});
