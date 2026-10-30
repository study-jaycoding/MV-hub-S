import { afterEach, expect, it, vi } from "vitest";
import { comfyApi } from "../src/lib/comfyApi";
import type { ComfyCanvasResolution } from "../src/lib/comfyRunState";

afterEach(() => vi.unstubAllGlobals());
it("resolve와 반복 ACK가 백엔드 필드 이름과 linked 응답을 보존한다", async () => {
  const result: ComfyCanvasResolution = { attempt_id: "attempt", state: "saved", result_revision: 7,
    outputs: [{ output_key: "text:1", kind: "text", text: "hello", state: "text" }], origin: { hub_id: "hub", device_id: "pc" } };
  const linked = { ...result, state: "linked", disposition: "attached", outputs: [] };
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ runs: [result] })))
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(linked))));
  vi.stubGlobal("fetch", fetcher);
  expect(await comfyApi.resolveCanvasRuns(["attempt"])).toEqual({ runs: [result] });
  const receipt = { attempt_id: "attempt", result_revision: 7, disposition: "attached" as const };
  expect(await comfyApi.ackCanvasRun(receipt)).toEqual(linked);
  expect(await comfyApi.ackCanvasRun(receipt)).toEqual(linked);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/comfy/canvas-runs/resolve", "/api/comfy/canvas-runs/ack", "/api/comfy/canvas-runs/ack",
  ]);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ attempt_ids: ["attempt"] });
  expect(fetcher.mock.calls.slice(1).map(([, request]) => JSON.parse(request.body))).toEqual([receipt, receipt]);
});

it("없는 UUID의 resolve 응답에서 원본을 얻고 식별자가 없으면 제출 준비를 거절한다", async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ runs: [{
    state: "not_found", origin: { hub_id: "hub", device_id: "pc" },
  }] }))));
  vi.stubGlobal("fetch", fetcher);
  expect(await comfyApi.canvasOrigin()).toEqual({ hub_id: "hub", device_id: "pc" });
  expect(JSON.parse(fetcher.mock.calls[0][1].body).attempt_ids[0]).toMatch(/^[\da-f-]{36}$/);
  fetcher.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ runs: [] }))));
  await expect(comfyApi.canvasOrigin()).rejects.toThrow("원본");
});
