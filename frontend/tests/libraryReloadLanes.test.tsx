// @vitest-environment jsdom
// 목록 다시 받기의 두 줄(2026-10-07) — 목록 줄은 목록 구간까지만 잡고, 메타(통계·태그·폴더)는 따로 줄을 선다.
//  지키는 것: 다음 목록이 앞 실행의 메타를 기다리지 않는다 · 메타 묶음은 한 번에 하나 · 전체 메타 요구는 버려져도 다음 묶음이
//  이어받는다 · `await reload()` 는 맡긴 메타가 처리된 뒤에 풀린다 · 낡은 응답은 적용하지 않는다.
//  StrictMode 의 이중 effect 는 호출 수 세기를 흐리므로 여기서는 쓰지 않는다(listFolderPeek.test.tsx 가 StrictMode 로 본다).
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { folderPeekQuery } from "../src/lib/appGenerationQuery";
import { createLibraryMutationOrigin, decideLibrarySync, markMutationDomainsSucceeded } from "../src/lib/librarySync";
import type { GenerationLocation } from "../src/lib/resolveLibraryLocation";
import { useGenerationLibraryData } from "../src/lib/useGenerationLibraryData";
import type { Filters, GenQuery, Generation } from "../src/types";

vi.mock("../src/api", () => ({ GEN_PAGE: 200, api: {
  listGenerations: vi.fn(), projects: vi.fn(), facets: vi.fn(), generationStats: vi.fn(), listTrash: vi.fn(), locateGenerations: vi.fn(),
} }));

type Props = {
  query: GenQuery; authReady?: boolean; projectWorkspaceId?: string;
  composeListEnabled?: boolean; // 캔버스의 '폴더 보기' 창이 열려 있다
  auto?: boolean; // false = 조회를 시험이 직접 부른다
};
const MAIN: GenQuery = { tab: "my", search: "cat" };
const LOCATED: GenQuery = { tab: "my", project_id: "project-b", folder_path: "e001/c0010" };
const gen = (id: string) => ({
  id, sort_ts: 10, status: "done", project_id: "project-b", folder_path: "e001/c0010", assets: [], tags: [], auto_tags: [],
}) as unknown as Generation;
const mainRows = [gen("m1"), gen("m2")];
const folderRows = [gen("f1")];
const locationOf = (item: Generation): GenerationLocation => ({
  items: [item], focus_ids: [item.id], project_id: "project-b", folder_path: "e001/c0010",
});

let root: Root;
let host: HTMLDivElement;
let data: ReturnType<typeof useGenerationLibraryData>;
let clock: ReturnType<typeof vi.spyOn> | null = null;
const flash = vi.fn();
function Harness({ query, authReady = true, projectWorkspaceId, composeListEnabled, auto = true }: Props) {
  const filters: Filters = { tab: query.tab };
  data = useGenerationLibraryData({ authReady, filters, genQuery: query, flash, projectWorkspaceId, composeListEnabled });
  const key = JSON.stringify(query);
  // App 과 같은 배선 — 조회 조건·탭·인증이 바뀌면 신선도 확인을 거쳐 다시 받는다.
  useEffect(() => { if (auto) void data.reloadIfStale(); }, [auto, key, authReady, data.reloadIfStale]);
  return null;
}
const show = (props: Props) => act(() => root.render(<Harness {...props} />));
const settle = async () => { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
const mount = async (props: Props = { query: MAIN }) => { show(props); await settle(); };
const ids = () => data.gens.map((g) => g.id);
const calls = () => ({
  list: vi.mocked(api.listGenerations).mock.calls.length, stats: vi.mocked(api.generationStats).mock.calls.length,
  facets: vi.mocked(api.facets).mock.calls.length, projects: vi.mocked(api.projects).mock.calls.length,
});
const folders = (unassigned: number) => ({ projects: [], unassigned });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
// 다음 한 번의 요청을 멈춰 둔다
const hold = <T,>(call: unknown) => {
  const held = deferred<T>();
  vi.mocked(call as () => Promise<T>).mockReturnValueOnce(held.promise);
  return held;
};
const start = (request: () => Promise<void>) => {
  const state = { done: false };
  act(() => { void request().then(() => { state.done = true; }); });
  return state;
};
const spyNow = (at: number) => (clock = vi.spyOn(Date, "now").mockReturnValue(at));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const call of Object.values(api)) vi.mocked(call as () => unknown).mockReset(); // 안 쓰고 남은 '한 번' 응답까지 지운다
  flash.mockReset();
  vi.mocked(api.listGenerations).mockImplementation(async (query) => (query.folder_path && query.project_id === "p1" ? folderRows : mainRows));
  vi.mocked(api.projects).mockResolvedValue(folders(0) as never);
  vi.mocked(api.facets).mockResolvedValue({ tags: [], auto_tags: [], models: [] } as never);
  vi.mocked(api.generationStats).mockResolvedValue({ failed_count: 0, has_unread: false } as never);
  vi.mocked(api.locateGenerations).mockResolvedValue(null as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clock?.mockRestore();
  clock = null;
});

