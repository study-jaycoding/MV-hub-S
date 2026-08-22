import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

afterEach(() => vi.unstubAllGlobals());

describe("comment counts batch API", () => {
  it("500개 서버 상한을 넘는 배지 폴은 여러 요청으로 나누고 응답을 다시 합친다", async () => {
    const ids = Array.from({ length: 1001 }, (_, index) => `g${index}`);
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const pageIds = JSON.parse(String(init.body)).gen_ids as string[];
      return Promise.resolve(
        okResponse(
          Object.fromEntries(
            pageIds.map((id) => [id, { comment_count: 1, has_unread: id === "g1000" }]),
          ),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const counts = await api.commentCounts(ids);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requestSizes = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return (JSON.parse(String(init.body)).gen_ids as string[]).length;
    });
    expect(requestSizes).toEqual([500, 500, 1]);
    expect(Object.keys(counts)).toHaveLength(1001);
    expect(counts["g0"]).toEqual({ comment_count: 1, has_unread: false });
    expect(counts["g1000"]).toEqual({ comment_count: 1, has_unread: true });
  });

  it("빈 목록은 서버를 호출하지 않는다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.commentCounts([])).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
