import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { buildGenerationQuery } from "../src/lib/appGenerationQuery";
import { manageApi } from "../src/lib/manageApi";
import {
  selectedWorkspaceContext,
  workspaceContextOf,
} from "../src/lib/workspaceContext";

function okResponse(result: unknown): Pick<Response, "ok" | "json"> {
  return { ok: true, json: vi.fn().mockResolvedValue(result) };
}

afterEach(() => vi.unstubAllGlobals());

describe("workspace context", () => {
  it("팀과 개인 컨텍스트를 구분하고 CLI 선택값을 초기값으로 사용한다", () => {
    const team = { id: "ws-a", name: "MILLIONVOLT", plan_type: "team", credits: 10, is_selected: true, user_role: "member" };
    const personal = { id: "personal-real-id", name: null, plan_type: "free", credits: 1, is_selected: false, user_role: "owner" };

    expect(workspaceContextOf(team)).toEqual({ scope: "team", id: "ws-a", name: "MILLIONVOLT" });
    expect(workspaceContextOf(personal)).toEqual({ scope: "personal", id: null, name: null });
    expect(selectedWorkspaceContext([personal, team])).toEqual({
      scope: "team", id: "ws-a", name: "MILLIONVOLT",
    });
  });

  it("워크스페이스 필터를 서버 생성물 쿼리에 보존한다", () => {
    const query = buildGenerationQuery({
      filters: { tab: "my", workspace_id: "ws-a" },
      typeFilter: "all",
      colorFilter: new Set(),
      tagFilter: new Set(),
      armedAutoTags: new Set(),
      sharedOnly: false,
      commentOnly: false,
      finalOnly: false,
    });
    expect(query.workspace_id).toBe("ws-a");
  });

  it("신규 생성 요청에 현재 워크스페이스를 포함한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: "pending" }));
    vi.stubGlobal("fetch", fetchMock);

    await api.create(
      { prompt: "test", model: "nano", params: {}, references: [] },
      { scope: "team", id: "ws-a", name: "MILLIONVOLT" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/gen-requests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "create",
          workspace: { scope: "team", id: "ws-a", name: "MILLIONVOLT" },
          create: { prompt: "test", model: "nano", params: {}, references: [] },
        }),
      }),
    );
  });

  it("대시보드 기간·워크스페이스·모델 필터를 API에 전달한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ totals: {}, by_worker: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await manageApi.teamOverview({
      dateFrom: "2026-08-01",
      dateTo: "2026-08-06",
      workspaceId: "ws-a",
      model: "nano",
      creatorUid: "member-1",
      projectId: "project-1",
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("date_from=2026-08-01");
    expect(url).toContain("date_to=2026-08-06");
    expect(url).toContain("workspace_id=ws-a");
    expect(url).toContain("model=nano");
    expect(url).toContain("creator_uid=member-1");
    expect(url).toContain("project_id=project-1");
  });
});
