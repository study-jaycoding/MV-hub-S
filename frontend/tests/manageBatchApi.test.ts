import { afterEach, describe, expect, it, vi } from "vitest";

import { manageApi } from "../src/lib/manageApi";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

afterEach(() => vi.unstubAllGlobals());

describe("PM task batch API", () => {
  it("순서 변경을 한 PATCH 요청으로 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true, count: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const items = [
      { task_id: "t1", sort_order: 20 },
      { task_id: "t2", sort_order: 10 },
    ];

    await manageApi.updateTaskOrderBatch(items);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/manage/tasks-batch/order",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ items }) }),
    );
  });

  it("선택 삭제를 한 POST 요청으로 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true, count: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    await manageApi.deleteTasksBatch(["t1", "t2"]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/manage/tasks-batch/delete",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ task_ids: ["t1", "t2"] }) }),
    );
  });
});
