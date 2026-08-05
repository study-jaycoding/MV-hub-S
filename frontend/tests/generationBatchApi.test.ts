import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

afterEach(() => vi.unstubAllGlobals());

describe("generation batch API", () => {
  it("500개 서버 상한을 넘는 씬은 여러 요청으로 나누고 응답을 다시 합친다", async () => {
    const ids = Array.from({ length: 1001 }, (_, index) => `g${index}`);
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const pageIds = JSON.parse(String(init.body)).gen_ids as string[];
      return Promise.resolve(
        okResponse({
          items: Object.fromEntries(
            pageIds.filter((id) => id !== "g1000").map((id) => [id, { id, prompt: "" }]),
          ),
          materials: Object.fromEntries(pageIds.map((id) => [id, [`parent:${id}`]])),
          missing: pageIds.includes("g1000") ? ["g1000"] : [],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.getGenerationsBatch([...ids, "g0", "  "]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requestSizes = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return (JSON.parse(String(init.body)).gen_ids as string[]).length;
    });
    expect(requestSizes).toEqual([500, 500, 1]);
    expect(Object.keys(result.items)).toHaveLength(1000);
    expect(result.materials["g750"]).toEqual(["parent:g750"]);
    expect(result.missing).toEqual(["g1000"]);
  });

  it("빈 목록은 서버를 호출하지 않는다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.getGenerationsBatch(["", "  "])).resolves.toEqual({
      items: {},
      materials: {},
      missing: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
