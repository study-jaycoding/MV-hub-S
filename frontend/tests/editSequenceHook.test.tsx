// @vitest-environment jsdom
// 편집 탭의 조회 훅 — 쪽 넘김·문맥 전환·실패·상한에서 '없음'을 잘못 선언하지 않는지(docs/EDIT_TAB.md).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ackTeamFreshKeys } from "../src/lib/teamSeen";
import type { Generation, WorkspaceContext } from "../src/types";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), projects: vi.fn(), links: vi.fn(), folder: vi.fn(), counts: vi.fn(), fresh: vi.fn(),
}));
vi.mock("../src/api", () => ({
  GEN_PAGE: 200,
  api: {
    listGenerations: mocks.list, projects: mocks.projects, projectFolderLinks: mocks.links,
    projectFolder: mocks.folder, projectFolderCountsBatch: mocks.counts, teamFreshAll: mocks.fresh,
  },
}));

// 새 항목 기준선만 대역으로 — teamSeen 은 계정 상태를 메모리에 들고 있어 시험 사이에 남는다(확인 기록은 진짜 것을 쓴다).
const seenBase = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("../src/lib/teamSeen", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/teamSeen")>("../src/lib/teamSeen")),
  getTeamBase: () => seenBase.value,
}));

import { editTick, useEditGenerations, useEditProjects } from "../src/lib/useEditSequence";

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
function TreeHarness({ workspace = TEAM }: { workspace?: WorkspaceContext }) {
  tree = useEditProjects({ authKey: "auth", workspace, projectId: "p1" });
  return null;
}
const render = (node: React.ReactNode) => act(() => root.render(node));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.values(mocks).forEach((mock) => mock.mockReset());
  localStorage.clear();
  seenBase.value = null;
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

