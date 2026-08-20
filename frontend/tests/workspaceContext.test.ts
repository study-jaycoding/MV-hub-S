import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { buildGenerationQuery } from "../src/lib/appGenerationQuery";
import { manageApi } from "../src/lib/manageApi";
import {
  activeWorkspaceOf,
  isGenerationWorkspaceReady,
  reconcileReportedWorkspaceContext,
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

  it("저장 필터에서 id만 복원된 팀 컨텍스트에 보고된 정식 이름을 채운다", () => {
    const restored = { scope: "team" as const, id: "ws-a", name: null };
    const reported = [
      { id: "personal", name: null, plan_type: "free", credits: 1, is_selected: false, user_role: "owner" },
      { id: "ws-a", name: "MILLIONVOLT", plan_type: "team", credits: 10, is_selected: true, user_role: "member" },
    ];

    expect(reconcileReportedWorkspaceContext(restored, reported)).toEqual({
      scope: "team", id: "ws-a", name: "MILLIONVOLT",
    });
  });

  it("보고 목록이 사용자가 고른 다른 공간을 임의로 바꾸지 않는다", () => {
    const chosen = { scope: "team" as const, id: "ws-b", name: "티타임" };
    const reported = [
      { id: "ws-a", name: "MILLIONVOLT", plan_type: "team", credits: 10, is_selected: true, user_role: "member" },
    ];

    expect(reconcileReportedWorkspaceContext(chosen, reported)).toBe(chosen);
  });

  it("생성은 개인 또는 id와 이름이 모두 확인된 팀에서만 허용한다", () => {
    expect(isGenerationWorkspaceReady({ scope: "personal", id: null, name: null })).toBe(true);
    expect(isGenerationWorkspaceReady({ scope: "team", id: "ws-a", name: "MILLIONVOLT" })).toBe(true);
    expect(isGenerationWorkspaceReady({ scope: "team", id: "ws-a", name: null })).toBe(false);
    expect(isGenerationWorkspaceReady({ scope: "unknown", id: null, name: null })).toBe(false);
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
      undefined,
      "11111111-1111-4111-8111-111111111111",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/gen-requests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "create",
          workspace: { scope: "team", id: "ws-a", name: "MILLIONVOLT" },
          create: { prompt: "test", model: "nano", params: {}, references: [] },
          idempotency_key: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("이름이 아직 확인되지 않은 팀 생성 요청은 API 전송 전에 차단한다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.create(
      { prompt: "test", model: "nano", params: {}, references: [] },
      { scope: "team", id: "ws-a", name: null },
    )).rejects.toThrow("워크스페이스 id와 이름");

    expect(fetchMock).not.toHaveBeenCalled();
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

  it("잔액 표시는 CLI 선택이 아니라 앱에서 고른 워크스페이스를 따른다", () => {
    // account status(=CLI 선택 공간) 숫자를 그대로 쓰면 앱에서 팀을 바꿔도 이전 팀 잔액이 남는다.
    const ws = (id: string, name: string | null, credits: number, is_selected = false) => ({
      id, name, credits, is_selected, plan_type: "enterprise", user_role: "member",
    });
    const list = [ws("p", null, 8.5), ws("a", "MILLIONVOLT", 90172, true), ws("b", "뻘뻘뻘", 1020)];

    expect(activeWorkspaceOf(list, { scope: "team", id: "b", name: "뻘뻘뻘" })?.credits).toBe(1020);
    expect(activeWorkspaceOf(list, { scope: "personal", id: null, name: null })?.credits).toBe(8.5);
    // 아직 확정 전(unknown)일 때만 CLI 가 물고 있는 공간으로 폴백한다.
    expect(activeWorkspaceOf(list, { scope: "unknown", id: null, name: null })?.credits).toBe(90172);
  });
});
