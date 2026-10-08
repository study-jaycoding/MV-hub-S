// @vitest-environment jsdom
// 편집 탭의 조회 훅 — 쪽 넘김·문맥 전환·실패·상한에서 '없음'을 잘못 선언하지 않는지(docs/EDIT_TAB.md).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation, WorkspaceContext } from "../src/types";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), projects: vi.fn(), links: vi.fn(), folder: vi.fn(), counts: vi.fn(),
}));
vi.mock("../src/api", () => ({
  GEN_PAGE: 200,
  api: {
    listGenerations: mocks.list, projects: mocks.projects, projectFolderLinks: mocks.links,
    projectFolder: mocks.folder, projectFolderCountsBatch: mocks.counts,
  },
}));

import { useEditGenerations, useEditProjects } from "../src/lib/useEditSequence";

const TEAM: WorkspaceContext = { scope: "team", id: "w1", name: "W" };
const UNKNOWN: WorkspaceContext = { scope: "unknown", id: null, name: null };
let host: HTMLDivElement;
let root: Root;
let list: ReturnType<typeof useEditGenerations>;
let tree: ReturnType<typeof useEditProjects>;

const row = (id: string, usable = true, ts = 1): Generation => ({
  id, job_id: `j-${id}`, status: usable ? "done" : "failed", sort_ts: ts, folder_path: "e070/c1",
  workspace_scope: "team", workspace_id: "w1", params: {},
  assets: usable ? [{ id: `a-${id}`, generation_id: id, type: "video", file_path: `/m/${id}.mp4`, thumbnail_path: null, source_url: null, cached: true }] : [],
} as unknown as Generation);
const page = (prefix: string, usable: boolean, count = 200) =>
  Array.from({ length: count }, (_, i) => row(`${prefix}${i}`, usable, 1000 - i));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

function ListHarness(props: { seq: string | null; workspace?: WorkspaceContext; all?: boolean }) {
  list = useEditGenerations({
    authKey: "auth", workspace: props.workspace ?? TEAM, projectId: "p1", seq: props.seq, allWorkspaces: props.all,
  });
  return null;
}
function TreeHarness() {
  tree = useEditProjects({ authKey: "auth", workspace: TEAM, projectId: "p1" });
  return null;
}
const render = (node: React.ReactNode) => act(() => root.render(node));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.values(mocks).forEach((mock) => mock.mockReset());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("쓸 수 있는 것이 0개인 쪽 뒤에도 다음 쪽을 묻는다 — 커서는 거르기 전 마지막 행", async () => {
  const first = page("x", false);
  mocks.list.mockResolvedValueOnce(first).mockResolvedValueOnce([row("ok1"), row("ok2")]);
  render(<ListHarness seq="e070" />);
  await flush();
  expect(mocks.list).toHaveBeenCalledTimes(2);
  expect(mocks.list.mock.calls[0][0]).toMatchObject({ tab: "team", workspace_ids: ["w1"], project_id: "p1", folder_path: "e070" });
  expect(mocks.list.mock.calls[0][0]).not.toHaveProperty("review_filter"); // 일반 공유·보류·최종 모두
  expect(mocks.list.mock.calls[1][1]).toEqual({ ts: first[199].sort_ts, id: first[199].id });
  expect(list.state).toBe("ok");
  expect(list.complete).toBe(true);
  expect(list.gens.map((gen) => gen.id)).toEqual(["ok1", "ok2"]);
});

it("문맥이 바뀐 뒤 늦게 온 응답은 버리고 그 문맥의 다음 쪽도 묻지 않는다", async () => {
  const slow = deferred<Generation[]>();
  mocks.list.mockImplementation((query: { folder_path: string }) =>
    query.folder_path === "e070" ? slow.promise : Promise.resolve([row("b1")]));
  render(<ListHarness seq="e070" />);
  await flush();
  render(<ListHarness seq="e071" />);
  await flush();
  expect(list.gens.map((gen) => gen.id)).toEqual(["b1"]);
  slow.resolve(page("a", true));
  await flush();
  expect(list.gens.map((gen) => gen.id)).toEqual(["b1"]);
  expect(mocks.list.mock.calls.filter(([query]) => query.folder_path === "e070")).toHaveLength(1);
});

it("실패하면 같은 문맥의 마지막 성공 결과를 남기되 '끝까지 받음'은 아니다", async () => {
  mocks.list.mockResolvedValueOnce([row("a1"), row("a2")]);
  render(<ListHarness seq="e070" />);
  await flush();
  expect(list.complete).toBe(true);
  mocks.list.mockRejectedValueOnce(new Error("HTTP 502"));
  act(() => list.reload());
  await flush();
  expect(list.state).toBe("error");
  expect(list.error).toContain("502");
  expect(list.complete).toBe(false); // 여기 없는 클립을 '미디어 없음'으로 판정하면 안 된다
  expect(list.known).toBe(true); // 한 번 끝까지 받은 문맥 — 남은 결과로 '빈 폴더'는 가려도 된다
  expect(list.gens.map((gen) => gen.id)).toEqual(["a1", "a2"]);
});

