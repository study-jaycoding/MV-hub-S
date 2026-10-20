import { setHubFeatures } from "../src/lib/hubFeatures";
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureSubmissionScope, configureOperationContext, watchOperationContext, invalidateOperationContext } from "../src/app/operationContext";
import { getGenerationReadModel } from "../src/features/library/readModels";
import { setAccountScope } from "../src/lib/accountScope";
import { setApiPause, setAuthToken } from "../src/lib/http";
import { APP_EVENTS } from "../src/lib/appEvents";
import { prepareCreateSubmission } from "../src/features/generation/api";
import { runSubmission } from "../src/features/generation/submit";
import type { Generation } from "../src/types";

const workspace = { scope: "personal" as const, id: null, name: null };
const configure = (key: string, serverOrigin = "http://synthetic-a.invalid") => configureOperationContext({ key, serverOrigin, authority: "local", ready: true });
const generation = { id: "accepted-original" } as Generation;
beforeEach(() => { setApiPause(null); setAuthToken(null); setAccountScope("synthetic-a"); configure("account-a"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setHubFeatures([]); setApiPause(null); setAuthToken(null); });

it("rejects account/server A-B-A while a different workspace alone does not change the session", () => {
  const account = captureSubmissionScope(workspace);
  setAccountScope("synthetic-b"); captureSubmissionScope(workspace); setAccountScope("synthetic-a");
  expect(account.isCurrent!()).toBe(false);
  const server = captureSubmissionScope(workspace);
  configure("server-b", "http://synthetic-b.invalid"); configure("account-a");
  expect(server.isCurrent!()).toBe(false);
  const original = captureSubmissionScope(workspace);
  const otherWorkspace = captureSubmissionScope({ scope: "team", id: "workspace-b", name: "B" });
  expect(original.isCurrent!()).toBe(true);
  expect(otherWorkspace.operation!.workspaceId).toBe("workspace-b");
});

it("observes actual auth refresh and cross-tab logout signals, including same-string ABA", () => {
  const off = watchOperationContext();
  try {
    for (const event of [new Event(APP_EVENTS.authRequired), new StorageEvent("storage", { key: "mvhub.hubLogoutAt", newValue: "1" })]) {
      const operation = captureSubmissionScope(workspace); window.dispatchEvent(event);
      expect(operation.isCurrent!()).toBe(false);
    }
  } finally { off(); }
});

it("rejects token/pause changes even before App has rendered the new auth state", () => {
  const original = captureSubmissionScope(workspace); setAuthToken("synthetic-token");
  expect(original.isCurrent!()).toBe(false);
  const next = captureSubmissionScope(workspace); setApiPause("hub");
  expect(next.isCurrent!()).toBe(false);
});

it("revalidates after durable destination wait and does not send into another session", async () => {
  const scope = captureSubmissionScope(workspace); const send = vi.fn().mockResolvedValue(generation);
  const result = await runSubmission({ operationId: "original-operation", context: { workspace, ...scope }, send }, {
    confirm: async () => { configure("account-b"); return true; }, apply: vi.fn(),
  });
  expect(result.outcome).toEqual({ kind: "prepare_failed", reasonCode: "context_changed" });
  expect(send).not.toHaveBeenCalled();
});

it("keeps server acceptance and original Generation after account change, without a new screen write", async () => {
  const scope = captureSubmissionScope(workspace); const apply = vi.fn();
  const result = await runSubmission({ operationId: "original-operation", context: { workspace, ...scope }, send: async () => { configure("account-b"); return generation; } }, {
    confirm: () => true, apply,
  });
  expect(result.outcome).toEqual({ kind: "accepted_local_pending", operationId: "original-operation", generationId: generation.id });
  expect(result.generation).toBe(generation); expect(apply).not.toHaveBeenCalled();
});

it("does not invent a pending local attachment for an accepted standalone request", async () => {
  const scope = captureSubmissionScope(workspace);
  const result = await runSubmission({ operationId: "standalone", context: { workspace, ...scope }, send: async () => { configure("account-b"); return generation; } });
  expect(result.outcome).toEqual({ kind: "accepted", operationId: "standalone", generationId: generation.id });
  expect(result.generation).toBe(generation);
});

it("checks context even when a caller invokes the detached legacy send directly", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const prepared = prepareCreateSubmission({ prompt: "synthetic", model: "model" }, workspace, undefined, captureSubmissionScope(workspace));
  configure("account-b");
  await expect(prepared.send()).rejects.toThrow("계정 또는 서버");
  expect(fetch).not.toHaveBeenCalled();
});

it("settles into the captured document when only the visible document changes", async () => {
  let visibleDocument = "scene-a";
  const original = { scene_id: visibleDocument, card_id: "card-a", generation_id: generation.id, attempt_id: "attempt-a" };
  const applied: string[] = [];
  const result = await runSubmission({ operationId: original.attempt_id, context: { workspace, canvasLink: original, ...captureSubmissionScope(workspace) }, send: async () => { visibleDocument = "scene-b"; return generation; } }, {
    confirm: () => true, apply: (_generation, prepared) => { applied.push(prepared.context.canvasLink!.scene_id); },
  });
  expect(visibleDocument).toBe("scene-b"); expect(applied).toEqual(["scene-a"]); expect(result.outcome.kind).toBe("accepted");
});

it("계정 이름 갱신 알림만으로 동일 계정의 작업 세대를 바꾸지 않는다", () => {
  const off = watchOperationContext();
  try { const original = captureSubmissionScope(workspace); window.dispatchEvent(new Event(APP_EVENTS.accountUpdated)); expect(original.isCurrent!()).toBe(true); }
  finally { off(); }
});

it("checks the same context before an internal HTTP retry, preserving uncertain first acceptance", async () => {
  vi.useFakeTimers(); setHubFeatures(["request_retry_v1"]);
  const fetch = vi.fn().mockRejectedValue(new TypeError("synthetic response loss")); vi.stubGlobal("fetch", fetch);
  const prepared = prepareCreateSubmission({ prompt: "synthetic", model: "model" }, workspace, undefined, captureSubmissionScope(workspace));
  const running = runSubmission(prepared);
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(1);
  configure("different-server", "http://synthetic-b.invalid");
  await vi.advanceTimersByTimeAsync(1001);
  const result = await running;
  expect(result.outcome).toEqual({ kind: "acceptance_unknown", operationId: prepared.operationId });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("invalidates read-model records and old tickets without replacing same-scope subscribers", () => {
  const model = getGenerationReadModel("account-a", "local");
  const oldRead = model.beginRead();
  model.store({ [generation.id]: generation }, oldRead);
  expect(model.read(generation.id)).toBeDefined();
  invalidateOperationContext();
  expect(model.read(generation.id)).toBeUndefined();
  expect(model.store({ [generation.id]: generation }, oldRead)).toEqual([]);
  expect(getGenerationReadModel("account-a", "local")).toBe(model);
});