it("목록과 메타는 같은 순간에 출발한다 — 메타 줄이 비어 있으면 목록 왕복을 기다리지 않는다", async () => {
  await mount();
  const list = hold<Generation[]>(api.listGenerations);
  const before = calls();
  act(() => { void data.reload(); });
  expect(calls()).toEqual({ list: before.list + 1, stats: before.stats + 1, facets: before.facets + 1, projects: before.projects + 1 });
  await act(async () => { list.resolve(mainRows); });
  await settle();
});

it("다음 목록은 앞 실행의 메타를 기다리지 않고 출발한다 — 메타 묶음은 앞 묶음이 끝난 뒤에 나간다", async () => {
  await mount();
  const slowMeta = hold(api.projects);
  const first = start(() => data.reload());
  await settle();
  expect(first.done).toBe(false); // 목록은 적용됐지만 메타가 아직 — 이 호출의 약속은 안 풀렸다
  const before = calls();
  const second = start(() => data.reload());
  expect(calls().list).toBe(before.list + 1); // 곧바로
  await settle();
  expect(calls()).toEqual({ ...before, list: before.list + 1 }); // 메타 묶음은 한 번에 하나
  expect(second.done).toBe(false);
  vi.mocked(api.projects).mockResolvedValueOnce(folders(7) as never);
  await act(async () => { slowMeta.resolve(folders(99)); });
  await settle();
  expect(calls()).toMatchObject({ facets: before.facets + 1, projects: before.projects + 1 });
  expect(data.unassignedCount).toBe(7); // 앞 묶음(99)은 낡아서 버리고 뒤 묶음을 적용했다
  expect([first.done, second.done]).toEqual([true, true]);
});

it("앞 실행의 목록이 아직 안 왔으면 한 줄로 선다 — 여러 번 불러도 다음 실행은 하나로 합쳐지고 강한 쪽을 따른다", async () => {
  await mount();
  const slowList = hold<Generation[]>(api.listGenerations);
  const before = calls();
  const waiting = [start(() => data.reload()), start(() => data.reload(true, true)), start(() => data.reload(true))];
  await settle();
  expect(calls().list).toBe(before.list + 1);
  await act(async () => { slowList.resolve(mainRows); });
  await settle();
  expect(calls()).toMatchObject({ list: before.list + 2, facets: before.facets + 2 }); // 합쳐진 실행은 전체 조회
  expect(waiting.map((call) => call.done)).toEqual([true, true, true]);
});

it("낡은 실행도 목록이 도착하면 줄을 넘긴다 — 다음 실행이 그 실행의 메타를 기다리지 않는다", async () => {
  await mount();
  const listA = hold<Generation[]>(api.listGenerations);
  const metaA = hold(api.projects);
  const a = start(() => data.reload()); // A: 목록도 메타도 멈춤
  const b = start(() => data.reload()); // B: A 를 낡게 하고 뒤에 선다
  const before = calls();
  await act(async () => { listA.resolve(mainRows); });
  await settle();
  expect(calls().list).toBe(before.list + 1); // B 출발 — A 의 메타는 아직 멈춰 있다
  expect(ids()).toEqual(["m1", "m2"]);
  expect([a.done, b.done]).toEqual([false, false]);
  await act(async () => { metaA.resolve(folders(0)); });
  await settle();
  expect([a.done, b.done]).toEqual([true, true]);
});

