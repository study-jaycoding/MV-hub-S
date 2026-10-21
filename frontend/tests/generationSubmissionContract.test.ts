import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { prepareCreateSubmission, prepareRegenerateSubmission } from "../src/features/generation/api";
import { runSubmission } from "../src/features/generation/submit";
import { ApiPausedError, HttpError } from "../src/lib/http";
import { setHubFeatures } from "../src/lib/hubFeatures";
import type { Generation } from "../src/types";
import type { PreparedSubmission, SubmissionDestination } from "../src/shared/contracts/generation";

const workspace = { scope: "personal" as const, id: null, name: null };
const body = { prompt: "synthetic contract", model: "nano" };
const link = { attempt_id: "attempt-a", generation_id: "generation-a", scene_id: "scene-a", card_id: "card-a" };
const generation = { id: "generation-a", prompt: "response", tags: ["tag"], assets: [] } as unknown as Generation;
const response = () => ({ ok: true, json: async () => generation });
const requestBodies = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(call => JSON.parse(String(call[1].body)));
const prepared = (send = vi.fn<() => Promise<Generation>>().mockResolvedValue(generation)): PreparedSubmission => ({
  operationId: "operation-a", context: { workspace }, send,
});
const destination = (): SubmissionDestination => ({ confirm: vi.fn().mockResolvedValue(true), apply: vi.fn() });

afterEach(() => { vi.unstubAllGlobals(); setHubFeatures([]); });