it("2,000행에서 멈추고 '일부만'으로 알린다", async () => {
  mocks.list.mockImplementation(() => Promise.resolve(page("p", true)));
  render(<ListHarness seq="e070" />);
  await flush();
  await flush();
  expect(mocks.list).toHaveBeenCalledTimes(10);
  expect(list.state).toBe("capped");
  expect(list.complete).toBe(false);
  expect(list.known).toBe(false); // 뒤가 잘렸다 — 여기 없다고 '빈 폴더'라 하지 않는다
});

it("끝까지 받았던 문맥도 다음 조회가 잘리면 '빈 폴더' 판정을 멈춘다 — 든 목록이 더는 온전하지 않다", async () => {
  mocks.list.mockResolvedValueOnce([row("a1")]);
  render(<ListHarness seq="e070" />);
  await flush();
  expect(list.known).toBe(true);
  mocks.list.mockImplementation(() => Promise.resolve(page("p", true))); // 그사이 공유물이 2,000행을 넘겼다
  act(() => list.reload());
  await flush();
  await flush();
  expect(list.state).toBe("capped");
  expect(list.known).toBe(false);
});

it("워크스페이스를 모르면 묻지 않는다 — '전체 보기'면 워크스페이스 조건 없이 묻는다", async () => {
  mocks.list.mockResolvedValue([row("a1")]);
  render(<ListHarness seq="e070" workspace={UNKNOWN} />);
  await flush();
  expect(mocks.list).not.toHaveBeenCalled();
  expect(list.state).toBe("idle");
  render(<ListHarness seq="e070" workspace={UNKNOWN} all />);
  await flush();
  expect(mocks.list.mock.calls[0][0]).toEqual({ tab: "team", project_id: "p1", folder_path: "e070" });
  expect(list.gens).toHaveLength(1);
});

it("폴더 — 디스크 트리를 못 읽으면 공유 기록의 폴더만 보이고 '온전하지 않음'으로 둔다", async () => {
  mocks.projects.mockResolvedValue({ projects: [{ id: "p1", name: "P" }], unassigned: 0 });
  mocks.links.mockResolvedValue({ links: { p1: {} } });
  mocks.folder.mockRejectedValue(new Error("nas"));
  mocks.counts.mockResolvedValue({ counts: { p1: { "e070/c2": 3, "e070/c1": 1 } } });
  render(<TreeHarness />);
  await flush();
  await flush();
  expect(mocks.projects).toHaveBeenCalledWith("team", false, "w1");
  expect(tree.projectsState).toBe("ok");
  expect(tree.tree.state).toBe("ready");
  expect(tree.tree.complete).toBe(false); // '하위 폴더 없음'을 믿지 않는다
  expect(tree.tree.note).toBeTruthy();
  expect(tree.tree.roots.map((node) => node.path)).toEqual(["e070"]);
  expect(tree.tree.roots[0].children?.map((node) => node.path).sort()).toEqual(["e070/c1", "e070/c2"]);
});

it("폴더 — 연결된 폴더가 없는 프로젝트는 공유 기록만으로 온전하다", async () => {
  mocks.projects.mockResolvedValue({ projects: [{ id: "p1", name: "P" }], unassigned: 0 });
  mocks.links.mockResolvedValue({ links: {} });
  mocks.counts.mockResolvedValue({ counts: { p1: { "e070/c1": 1 } } });
  render(<TreeHarness />);
  await flush();
  await flush();
  expect(mocks.folder).not.toHaveBeenCalled();
  expect(tree.tree.complete).toBe(true);
  expect(tree.tree.note).toBeNull();
});

it("폴더 — 연결 조회에 실패하면 '연결 없음'으로 치지 않는다(온전하지 않음)", async () => {
  mocks.projects.mockResolvedValue({ projects: [{ id: "p1", name: "P" }], unassigned: 0 });
  mocks.links.mockRejectedValue(new Error("HTTP 502"));
  mocks.counts.mockResolvedValue({ counts: { p1: { "e070/c1": 1 } } });
  render(<TreeHarness />);
  await flush();
  await flush();
  expect(tree.tree.state).toBe("ready");
  expect(tree.tree.complete).toBe(false);
  expect(tree.tree.note).toBeTruthy();
});

it("다시 받는 동안에는 '끝까지 받음'이 아니다 — 그 사이 여기 없는 클립을 '없음'으로 판정하지 않는다", async () => {
  mocks.list.mockResolvedValueOnce([row("a1")]);
  render(<ListHarness seq="e070" />);
  await flush();
  expect(list.complete).toBe(true);
  const slow = deferred<Generation[]>();
  mocks.list.mockReturnValueOnce(slow.promise);
  act(() => list.reload());
  await flush();
  expect(list.state).toBe("loading");
  expect(list.complete).toBe(false);
  expect(list.known).toBe(true); // 다시 받는 동안에도 '빈 폴더' 판정은 출렁이지 않는다
  expect(list.gens.map((gen) => gen.id)).toEqual(["a1"]); // 마지막 성공 결과는 그대로 보인다
  slow.resolve([row("a1"), row("a2")]);
  await flush();
  expect(list.complete).toBe(true);
  expect(list.gens).toHaveLength(2);
});
