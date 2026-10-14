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
  it("여러 태그 변경을 더하기·빼기 한 요청으로 보낸다(목록 통째가 아니다 — 서버셋 설계 ③)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true, items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const items = [
      { path: "a.png", add: ["hero"] },
      { path: "b.png", remove: ["bg"] },
    ];

    await expect(assetsApi.applyAssetTagOps("demo", items)).resolves.toEqual({ ok: true, count: 2, items: [] });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assets/tags/ops",
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

  it("여러 소스 지정을 한 요청 본문으로 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true, count: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const items = [
      { path: "a.png", name: "a.png" },
      { path: "b.png", name: "b.png" },
    ];

    await assetsApi.setAssetSourcesBatch("demo", items);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assets/sources/batch",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ project: "demo", items }) }),
    );
  });
});
