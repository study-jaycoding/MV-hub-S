// @vitest-environment jsdom
// 목록 탭의 '폴더 보기' 창(카드의 폴더 이름표, 2026-10-07) — 조회 조건과, 열고 닫을 때 목록을 비우고 다시 받는 약속.
// 창 자체(App 배선)는 resolveSelectionRender.test.tsx 의 "App … 폴더 이름표" 시험이 본다.
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { folderPeekQuery } from "../src/lib/appGenerationQuery";
import { useGenerationLibraryData } from "../src/lib/useGenerationLibraryData";
import type { Filters, GenQuery, Generation } from "../src/types";

vi.mock("../src/api", () => ({ GEN_PAGE: 200, api: {
  listGenerations: vi.fn(), projects: vi.fn(), facets: vi.fn(), generationStats: vi.fn(), listTrash: vi.fn(), locateGenerations: vi.fn(),
} }));

const FILTERS: Filters = { tab: "my" };
const MAIN: GenQuery = { tab: "my", search: "cat" };
const FOLDER = folderPeekQuery(MAIN, { projectId: "p1", path: "e035/c0010" });
const gen = (id: string) => ({ id, sort_ts: 10, status: "done", assets: [], tags: [], auto_tags: [] }) as unknown as Generation;
const mainRows = [gen("m1"), gen("m2")];
const folderRows = [gen("f1")];

let root: Root;
let host: HTMLDivElement;
let data: ReturnType<typeof useGenerationLibraryData>;
const flash = () => {}; // App 처럼 고정된 함수 — 렌더마다 새 함수면 reload 계열이 매번 새로 만들어져 아래 effect 가 렌더마다 다시 돈다
function Harness({ query, filters = FILTERS, authKey = "", workspaceScopeKey = "" }: {
  query: GenQuery; filters?: Filters; authKey?: string; workspaceScopeKey?: string;
}) {
  data = useGenerationLibraryData({ authReady: true, authKey, filters, genQuery: query, flash, workspaceScopeKey });
  const key = JSON.stringify(query);
  // App 과 같은 배선 — 조회 조건(또는 보는 공간)이 바뀌면 신선도 확인을 거쳐 다시 받는다.
  useEffect(() => { void data.reloadIfStale(); }, [key, data.reloadIfStale, workspaceScopeKey]);
  return null;
}
const render = (query: GenQuery, filters?: Filters, authKey?: string, workspaceScopeKey?: string) =>
  root.render(<StrictMode><Harness query={query} filters={filters} authKey={authKey} workspaceScopeKey={workspaceScopeKey} /></StrictMode>);
