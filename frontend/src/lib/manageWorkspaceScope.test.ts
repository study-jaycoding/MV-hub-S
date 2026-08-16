import { describe, expect, it } from "vitest";
import { workspaceScopeFromLibraryFilters } from "./manageWorkspaceScope";

describe("workspaceScopeFromLibraryFilters", () => {
  it("uses the selected team workspace", () => {
    expect(workspaceScopeFromLibraryFilters({ tab: "my", workspace_id: " ws-a " }))
      .toEqual({ workspaceId: "ws-a" });
  });

  it("keeps personal mode unscoped", () => {
    expect(workspaceScopeFromLibraryFilters({ tab: "my" })).toEqual({});
    expect(workspaceScopeFromLibraryFilters({ workspace_id: null })).toEqual({});
    expect(workspaceScopeFromLibraryFilters("broken")).toEqual({});
  });
});
