import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedProjectFolderEntries,
  initialProjectFolderExpansion,
  loadProjectFolderExpansion,
  rememberProjectFolderEntry,
  rememberProjectFolderLink,
  saveProjectFolderExpansion,
} from "../src/lib/projectFolderTree";
import { STORAGE_KEYS } from "../src/lib/storageKeys";
import type { ProjectFolderNode, ProjectFolderState } from "../src/types";

const stored = new Map<string, string>();

beforeEach(() => {
  stored.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
});

afterEach(() => vi.unstubAllGlobals());

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

function largeTree(): ProjectFolderNode[] {
  return Array.from({ length: 20 }, (_, episode) => ({
    name: `ep${episode}`,
    path: `ep${episode}`,
    count: 0,
    children: Array.from({ length: 10 }, (_, sequence) => ({
      name: `sq${sequence}`,
      path: `ep${episode}/sq${sequence}`,
      count: 0,
      children: Array.from({ length: 10 }, (_, shot) => ({
        name: `shot${shot}`,
        path: `ep${episode}/sq${sequence}/shot${shot}`,
        count: 0,
        children: [],
      })),
    })),
  }));
}

describe("프로젝트 폴더 초기 확장", () => {
  it("작은 트리는 기존처럼 모든 부모 폴더를 펼친다", () => {
    const nodes = largeTree().slice(0, 1);

    const expanded = initialProjectFolderExpansion(nodes, "", 200);

    expect(expanded.has("ep0")).toBe(true);
    expect(expanded.has("ep0/sq0")).toBe(true);
  });

  it("큰 트리는 첫 단계까지만 펼쳐 초기 표시 행을 제한한다", () => {
    const expanded = initialProjectFolderExpansion(largeTree(), "", 250);

    expect(expanded.size).toBe(20);
    expect(expanded.has("ep0")).toBe(true);
    expect(expanded.has("ep0/sq0")).toBe(false);
  });

  it("첫 단계만으로도 한도를 넘으면 접되 마지막 선택의 조상은 연다", () => {
    const expanded = initialProjectFolderExpansion(
      largeTree(),
      "ep19\\sq9\\shot9",
      100,
    );

    expect(expanded).toEqual(new Set(["ep19", "ep19/sq9"]));
  });

  it("깊이가 큰 트리도 재귀 호출 스택 없이 처리한다", () => {
    let node: ProjectFolderNode = {
      name: "leaf",
      path: "root/leaf",
      count: 0,
      children: [],
    };
    for (let depth = 1_498; depth >= 0; depth -= 1) {
      node = {
        name: `d${depth}`,
        path: `d${depth}`,
        count: 0,
        children: [node],
      };
    }

    expect(initialProjectFolderExpansion([node], "", 2_000).size).toBe(1_499);
  });

  it("구형 전체 펼침 저장값을 폐기하고 버전 저장값만 복원한다", () => {
    stored.set(STORAGE_KEYS.projectFolderExpanded, JSON.stringify({ p1: ["ep0", "ep0/sq0"] }));
    expect(loadProjectFolderExpansion()).toEqual({});

    saveProjectFolderExpansion({ p1: new Set(["ep0"]) });
    expect(loadProjectFolderExpansion().p1).toEqual(new Set(["ep0"]));
    expect(JSON.parse(stored.get(STORAGE_KEYS.projectFolderExpanded) || "{}")).toEqual({
      version: 2,
      projects: { p1: ["ep0"] },
    });
  });
});