const settle = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
const ids = () => data.gens.map((g) => g.id);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const rowsFor = (query: GenQuery) => (query.folder_path ? folderRows : mainRows);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(api.listGenerations).mockImplementation(async (query) => rowsFor(query));
  vi.mocked(api.projects).mockResolvedValue({ projects: [], unassigned: 0 } as never);
  vi.mocked(api.facets).mockResolvedValue({ tags: [], auto_tags: [], models: [] } as never);
  vi.mocked(api.generationStats).mockResolvedValue({ failed_count: 0, has_unread: false } as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("the folder window follows only tab, workspace scope and the conditions its toolbar shows", () => {
  const main: GenQuery = {
    tab: "team", workspace_ids: ["ws-b", "ws-a"], project_id: "p-main", folder_path: "main/dir",
    search: "cat", creator_uid: "u1", worker_id: "w1", share_dir: "d1", local_only: true, include_deleted: true, deleted_only: true,
    auto_tags: ["auto"], media_type: "video", colors: ["red"], tags: ["t"], review_filter: "held", comment_only: true, final_only: true,
  };
  // 창에서 안 보이는 조건(검색·작성자·자동 태그·휴지통 등)은 빠진다 — 따라오면 폴더에 있는 것이 말없이 빠진다
  expect(folderPeekQuery(main, { projectId: "p1", path: "e035/c0010" })).toStrictEqual({
    tab: "team", workspace_ids: ["ws-a", "ws-b"], project_id: "p1", folder_path: "e035/c0010",
    media_type: "video", colors: ["red"], tags: ["t"], review_filter: "held", comment_only: true, final_only: true,
  });
  // 프로젝트가 없는 폴더는 "none" — 생략하면 다른 프로젝트의 같은 이름 폴더가 섞인다
  expect(JSON.parse(JSON.stringify(folderPeekQuery({ tab: "my", workspace_scope: "personal" }, { projectId: null, path: "a" })))).toStrictEqual({
    tab: "my", workspace_scope: "personal", project_id: "none", folder_path: "a",
  });
});

it("after emptying, the list is fetched again even when the tab cache is fresh — opening then closing right away does not leave the main list empty", async () => {
  act(() => render(MAIN));
  await settle();
  expect(ids()).toEqual(["m1", "m2"]);

  // 열기: 비우고 → 조회 조건이 폴더로 바뀜. 폴더 응답은 아직 안 왔다.
  const slowFolder = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockImplementation((query) => (query.folder_path ? slowFolder.promise : Promise.resolve(mainRows)));
  act(() => { data.beginComposeList(); render(FOLDER); });
  expect(ids()).toEqual([]); // 본 목록 카드가 창에 비치지 않는다
  await settle();
  // 응답이 오기 전에 닫기: 비우고 → 조회 조건이 본 목록으로. 본 목록 캐시는 15초 안이라 '신선' 하다.
  const callsBeforeClose = vi.mocked(api.listGenerations).mock.calls.length;
  act(() => { data.beginComposeList(); render(MAIN); });
  await settle();
  await act(async () => { slowFolder.resolve(folderRows); });
  await settle();
  expect(ids()).toEqual(["m1", "m2"]); // 빈 채로 남지도, 늦은 폴더 응답이 들어오지도 않는다
  expect(vi.mocked(api.listGenerations).mock.calls.length).toBeGreaterThan(callsBeforeClose);
  expect(vi.mocked(api.listGenerations).mock.calls.at(-1)![0]).toMatchObject({ tab: "my", search: "cat" });
  expect(data.loading).toBe(false);
});

it("closing then reopening the same folder right away fetches it again instead of trusting the cache", async () => {
  act(() => render(MAIN));
  await settle();
  act(() => { data.beginComposeList(); render(FOLDER); });
  await settle();
  expect(ids()).toEqual(["f1"]);
  // 닫자마자(본 목록 응답 전에) 같은 폴더를 다시 연다 — 폴더 목록 캐시는 방금 받은 것이라 '신선' 하다
  const slowMain = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockImplementation((query) => (query.folder_path ? Promise.resolve(folderRows) : slowMain.promise));
  act(() => { data.beginComposeList(); render(MAIN); });
  await settle();
  act(() => { data.beginComposeList(); render(FOLDER); });
  await settle();
  await act(async () => { slowMain.resolve(mainRows); });
  await settle();
  expect(ids()).toEqual(["f1"]);
});

it("emptying drops the answers of a reload and of a next-page load that were still on their way", async () => {
  act(() => render(MAIN));
  await settle();
  await act(async () => { await data.reload(true); }); // 처음 조회 묶음이 다 끝난 뒤에 시작한다(대기 중인 조회는 비운 뒤의 조건으로 새로 돈다 — 버릴 대상이 아니다)
  const late = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockImplementation(() => late.promise);
  let reloading!: Promise<void>;
  act(() => { reloading = data.reload(true); });
  act(() => { data.beginComposeList(); });
  expect(ids()).toEqual([]);
  await act(async () => { late.resolve(mainRows); await reloading; });
  await settle();
  expect(ids()).toEqual([]); // 옛 조건의 카드가 비운 목록에 다시 들어오지 않는다

  // 다음 쪽을 받는 중에 비워도 같다
  vi.mocked(api.listGenerations).mockImplementation(async () => mainRows);
  await act(async () => { await data.reload(); });
  expect(ids()).toEqual(["m1", "m2"]);
  const latePage = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockImplementation(() => latePage.promise);
  let more!: Promise<void>;
  act(() => { more = data.loadMore(); });
  act(() => { data.beginComposeList(); });
  await act(async () => { latePage.resolve([gen("m3")]); await more; });
  await settle();
  expect(ids()).toEqual([]);
});

// ── 닫은 직후의 빈 화면 없애기(Jay 2026-10-07) — 열 때 본 목록의 첫 쪽을 담아 두고, 닫을 때 그것을 먼저 그린 뒤 반드시 다시 받는다 ──
const KEY = JSON.stringify(MAIN); // App 이 넘기는 '본 목록 조회의 키'
const openWindow = (keep = KEY) => act(() => { data.beginComposeList({ keep }); render(FOLDER); });
const closeWindow = (restore = KEY) => act(() => { data.beginComposeList({ restore }); render(MAIN); });
const listCalls = () => vi.mocked(api.listGenerations).mock.calls;

it("closing shows the kept first page at once and stays locked until the fresh first page is actually applied — even when it is identical", async () => {
  act(() => render(MAIN));
  await settle();
  openWindow();
  expect(ids()).toEqual([]); // 본 목록 카드가 창에 비치지 않는다
  expect(data.loading).toBe(true); // 비운 그 자리에서 '불러오는 중' — "항목이 없습니다"가 비치지 않게
  await settle();
  expect(ids()).toEqual(["f1"]);
  expect(data.staleList).toBe(false);

  const slowMain = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockImplementation((query) => (query.folder_path ? Promise.resolve(folderRows) : slowMain.promise));
  const callsBeforeClose = listCalls().length;
  closeWindow();
  expect(ids()).toEqual(["m1", "m2"]); // 빈 화면 없이 곧바로 옛 첫 쪽
  expect(data.staleList).toBe(true); // 그동안 화면은 조작을 막는다
  expect(data.hasMore).toBe(false); // 옛 커서로 다음 쪽을 받지 않는다
  await settle();
  expect(listCalls().length).toBe(callsBeforeClose + 1); // 첫 쪽을 반드시 다시 받는다
  expect(listCalls().at(-1)![0]).toMatchObject({ tab: "my", search: "cat" });
  expect(listCalls().at(-1)![1]).toBeNull(); // 첫 쪽(커서 없음)

  // 사본을 보이는 동안: 다음 쪽 요청 없음 · 실시간 갱신이 사본을 고쳐도 잠금은 그대로
  await act(async () => { await data.loadMore(); });
  expect(listCalls().length).toBe(callsBeforeClose + 1);
  act(() => data.setGens((prev) => prev.map((item) => ({ ...item }))));
  expect(data.staleList).toBe(true);

  await act(async () => { slowMain.resolve(mainRows); }); // 사본과 같은 내용
  await settle();
  expect(data.staleList).toBe(false);
  expect(ids()).toEqual(["m1", "m2"]);
  expect(data.loading).toBe(false);
});

it("keeps only the first page, and only a list it can vouch for — otherwise closing falls back to an empty loading list", async () => {
  // 첫 쪽만: 200장 + 다음 쪽 200장을 보던 목록(더 받을 것이 남아 있다)
  const firstPage = Array.from({ length: 200 }, (_, index) => gen(`p${index}`));
  const nextPage = Array.from({ length: 200 }, (_, index) => gen(`x${index}`));
  const folderPage = Array.from({ length: 200 }, (_, index) => gen(`f${index}`)); // 창의 목록도 꽉 찬 쪽(더 받을 것이 있다)
  vi.mocked(api.listGenerations).mockImplementation(async (query, cursor) => (query.folder_path ? folderPage : cursor ? nextPage : firstPage));
  act(() => render(MAIN));
  await settle();
  await act(async () => { await data.loadMore(); });
  expect(ids()).toHaveLength(400);
  expect(data.hasMore).toBe(true);
  openWindow();
  await settle();
  closeWindow();
  expect(ids()).toHaveLength(200);
  expect(ids()[199]).toBe("p199");
  expect(data.hasMore).toBe(false); // 사본을 보이는 동안은 다음 쪽이 없는 것으로 — 창의 '더 있음'이 본 목록에 남지 않는다
  await settle();
  expect(data.staleList).toBe(false);
  expect(data.hasMore).toBe(true); // 새 첫 쪽이 온 뒤에 이어 받는다

  // 창 안에서 툴바 필터를 바꿨다(본 목록 조회의 키가 달라졌다) → 사본을 쓰지 않는다
  openWindow();
  await settle();
  closeWindow("another-key");
  expect(ids()).toEqual([]);
  expect(data.staleList).toBe(false);
  expect(data.loading).toBe(true);
  await settle();

  // 필터를 막 바꿔 새 응답을 기다리는 중 — 화면의 카드는 옛 조건의 것이다. 그것을 새 키로 담으면 안 된다
  const OTHER: GenQuery = { tab: "my", search: "dog" };
  const slowOther = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockImplementation((query) => (query.folder_path ? Promise.resolve(folderRows) : query.search === "dog" ? slowOther.promise : Promise.resolve(firstPage)));
  act(() => render(OTHER));
  await settle();
  expect(ids()).toHaveLength(200); // 아직 cat 목록이 보인다
  act(() => { data.beginComposeList({ keep: JSON.stringify(OTHER) }); render(FOLDER); });
  await settle();
  act(() => { data.beginComposeList({ restore: JSON.stringify(OTHER) }); render(OTHER); });
  expect(ids()).toEqual([]);
  expect(data.staleList).toBe(false);
  await act(async () => { slowOther.resolve([gen("d1")]); });
  await settle();
  expect(ids()).toEqual(["d1"]);

  // 다빈치가 끼워 넣은 화면·실패한 화면도 담지 않는다
  act(() => data.revealLocated("my", { items: [gen("r1")], focus_ids: ["r1"], project_id: "p9", folder_path: "z" } as never));
  vi.mocked(api.listGenerations).mockImplementation(async () => [gen("d1")]);
  await act(async () => { await data.reload(); }); // 이 조회로 탭 캐시(= 출처 확인)는 다시 생긴다 — 그래도 끼워 넣은 화면이다
  act(() => { data.beginComposeList({ keep: JSON.stringify(OTHER) }); });
  act(() => { data.beginComposeList({ restore: JSON.stringify(OTHER) }); });
  expect(ids()).toEqual([]);
  vi.mocked(api.listGenerations).mockImplementation(async () => [gen("d1")]);
  await act(async () => { await data.reload(); });
  vi.mocked(api.listGenerations).mockImplementation(async () => { throw new Error("down"); });
  await act(async () => { await data.reload(); });
  expect(data.loadError).toBeTruthy();
  act(() => { data.beginComposeList({ keep: JSON.stringify(OTHER) }); });
  act(() => { data.beginComposeList({ restore: JSON.stringify(OTHER) }); });
  expect(ids()).toEqual([]);
});

it("emptying turns the loading state on in the same step — the grid never gets a chance to say the list is empty before the fetch starts", async () => {
  act(() => render(MAIN));
  await settle();
  expect(data.loading).toBe(false);
  // 조회 조건을 바꾸지 않고 비우기만 한다(= 조회 effect 가 돌기 전의 화면) — 이때 이미 '받는 중'이어야 한다
  act(() => { data.beginComposeList({ restore: "no-such-key" }); });
  expect(ids()).toEqual([]);
  expect(data.loading).toBe(true);
});

it("a discarded answer does not unlock the kept page; a failed first page removes it and shows the failure", async () => {
  act(() => render(MAIN));
  await settle();
  openWindow();
  await settle();
  const first = deferred<Generation[]>();
  const second = deferred<Generation[]>();
  const answers = [first.promise, second.promise];
  vi.mocked(api.listGenerations).mockImplementation((query) => (query.folder_path ? Promise.resolve(folderRows) : answers.shift() ?? Promise.resolve(mainRows)));
  closeWindow();
  await settle();
  expect(data.staleList).toBe(true);
  // 폴링이 끼어들어 앞선 조회를 무효로 만든다 — 그 응답이 와도(버려진다) 잠금은 그대로
  let poll!: Promise<void>;
  act(() => { poll = data.reload(true, true); });
  await act(async () => { first.resolve([gen("old")]); });
  await settle();
  expect(ids()).toEqual(["m1", "m2"]);
  expect(data.staleList).toBe(true);
  // 이어진 조회가 실패 — 사본을 최신처럼 남기지 않는다
  await act(async () => { second.reject(new Error("down")); await poll; });
  await settle();
  expect(data.staleList).toBe(false);
  expect(ids()).toEqual([]);
  expect(data.loadError).toBeTruthy();
});

it.each(["tab", "account", "team workspace"])("changing the %s while the kept page is shown ends the lock and drops it", async (what) => {
  const team = what === "team workspace";
  const main: GenQuery = team ? { tab: "team" } : MAIN;
  const filters: Filters = team ? { tab: "team" } : FILTERS;
  const key = JSON.stringify(main);
  vi.mocked(api.listGenerations).mockImplementation(async (query) => (query.folder_path ? folderRows : mainRows));
  act(() => render(main, filters));
  await settle();
  act(() => { data.beginComposeList({ keep: key }); render({ ...main, project_id: "p1", folder_path: "e035/c0010" }, filters); });
  await settle();
  const never = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockImplementation(() => never.promise);
  act(() => { data.beginComposeList({ restore: key }); render(main, filters); });
  expect(ids()).toEqual(["m1", "m2"]);
  expect(data.staleList).toBe(true);
  if (what === "tab") act(() => render({ tab: "team" }, { tab: "team" }));
  else if (what === "account") act(() => render(main, filters, "other-account"));
  else act(() => render(main, filters, "", "another-workspace"));
  expect(data.staleList).toBe(false);
  expect(ids()).toEqual([]); // 다른 문맥의 화면에 옛 사본이 남지 않는다
});

it("on the my tab a workspace change keeps the kept page locked until the fresh first page arrives — that tab does not swap its list on the spot", async () => {
  act(() => render(MAIN));
  await settle();
  openWindow();
  await settle();
  const slowMain = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockImplementation(() => slowMain.promise);
  closeWindow();
  act(() => render(MAIN, FILTERS, "", "another-workspace"));
  expect(ids()).toEqual(["m1", "m2"]);
  expect(data.staleList).toBe(true); // 사본이 그대로 보이는 동안은 잠근 채
  await settle();
  await act(async () => { slowMain.resolve([gen("n1")]); });
  await settle();
  expect(data.staleList).toBe(false);
  expect(ids()).toEqual(["n1"]);
});
