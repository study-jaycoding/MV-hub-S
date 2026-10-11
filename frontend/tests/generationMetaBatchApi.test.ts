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

  // 15회차(조작 규칙 42): 500개씩 나눠 보내는데, 뒤 묶음의 요청이 실패하면 통째로 던져 앞 묶음의 성공이 사라졌다 —
  //  500건이 저장됐는데 호출부가 "600건 실패"라고 알렸다.
  const ids = Array.from({ length: 600 }, (_, index) => `g${index}`);
  const firstOkThenFail = () => vi.fn()
    .mockImplementationOnce(async (_url: string, init: { body: string }) =>
      okResponse({ succeeded: (JSON.parse(init.body).items as { id: string }[]).map((item) => item.id), failed: [] }))
    .mockRejectedValueOnce(new Error("Failed to fetch"));

  it("색: 뒤 묶음의 요청이 실패해도 앞 묶음의 성공은 버리지 않는다 — 실패한 묶음만 실패로 돌려준다", async () => {
    vi.stubGlobal("fetch", firstOkThenFail());
    const result = await api.setColorsBatch(ids, "red");
    expect(result.succeeded).toEqual(ids.slice(0, 500));
    expect(result.failed).toEqual(ids.slice(500));
  });

  it("태그: 뒤 묶음의 요청이 실패해도 앞 묶음의 성공은 버리지 않는다", async () => {
    vi.stubGlobal("fetch", firstOkThenFail());
    const result = await api.setTagsBatch(ids.map((id) => ({ id, tags: ["hero"] })));
    expect(result.succeeded).toEqual(ids.slice(0, 500));
    expect(result.failed).toEqual(ids.slice(500));
  });

  it("묶음이 셋 이상이면 실패한 묶음 뒤의 것은 보내지 않고, 안 보낸 것까지 실패로 돌려준다", async () => {
    const many = Array.from({ length: 1100 }, (_, index) => `g${index}`);
    for (const send of [
      () => api.setColorsBatch(many, "red"),
      () => api.setTagsBatch(many.map((id) => ({ id, tags: ["hero"] }))),
    ]) {
      const fetchMock = firstOkThenFail();
      vi.stubGlobal("fetch", fetchMock);
      const result = await send();
      expect(fetchMock).toHaveBeenCalledTimes(2); // 셋째 묶음은 나가지 않았다
      expect(result.succeeded).toEqual(many.slice(0, 500));
      expect(result.failed).toEqual(many.slice(500)); // 실패한 둘째 500 + 안 보낸 셋째 100
    }
  });

  it("첫 묶음부터 실패하면 그대로 던진다(저장된 것이 없다) · 계정이 바뀌어 멈춘 것은 저장 실패로 바꾸지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Failed to fetch")));
    await expect(api.setColorsBatch(ids, "red")).rejects.toThrow();
    await expect(api.setTagsBatch(ids.map((id) => ({ id, tags: [] })))).rejects.toThrow();
    // 둘째 묶음을 보내기 전에 계정이 바뀌었다 — assertCurrent 가 던진 것이 그대로 나온다
    vi.stubGlobal("fetch", firstOkThenFail());
    class Changed extends Error {}
    let calls = 0;
    await expect(api.setColorsBatch(ids, "red", () => { calls += 1; if (calls === 2) throw new Changed(); })).rejects.toBeInstanceOf(Changed);
  });
});
