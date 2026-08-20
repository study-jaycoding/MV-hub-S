import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { withMirrorPendingNotice } from "../src/lib/shareMirrorPending";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

afterEach(() => vi.unstubAllGlobals());

describe("share-state mirror_pending", () => {
  it("서버 200 응답을 성공으로 유지하고 자동 동기화 안내를 붙인다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        id: "generation-1",
        prompt: "",
        mirror_pending: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.finalize("generation-1");

    expect(result.mirror_pending).toBe(true);
    expect(withMirrorPendingNotice("최종(골드)으로 지정했습니다.", result)).toContain(
      "일부 로컬 반영은 잠시 후 자동 동기화됩니다",
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/generations/generation-1/finalize");
    expect(init.method).toBe("POST");
  });
});
