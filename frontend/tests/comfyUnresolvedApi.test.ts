// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comfyApi } from "../src/lib/comfyApi";
import { HttpError, setAuthToken } from "../src/lib/http";

describe("Comfy unresolved run HTTP boundary", () => {
  beforeEach(() => { vi.useFakeTimers(); setAuthToken("synthetic-session"); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setAuthToken(null); });

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
