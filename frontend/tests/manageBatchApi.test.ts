import { afterEach, describe, expect, it, vi } from "vitest";

import { manageApi } from "../src/lib/manageApi";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

afterEach(() => vi.unstubAllGlobals());

describe("PM task batch API", () => {
  it("과거 작업용 프로젝트 목록을 선택 워크스페이스 ID로 요청한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ projects: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await manageApi.taskProjects("ws-a", true);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/manage/task-projects?workspace_id=ws-a&include_historical=true",
      expect.any(Object),
    );
  });

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

  it("프로젝트가 500개를 넘으면 누락 없이 여러 요청으로 나눈다", async () => {
    const projectIds = Array.from({ length: 501 }, (_, index) => `p${index}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ p0: [{ id: "t0" }] }))
      .mockResolvedValueOnce(okResponse({ p500: [{ id: "t500" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await manageApi.listTasksBatch(projectIds, "ws-a");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchMock.mock.calls[0][0]), "http://local");
    const secondUrl = new URL(String(fetchMock.mock.calls[1][0]), "http://local");
    expect(firstUrl.searchParams.getAll("project_id")).toHaveLength(500);
    expect(secondUrl.searchParams.getAll("project_id")).toEqual(["p500"]);
    expect(result).toEqual({ p0: [{ id: "t0" }], p500: [{ id: "t500" }] });
  });
});

function errorResponse(
  status: number,
  detail = status === 404 ? "Not Found" : status === 405 ? "Method Not Allowed" : "err",
): Pick<Response, "ok" | "status" | "statusText" | "json"> {
  return {
    ok: false,
    status,
    statusText: `status-${status}`,
    json: vi.fn().mockResolvedValue({ detail }),
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

  it("현재 서버의 도메인 404는 구버전으로 오인해 단건 쓰기로 우회하지 않는다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(404, "없는 작업: t1"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(manageApi.updateTaskOrderSnapshot(["t1"])).rejects.toThrow("없는 작업");
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
