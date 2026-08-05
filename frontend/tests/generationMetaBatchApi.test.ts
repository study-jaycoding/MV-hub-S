import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../src/api";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

afterEach(() => vi.unstubAllGlobals());

describe("Generation metadata batch API", () => {
  it("색상 여러 건을 한 요청으로 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ succeeded: ["g1", "g2"], failed: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await api.setColorsBatch(["g1", "g2"], "red");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/generations/colors/batch",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ items: [{ id: "g1", color: "red" }, { id: "g2", color: "red" }] }),
      }),
    );
  });

  it("자동 태그 여러 건을 auto 표시와 함께 한 요청으로 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ succeeded: ["g1"], failed: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const items = [{ id: "g1", tags: ["hero"] }];

    await api.setTagsBatch(items, true);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/generations/tags/batch",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ items, auto: true }) }),
    );
  });
});
