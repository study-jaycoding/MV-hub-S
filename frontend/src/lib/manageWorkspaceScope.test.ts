import { describe, expect, it } from "vitest";
import { workspaceScopeFromContext } from "./manageWorkspaceScope";

describe("workspaceScopeFromContext", () => {
  it("팀 컨텍스트의 id만 관리 창 범위로 넘긴다", () => {
    expect(workspaceScopeFromContext({ scope: "team", id: " ws-a ", name: "팀A" }))
      .toEqual({ workspaceId: "ws-a" });
  });
  it("개인/미확정/깨진 값은 전체 범위(빈 객체)", () => {
    expect(workspaceScopeFromContext({ scope: "personal", id: null, name: null })).toEqual({});
    expect(workspaceScopeFromContext({ scope: "unknown", id: null, name: null })).toEqual({});
    expect(workspaceScopeFromContext({ scope: "team", id: null })).toEqual({});
    expect(workspaceScopeFromContext("broken")).toEqual({});
    expect(workspaceScopeFromContext(null)).toEqual({});
  });
});
