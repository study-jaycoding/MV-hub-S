import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

afterEach(() => vi.unstubAllGlobals());

describe("generation recovery API", () => {
  it("generation id를 인코딩하고 명시적 미제출 확인값을 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true, applied: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.confirmGenerationNotSubmitted("gen/a b")).resolves.toEqual({
      ok: true,
      applied: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/gen-requests/by-generation/gen%2Fa%20b/confirm-not-submitted",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ confirmed_not_submitted: true });
  });
});
