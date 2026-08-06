import { afterEach, describe, expect, it, vi } from "vitest";

import { manageApi } from "../src/lib/manageApi";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

afterEach(() => vi.unstubAllGlobals());

describe("PM task batch API", () => {
  it("순서 저장은 전체 스냅샷 + 구배치 호환 items 이중 페이로드를 한 PATCH 로 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true, count: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    await manageApi.updateTaskOrderSnapshot(["t2", "t1"]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/manage/tasks-batch/order",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          ordered_task_ids: ["t2", "t1"],
          // 스냅샷 계약을 모르는 구배치 서버도 같은 전체 상태를 items 로 저장한다(무음 no-op 방지).
          items: [
            { task_id: "t2", sort_order: 0 },
            { task_id: "t1", sort_order: 10 },
          ],
        }),
      }),
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

function errorResponse(status: number): Pick<Response, "ok" | "status" | "statusText" | "json"> {
  return {
    ok: false,
    status,
    statusText: `status-${status}`,
    json: vi.fn().mockResolvedValue({ detail: "err" }),
  };
}

describe("구서버 폴백 (404/405 한정)", () => {
  it("순서 저장 404(라우트 없음)면 단건 PATCH 로 전체 스냅샷을 저장한다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(404))
      .mockResolvedValue(okResponse({ id: "t" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await manageApi.updateTaskOrderSnapshot(["t1", "t2"]);

    expect(res).toEqual({ ok: true, count: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/manage/tasks/t1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ sort_order: 0 }) }),
    );
  });

  it("순서 저장 5xx 는 폴백하지 않고 오류를 전파한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(502));
    vi.stubGlobal("fetch", fetchMock);

    await expect(manageApi.updateTaskOrderSnapshot(["t1"])).rejects.toThrow("502");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("삭제 배치 404 폴백에서 이미 없는 작업(단건 404)은 건너뛴다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(404)) // 배치 라우트 없음
      .mockResolvedValueOnce(okResponse({ ok: true })) // t1 삭제 성공
      .mockResolvedValueOnce(errorResponse(404)); // t2 이미 없음
    vi.stubGlobal("fetch", fetchMock);

    const res = await manageApi.deleteTasksBatch(["t1", "t2"]);

    expect(res).toEqual({ ok: true, count: 1 });
  });

  it("담당 해제: 구서버 400(mode 미지원)이면 단건 DELETE 로 폴백한다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(400))
      .mockResolvedValue(okResponse({ removed: true }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await manageApi.bulkSetAssignments(
      [{ task_id: "t1", assignee_uids: ["u1", "u2"] }],
      "remove",
    );

    expect(res).toEqual({ ok: true, count: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/manage/tasks/t1/assignees/u1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("담당 교체(replace)는 구서버 폴백 불가 — 명시 오류", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      manageApi.bulkSetAssignments([{ task_id: "t1", assignee_uids: ["u1"] }], "replace"),
    ).rejects.toThrow("구버전");
  });

  it("501개 삭제는 500 단위 두 청크로 나눠 보낸다", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ ok: true, count: 500 }))
      .mockResolvedValueOnce(okResponse({ ok: true, count: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const ids = Array.from({ length: 501 }, (_, i) => `t${i}`);
    const res = await manageApi.deleteTasksBatch(ids);

    expect(res).toEqual({ ok: true, count: 501 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