it("로그인 전에 부른 조회는 줄을 잡지 않는다 — 로그인 뒤의 조회가 막히지 않는다", async () => {
  await mount({ query: MAIN, authReady: false });
  await act(async () => { await data.reload(); });
  expect(calls().list).toBe(0);
  show({ query: MAIN, authReady: true });
  await settle();
  expect(ids()).toEqual(["m1", "m2"]);
});

it("메타 차례를 기다리던 전체 요구는 가벼운 요청이 뒤따라와도 사라지지 않는다", async () => {
  await mount();
  const metaA = hold(api.projects);
  act(() => { void data.reload(); }); // A: 목록 적용, 메타는 멈춤
  await settle();
  const listB = hold<Generation[]>(api.listGenerations);
  const b = start(() => data.reload(false, false)); // B 전체: 목록은 출발했고 메타는 A 뒤에 선다
  const c = start(() => data.reload(true, true)); // C 가벼움: B 의 목록 뒤에 선다
  await act(async () => { listB.resolve(mainRows); }); // B 는 낡았다 → C 출발
  await settle();
  const before = calls();
  expect([b.done, c.done]).toEqual([false, false]); // 맡긴 메타가 처리되기 전에는 안 풀린다
  vi.mocked(api.projects).mockResolvedValueOnce(folders(5) as never);
  await act(async () => { metaA.resolve(folders(99)); });
  await settle();
  expect(calls()).toMatchObject({ facets: before.facets + 1, projects: before.projects + 1 }); // 전체로 한 번 더
  expect(data.unassignedCount).toBe(5);
  expect([b.done, c.done]).toEqual([true, true]);
});

it("전체 메타가 보낸 직후 다음 실행에 밀려 버려져도 그다음 묶음이 전체로 나간다", async () => {
  await mount();
  const metaA = hold(api.projects);
  act(() => { void data.reload(); }); // A
  await settle();
  const listB = hold<Generation[]>(api.listGenerations);
  act(() => { void data.reload(false, false); }); // B 전체: 목록이 느리다
  const c = start(() => data.reload(true, true)); // C 가벼움: B 의 목록 뒤
  const metaB = hold(api.projects);
  await act(async () => { metaA.resolve(folders(99)); }); // 못 보냈던 전체 묶음이 지금 출발한다
  await settle();
  const before = calls();
  await act(async () => { listB.resolve(mainRows); }); // C 출발 — seq 가 올라 방금 보낸 묶음이 낡는다
  await settle();
  vi.mocked(api.projects).mockResolvedValueOnce(folders(5) as never);
  await act(async () => { metaB.resolve(folders(98)); });
  await settle();
  expect(calls()).toMatchObject({ facets: before.facets + 1, projects: before.projects + 1 }); // C 는 가볍지만 묶음은 전체
  expect(data.unassignedCount).toBe(5);
  expect(c.done).toBe(true);
});

it("버려진 전체 메타는 스스로 다시 나가지 않는다 — 다음 요청이 가벼워도 그때 전체로 갚는다", async () => {
  await mount();
  const meta = hold(api.projects);
  act(() => { void data.reload(); });
  await settle();
  act(() => { data.beginComposeList(); }); // seq 만 오른다 — 뒤따르는 요청이 없다
  const before = calls();
  await act(async () => { meta.resolve(folders(99)); });
  await settle();
  expect(calls()).toEqual(before);
  expect(data.unassignedCount).toBe(0);
  vi.mocked(api.projects).mockResolvedValueOnce(folders(4) as never);
  await act(async () => { await data.reload(true, true); });
  expect(calls()).toMatchObject({ facets: before.facets + 1, projects: before.projects + 1 });
  expect(data.unassignedCount).toBe(4);
});

it("이미 줄을 넘긴 옛 실행의 종료는 그 뒤에 출발한 실행의 줄과 스피너를 건드리지 않는다", async () => {
  await mount();
  const metaA = hold(api.projects);
  act(() => { void data.reload(); }); // A
  await settle();
  const listB = hold<Generation[]>(api.listGenerations);
  act(() => { void data.reload(); }); // B: 목록 진행 중(스피너 켜짐)
  await act(async () => { metaA.resolve(folders(0)); }); // A 가 완전히 끝난다
  await settle();
  expect(data.loading).toBe(true);
  const before = calls();
  const c = start(() => data.reload()); // C 는 B 뒤에 서야 한다
  await settle();
  expect(calls().list).toBe(before.list);
  await act(async () => { listB.resolve(mainRows); });
  await settle();
  expect(calls().list).toBe(before.list + 1);
  expect(c.done).toBe(true);
  expect(data.loading).toBe(false);
});