// 목록을 낸 조회의 출발 순번 — 편집 탭 풀의 태그 덧입힘이 '저장이 끝난 뒤 출발한 조회'를 가리는 기준이다(Codex 리뷰 10-15).
//  다시 받는 동안·실패에는 그대로, 새 응답이 들어올 때만 그 조회의 순번으로 바뀐다. 다음 조회가 출발한 뒤에 온 옛 응답은 버린다.
it("startedAt 은 지금 목록을 낸 조회의 출발 순번이다 — 다시 받는 동안·실패에는 그대로, 늦게 온 옛 응답은 바꾸지 못한다", async () => {
  const [first, second, third] = [deferred<Generation[]>(), deferred<Generation[]>(), deferred<Generation[]>()];
  mocks.list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
  render(<ListHarness seq="e070" />);
  expect(list.startedAt).toBe(0);
  first.resolve([row("a1")]);
  await flush();
  const one = list.startedAt;
  expect(one).toBeGreaterThan(0);
  act(() => list.reload()); // 둘째 조회 출발
  expect([list.state, list.startedAt]).toEqual(["loading", one]); // 다시 받는 동안은 그대로(목록 배열이 다시 만들어져도)
  const between = editTick();
  act(() => list.reload()); // 셋째 조회 출발 — 둘째는 이제 옛 응답
  second.resolve([row("old")]);
  await flush();
  expect([list.startedAt, list.gens.map((gen) => gen.id)]).toEqual([one, ["a1"]]);
  third.reject(new Error("HTTP 502"));
  await flush();
  expect([list.state, list.startedAt]).toEqual(["error", one]); // 실패는 새 목록이 아니다
  mocks.list.mockResolvedValueOnce([row("b1")]);
  act(() => list.reload());
  await flush();
  expect(list.startedAt).toBeGreaterThan(between);
  expect(list.gens.map((gen) => gen.id)).toEqual(["b1"]);
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

// 25회차(조작 규칙 52, Codex 전수 검토): 같은 문맥의 재조회는 상태를 바꾸지 않아, '다시 시도'를 눌러도 실패 표시와 단추가 그대로였다 —
//  시작됐는지 알 수 없고 계속 누르면 새 조회가 앞 응답을 버렸다.
it("프로젝트 조회에 실패한 뒤 '다시 시도'하면 곧바로 조회 중이 된다 — 받은 목록·폴더는 둔 채, 재조회가 실패해도 폴더가 '로딩…'에 남지 않는다", async () => {
  mocks.projects.mockRejectedValueOnce(new Error("HTTP 502"));
  mocks.links.mockResolvedValue({ links: {} });
  mocks.counts.mockResolvedValue({ counts: { p1: { "e070/c1": 1 } } });
  render(<TreeHarness />);
  await flush();
  expect(tree.projectsState).toBe("error");
  const slow = deferred<{ projects: { id: string; name: string }[]; unassigned: number }>();
  mocks.projects.mockReturnValueOnce(slow.promise);
  act(() => tree.reload());
  await flush();
  expect(tree.projectsState).toBe("loading"); // 전엔 "error" 그대로
  slow.resolve({ projects: [{ id: "p1", name: "P" }], unassigned: 0 });
  await flush();
  await flush();
  expect([tree.projectsState, tree.projects.map((project) => project.id), tree.tree.state]).toEqual(["ok", ["p1"], "ready"]);
  const roots = tree.tree.roots.map((node) => node.path);
  expect(roots).toEqual(["e070"]);

  // 받은 목록·폴더가 있는 채 다시(폴더 주의문구의 '다시 시도') — 조회 중으로 보이되 목록·폴더는 그대로고 폴더 조회가 끊기지 않는다
  const again = deferred<{ projects: { id: string; name: string }[]; unassigned: number }>();
  const slowCounts = deferred<{ counts: Record<string, Record<string, number>> }>();
  mocks.projects.mockReturnValueOnce(again.promise);
  mocks.counts.mockReturnValueOnce(slowCounts.promise); // 폴더 건수도 늦는다
  act(() => tree.reload());
  await flush();
  expect([tree.projectsState, tree.projects.map((project) => project.id)]).toEqual(["loading", ["p1"]]);
  expect(tree.tree.roots.map((node) => node.path)).toEqual(roots); // 받아 둔 폴더는 그대로 보인다
  again.reject(new Error("HTTP 502")); // 프로젝트 재조회가 **먼저** 실패하고
  await flush();
  expect(tree.projectsState).toBe("error");
  slowCounts.resolve({ counts: { p1: { "e070/c1": 1 } } }); // 폴더 건수는 뒤에 온다
  await flush();
  await flush();
  // Codex 코드 리뷰: 실패가 listOk 를 꺼 폴더 조회를 취소하면 뒤에 온 답이 버려져 '폴더 로딩…'에 남았다 — 목록을 받았다는 사실은 실패로 사라지지 않는다
  expect([tree.tree.state, tree.tree.roots.map((node) => node.path)]).toEqual(["ready", roots]);
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

// 왼쪽 폴더 옆 표시(Jay 2026-10-08) — 공유 & 리뷰 사이드바와 같은 원천: 상태별 개수는 개수 조회의 같은 응답,
//  새 항목(+N)은 기준선 이후 공유된 목록에서 확인(클릭)한 것을 뺀 것.
it("폴더 — 최종·보류 개수와 새 항목(+N)이 트리에 실리고, 확인하면 그 자리에서 줄어든다", async () => {
  seenBase.value = "2026-10-01 00:00:00"; // 공유 & 리뷰에 들어간 적이 있다
  mocks.projects.mockResolvedValue({ projects: [{ id: "p1", name: "P" }, { id: "p2", name: "Q" }], unassigned: 0 });
  mocks.links.mockResolvedValue({ links: {} });
  mocks.counts.mockResolvedValue({
    counts: { p1: { "e070/c1": 2, "e070/c2": 1 } },
    review_counts: { p1: { "e070/c1": { final: 1, held: 1, shared: 0 }, "e070/c2": { final: 0, held: 0, shared: 1 } } },
  });
  mocks.fresh.mockResolvedValue([
    { id: "n1", project_id: "p1", folder_path: "e070/c1", shared_at: "2099-01-01 00:00:00", ack_key: "j1" },
    { id: "n2", project_id: "p2", folder_path: "x", shared_at: "2099-01-01 00:00:00", ack_key: "j2" },
    { id: "n3", project_id: null, folder_path: null, shared_at: "2099-01-01 00:00:00", ack_key: "j3" },
  ]);
  render(<TreeHarness />);
  await flush();
  await flush();
  expect(mocks.counts).toHaveBeenCalledWith(["p1"], "team");
  expect(mocks.fresh).toHaveBeenCalledWith("2026-10-01 00:00:00", expect.any(String));
  const seq = () => tree.tree.roots[0];
  const cut = (name: string) => seq().children!.find((node) => node.name === name)!;
  expect(seq()).toMatchObject({ count: 3, newCount: 1, reviewCounts: { final: 1, held: 1, shared: 1 } }); // 하위 폴더의 것이 모인다
  expect(cut("c1")).toMatchObject({ count: 2, newCount: 1, reviewCounts: { final: 1, held: 1, shared: 0 } });
  expect(cut("c2")).toMatchObject({ count: 1, newCount: 0, reviewCounts: { final: 0, held: 0, shared: 1 } });
  expect(tree.freshByProject).toEqual({ p1: 1, p2: 1 }); // 프로젝트 없는 것은 세지 않는다

  act(() => { ackTeamFreshKeys([{ ackKey: "j1", sharedAt: "2099-01-01 00:00:00" }]); }); // 카드를 눌러 확인했다
  expect(cut("c1").newCount).toBe(0);
  expect(tree.freshByProject).toEqual({ p2: 1 });
});

it("폴더 — 숫자만 다시 받을 때는 트리를 치우지도 디스크를 다시 읽지도 않는다. 실패·늦게 온 옛 응답은 버린다", async () => {
  mocks.projects.mockResolvedValue({ projects: [{ id: "p1", name: "P" }], unassigned: 0 });
  mocks.links.mockResolvedValue({ links: { p1: {} } });
  mocks.folder.mockRejectedValue(new Error("nas")); // 디스크는 못 읽는다 — 공유 기록의 폴더만 보인다
  mocks.counts.mockResolvedValue({ counts: { p1: { "e070/c1": 1 } } }); // 상태별 개수를 안 주는 서버
  render(<TreeHarness />);
  await flush();
  await flush();
  const count = () => tree.tree.roots[0].children![0];
  expect(count()).toMatchObject({ count: 1, reviewCounts: null }); // 추정하지 않는다 — '전체 N'으로 보인다
  expect(mocks.fresh).not.toHaveBeenCalled(); // 기준선이 없으면(공유 & 리뷰에 들어간 적 없음) 새 항목을 묻지 않는다

  const slow = deferred<unknown>();
  mocks.counts.mockReturnValueOnce(slow.promise);
  act(() => tree.reloadCounts());
  expect(tree.tree.state).toBe("ready"); // 받는 동안에도 트리는 그대로 보인다
  mocks.counts.mockResolvedValueOnce({ counts: { p1: { "e070/c1": 5 } }, review_counts: { p1: { "e070/c1": { final: 2, held: 0, shared: 3 } } } });
  act(() => tree.reloadCounts());
  await flush();
  expect(count()).toMatchObject({ count: 5, reviewCounts: { final: 2, held: 0, shared: 3 } });
  slow.resolve({ counts: { p1: { "e070/c1": 9 } } }); // 먼저 떠난 조회가 늦게 왔다
  await flush();
  expect(count().count).toBe(5);

  mocks.counts.mockRejectedValueOnce(new Error("HTTP 502"));
  act(() => tree.reloadCounts());
  await flush();
  expect(count().count).toBe(5); // 실패하면 마지막 숫자를 둔다
  expect(mocks.folder).toHaveBeenCalledTimes(1);
  expect(mocks.projects).toHaveBeenCalledTimes(1);
});

it("폴더 — 트리를 처음 받는 사이에 먼저 도착한 '숫자만 다시 받기'의 숫자를 늦게 끝난 트리 조회가 덮지 않는다", async () => {
  mocks.projects.mockResolvedValue({ projects: [{ id: "p1", name: "P" }], unassigned: 0 });
  mocks.links.mockResolvedValue({ links: {} });
  const first = deferred<unknown>();
  mocks.counts.mockReturnValueOnce(first.promise); // 트리 조회의 숫자 — 늦게 온다
  render(<TreeHarness />);
  await flush();
  await flush();
  expect(tree.tree.state).toBe("loading");
  mocks.counts.mockResolvedValueOnce({ counts: { p1: { "e070/c1": 5, "e070/c9": 1 } } });
  act(() => tree.reloadCounts()); // 그사이 생성물이 바뀌었다는 알림
  await flush();
  first.resolve({ counts: { p1: { "e070/c1": 1 } } });
  await flush();
  expect(tree.tree.state).toBe("ready");
  expect(tree.tree.roots[0].children!.map((node) => [node.name, node.count])).toEqual([["c1", 5], ["c9", 1]]);
});

it("폴더 — 먼저 떠난 트리 조회가 늦게 실패해도 그사이 받은 숫자와 폴더를 지우지 않는다. 못 받은 트리는 다음 알림 때 처음부터 다시 받는다", async () => {
  mocks.projects.mockResolvedValue({ projects: [{ id: "p1", name: "P" }], unassigned: 0 });
  mocks.links.mockResolvedValue({ links: {} });
  const first = deferred<unknown>();
  mocks.counts.mockReturnValueOnce(first.promise);
  render(<TreeHarness />);
  await flush();
  await flush();
  mocks.counts.mockResolvedValueOnce({ counts: { p1: { "e070/c1": 5 } } });
  act(() => tree.reloadCounts());
  await flush();
  first.reject(new Error("HTTP 502")); // 처음 조회가 이제야 실패한다
  await flush();
  expect(tree.tree.state).toBe("ready");
  expect(tree.tree.note).toBeNull();
  expect(tree.tree.roots[0].children!.map((node) => [node.name, node.count])).toEqual([["c1", 5]]);

  act(() => root.unmount()); // 이번에는 아무것도 못 받은 채로 끝난다
  root = createRoot(host);
  mocks.counts.mockRejectedValueOnce(new Error("HTTP 502"));
  render(<TreeHarness />);
  await flush();
  await flush();
  expect(tree.tree.state).toBe("error");
  mocks.counts.mockResolvedValue({ counts: { p1: { "e070/c1": 2 } } });
  act(() => tree.reloadCounts()); // 생성물이 바뀌었다는 알림 — 숫자만으로는 못 살리니 처음부터 다시 받는다
  await flush();
  await flush();
  expect(tree.tree.state).toBe("ready");
  expect(tree.tree.roots[0].children![0].count).toBe(2);
});

it("폴더 — 공간을 A→B→A 로 오갈 때 처음 A 의 늦은 답이 새 항목(+N)을 덮지 않는다", async () => {
  seenBase.value = "2026-10-01 00:00:00";
  mocks.projects.mockResolvedValue({ projects: [{ id: "p1", name: "P" }], unassigned: 0 });
  mocks.links.mockResolvedValue({ links: {} });
  mocks.counts.mockResolvedValue({ counts: { p1: { "e070/c1": 3 } } });
  const item = (id: string) => ({ id, project_id: "p1", folder_path: "e070/c1", shared_at: "2099-01-01 00:00:00", ack_key: id });
  const oldA = deferred<unknown[]>();
  mocks.fresh.mockReturnValueOnce(oldA.promise).mockResolvedValueOnce([]).mockResolvedValueOnce([item("x1"), item("x2")]);
  render(<TreeHarness />);
  await flush();
  render(<TreeHarness workspace={{ scope: "team", id: "w2", name: "B" }} />);
  await flush();
  render(<TreeHarness />);
  await flush();
  await flush();
  expect(tree.freshByProject).toEqual({ p1: 2 });
  oldA.resolve([item("x1")]); // 처음 A 의 답이 이제야 온다
  await flush();
  expect(tree.freshByProject).toEqual({ p1: 2 });
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
