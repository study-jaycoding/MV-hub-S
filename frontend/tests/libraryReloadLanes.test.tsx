// @vitest-environment jsdom
// 목록 다시 받기의 두 줄(2026-10-07) — 목록 줄은 목록 구간까지만 잡고, 메타(통계·태그·폴더)는 따로 줄을 선다.
//  지키는 것: 다음 목록이 앞 실행의 메타를 기다리지 않는다 · 메타 묶음은 한 번에 하나 · 전체 메타 요구는 버려져도 다음 묶음이
//  이어받는다 · `await reload()` 는 맡긴 메타가 처리된 뒤에 풀린다 · 낡은 응답은 적용하지 않는다.
//  StrictMode 의 이중 effect 는 호출 수 세기를 흐리므로 여기서는 쓰지 않는다(listFolderPeek.test.tsx 가 StrictMode 로 본다).
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, connectProgress } from "../src/api";
import { folderPeekQuery } from "../src/lib/appGenerationQuery";
import { LIBRARY_LIST_TIMEOUT_MESSAGE, LIBRARY_LIST_TIMEOUT_MS } from "../src/lib/libraryRequestTimeout";
import { createLibraryMutationOrigin, decideLibrarySync, markMutationDomainsSucceeded } from "../src/lib/librarySync";
import type { GenerationLocation } from "../src/lib/resolveLibraryLocation";
import { useGenerationAutoRefresh } from "../src/lib/useGenerationAutoRefresh";
import { useGenerationLibraryData, type LibraryOwner } from "../src/lib/useGenerationLibraryData";
import type { Filters, GenQuery, Generation } from "../src/types";
import { APP_EVENTS, dispatchAppEvent } from "../src/lib/appEvents";
import { useGenerationProgress } from "../src/lib/useGenerationProgress";
import { usePromptCreatedActions } from "../src/lib/usePromptCreatedActions";
import { onLibraryChanged } from "../src/lib/libraryBroadcast";
import { clearGenerationReadModels, generationChangeScope, getGenerationReadModel } from "../src/features/library/api";

vi.mock("../src/api", () => ({ GEN_PAGE: 200, connectProgress: vi.fn(() => () => {}), api: {
  listGenerations: vi.fn(), projects: vi.fn(), facets: vi.fn(), generationStats: vi.fn(), listTrash: vi.fn(), locateGenerations: vi.fn(),
} }));

type Props = {
  query: GenQuery; authReady?: boolean; projectWorkspaceId?: string;
  composeListEnabled?: boolean; // 캔버스의 '폴더 보기' 창이 열려 있다
  auto?: boolean; // false = 조회를 시험이 직접 부른다
  trash?: boolean; // 휴지통 보기
  poll?: boolean; // App 과 같은 자동 조회(useGenerationAutoRefresh)를 붙인다
  progress?: boolean;
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
let ownerNow: LibraryOwner | null = null; // App 이 커밋마다 적는 자료 주인(83회차) — 시험이 바꾼다
let promptCreated: ReturnType<typeof usePromptCreatedActions>["handlePromptCreated"];
const noop = () => {};
const readOwner = () => ownerNow;
function Harness({ query, authReady = true, projectWorkspaceId, composeListEnabled, auto = true, trash = false, poll = false, progress = false }: Props) {
  const filters: Filters = { tab: query.tab, ...(trash ? { deleted_only: true } : {}) };
  data = useGenerationLibraryData({ authReady, filters, genQuery: query, flash, projectWorkspaceId, composeListEnabled, owner: readOwner });
  const key = JSON.stringify(query);
  // App 과 같은 배선 — 조회 조건·탭·인증이 바뀌면 신선도 확인을 거쳐 다시 받는다.
  useEffect(() => { if (auto) void data.reloadIfStale(); }, [auto, key, authReady, data.reloadIfStale]);
  useGenerationAutoRefresh({ generations: data.gens, tab: poll ? query.tab : "compose", reload: data.reload, paused: data.autoRefreshPaused }); // compose = 주기 없음
  useGenerationProgress({ enabled: progress, scopeKey: "test", gens: data.gens, setGens: data.setGens, reload: data.reload,
    bumpBoard: noop, setSyncTick: noop, historyBoardVisible: false, commentsVisible: false });
  promptCreated = usePromptCreatedActions({ boardFocusIdRef: { current: null }, boardSelectedRef: { current: [] },
    filtersRef: { current: filters }, bumpBoard: noop, flash, reload: data.reload, setGens: data.setGens }).handlePromptCreated;
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

it("[R4-1] real reconnect dispatch invalidates before real reload starts", async () => {
  vi.useFakeTimers();
  try {
    await mount({ query: MAIN, progress: true });
    const before = calls().list;
    vi.mocked(api.listGenerations).mockResolvedValue([gen("after-reconnect")]);
    act(() => vi.mocked(connectProgress).mock.calls.at(-1)?.[1]?.());
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await settle();
    expect(ids()).toEqual(["after-reconnect"]);
    expect(calls().list).toBe(before + 1);
  } finally { vi.useRealTimers(); }
});

it.each(["my", "team"] as const)("[R5-3] prompt-created %s reload follows the real local broadcast without retrying", async (tab) => {
  await mount({ query: { ...MAIN, tab } });
  const before = calls().list;
  vi.mocked(api.listGenerations).mockResolvedValue([gen("created")]);
  await act(async () => promptCreated());
  await settle();
  expect(ids()).toEqual(["created"]);
  expect(calls().list).toBe(before + 1);
});

it("[R4-2] a peer broadcast retiring an ongoing read still applies a fresh page", async () => {
  class PeerChannel {
    static all: PeerChannel[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() { PeerChannel.all.push(this); }
    close() { PeerChannel.all = PeerChannel.all.filter(channel => channel !== this); }
  }
  vi.stubGlobal("BroadcastChannel", PeerChannel);
  const off = onLibraryChanged(noop);
  try {
    await mount();
    const before = calls().list;
    const first = hold<Generation[]>(api.listGenerations);
    const done = start(() => data.reload());
    vi.mocked(api.listGenerations).mockResolvedValue([gen("after-peer")]);
    act(() => {
      for (const channel of PeerChannel.all) channel.onmessage?.({ data: { tab: "peer", change: {
        version: 1, id: "R4-peer", scope: generationChangeScope(), resourceIds: [], affectsMembership: true, source: "bc",
      } } });
    });
    await act(async () => first.resolve([gen("obsolete")]));
    await settle();
    expect(ids()).toEqual(["after-peer"]); expect(done.done).toBe(true);
    expect(calls().list).toBe(before + 2);
  } finally { off(); vi.unstubAllGlobals(); }
});

it("[R5-2] a single execution retries once and its one follow-up check cannot chain", async () => {
  await mount();
  const before = calls().list;
  const pages = Array.from({ length: 4 }, () => deferred<Generation[]>());
  for (const page of pages) vi.mocked(api.listGenerations).mockReturnValueOnce(page.promise);
  const done = start(() => data.reload());
  expect(calls().list).toBe(before + 1);
  for (let index = 0; index < pages.length; index++) {
    act(() => dispatchAppEvent(APP_EVENTS.libraryChanged));
    await act(async () => pages[index].resolve([gen("keeps-changing")]));
    await settle();
    expect(calls().list).toBe(before + Math.min(index + 2, 4));
  }
  expect(done.done).toBe(true);
  expect(ids()).not.toContain("keeps-changing");
});

const evictRow = (id: string) => {
  const records = getGenerationReadModel(undefined, "local");
  const newer = records.beginRead();
  records.store({ [id]: gen(id) }, newer);
  records.store(Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`cached-${i}`, gen(`cached-${i}`)])), newer);
  expect(records.read(id)).toBeUndefined();
};