describe("prepared generation submission contract", () => {
  it("keeps one detached send key and creates a different key for another user intent", async () => {
    const fetchMock = vi.fn().mockImplementation(response);
    vi.stubGlobal("fetch", fetchMock);
    const operation = prepareCreateSubmission(body, workspace);
    const send = operation.send;
    await send(); await send();
    const next = prepareCreateSubmission(body, workspace);
    await next.send();
    const requests = requestBodies(fetchMock);
    expect(requests[0].idempotency_key).toBe(operation.operationId);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2].idempotency_key).toBe(next.operationId);
    expect(next.operationId).not.toBe(operation.operationId);
  });

  it("preserves canvas identity without adding a general idempotency key", async () => {
    const fetchMock = vi.fn().mockImplementation(response); vi.stubGlobal("fetch", fetchMock);
    const operation = prepareCreateSubmission(body, workspace, link);
    await operation.send(); await operation.send();
    expect(operation.operationId).toBe(link.attempt_id);
    const requests = requestBodies(fetchMock);
    expect(requests[0].canvas_link).toEqual(link);
    expect(requests[0].idempotency_key).toBeUndefined();
    expect(requests[1]).toEqual(requests[0]);
    expect(Object.isFrozen(operation.context.workspace)).toBe(true);
    expect(Object.isFrozen(operation.context.canvasLink)).toBe(true);
  });

  it("preserves regenerate body/source and legacy detached prepare API", async () => {
    const fetchMock = vi.fn().mockImplementation(response); vi.stubGlobal("fetch", fetchMock);
    const operation = prepareRegenerateSubmission("source-a", { prompt: "again" }, workspace);
    await operation.send(); await operation.send();
    const send = api.prepareRegenerate("source-a", { prompt: "legacy" }, workspace);
    await send(); await send();
    const requests = requestBodies(fetchMock);
    expect(requests[0]).toMatchObject({ kind: "regenerate", source_gen_id: "source-a", regenerate: { prompt: "again" } });
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[3]).toEqual(requests[2]);
    expect(requests[2].idempotency_key).not.toBe(operation.operationId);
  });

  it("legacy direct create is a new intent each time and keeps the Generation response", async () => {
    const fetchMock = vi.fn().mockImplementation(response); vi.stubGlobal("fetch", fetchMock);
    expect(await api.create(body, workspace)).toEqual(generation);
    await api.create(body, workspace);
    const requests = requestBodies(fetchMock);
    expect(requests[0].idempotency_key).not.toBe(requests[1].idempotency_key);
  });

  it("keeps the existing direct API's explicit idempotency key", async () => {
    const fetchMock = vi.fn().mockImplementation(response); vi.stubGlobal("fetch", fetchMock);
    await api.create(body, workspace, undefined, "existing-key");
    await api.regenerate("source-a", {}, workspace, undefined, "existing-regen-key");
    expect(requestBodies(fetchMock).map(request => request.idempotency_key)).toEqual(["existing-key", "existing-regen-key"]);
  });

  it("captures payload/context so caller edits cannot change an already prepared retry", async () => {
    const fetchMock = vi.fn().mockImplementation(response); vi.stubGlobal("fetch", fetchMock);
    const input = { ...body, params: { duration: 5 } };
    const mutableWorkspace = { scope: "team" as const, id: "workspace-a", name: "A" };
    const mutableLink = { ...link };
    const operation = prepareCreateSubmission(input, mutableWorkspace, mutableLink);
    await operation.send();
    input.params.duration = 9; mutableWorkspace.id = "workspace-b"; mutableLink.card_id = "card-b";
    await operation.send();
    const requests = requestBodies(fetchMock);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[1]).toMatchObject({ create: { params: { duration: 5 } }, workspace: { id: "workspace-a" }, canvas_link: { card_id: "card-a" } });
  });

  it("never sends when the reserved destination is not confirmed or its check fails", async () => {
    for (const confirm of [vi.fn().mockResolvedValue(false), vi.fn().mockRejectedValue(new Error("storage unavailable"))]) {
      const operation = prepared(); const target = { confirm, apply: vi.fn() };
      expect((await runSubmission(operation, target)).outcome.kind).toBe("prepare_failed");
      expect(operation.send).not.toHaveBeenCalled(); expect(target.apply).not.toHaveBeenCalled();
    }
  });

  it("requires an adapter for a canvas link and a ready workspace before send", async () => {
    const operation = prepared();
    expect((await runSubmission({ ...operation, context: { workspace, canvasLink: link } })).outcome.kind).toBe("prepare_failed");
    expect((await runSubmission({ ...operation, context: { workspace: { scope: "unknown", id: null, name: null } } })).outcome.kind).toBe("prepare_failed");
    expect(operation.send).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 422])("classifies definite HTTP %s rejection without attachment", async status => {
    const error = new HttpError(status, "synthetic rejection"); const operation = prepared(vi.fn().mockRejectedValue(error)); const target = destination();
    const result = await runSubmission(operation, target);
    expect(result.outcome.kind).toBe("rejected"); expect(result.error).toBe(error);
    expect(target.apply).not.toHaveBeenCalled();
  });

  // 서버 계약(gen_requests NOT_STARTED): 409 는 X-MVHub-Submission: not-started 가 붙었을 때만 '안 했음'이다. 표식 없는 409(같은 열쇠의 기존 요청·캔버스 충돌)는 이미 접수됐을 수 있다.
  it("treats HTTP 409 as rejected only when the server marks it not-started", async () => {
    const conflict = (headers?: Record<string, string>) => new Response(JSON.stringify({ detail: "synthetic conflict" }), { status: 409, headers });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(conflict()).mockResolvedValueOnce(conflict({ "X-MVHub-Submission": "not-started" })));
    const target = destination();
    const unmarked = await runSubmission(prepareCreateSubmission(body, workspace, link), target);
    expect(unmarked.outcome).toEqual({ kind: "acceptance_unknown", operationId: link.attempt_id });
    const marked = await runSubmission(prepareCreateSubmission(body, workspace, link), target);
    expect(marked.outcome.kind).toBe("rejected");
    expect(target.apply).not.toHaveBeenCalled();
  });

  it("uses the existing paused-request definite rejection rule", async () => {
    const result = await runSubmission(prepared(vi.fn().mockRejectedValue(new ApiPausedError())));
    expect(result.outcome.kind).toBe("rejected");
  });

  it.each([408, 429, 500, 503])("keeps HTTP %s acceptance unknown", async status => {
    const result = await runSubmission(prepared(vi.fn().mockRejectedValue(new HttpError(status, "unknown"))));
    expect(result.outcome).toEqual({ kind: "acceptance_unknown", operationId: "operation-a" });
    expect(result.generation).toBeUndefined();
  });

  it("keeps unexpected transport errors unknown without matching error text", async () => {
    const error = new Error("arbitrary transport failure"); const result = await runSubmission(prepared(vi.fn().mockRejectedValue(error)));
    expect(result.outcome.kind).toBe("acceptance_unknown"); expect(result.error).toBe(error);
  });

  it("separates server acceptance from local attachment failure and preserves the exact response", async () => {
    const error = new Error("local attachment failed"); const target = destination(); target.apply = vi.fn().mockRejectedValue(error);
    const result = await runSubmission(prepared(), target);
    expect(result.outcome).toEqual({ kind: "accepted_local_pending", operationId: "operation-a", generationId: generation.id });
    expect(result.generation).toBe(generation); expect(result.error).toBe(error);
    expect(target.apply).toHaveBeenCalledWith(generation, expect.objectContaining({ operationId: "operation-a" }));
  });

  it("accepts without inventing requestId, and preserves one only when received", async () => {
    const result = await runSubmission(prepared());
    expect(result.outcome).toEqual({ kind: "accepted", operationId: "operation-a", generationId: generation.id });
    expect(result.generation).toBe(generation);
    const received = { ...generation, request_id: "request-received" };
    expect((await runSubmission(prepared(vi.fn().mockResolvedValue(received)))).outcome).toMatchObject({ requestId: "request-received" });
  });

  it("cannot confirm acceptance without Generation.id even when HTTP returned JSON", async () => {
    const target = destination();
    const result = await runSubmission(prepared(vi.fn().mockResolvedValue({ prompt: "incomplete response" })), target);
    expect(result.outcome).toEqual({ kind: "acceptance_unknown", operationId: "operation-a" });
    expect(target.apply).not.toHaveBeenCalled();
  });
});
