import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGenerationProjectActions } from "../src/lib/useGenerationProjectActions";
import type { Filters } from "../src/types";

const { assignProject, broadcast } = vi.hoisted(() => ({
  assignProject: vi.fn(), broadcast: vi.fn(),
}));
vi.mock("../src/api", () => ({ api: { assignProject } }));
vi.mock("../src/lib/libraryBroadcast", () => ({ postLibraryChanged: broadcast }));

function actions(ids = ["old-1"], tab: "my" | "team" = "my") {
  return useGenerationProjectActions({
    bumpBoard: vi.fn(), flash: vi.fn(), reload: vi.fn().mockResolvedValue(undefined),
    filtersRef: { current: { tab } as Filters },
    selectedRef: { current: new Set(ids) },
  });
}

describe("explicit folder placement resumes work", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignProject.mockResolvedValue({ ok: true, updated: 1 });
  });
  it("only resumes the explicitly selected old results", async () => {
    const ids = ["old-1", "old-2", "old-3", "old-4", "old-5"];
    await actions(ids).assignSelectedToProject("project", "e001/c0010");
    expect(assignProject).toHaveBeenCalledWith(ids, "project", "my", "e001/c0010", true);
    expect(broadcast).toHaveBeenCalledOnce();
  });
  it("a same-folder user drop requests resume, not an automatic refresh", async () => {
    await actions().dropOnFolder("old-1", "project", "e001/c0010");
    expect(assignProject).toHaveBeenCalledWith(["old-1"], "project", "my", "e001/c0010", true);
  });
  it("project-only placement does not explicitly resume a retained folder", async () => {
    await actions().assignSelectedToProject("project");
    expect(assignProject).toHaveBeenCalledWith(["old-1"], "project", "my", undefined, false);
  });
  it("unassign does not reactivate another task", async () => {
    await actions().dropUnassign("old-1");
    expect(assignProject).toHaveBeenCalledWith(["old-1"], null, "my", undefined, false);
  });
});