it.each([false, true])("[F9-7 R1] retries an evicted row without advancing the page: more=%s", async (more) => {
  const initial = Array.from({ length: 200 }, (_, i) => gen(`initial-${i}`));
  vi.mocked(api.listGenerations).mockResolvedValueOnce(initial);
  await mount();
  const before = calls().list;
  const old = hold<Generation[]>(api.listGenerations);
  const done = start(() => more ? data.loadMore() : data.reload());
  evictRow("evicted");
  vi.mocked(api.listGenerations).mockResolvedValue([gen("evicted")]);
  await act(async () => old.resolve([gen("evicted")]));
  await settle();
  expect(done.done).toBe(true);
  expect(ids()).toEqual(more ? [...initial.map(g => g.id), "evicted"] : ["evicted"]);
  expect(data.hasMore).toBe(false);
  expect(data.loadError).toBeNull();
  expect(calls().list).toBe(before + 2);
  const requests = vi.mocked(api.listGenerations).mock.calls.slice(before);
  expect(requests.map(call => call[1])).toEqual(more
    ? [{ ts: 10, id: "initial-199" }, { ts: 10, id: "initial-199" }] : [null, null]);
});

it.each([false, true])("[F9-7 R1] repeated eviction cannot chain follow-up checks: more=%s", async (more) => {
  await mount();
  const before = calls().list;
  vi.mocked(api.listGenerations).mockImplementation(async () => {
    evictRow("keeps-evicting");
    return [gen("keeps-evicting")];
  });
  const done = start(() => more ? data.loadMore() : data.reload());
  await settle();
  expect(done.done).toBe(true);
  expect(calls().list).toBe(before + 4); // two attempts + one check with two attempts
  expect(ids()).toEqual(mainRows.map(g => g.id));
});

it.each([[false, false], [false, true], [true, false], [true, true]])("[F9-7 IDs] accepts pages without retries: more=%s invalid=%s", async (more, invalid) => {
  await mount();
  const before = calls().list;
  const missing = { ...gen("missing") } as Partial<Generation>;
  delete missing.id;
  vi.mocked(api.listGenerations).mockResolvedValue([gen("valid"), ...(invalid ? [missing as Generation, gen("")] : [])]);
  const done = start(() => more ? data.loadMore() : data.reload());
  await settle();
  expect(done.done).toBe(true);
  expect(ids()).toEqual(more ? [...mainRows.map(g => g.id), "valid"] : ["valid"]);
  expect(data.loadError).toBeNull();
  expect(data.hasMore).toBe(false);
  expect(calls().list).toBe(before + 1);
});