it("목록이 실패해도 줄은 넘어가고 메타는 처리된다 — 살아 있는 실행의 실패만 화면에 남는다", async () => {
  await mount();
  const meta = hold(api.projects);
  vi.mocked(api.listGenerations).mockRejectedValueOnce(new Error("offline"));
  const failed = start(() => data.reload());
  await settle();
  expect(data.loadError).toBe("offline");
  expect(flash).toHaveBeenCalledWith("로드 실패: Error: offline");
  expect(failed.done).toBe(false); // 메타가 아직
  const before = calls();
  act(() => { void data.reload(); }); // 실패한 실행의 메타를 기다리지 않고 다시 받는다
  expect(calls().list).toBe(before.list + 1);
  await act(async () => { meta.resolve(folders(0)); });
  await settle();
  expect(failed.done).toBe(true);
  expect(data.loadError).toBeNull();
  expect(ids()).toEqual(["m1", "m2"]);

  // 이미 낡은 실행의 실패 — 화면에 남기지 않는다
  flash.mockClear();
  const late = hold<Generation[]>(api.listGenerations);
  const stale = start(() => data.reload());
  const next = start(() => data.reload());
  await act(async () => { late.reject(new Error("too late")); });
  await settle();
  expect(flash).not.toHaveBeenCalled();
  expect(data.loadError).toBeNull();
  expect([stale.done, next.done]).toEqual([true, true]);
  expect(ids()).toEqual(["m1", "m2"]);
});

it("메타가 실패해도 줄은 풀린다 — 실패한 것만 빠지고, 실패했다고 다음 묶음을 전체로 올리지 않는다", async () => {
  await mount();
  vi.mocked(api.facets).mockRejectedValueOnce(new Error("500"));
  vi.mocked(api.projects).mockResolvedValueOnce(folders(2) as never);
  await act(async () => { await data.reload(); }); // 태그만 실패
  expect(data.unassignedCount).toBe(2);
  const before = calls();
  await act(async () => { await data.reload(true, true); });
  expect(calls()).toMatchObject({ facets: before.facets, projects: before.projects }); // 기존 오류 정책 그대로 — 다시 받지 않는다
  for (const call of [api.generationStats, api.facets, api.projects]) vi.mocked(call as () => Promise<never>).mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await data.reload(); }); // 전부 실패
  expect(data.unassignedCount).toBe(2);
  await act(async () => { await data.reload(); }); // 다음 조회는 살아 있다
  expect(calls().projects).toBe(before.projects + 2);
});

it("메타 차례를 기다리는 사이 로그인이 풀리면 못 보낸 요구는 보내지 않는다 — 기다리던 호출은 풀리고 줄도 다시 쓸 수 있다", async () => {
  await mount();
  const metaA = hold(api.projects);
  act(() => { void data.reload(); });
  await settle();
  const b = start(() => data.reload()); // 메타는 A 뒤에서 기다린다
  await settle();
  show({ query: MAIN, authReady: false });
  const before = calls();
  await act(async () => { metaA.resolve(folders(99)); });
  await settle();
  expect(calls()).toEqual(before); // 인증 없이 아무것도 보내지 않았다
  expect(b.done).toBe(true);
  expect(data.unassignedCount).toBe(0); // 옛 응답도 적용하지 않는다
  show({ query: MAIN, authReady: true }); // 다시 로그인 → 조회
  await settle();
  expect(calls().projects).toBe(before.projects + 1);
});

