import { describe, expect, it } from "vitest";
import {
  cachedProjectFolderEntries,
  rememberProjectFolderEntry,
  rememberProjectFolderLink,
} from "../src/lib/projectFolderTree";
import type { ProjectFolderState } from "../src/types";

function state(projectId: string, rootPath: string): ProjectFolderState {
  return {
    project_id: projectId,
    root_path: rootPath,
    selected_path: "ep001",
    render_path: `${rootPath}\\Render`,
    tree: { name: "Render", path: "", count: 0, children: [] },
    error: null,
    truncated: false,
  };
}

describe("프로젝트 폴더 세션 캐시", () => {
  it("한 번 읽은 폴더 트리를 다음 사이드바 인스턴스가 즉시 복원한다", () => {
    const saved = state("project-session", "Z:\\project");
    rememberProjectFolderEntry(saved);

    expect(cachedProjectFolderEntries(["project-session"])["project-session"]).toBe(saved);
  });

  it("같은 루트의 링크 갱신은 기존 트리를 유지한다", () => {
    const saved = state("project-same-root", "Z:\\project");
    rememberProjectFolderEntry(saved);

    const next = rememberProjectFolderLink({
      project_id: "project-same-root",
      root_path: "Z:\\project",
      selected_path: "ep002",
    });

    expect(next.tree).toBe(saved.tree);
    expect(next.selected_path).toBe("ep002");
  });

  it("루트 경로가 바뀌면 이전 폴더 트리를 재사용하지 않는다", () => {
    rememberProjectFolderEntry(state("project-new-root", "Z:\\old"));

    const next = rememberProjectFolderLink({
      project_id: "project-new-root",
      root_path: "Z:\\new",
      selected_path: "",
    });

    expect(next.tree).toBeUndefined();
    expect(next.root_path).toBe("Z:\\new");
  });
});