it.each([false, true])("[F9-8 P3-1] discards loadMore overtaken by a first page and resumes from that page: trash=%s", async (trash) => {
  const list = vi.mocked(trash ? api.listTrash : api.listGenerations);
  const firstPage = Array.from({ length: 200 }, (_, i) => gen(`first-${i}`));
  const secondPage = Array.from({ length: 200 }, (_, i) => gen(`second-${i}`));
  list.mockResolvedValueOnce(firstPage);
  await mount({ query: MAIN, trash });
  list.mockResolvedValueOnce(secondPage);
  await act(async () => { await data.loadMore(); });
  expect(ids()).toEqual([...firstPage, ...secondPage].map(g => g.id));

  const first = hold<Generation[]>(list);
  const reload = start(() => data.reload(true, true, "check"));
  const later = hold<Generation[]>(list);
  const more = start(() => data.loadMore());
  expect(list.mock.calls.at(-1)?.[1]).toEqual(trash ? 400 : { ts: 10, id: "second-199" });
  expect(data.loadingMore).toBe(true);

  await act(async () => first.resolve(firstPage));
  await settle();
  expect(reload.done).toBe(true);
  expect(ids()).toEqual(firstPage.map(g => g.id));
  expect(data.hasMore).toBe(true);
  await act(async () => later.resolve([gen("stale-third-page")]));
  await settle();
  expect(more.done).toBe(true);
  expect(data.loadingMore).toBe(false);
  expect(data.hasMore).toBe(true);
  expect(ids()).toEqual(firstPage.map(g => g.id));

  list.mockResolvedValueOnce([gen("fresh-next-page")]);
  await act(async () => { await data.loadMore(); });
  expect(list.mock.calls.at(-1)?.[1]).toEqual(trash ? 200 : { ts: 10, id: "first-199" });
  expect(ids()).toEqual([...firstPage.map(g => g.id), "fresh-next-page"]);
  expect(data.hasMore).toBe(false);
  expect(data.loadingMore).toBe(false);
});

it("[R5-2] a follow-up check applies fresh rows without waiting for stalled metadata", async () => {
  await mount();
  const before = calls();
  const metadata = hold<Awaited<ReturnType<typeof api.projects>>>(api.projects);
  let retired = 0;
  vi.mocked(api.listGenerations).mockImplementation(async () => {
    if (retired++ < 2) dispatchAppEvent(APP_EVENTS.libraryChanged);
    return [gen("after-two-retirements")];
  });
  const done = start(() => data.reload());
  await settle();
  expect(calls().list).toBe(before.list + 3);
  expect(ids()).toEqual(["after-two-retirements"]);
  expect(done.done).toBe(false);
  expect(calls().facets).toBe(before.facets + 1); // 메타는 기존 줄에서 기다리고 목록만 먼저 끝난다.
  await act(async () => metadata.resolve(folders(0)));
  await settle();
  expect(done.done).toBe(true);
  expect(calls().list).toBe(before.list + 3);
});

it("[R4-3] a stalled metadata bundle times out, releases await reload and drains queued metadata", async () => {
  vi.useFakeTimers();
  try {
    await mount();
    const signals: AbortSignal[] = [];
    const stall = (signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    };
    vi.mocked(api.generationStats).mockImplementationOnce(signal => stall(signal!));
    vi.mocked(api.facets).mockImplementationOnce((_tab, signal) => stall(signal!));
    vi.mocked(api.projects).mockImplementationOnce((_tab, _archived, _workspace, signal) => stall(signal!));
    const first = start(() => data.reload()); await settle();
    const second = start(() => data.reload()); await settle();
    expect(first.done).toBe(false); expect(second.done).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(LIBRARY_LIST_TIMEOUT_MS); });
    await settle();
    expect(signals).toHaveLength(3); expect(signals.every(signal => signal?.aborted)).toBe(true);
    expect([first.done, second.done]).toEqual([true, true]);
  } finally { vi.useRealTimers(); }
});

it("peer tags requery an idle Workspace filter including rows outside the old page and pagination", async () => {
  class PeerChannel {
    static all: PeerChannel[] = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() { PeerChannel.all.push(this); }
    close() { PeerChannel.all = PeerChannel.all.filter(channel => channel !== this); }
  }
  vi.stubGlobal("BroadcastChannel", PeerChannel);
  const broad = vi.fn(); window.addEventListener(APP_EVENTS.libraryChanged, broad);
  try {
    const initial = Array.from({ length: 200 }, (_, index) => ({ ...gen(`old-${index}`), tags: ["wanted"] }));
    vi.mocked(api.listGenerations).mockResolvedValueOnce(initial);
    await mount({ query: { tab: "my", tag: "wanted" } });
    expect(data.gens).toHaveLength(200); expect(data.hasMore).toBe(true);
    const oldCalls = calls().list;
    const next = { ...gen("outside-old-page"), tags: ["wanted"] };
    vi.mocked(api.listGenerations).mockResolvedValue([next]);
    vi.mocked(api.facets).mockResolvedValue({ tags: ["wanted", "new-tag"], auto_tags: [], models: [] } as never);
    const change = { version: 1, id: "peer-filter", scope: generationChangeScope(), resourceIds: [next.id],
      changedFields: ["tags"], affectsMembership: false, source: "local" };
    act(() => {
      for (const channel of PeerChannel.all) channel.onmessage?.({ data: {
        tab: "peer", event: APP_EVENTS.generationTagsSettled, change,
      } });
    });
    await settle();
    expect(calls().list).toBe(oldCalls + 1);
    expect(ids()).toEqual([next.id]); expect(data.hasMore).toBe(false);
    expect(data.facets.tags).toEqual(["wanted", "new-tag"]);
    expect(vi.mocked(api.listGenerations).mock.calls.at(-1)?.[0]).toMatchObject({ tab: "my", tag: "wanted" });
    expect(broad).not.toHaveBeenCalled();
    act(() => {
      for (const channel of PeerChannel.all) channel.onmessage?.({ data: {
        tab: "peer", event: APP_EVENTS.generationTagsSettled, change,
      } });
    });
    await settle(); expect(calls().list).toBe(oldCalls + 1);
  } finally {
    window.removeEventListener(APP_EVENTS.libraryChanged, broad);
    vi.unstubAllGlobals();
  }
});