it("못 보낸 메타 요구는 보내는 순간의 탭·공간으로 나간다 — 옛 문맥의 인자로 보내지 않는다", async () => {
  await mount({ query: MAIN, projectWorkspaceId: "ws-a" });
  const metaA = hold(api.projects);
  act(() => { void data.reload(); });
  await settle();
  show({ query: { tab: "team" }, projectWorkspaceId: "ws-b" }); // 탭·공간이 바뀐다 → 새 문맥의 조회(메타는 A 뒤에 선다)
  await settle();
  vi.mocked(api.projects).mockResolvedValueOnce(folders(3) as never);
  await act(async () => { metaA.resolve(folders(99)); });
  await settle();
  expect(vi.mocked(api.projects).mock.calls.at(-1)).toEqual(["team", false, "ws-b"]);
  expect(vi.mocked(api.facets).mock.calls.at(-1)).toEqual(["team"]);
  expect(data.unassignedCount).toBe(3);
});

it("통계 10초 간격은 실제로 받은 때부터 잰다 — 통계를 건너뛴 가벼운 조회가 시계를 미루지 않는다", async () => {
  const now = spyNow(1_000_000);
  await mount(); // 전체 조회 — 통계를 받았다
  const before = calls();
  for (const at of [3_000, 6_000, 9_000]) {
    now.mockReturnValue(1_000_000 + at);
    await act(async () => { await data.reload(true, true); });
    expect(calls().stats).toBe(before.stats);
  }
  now.mockReturnValue(1_010_001);
  await act(async () => { await data.reload(true, true); });
  expect(calls()).toMatchObject({ stats: before.stats + 1, facets: before.facets }); // 가벼운 조회는 태그·폴더를 받지 않는다
});

it("통계를 받을지는 메타가 실제로 출발하는 때에 정한다", async () => {
  const now = spyNow(1_000_000);
  await mount(); // 통계 시계 = 0초
  show({ query: { tab: "compose" }, auto: false });
  const held = hold(api.projects);
  now.mockReturnValue(1_001_000);
  act(() => { void data.reload(true, true); }); // 캔버스의 가벼운 조회 — 폴더만 받는다(멈춤)
  show({ query: MAIN, auto: false });
  now.mockReturnValue(1_005_000);
  const before = calls();
  act(() => { void data.reload(true, true); }); // 5초 — 지금 정하면 통계는 아직 이르다
  await settle();
  expect(calls().stats).toBe(before.stats);
  now.mockReturnValue(1_012_000);
  await act(async () => { held.resolve(folders(0)); }); // 12초에야 차례가 온다
  await settle();
  expect(calls().stats).toBe(before.stats + 1);
});

it("silent 실행이 앞 실행의 스피너를 이어받으면 자기 목록이 끝날 때 내린다 — 약속은 메타까지 처리된 뒤에 풀린다", async () => {
  await mount();
  const listA = hold<Generation[]>(api.listGenerations);
  act(() => { void data.reload(); }); // A: 스피너 켬
  await settle();
  expect(data.loading).toBe(true);
  const metaB = hold(api.projects);
  const b = start(() => data.reload(true)); // B: silent — A 를 낡게 하고 뒤에 선다
  await act(async () => { listA.resolve(mainRows); });
  await settle();
  expect(data.loading).toBe(false); // B 의 목록이 끝났다
  expect(b.done).toBe(false); // B 의 메타는 아직
  await act(async () => { metaB.resolve(folders(8)); });
  await settle();
  expect(b.done).toBe(true);
  expect(data.unassignedCount).toBe(8);
});

it("가벼운 조회의 약속도 자기가 맡긴 메타가 처리된 뒤에 풀린다", async () => {
  const now = spyNow(1_000_000);
  await mount();
  now.mockReturnValue(1_020_000); // 통계를 다시 받을 때가 됐다
  const stats = hold(api.generationStats);
  const poll = start(() => data.reload(true, true));
  await settle();
  expect(poll.done).toBe(false);
  await act(async () => { stats.resolve({ failed_count: 4, has_unread: true }); });
  await settle();
  expect(poll.done).toBe(true);
  expect(data.stats.failed_count).toBe(4);
});

