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
function Harness({ query }: { query: GenQuery }) {
  data = useGenerationLibraryData({ authReady: true, filters: FILTERS, genQuery: query, flash });
  const key = JSON.stringify(query);
  // App 과 같은 배선 — 조회 조건이 바뀌면 신선도 확인을 거쳐 다시 받는다.
  useEffect(() => { void data.reloadIfStale(); }, [key, data.reloadIfStale]);
  return null;
}
const render = (query: GenQuery) => root.render(<StrictMode><Harness query={query} /></StrictMode>);
const settle = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
const ids = () => data.gens.map((g) => g.id);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