beforeEach(() => {
  clearGenerationReadModels();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const call of Object.values(api)) vi.mocked(call as () => unknown).mockReset(); // 안 쓰고 남은 '한 번' 응답까지 지운다
  flash.mockReset();
  ownerNow = null;
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

// 64회차 실측 — 다른 탭 로그아웃으로 멈춘 동안(4B)의 목록 조회는 실패가 아니다: 자동 조회가 "로드 실패: ApiPausedError…"를 띄우고 실패 표시를
//  켰다. 띠가 이미 알리니 자동 조회는 조용히, 사람이 누른 다시 받기는 멈춤만 알리고, 목록·실패 표시는 그대로 둔다.
it("멈춘 동안의 목록 조회 — '로드 실패'·실패 표시 없이 목록을 그대로 둔다(누른 다시 받기만 멈춤을 알린다)", async () => {
  const { ApiPausedError, API_PAUSED_MESSAGE } = await import("../src/lib/http");
  await mount();
  expect(ids()).toEqual(["m1", "m2"]);
  vi.mocked(api.listGenerations).mockRejectedValueOnce(new ApiPausedError(API_PAUSED_MESSAGE));
  await act(async () => { await data.reload(true, true); }); // 자동 조회(15초·창 복귀)
  expect([flash.mock.calls.length, data.loadError, ids()]).toEqual([0, null, ["m1", "m2"]]);
  vi.mocked(api.listGenerations).mockRejectedValueOnce(new ApiPausedError(API_PAUSED_MESSAGE));
  await act(async () => { await data.reload(); });
  expect(flash).toHaveBeenCalledExactlyOnceWith(API_PAUSED_MESSAGE);
  expect([data.loadError, ids()]).toEqual([null, ["m1", "m2"]]);
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
  expect(vi.mocked(api.projects).mock.calls.at(-1)).toEqual(["team", false, "ws-b", expect.any(AbortSignal)]);
  expect(vi.mocked(api.facets).mock.calls.at(-1)).toEqual(["team", expect.any(AbortSignal)]);
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
  expect(api.projects).toHaveBeenLastCalledWith("my", false, "ws-a", expect.any(AbortSignal));
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

// 2026-10-13(Jay "아직 폴더 이동할 때 딜레이"): 화면의 목록이 지금 조회의 것인지 알려 준다 — App 이 자리를 옮긴 직후 옛 자리의 목록을 그대로 그리지 않고,
//  받아 둔 넓은 목록에서 새 자리의 것만 골라 먼저 보이게(App 의 narrowing).
it("listBehind — 조회가 바뀌면 새 첫 쪽이 적용될 때까지 참, 같은 조회를 다시 받는 동안은 거짓", async () => {
  const EP: GenQuery = { tab: "team", project_id: "p1", folder_path: "e035" };
  const CUT: GenQuery = { tab: "team", project_id: "p1", folder_path: "e035/C0010" };
  show({ query: EP });
  expect(data.listBehind).toBe(true); // 아직 아무것도 못 받았다
  await settle();
  expect(data.listBehind).toBe(false);
  const again = hold<Generation[]>(api.listGenerations);
  act(() => { void data.reload(true); }); // 같은 조회를 다시 받는 중(주기 조회)
  expect(data.listBehind).toBe(false);
  await act(async () => { again.resolve(folderRows); });
  await settle();
  const next = hold<Generation[]>(api.listGenerations);
  show({ query: CUT }); // 자리를 옮겼다 — 새 첫 쪽 전에는 화면의 목록이 옛 자리의 것이다
  expect([data.listBehind, ids()]).toEqual([true, ["f1"]]);
  await act(async () => { next.resolve(folderRows); });
  await settle();
  expect(data.listBehind).toBe(false);
});

// 2026-10-13(Jay "아직 폴더 이동할 때 딜레이", 31회차): 조회가 바뀌었는데 앞 실행의 목록(에피소드의 첫 쪽·주기 조회)이 아직 안 왔으면 그것을 기다리지
//  않는다 — 어차피 버릴 목록이다. 같은 조회를 다시 받는 것은 전처럼 줄을 선다(위 '한 줄로 선다' 시험들).
it("조회가 바뀌면 앞 실행의 목록을 기다리지 않고 바로 출발한다 — 늦게 온 옛 목록은 버리고, 같은 조회는 전처럼 줄을 선다", async () => {
  const EP: GenQuery = { tab: "team", project_id: "p1", folder_path: "e035" };
  const CUT: GenQuery = { tab: "team", project_id: "p1", folder_path: "e035/C0010" };
  await mount({ query: EP });
  const slowEp = hold<Generation[]>(api.listGenerations); // 에피소드의 주기 조회가 떠 있다
  const poll = start(() => data.reload(true, true));
  const before = calls();
  const cutList = hold<Generation[]>(api.listGenerations);
  show({ query: CUT }); // 그사이 다른 폴더를 눌렀다
  expect(calls().list).toBe(before.list + 1); // 기다리지 않고 출발했다
  expect(vi.mocked(api.listGenerations).mock.calls.at(-1)![0]).toEqual(CUT);
  expect([data.loading, data.listBehind]).toEqual([true, true]);
  await act(async () => { cutList.resolve([gen("cut-1")]); });
  await settle();
  expect([ids(), data.loading, data.listBehind, poll.done]).toEqual([["cut-1"], false, false, false]); // 앞지름당한 실행의 약속은 자기 요청이 끝나야 풀린다
  await act(async () => { slowEp.resolve(mainRows); }); // 늦게 온 옛 조회 — 버린다
  await settle();
  expect([ids(), data.loading, poll.done]).toEqual([["cut-1"], false, true]);
  // 같은 조회를 다시 받는 것은 전처럼 줄을 선다 — 앞 실행이 끝난 뒤에 출발한다
  const slow = hold<Generation[]>(api.listGenerations);
  act(() => { void data.reload(true); });
  const mark = calls();
  const again = start(() => data.reload());
  await settle();
  expect([calls().list, again.done]).toEqual([mark.list, false]);
  await act(async () => { slow.resolve([gen("cut-1")]); });
  await settle();
  expect([calls().list, again.done]).toEqual([mark.list + 1, true]);
});

// 앞지른 요청은 취소하지 못한다 — 느린 서버에서 폴더를 연달아 옮기면 낡은 요청들이 연결을 차지해 정작 마지막 조회가 늦는다(Codex 31회차 설계 검토).
it("앞지르기는 낡은 요청 하나까지 — 그것이 떠 있는 동안 또 옮기면 줄을 서고, 낡은 요청이 끝나면 다시 앞지를 수 있다", async () => {
  const at = (folder: string): GenQuery => ({ tab: "team", project_id: "p1", folder_path: folder });
  await mount({ query: at("e035") });
  const slowEp = hold<Generation[]>(api.listGenerations); // 에피소드의 주기 조회가 떠 있다
  act(() => { void data.reload(true, true); });
  const before = calls();
  const first = hold<Generation[]>(api.listGenerations);
  show({ query: at("e035/C0010") }); // 앞지른다 — 낡은 요청 하나(에피소드)
  expect(calls().list).toBe(before.list + 1);
  const second = hold<Generation[]>(api.listGenerations);
  show({ query: at("e035/C0020") }); // 또 옮겼다 — 낡은 요청이 아직 떠 있어 줄을 선다
  expect(calls().list).toBe(before.list + 1);
  await act(async () => { first.resolve([gen("c10")]); }); // 줄을 잡은 실행의 목록이 왔다(버린다) → 줄 선 실행이 출발
  await settle();
  expect(calls().list).toBe(before.list + 2);
  expect(vi.mocked(api.listGenerations).mock.calls.at(-1)![0]).toEqual(at("e035/C0020"));
  expect([ids(), data.listBehind]).toEqual([["f1"], true]); // 버린 목록은 화면에 서지 않는다
  await act(async () => { second.resolve([gen("c20")]); });
  await settle();
  expect([ids(), data.loading, data.listBehind]).toEqual([["c20"], false, false]);
  await act(async () => { slowEp.resolve(mainRows); }); // 낡은 요청이 실제로 끝났다
  await settle();
  expect(ids()).toEqual(["c20"]);
  // 다시 앞지를 수 있다 — 수를 줄 넘길 때가 아니라 목록이 끝날 때 내린다
  hold<Generation[]>(api.listGenerations);
  act(() => { void data.reload(true, true); });
  const mark = calls();
  show({ query: at("e035/C0030") });
  expect(calls().list).toBe(mark.list + 1);
});

// 60회차(Codex): 자동 조회(조용한 다시 받기)는 3초마다 돈다 — 실패할 때마다 알림을 띄워 다른 조작의 안내를 덮었다. 실패 표시는 화면에 남으니
//  조용한 조회는 처음 한 번만 알리고, 사람이 직접 한 조회는 전처럼 알린다. 다시 성공하면 다음 실패는 또 알린다.
it("조용한 다시 받기의 같은 실패는 한 번만 알린다 — 직접 한 다시 받기·성공 뒤의 실패는 알린다", async () => {
  await mount();
  flash.mockClear();
  vi.mocked(api.listGenerations).mockRejectedValue(new Error("offline"));
  await act(async () => { await data.reload(true, true); });
  await act(async () => { await data.reload(true, true); });
  await act(async () => { await data.reload(true, true); });
  expect(flash).toHaveBeenCalledTimes(1); // 전엔 세 번
  await act(async () => { await data.reload(); }); // 사람이 누른 다시 받기
  expect(flash).toHaveBeenCalledTimes(2);
  vi.mocked(api.listGenerations).mockResolvedValue(mainRows);
  await act(async () => { await data.reload(true, true); }); // 되살아났다
  vi.mocked(api.listGenerations).mockRejectedValue(new Error("offline"));
  await act(async () => { await data.reload(true, true); });
  expect(flash).toHaveBeenCalledTimes(3);
});

// Codex 검토: 실패 표시(loadError)는 다시 그린 뒤에야 ref 에 들어가, 그리기 전에 연달아 끝난 조용한 실패가 또 알렸다.
it("조용한 다시 받기 — 다시 그리기 전에 연달아 실패해도 한 번만 알린다", async () => {
  await mount();
  flash.mockClear();
  vi.mocked(api.listGenerations).mockRejectedValue(new Error("offline"));
  await act(async () => {
    await data.reload(true, true);
    await data.reload(true, true);
  });
  expect(flash).toHaveBeenCalledTimes(1);
  await act(async () => { // 같은 박자에 성공 → 실패 — 되살아난 뒤의 실패는 새 실패다
    vi.mocked(api.listGenerations).mockResolvedValueOnce(mainRows);
    await data.reload(true, true);
    await data.reload(true, true);
  });
  expect(flash).toHaveBeenCalledTimes(2);
});

// Codex 검토: 다른 탭의 실패 표시가 남은 채 신선한 캐시로 돌아오면, 이 탭의 첫 조용한 실패를 알리지 않았다 — 탭을 바꾸면 실패 표시도 그 탭의 것이 아니다.
it("탭을 오가면 앞 탭의 실패 표시가 이 탭의 첫 실패를 묻지 않는다", async () => {
  await mount();
  flash.mockClear();
  vi.mocked(api.listGenerations).mockRejectedValueOnce(new Error("offline"));
  await mount({ query: { tab: "team" } }); // 팀 탭 첫 조회 실패 — 알림 1
  expect(flash).toHaveBeenCalledTimes(1);
  await mount({ query: MAIN }); // 15초 안 — 신선한 캐시로 돌아온다(다시 받지 않는다)
  expect(data.loadError).toBeNull();
  vi.mocked(api.listGenerations).mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await data.reload(true, true); }); // 이 탭의 첫 조용한 실패
  expect(flash).toHaveBeenCalledTimes(2); // 전엔 앞 탭의 실패 표시 때문에 묻혔다
});

// 52회차 격리 실측 — 공유 & 리뷰 → 워크스페이스 → 15초 안에 공유 & 리뷰: 목록은 캐시로 돌아왔는데 왼쪽 폴더·태그 숫자는 워크스페이스
//  것(830·21)으로 남았다. 팀 탭의 15초 폴링은 가벼워서 폴더·태그를 다시 받지 않으므로 새로고침 전까지 그대로였다.
it("15초 안에 돌아온 탭: 목록은 캐시로 두되, 다른 범위의 폴더·태그가 남아 있으면 그것만 다시 받는다", async () => {
  vi.mocked(api.projects).mockImplementation(async (scope) => folders(scope === "team" ? 2 : 830) as never);
  await mount({ query: { tab: "team" } });
  expect(data.unassignedCount).toBe(2);
  await mount({ query: MAIN });
  expect(data.unassignedCount).toBe(830);
  const before = calls();
  await mount({ query: { tab: "team" } });
  expect(calls().list).toBe(before.list); // 목록은 신선한 캐시 그대로
  expect(vi.mocked(api.facets).mock.calls.at(-1)).toEqual(["team", expect.any(AbortSignal)]);
  expect(data.unassignedCount).toBe(2);
  const again = calls();
  await act(async () => { await data.reloadIfStale(); }); // 이미 이 범위의 것 — 더 받지 않는다
  expect(calls()).toEqual(again);
});

// 81회차 실측 1 F1: 다른 조회(전체 → 프로젝트)로 옮긴 뒤 그 조회가 실패로 끝나면(500·30초 무응답) 앞 조회의 목록이 그대로 남아, 토스트가 사라진 뒤
//  옛 조건의 카드가 지금 조회의 결과처럼 보였고 재시도 화면(빈 격자 + 실패 표시)도 뜨지 않았다. 같은 조회를 다시 받다 실패한 것은 전처럼 목록을 둔다.
it.each([["500", false], ["30초 무응답", true]])("다른 조회로 옮긴 뒤 그 조회가 실패하면(%s) 앞 조회의 목록을 걷고 재시도 화면 — 다시 시도 한 번에 새 조회의 것만", async (_name, hang) => {
  const ALL: GenQuery = { tab: "my" };
  const PROJECT: GenQuery = { tab: "my", project_id: "pa" };
  const page = Array.from({ length: 200 }, (_, index) => gen(`c${index}`)); // 꽉 찬 첫 쪽 — 다음 쪽이 있다
  vi.mocked(api.listGenerations).mockImplementation(async (query) => (query.project_id === "pa" ? [gen("a1")] : page));
  await mount({ query: ALL });
  expect([ids().length, data.hasMore]).toEqual([200, true]);
  vi.mocked(api.listGenerations).mockRejectedValueOnce(new Error("500: boom"));
  await act(async () => { await data.reload(true, true); }); // 같은 조회의 갱신 실패 — 보던 목록을 그대로 둔다
  expect([ids().length, data.loadError]).toEqual([200, "500: boom"]);
  await act(async () => { await data.reload(true, true); });
  expect(data.loadError).toBeNull();
  if (hang) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(api.listGenerations).mockImplementationOnce((_query, _cursor, _limit, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
  } else {
    vi.mocked(api.listGenerations).mockRejectedValueOnce(new Error("500: boom"));
  }
  try {
    show({ query: PROJECT });
    expect(ids().length).toBe(200); // 기다리는 동안은 앞 목록을 둔다(§5-1)
    if (hang) await act(async () => { await vi.advanceTimersByTimeAsync(LIBRARY_LIST_TIMEOUT_MS); });
    await settle();
  } finally {
    vi.useRealTimers();
  }
  expect([ids(), data.hasMore, data.loading]).toEqual([[], false, false]); // 빈 격자 + 실패 표시 = 재시도 화면
  expect(data.loadError).toBe(hang ? LIBRARY_LIST_TIMEOUT_MESSAGE : "500: boom");
  await act(async () => { await data.reload(); }); // [다시 시도]
  expect([ids(), data.loadError]).toEqual([["a1"], null]);
});

// 81회차 F1 Codex 리뷰: '다른 조회인가'를 탭 캐시로 가리면, 캐시를 지운 구간(휴지통 추가 조회 실패·위치 주입)에서는 못 가려 앞 목록이 남았다.
//  보이는 목록이 어느 조회의 것인지는 캐시와 따로 든다.
it("휴지통(공간 필터): 추가 조회 실패로 캐시가 지워진 뒤 검색을 바꿔 그 조회도 실패하면 앞 목록을 걷는다", async () => {
  const TRASH: GenQuery = { tab: "my", workspace_scope: "personal" };
  const trashed = (id: string) => ({ ...gen(id), workspace_scope: "personal" }) as unknown as Generation;
  vi.mocked(api.listTrash).mockResolvedValueOnce(Array.from({ length: 200 }, (_, index) => trashed(`t${index}`)));
  await mount({ query: TRASH, trash: true });
  expect([ids().length, data.hasMore]).toEqual([200, true]);
  vi.mocked(api.listTrash).mockRejectedValueOnce(new Error("500: boom"));
  await act(async () => { await data.loadMore(); }); // 추가 조회 실패 — 이 탭의 캐시를 지운다(목록은 같은 조회라 둔다)
  expect([ids().length, data.hasMore, !!data.loadError]).toEqual([200, false, true]);
  vi.mocked(api.listTrash).mockRejectedValueOnce(new Error("500: boom"));
  show({ query: { ...TRASH, search: "dog" }, trash: true });
  await settle();
  expect([ids(), data.loadError]).toEqual([[], "500: boom"]);
});

it("위치 주입 뒤: 같은 자리를 다시 받다 실패하면 주입한 카드까지 둔다 — 다른 조회로 옮긴 뒤 실패하면 걷는다", async () => {
  await mount({ query: LOCATED });
  vi.mocked(api.listGenerations).mockRejectedValueOnce(new Error("500: boom"));
  act(() => { data.revealLocated("my", locationOf(gen("outside-page"))); }); // 목록 밖 대상 — 캐시를 지우고 같은 자리를 다시 받는다(실패)
  await settle();
  expect([[...ids()].sort(), data.loadError]).toEqual([["m1", "m2", "outside-page"], "500: boom"]);
  vi.mocked(api.listGenerations).mockRejectedValueOnce(new Error("500: boom"));
  show({ query: MAIN });
  await settle();
  expect([ids(), data.loadError]).toEqual([[], "500: boom"]);
});

// Codex 재확인 P2: 새 자리(B)의 목록을 기다리는 중에 따라가면(위치 주입) 앞 조회(A)의 목록에 B 카드를 합쳤고, 그 전체를 위치 목록으로 여겨 뒤따른
//  B 조회가 실패해도 A 카드가 남았다. 보이는 목록이 이미 B 의 것일 때만 합친다.
it("위치 주입: 새 자리의 목록을 기다리는 중에 따라가면 앞 조회의 카드에 합치지 않는다 — 뒤따른 조회가 실패해도 주입한 카드만 남는다", async () => {
  await mount({ query: MAIN });
  expect(ids()).toEqual(["m1", "m2"]);
  const slowB = hold<Generation[]>(api.listGenerations);
  show({ query: LOCATED }); // B 로 옮겼다 — 목록은 아직(그동안 A 목록을 둔다)
  expect(ids()).toEqual(["m1", "m2"]);
  act(() => { data.revealLocated("my", locationOf(gen("outside-page"))); });
  vi.mocked(api.listGenerations).mockRejectedValueOnce(new Error("500: boom")); // 뒤따른 B 조회
  await act(async () => { slowB.resolve([gen("b-old")]); }); // 주입 앞에 떠난 B 조회 — 낡아서 버린다
  await settle();
  expect([ids(), data.hasMore, data.loadError]).toEqual([["outside-page"], false, "500: boom"]);
});

// 81회차 P2b 3-a — 격자는 주입 카드 하나로 먼저 내려간다. 그 뒤 첫 정상 목록을 적용했다는 신호로 한 번 더 맞춘다.
it("위치 주입 뒤 첫 정상 목록을 적용할 때 신호가 한 번 오른다 — 주기 조회나 실패 뒤의 성공으로는 오르지 않는다", async () => {
  await mount({ query: MAIN });
  const before = data.locatedSettle;
  const slowB = hold<Generation[]>(api.listGenerations);
  show({ query: LOCATED }); // 새 자리 — 목록은 아직
  vi.mocked(api.locateGenerations).mockResolvedValue(locationOf(gen("outside-page")));
  act(() => { data.revealLocated("my", locationOf(gen("outside-page"))); });
  expect(data.locatedSettle).toBe(before); // 주입만으로는 오르지 않는다
  await act(async () => { slowB.resolve([gen("b-old")]); }); // 주입 앞에 떠난 조회 — 낡아서 버린다
  await settle();
  expect([data.locatedSettle, [...ids()].sort()]).toEqual([before + 1, ["m1", "m2", "outside-page"]]);
  await act(async () => { await data.reload(true); }); // 주기 조회
  await settle();
  expect(data.locatedSettle).toBe(before + 1);

  vi.mocked(api.listGenerations).mockRejectedValueOnce(new Error("500: boom"));
  act(() => { data.revealLocated("my", locationOf(gen("outside-2"))); }); // 목록 밖 대상 — 같은 자리를 다시 받다 실패
  await settle();
  expect(data.loadError).toBe("500: boom");
  await act(async () => { await data.reload(true); }); // 실패 뒤의 성공 — 기다림은 이미 닫혔다
  await settle();
  expect(data.locatedSettle).toBe(before + 1);
});

// 81회차 F2-2 — 직전 화면의 진행 중 카드로 3초 자동 조회가 남아 있으면, 자리를 옮길 때마다 받던 첫 쪽을 버리고 같은 목록을 한 번 더 받았다.
it("바뀐 조회의 첫 쪽을 받는 동안 자동 조회는 쉰다 — 첫 응답을 그대로 쓰고, 실제 변경 통보의 다시 받기는 그대로 둔다", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const running = { ...gen("r1"), status: "running" } as Generation;
    vi.mocked(api.listGenerations).mockImplementation(async (query) => (query.project_id === "project-b" ? [gen("b1")] : [running]));
    await mount({ query: MAIN, poll: true });
    expect(ids()).toEqual(["r1"]);
    const slowB = hold<Generation[]>(api.listGenerations);
    const before = calls().list;
    show({ query: LOCATED, poll: true }); // 자리를 옮겼다 — 첫 쪽은 아직(직전 화면의 진행 중 카드로 3초 조회가 남아 있다)
    await settle();
    act(() => { vi.advanceTimersByTime(3_000); }); // 3초 자동 조회 차례 — 쉰다(끼어들면 받던 첫 쪽을 버리고 한 번 더 받는다)
    await act(async () => { slowB.resolve([gen("b1")]); });
    await settle();
    expect([ids(), calls().list, data.autoRefreshPaused]).toEqual([["b1"], before + 1, false]);

    // 대조: 첫 쪽을 기다리는 중의 실제 변경 통보(직접 다시 받기)는 그대로 받던 쪽을 무효화하고 다시 받는다
    const slowMain = hold<Generation[]>(api.listGenerations);
    show({ query: MAIN, poll: true });
    await settle();
    const before2 = calls().list;
    act(() => { void data.reload(true, true); });
    await act(async () => { slowMain.resolve([running]); });
    await settle();
    expect(calls().list).toBe(before2 + 1);

    // 실패하면 쉬지 않는다 — 다음 주기에 다시 받는다
    vi.mocked(api.listGenerations).mockRejectedValueOnce(new Error("500: boom"));
    show({ query: LOCATED, poll: true });
    await settle();
    expect([data.loadError, data.autoRefreshPaused]).toEqual(["500: boom", false]);
  } finally {
    vi.useRealTimers();
  }
});