it("메타가 목록보다 먼저 오면 먼저 적용된다 — 그 결과로 조회 조건이 바뀌면 늦게 온 옛 목록은 버린다", async () => {
  const late = hold<Generation[]>(api.listGenerations);
  vi.mocked(api.projects).mockResolvedValueOnce({ projects: [{ id: "alive" }], unassigned: 1 } as never);
  await mount({ query: { tab: "my", project_id: "gone" } });
  expect(data.projects.map((project) => project.id)).toEqual(["alive"]); // 목록은 아직 — 폴더가 먼저 보인다
  expect(data.projectsLoadedRef.current).toBe(true);
  show({ query: { tab: "my" } }); // App: 없어진 프로젝트 필터를 푼다 → 새 조건으로 조회
  await act(async () => { late.resolve([gen("row-of-gone-project")]); });
  await settle();
  expect(ids()).toEqual(["m1", "m2"]);
  expect(vi.mocked(api.listGenerations).mock.calls.at(-1)![0]).toEqual({ tab: "my" });
});

it("위치 확인만 늦어도 목록 구간이다 — 그동안 다음 실행은 줄을 선다", async () => {
  await mount({ query: LOCATED });
  const location = locationOf(gen("outside-page"));
  const check = hold<GenerationLocation>(api.locateGenerations);
  act(() => { data.revealLocated("my", location); }); // 목록 밖 대상 → 정상 페이지와 함께 위치를 다시 확인한다
  await settle();
  const before = calls();
  const next = start(() => data.reload());
  await settle();
  expect(calls().list).toBe(before.list);
  await act(async () => { check.resolve(location); });
  await settle();
  expect(calls().list).toBe(before.list + 1);
  expect(next.done).toBe(true);
});

it("메타가 아직 떠 있는 동안에는 위치 표시가 정상 페이지를 재사용하지 않는다", async () => {
  await mount({ query: LOCATED });
  const location = locationOf(mainRows[0]);
  vi.mocked(api.locateGenerations).mockResolvedValue(location);
  let before = calls();
  act(() => { data.revealLocated("my", location); }); // 대조: 조용할 때는 신선한 페이지를 재사용한다
  await settle();
  expect(calls().list).toBe(before.list);
  const meta = hold(api.projects);
  act(() => { void data.reload(); });
  await settle(); // 목록은 적용됐고 메타만 멈춰 있다
  before = calls();
  act(() => { data.revealLocated("my", location); });
  await settle();
  expect(calls().list).toBe(before.list + 1);
  await act(async () => { meta.resolve(folders(0)); });
  await settle();
});

it("캔버스(목록 없음): 메타가 멈춘 사이 연달아 불러도 모두 풀리고, 그 뒤의 요청도 정상으로 나간다", async () => {
  const held = hold(api.projects);
  await mount({ query: { tab: "compose" }, projectWorkspaceId: "ws-a" }); // 첫 조회의 폴더가 멈춘다
  const b = start(() => data.reload());
  const c = start(() => data.reload(true, true));
  await settle();
  expect(api.projects).toHaveBeenCalledTimes(1); // 메타 묶음은 하나 — 나머지는 합쳐져 뒤에 선다
  vi.mocked(api.projects).mockResolvedValueOnce(folders(6) as never);
  await act(async () => { held.resolve(folders(99)); });
  await settle();
  expect([b.done, c.done]).toEqual([true, true]);
  expect(api.projects).toHaveBeenCalledTimes(2);
  expect(api.projects).toHaveBeenLastCalledWith("my", false, "ws-a");
  expect(data.unassignedCount).toBe(6);
  expect(api.listGenerations).not.toHaveBeenCalled(); // 캔버스는 목록도
  expect(api.generationStats).not.toHaveBeenCalled(); //  통계도 받지 않는다
  const before = calls();
  await act(async () => { await data.reload(true, true); }); // 줄이 막혀 있지 않다 — 가벼운 요청은 폴더만 받는다
  expect(calls()).toEqual({ ...before, projects: before.projects + 1 });
});

it("캔버스: 폴더·태그를 받는 중에 '폴더 보기' 창을 열면 목록이 그것을 기다리지 않고 출발한다", async () => {
  const held = hold(api.projects);
  await mount({ query: { tab: "compose" } }); // 캔버스의 조회 — 폴더가 멈춘다
  show({ query: { tab: "compose" }, composeListEnabled: true });
  act(() => { void data.reload(); });
  expect(calls().list).toBe(1);
  await settle();
  expect(ids()).toEqual(["m1", "m2"]);
  await act(async () => { held.resolve(folders(0)); });
  await settle();
});

