import { afterEach, describe, expect, it, vi } from "vitest";

import { assetsApi } from "../src/lib/assetsApi";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(result),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Assets batch metadata API", () => {
  it("여러 태그 변경을 한 요청 본문으로 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true, count: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const items = [
      { path: "a.png", tags: ["hero"] },
      { path: "b.png", tags: ["bg"] },
    ];

    await expect(assetsApi.setAssetTagsBatch("demo", items)).resolves.toEqual({ ok: true, count: 2 });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assets/tags/batch",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ project: "demo", items }) }),
    );
  });

  it("여러 색상 변경을 한 요청 본문으로 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true, count: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    await assetsApi.setAssetColorsBatch("demo", ["a.png", "b.png"], "green");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assets/colors/batch",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ project: "demo", paths: ["a.png", "b.png"], color: "green" }),
      }),
    );
  });
});
