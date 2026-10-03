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

  it("allowPartial 은 조각마다 보내고 unavailable 을 합친다 — 기본 호출은 보내지 않는다(2026-10-03)", async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `g${index}`);
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { gen_ids: string[]; allow_partial?: boolean };
      bodies.push(body);
      const team = body.gen_ids.filter((id) => id === "g3" || id === "g500");
      return Promise.resolve(
        okResponse({
          items: Object.fromEntries(body.gen_ids.filter((id) => !team.includes(id)).map((id) => [id, { id, prompt: "" }])),
          materials: {},
          missing: [],
          ...(body.allow_partial ? { unavailable: team } : {}),
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const partial = await api.getGenerationsBatch(ids, undefined, { allowPartial: true });
    expect(bodies.map((body) => body.allow_partial)).toEqual([true, true]);
    expect(partial.unavailable?.sort()).toEqual(["g3", "g500"]);
    expect(partial.missing).toEqual([]);

    bodies.length = 0;
    await api.getGenerationsBatch(["g1"]);
    expect(bodies).toEqual([{ gen_ids: ["g1"] }]);
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