it("캔버스: 메타가 전부 실패하면 '내 변경을 반영했다'고 표시하지 않는다", async () => {
  const origin = createLibraryMutationOrigin("POST")!;
  markMutationDomainsSucceeded(origin, origin.mutation_id, ["library"]);
  vi.mocked(api.projects).mockRejectedValue(new Error("offline"));
  vi.mocked(api.facets).mockRejectedValue(new Error("offline"));
  await mount({ query: { tab: "compose" } });
  expect(decideLibrarySync([origin])).toBe("reload"); // 반영하지 못했다 — 알림이 오면 다시 받는다
  vi.mocked(api.projects).mockResolvedValue(folders(0) as never);
  await act(async () => { await data.reload(); });
  expect(decideLibrarySync([origin])).toBe("skip");
});

it("캔버스 조회가 메타 차례를 기다리는 사이 탭이 바뀌어도, 통계만 받은 것으로 '내 변경을 반영했다'고 표시하지 않는다", async () => {
  const held = hold(api.projects);
  await mount({ query: { tab: "compose" } }); // A: 캔버스 조회의 폴더가 멈춘다
  const origin = createLibraryMutationOrigin("POST")!;
  markMutationDomainsSucceeded(origin, origin.mutation_id, ["library"]);
  act(() => { void data.reload(); }); // B: 캔버스 조회 — 내 변경을 덮을 차례를 기다린다
  vi.mocked(api.listGenerations).mockRejectedValueOnce(new Error("offline"));
  show({ query: MAIN }); // 목록 탭으로 — C 의 목록은 실패한다
  await settle();
  vi.mocked(api.facets).mockRejectedValueOnce(new Error("offline"));
  vi.mocked(api.projects).mockRejectedValueOnce(new Error("offline"));
  const before = calls();
  await act(async () => { held.resolve(folders(99)); }); // 합쳐진 메타가 목록 탭 계획으로 나간다 — 통계만 성공
  await settle();
  expect(calls()).toEqual({ ...before, stats: before.stats + 1, facets: before.facets + 1, projects: before.projects + 1 });
  expect(decideLibrarySync([origin])).toBe("reload"); // 목록도 태그·폴더도 못 받았다
});

it("낡은 실행은 목록이 도착하면 곧바로 동기화 표식을 내려놓는다 — 메타가 느려도 '기다림'으로 붙잡지 않는다", async () => {
  await mount();
  const origin = createLibraryMutationOrigin("POST")!;
  markMutationDomainsSucceeded(origin, origin.mutation_id, ["library"]);
  const list = hold<Generation[]>(api.listGenerations);
  const meta = hold(api.projects);
  act(() => { void data.reload(); });
  expect(decideLibrarySync([origin])).toBe("wait"); // 이 조회가 내 변경을 덮을 것이다
  act(() => { data.beginComposeList(); }); // 이 조회는 낡았다(뒤따르는 조회 없음)
  await act(async () => { list.resolve(mainRows); });
  await settle();
  expect(decideLibrarySync([origin])).toBe("reload"); // 메타는 아직 멈춰 있지만 표식은 내려갔다
  await act(async () => { meta.resolve(folders(0)); });
  await settle();
});

it("폴더 창: 여는 조회의 메타가 멈춰 있어도, 닫으면 본 목록이 곧바로 다시 오고 잠금이 풀린다", async () => {
  const FOLDER = folderPeekQuery(MAIN, { projectId: "p1", path: "e035/c0010" });
  await mount();
  const openMeta = hold(api.projects);
  act(() => { data.beginComposeList({ keep: "main" }); root.render(<Harness query={FOLDER} />); }); // 열기
  await settle();
  expect(ids()).toEqual(["f1"]);
  act(() => { data.beginComposeList({ restore: "main" }); root.render(<Harness query={MAIN} />); }); // 닫기
  expect(data.staleList).toBe(true); // 옛 첫 쪽이 먼저 보이고 조작은 잠긴다
  await settle();
  expect(ids()).toEqual(["m1", "m2"]);
  expect(data.staleList).toBe(false); // 새 목록이 왔다 — 여는 조회의 메타는 아직 멈춰 있다
  expect(data.loading).toBe(false);
  await act(async () => { openMeta.resolve(folders(0)); });
  await settle();
});