// ── 83회차: 걸러 보는 컷 화면이 자료 주인일 때(App 이 owner 로 알린다 — Codex FH) ──
//  이 조회의 목록(200건 원문)은 보내지 않고 주인의 갱신을 기다린다 · 바람(ensure·check·invalidate)은 그대로 넘기되 덮지 않은 내 변경이 있으면 invalidate ·
//  결과가 '적용'이 아니면 내 변경을 덮었다고 적지 않는다 · 더 받기는 보내지 않는다 · 판정이 다른 조회의 것이면 목록도 주인 요청도 보내지 않는다(메타만) ·
//  주인을 되찾으면 같은 조회의 캐시라도 첫 쪽을 다시 받고, 그 전에는 옛 커서로 더 받지 않는다(Codex FE-02·FE-03·FE-09).
it("cut owner — 목록 대신 주인을 기다리고(바람 그대로·내 변경이면 invalidate), 더 받지 않으며, 되찾으면 첫 쪽부터 · 그 전엔 옛 커서를 쓰지 않는다", async () => {
  const page = Array.from({ length: 200 }, (_, index) => ({ ...gen(`p${index}`), sort_ts: 1000 - index }) as Generation);
  vi.mocked(api.listGenerations).mockResolvedValue(page);
  await mount();
  expect(data.hasMore).toBe(true);
  const asked: string[] = [];
  let finish!: () => void;
  const request = vi.fn((intent: string) => {
    asked.push(intent);
    return new Promise<{ status: string; key: string }>((resolve) => { finish = () => resolve({ status: "applied", key: "k" }); });
  });
  ownerNow = { kind: "cut", sig: JSON.stringify([false, MAIN]), key: "k", request };
  const before = calls();
  const polled = start(() => data.reload(true, true, "check"));
  await settle();
  expect([calls().list - before.list, asked, polled.done]).toEqual([0, ["check"], false]); // 주인의 갱신을 기다린다
  await act(async () => { finish(); });
  await settle();
  expect(polled.done).toBe(true);
  request.mockImplementation(async (intent: string) => { asked.push(intent); return { status: "reused", key: "k" }; });
  await act(async () => { await data.reloadIfStale(); }); // 진입 — 탭 캐시로 건너뛰지 않고 주인에게
  await act(async () => { await data.loadMore(); });
  expect([calls().list - before.list, asked]).toEqual([0, ["check", "ensure"]]);
  const origin = createLibraryMutationOrigin("POST")!;
  markMutationDomainsSucceeded(origin, origin.mutation_id, ["library"]);
  await act(async () => { await data.reload(true, true, "ensure"); });
  expect([asked.at(-1), decideLibrarySync([origin])]).toEqual(["invalidate", "reload"]); // 결과가 reused — 덮었다고 적지 않았다
  ownerNow = { ...ownerNow, sig: "다른 조회" };
  await act(async () => { await data.reload(); });
  expect([calls().list - before.list, asked.length]).toEqual([0, 3]);
  ownerNow = { kind: "list", sig: JSON.stringify([false, MAIN]), key: null, request: null };
  await act(async () => { await data.loadMore(); });
  expect(calls().list - before.list).toBe(0); // 아직 새 첫 쪽 전 — 옛 커서로 더 받지 않는다
  await act(async () => { await data.reloadIfStale(); }); // 같은 조회의 캐시(15초 안)라도 다시 받는다
  await settle();
  expect(calls().list - before.list).toBe(1);
  await act(async () => { await data.loadMore(); });
  expect([calls().list - before.list, vi.mocked(api.listGenerations).mock.calls.at(-1)?.[1]]).toEqual([2, { ts: 801, id: "p199" }]);
});
