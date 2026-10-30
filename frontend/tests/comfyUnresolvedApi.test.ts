// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comfyApi } from "../src/lib/comfyApi";
import { HttpError, setAuthToken } from "../src/lib/http";
import { setHubFeatures } from "../src/lib/hubFeatures";
import { setAccountScope } from "../src/lib/accountScope";

describe("Comfy unresolved run HTTP boundary", () => {
  beforeEach(() => { vi.useFakeTimers(); setAuthToken("synthetic-session"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setAuthToken(null); setAccountScope(""); setHubFeatures([]); });

  it("새 허브 회수는 원래 job을 collect하고 임시 job만 폴링한다", async () => {
    setHubFeatures(["comfy_canvas_runs_v1"]);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ job_id: "temporary-collect" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ outputs: [], prompt_id: "original-prompt" })));
    vi.stubGlobal("fetch", fetcher);
    const pending = comfyApi.collectRun("original-job");
    await vi.runAllTimersAsync(); await pending;
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/comfy/unresolved-runs/original-job/collect", "/api/comfy/run_status?job_id=temporary-collect",
    ]);
  });

  it("새 허브 회수 중 계정 전환은 다음 폴링을 막는다", async () => {
    setHubFeatures(["comfy_canvas_runs_v1"]);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ job_id: "temporary-collect" })));
    vi.stubGlobal("fetch", fetcher);
    const pending = comfyApi.collectRun("original-job").catch(error => error);
    await vi.advanceTimersByTimeAsync(0); setAccountScope("next");
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps unresolved job identity and structured HTTP status with shared auth headers", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ job_id: "synthetic-job" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "synthetic result unavailable" }), {
        status: 502, headers: { "X-Comfy-Unresolved": "1" },
      }));
    vi.stubGlobal("fetch", fetcher);
    const settled = comfyApi.run("{}").catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await settled;
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ name: "ComfyUnresolvedRunError", status: 502, jobId: "synthetic-job" });
    expect(fetcher.mock.calls[1][1].headers).toEqual({ Authorization: "Bearer synthetic-session" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not label ordinary auth errors as unresolved or resubmit generation", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ job_id: "synthetic-job" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "login expired" }), { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const settled = comfyApi.run("{}").catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await settled).toMatchObject({ name: "HttpError", status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves forty transient polling failures without a second submit", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ job_id: "synthetic-job" })));
    for (let index = 0; index < 40; index++) fetcher.mockRejectedValueOnce(new TypeError("synthetic offline"));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ outputs: [], prompt_id: "p" })));
    vi.stubGlobal("fetch", fetcher);
    const pending = comfyApi.run("{}");
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ outputs: [], prompt_id: "p" });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
