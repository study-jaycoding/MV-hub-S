// @vitest-environment jsdom
// 색 편집 장부의 남은 두 경로(조작 점검 7회차 R42-color · 규칙 6).
//  목록 전체 재조회 말고도 서버 사본으로 목록의 카드를 갈아 끼우는 길이 둘 있다 —
//   ① 다빈치 선택의 위치 조회(locate 응답을 revealLocated 가 목록에 합친다)
//   ② 생성 완료 뒤의 상세 조회(WS done → getGeneration 응답으로 그 한 장을 갈아 끼운다)
//  둘 다 응답은 '출발할 때의 서버 값'이다. 출발 뒤에 칠한 색을 그 응답이 덮으면 화면이 직전 색으로 돌아가고, 다음 색 키는 그 낡은 값을
//  기준으로 토글을 계산해 **틀린 색을 저장**한다(목록 재조회에서 실측된 것과 같은 고장 — tests/libraryColorReload).
//  규칙은 목록 재조회와 같다: 조회가 **출발할 때** 색 장부의 도장을 찍고, 응답을 합칠 때 '출발 뒤에 칠했거나 저장이 대기 중인 카드'는
//  칠한 색을 지킨다. 값 비교(출발 때의 색과 지금 색이 같은가)로는 안 된다 — 지웠다 다시 칠해 출발 때의 색으로 돌아온 것을 못 본다.
// ③ 은 같은 목록 훅의 다른 문제다 — 한 탭에서 한 편집이 다른 탭의 캐시에 닿지 않던 것(R42-cache, 설명은 그 describe 위).
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, useEffect, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { KEY_COLORS } from "../src/lib/appConstants";
import { createLibraryMutationOrigin, markMutationDomainsSucceeded } from "../src/lib/librarySync";
import type { GenerationLocation } from "../src/lib/resolveLibraryLocation";
import { makeStore } from "../src/lib/storage";
import { useGenerationKeyboardActions } from "../src/lib/useGenerationKeyboardActions";
import { useGenerationLibraryData } from "../src/lib/useGenerationLibraryData";
import { useGenerationProgress } from "../src/lib/useGenerationProgress";
import { useLibraryFilters } from "../src/lib/useLibraryFilters";
import { useResolveLibraryFollow } from "../src/lib/useResolveLibraryFollow";
import type { Generation, WorkspaceContext } from "../src/types";

const ws = vi.hoisted(() => ({ send: null as null | ((message: unknown) => void) }));
vi.mock("../src/api", () => ({ GEN_PAGE: 200, api: {
  listGenerations: vi.fn(), projects: vi.fn(), facets: vi.fn(), generationStats: vi.fn(), listTrash: vi.fn(),
  locateGenerations: vi.fn(), setColorsBatch: vi.fn(), getGeneration: vi.fn(),
}, connectProgress: (listener: (message: unknown) => void) => { ws.send = listener; return () => { ws.send = null; }; } }));

const store = makeStore("round7-color.");
const noop = () => {};
// 보던 폴더 안의 카드 한 장 — 위치 조회의 대상이자 색 키의 대상.
const card = (color: string | null, extra: Record<string, unknown> = {}) => ({
  id: "g1", sort_ts: 10, project_id: "project-b", project_name: "Project B", folder_path: "e001/c0010",
  status: "done", shared: true, deleted: false, assets: [], tags: [], auto_tags: [], color, prompt: "p", ...extra,
}) as unknown as Generation;
const location = (item: Generation): GenerationLocation => ({
  items: [item], focus_ids: [item.id], project_id: "project-b", folder_path: "e001/c0010",
});

let root: Root;
let host: HTMLDivElement;
let state: {
  data: ReturnType<typeof useGenerationLibraryData>; follow: ReturnType<typeof useResolveLibraryFollow>;
  filters: ReturnType<typeof useLibraryFilters>;
};
const selected = new Set<string>(); // 고른 카드 — 시험마다 g1 으로 시작한다
let workspace: WorkspaceContext | undefined; // 고른 워크스페이스 — 있으면 공유 & 리뷰 탭의 목록이 그 공간을 따른다(제품은 늘 있다)
// 화면에 반영된 렌더마다 한 줄 — 탭·카드 수·받는 중 여부. 격자는 0장이고 받는 중이 아니면 "항목이 없습니다"를, 받는 중이면 "불러오는 중…"을 그린다.
const frames: Array<{ tab: string; ids: string; count: number; loading: boolean }> = [];
// App 과 같은 배선 — 목록 훅 하나에 색 키·진행 WS·위치 따라가기가 붙고, 셋 다 목록 훅의 색 장부를 받는다.
function Harness() {
  const filters = useLibraryFilters(store, workspace);
  const data = useGenerationLibraryData({
    authReady: filters.workspaceQueryReady, authKey: "a", filters: filters.filters, genQuery: filters.genQuery, flash: noop,
    workspaceScopeKey: filters.workspaceScopeKey,
  });
  useLayoutEffect(() => {
    frames.push({ tab: filters.filters.tab, ids: data.gens.map((item) => item.id).join(","), count: data.gens.length, loading: data.loading });
  });
  const selectedRef = useRef(selected);
  useGenerationKeyboardActions({
    clearSelect: noop, filtersRef: data.filtersRef, flash: noop, gensRef: data.gensRef, reload: data.reload, selectedRef,
    setGens: data.setGens, colorLedger: data.colorLedger,
  });
  useGenerationProgress({
    enabled: true, gens: data.gens, scopeKey: "a", setGens: data.setGens, reload: data.reload, colorLedger: data.colorLedger,
    bumpBoard: noop, setSyncTick: noop, historyBoardVisible: false, commentsVisible: false,
  });
  const follow = useResolveLibraryFollow({
    filters: filters.filters, enabled: true, authReady: true, authKey: "a", manualRevision: filters.manualRevision,
    gens: data.gens, locatedVisibleIds: data.locatedVisibleIds, followLocation: filters.followLocation,
    revealLocated: data.revealLocated, colorLedger: data.colorLedger, canFollow: () => true,
  });
  const queryKey = JSON.stringify(filters.genQuery);
  useEffect(() => { void data.reloadIfStale(); }, [queryKey, filters.workspaceScopeKey, data.reloadIfStale]);
  state = { data, follow, filters };
  return null;
}
const settle = async () => { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
// 처음부터 그 폴더를 보고 있다 — 위치 조회가 필터를 옮기지 않고(같은 보기) 신선한 쪽을 그대로 쓴다.
async function mount(first: Generation) {
  vi.mocked(api.listGenerations).mockResolvedValue([first]);
  store.setJSON("filtersV2", { tab: "my", project_id: "project-b", folder_path: "e001/c0010", __v: "2" });
  act(() => root.render(<Harness />));
  await settle();
  expect(state.data.gens.map((item) => item.id)).toEqual(["g1"]);
}
const press = async (key: string) => {
  act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  await settle(); // 화면은 바로 바뀌고 저장도 끝난다
};
const shown = (id = "g1") => state.data.gens.find((item) => item.id === id);
const color = (id = "g1") => shown(id)?.color ?? null;
const saved = () => vi.mocked(api.setColorsBatch).mock.calls.map((call) => call[1]);
const lists = () => vi.mocked(api.listGenerations).mock.calls.length;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  selected.clear();
  selected.add("g1");
  workspace = undefined;
  for (const call of Object.values(api)) vi.mocked(call as () => unknown).mockReset();
  vi.mocked(api.projects).mockResolvedValue({ projects: [], unassigned: 0 } as never);
  vi.mocked(api.facets).mockResolvedValue({ tags: [], auto_tags: [], models: [] } as never);
  vi.mocked(api.generationStats).mockResolvedValue({ failed_count: 0, has_unread: false } as never);
  vi.mocked(api.setColorsBatch).mockResolvedValue({ succeeded: ["g1"], failed: [] } as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("① 위치 조회(다빈치 선택 따라가기)의 응답", () => {
  // 위치 조회가 출발했다(응답은 아직) — 다빈치에서 클립을 고른 직후
  const depart = () => {
    const held = deferred<GenerationLocation>();
    vi.mocked(api.locateGenerations).mockReturnValueOnce(held.promise);
    act(() => state.follow.receive(["g1"], false));
    expect(api.locateGenerations).toHaveBeenCalledTimes(1);
    return async (answer: Generation) => { await act(async () => { held.resolve(location(answer)); }); await settle(); };
  };

  it("출발 뒤에 칠한 색을 덮지 않는다 — 다음 키의 토글 기준도 틀어지지 않는다", async () => {
    await mount(card(null));
    const arrive = depart();
    await press("r");
    expect(color()).toBe(KEY_COLORS.r);
    const before = lists();

    await arrive(card(null, { prompt: "새 프롬프트" })); // 출발할 때의 서버 값 = 색 없음
    expect(color()).toBe(KEY_COLORS.r);
    expect(shown()?.prompt).toBe("새 프롬프트"); // 색 말고는 응답대로 받는다
    expect([...state.follow.highlightedIds]).toEqual(["g1"]);
    expect(lists()).toBe(before); // 신선한 쪽을 그대로 쓰는 길 — 뒤따라 바로잡아 줄 재조회가 없다

    await press("r"); // 빨강인 카드에 r = 해제. 낡은 값(색 없음)이 기준이었다면 빨강을 또 저장한다
    expect(color()).toBeNull();
    expect(saved()).toEqual([KEY_COLORS.r, null]);
  });

  it("지웠다 다시 칠해 출발 때의 색으로 돌아온 것도 지킨다 — 값 비교로는 못 보는 순서", async () => {
    await mount(card(KEY_COLORS.r)); // 전에 칠해 둔 빨강
    const arrive = depart();
    await press("r"); // 지움
    await press("r"); // 다시 빨강
    expect(color()).toBe(KEY_COLORS.r);

    await arrive(card(null)); // 서버가 두 저장 사이에 답했다 = 색 없음
    expect(color()).toBe(KEY_COLORS.r);

    await press("r");
    expect(color()).toBeNull();
    expect(saved()).toEqual([null, KEY_COLORS.r, null]);
  });

  it("칠하고 저장까지 끝난 뒤에 출발한 조회는 서버 값을 그대로 받는다 — 보호가 다른 곳의 변경을 막지 않는다", async () => {
    await mount(card(null));
    await press("r");
    expect(color()).toBe(KEY_COLORS.r);
    const arrive = depart();
    await arrive(card(KEY_COLORS.b)); // 다른 창에서 파랑으로 바꿨다
    expect(color()).toBe(KEY_COLORS.b);
  });

  // 목록 재조회는 뒤에 출발한 조회가 앞의 것을 버려 주지만, 위치 조회의 응답은 복구 재조회 뒤에도 살아서 도착한다.
  it("저장에 실패해 서버 값으로 되돌린 뒤에 도착해도 실패한 색을 되살리지 않는다", async () => {
    await mount(card(null));
    const arrive = depart();
    vi.mocked(api.setColorsBatch).mockResolvedValueOnce({ succeeded: [], failed: ["g1"] } as never);
    await press("r"); // 화면은 빨강 → 저장 실패 → 복구 재조회가 서버 값(색 없음)으로 되돌린다
    expect(color()).toBeNull();
    await arrive(card(null));
    expect(color()).toBeNull();
  });

  it("그사이 재조회가 받아들인 더 새 서버 값을 옛 칠한 색으로 되돌리지 않는다", async () => {
    await mount(card(null));
    const arrive = depart();
    await press("r");
    vi.mocked(api.listGenerations).mockResolvedValue([card(KEY_COLORS.b)]); // 저장이 끝난 뒤 다른 창에서 파랑으로 바꿨다
    await act(async () => { await state.data.reload(true); });
    await settle();
    expect(color()).toBe(KEY_COLORS.b);
    await arrive(card(null)); // 그 모든 것보다 먼저 출발한 응답
    expect(color()).toBe(KEY_COLORS.b);
  });
});

describe("② 생성 완료 뒤 상세 조회(WS done)의 응답", () => {
  // 완료 통지가 왔다 → 상세 조회가 출발했다(응답은 아직)
  const depart = () => {
    const held = deferred<Generation>();
    vi.mocked(api.getGeneration).mockReturnValueOnce(held.promise);
    act(() => ws.send!({ type: "progress", generation_id: "g1", status: "done" }));
    expect(api.getGeneration).toHaveBeenCalledTimes(1);
    expect(shown()?.status).toBe("done");
    return async (answer: Generation) => { await act(async () => { held.resolve(answer); }); await settle(); };
  };
  const done = (value: string | null) => card(value, { status: "done", assets: [{ id: "asset-1" }] });

  it("출발 뒤에 칠한 색을 덮지 않는다(값 비교가 이미 막던 순서 — 그대로인지 고정)", async () => {
    await mount(card(null, { status: "running" }));
    const arrive = depart();
    await press("r");
    await arrive(done(null));
    expect(color()).toBe(KEY_COLORS.r);
    expect(shown()?.assets).toEqual([{ id: "asset-1" }]); // 색 말고는 응답대로 받는다
  });

  it("지웠다 다시 칠해 출발 때의 색으로 돌아온 것도 지킨다 — 값 비교가 놓치던 순서", async () => {
    await mount(card(KEY_COLORS.r, { status: "running" })); // 생성 중에 칠해 둔 빨강
    const arrive = depart();
    await press("r"); // 지움
    await press("r"); // 다시 빨강
    expect(color()).toBe(KEY_COLORS.r);

    await arrive(done(null)); // 서버가 두 저장 사이에 답했다 = 색 없음
    expect(color()).toBe(KEY_COLORS.r);
    expect(shown()?.assets).toEqual([{ id: "asset-1" }]);

    await press("r"); // 빨강인 카드에 r = 해제. 화면이 '색 없음'으로 돌아가 있었다면 빨강을 또 저장한다
    expect(color()).toBeNull();
    expect(saved()).toEqual([null, KEY_COLORS.r, null]);
  });

  it("칠하고 저장까지 끝난 뒤에 출발한 조회는 서버 값을 그대로 받는다", async () => {
    await mount(card(null, { status: "running" }));
    await press("r");
    const arrive = depart();
    await arrive(done(KEY_COLORS.b)); // 다른 창에서 파랑으로 바꿨다
    expect(color()).toBe(KEY_COLORS.b);
  });

  it("저장에 실패해 서버 값으로 되돌린 뒤에 도착해도 실패한 색을 되살리지 않는다", async () => {
    await mount(card(null, { status: "running" }));
    const arrive = depart();
    vi.mocked(api.listGenerations).mockResolvedValue([done(null)]); // 복구 재조회가 받을 서버 값
    vi.mocked(api.setColorsBatch).mockResolvedValueOnce({ succeeded: [], failed: ["g1"] } as never);
    await press("r");
    expect(color()).toBeNull();
    await arrive(done(null));
    expect(color()).toBeNull();
    expect(shown()?.assets).toEqual([{ id: "asset-1" }]);
  });
});

// 탭마다 목록 캐시가 따로 있고, 15초 안에 돌아온 탭은 다시 받지 않고 캐시를 그대로 그린다(reloadIfStale). 한 탭에서 한 편집은 그 탭의
//  캐시만 고쳤다 → 다른 탭으로 가면 옛 값이 보이고, '작업 공간' 탭은 주기 조회도 없어 그대로 남았다(격리 실측 10/10 — 45초 내내 옛 색).
//  계약: 편집·내 변경이 있었으면 다른 탭의 캐시는 낡은 것이다 — 다음에 그 탭으로 가면 한 번 다시 받고, 값은 서버가 준다.
//  다른 탭 캐시에 값을 옮겨 적지는 않는다. 같은 생성물이라도 탭마다 카드 id 가 다르고(공유 & 리뷰의 카드 id 는 공유 서버의 것), job_id 가
//  같은 별개의 카드도 있다 — 프론트가 '같은 카드'를 추측해 쓰면 화면과 저장이 어긋나거나 엉뚱한 카드를 칠한다(Codex 리뷰의 재현 둘).
describe("③ 한 탭에서 한 편집과 다른 탭의 캐시(R42-cache)", () => {
  const server = { color: null as string | null }; // 서버가 아는 색 — 색 저장이 바꾼다
  let sameId = false; // 공유 서버 없이 도는 환경(격리 실측)에서는 두 탭의 카드 id 가 같다
  const row = (tab: string) => card(server.color, {
    job_id: "job-1", workspace_scope: "team", workspace_id: "a", ...(tab === "team" && !sameId ? { id: "srv-1" } : {}),
  });
  let rows = (tab: string) => [row(tab)]; // 탭마다 서버가 주는 목록
  const teamId = () => (sameId ? "g1" : "srv-1");
  const listsOf = (tab: string) => vi.mocked(api.listGenerations).mock.calls.filter(([query]) => query.tab === tab).length;
  const pick = (id: string) => { selected.clear(); selected.add(id); };
  const go = async (tab: "my" | "team") => { act(() => state.filters.patch({ tab })); await settle(); };
  // 다음 목록 조회 한 번을 멈춰 둔다 — 탭을 옮긴 직후, 새 응답이 오기 전의 화면을 본다
  const holdList = () => {
    const held = deferred<Generation[]>();
    vi.mocked(api.listGenerations).mockImplementationOnce(() => held.promise);
    return async (answer: Generation[]) => { await act(async () => { held.resolve(answer); }); await settle(); };
  };
  // 서버의 변경 통보(WS synced) — 0.4초 모았다가 지금 탭을 다시 받게 한다(lib/useGenerationProgress)
  const notifyChanged = async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => { ws.send!({ type: "synced" }); vi.advanceTimersByTime(500); });
    vi.useRealTimers();
    await settle();
  };
  // 두 탭을 한 번씩 열어 둘 다 캐시에 담는다 → 지금은 공유 & 리뷰
  async function bothTabsCached() {
    vi.mocked(api.listGenerations).mockImplementation((query) => Promise.resolve(rows(query.tab)));
    vi.mocked(api.setColorsBatch).mockImplementation(async (ids, value) => { server.color = value; return { succeeded: ids, failed: [] } as never; });
    store.setJSON("filtersV2", { tab: "my", __v: "2" });
    act(() => root.render(<Harness />));
    await settle();
    await go("team");
    expect(state.data.gens.map((item) => item.id)).toEqual([teamId()]);
    expect([listsOf("my"), listsOf("team")]).toEqual([1, 1]);
  }
  beforeEach(() => { server.color = null; sameId = false; rows = (tab) => [row(tab)]; });

  it.each([
    ["두 탭의 카드 id 가 다르다(공유 서버가 붙은 환경)", false],
    ["두 탭의 카드 id 가 같다(격리 환경)", true],
  ])("편집 뒤 15초 안에 다른 탭으로 가면 한 번 다시 받고 서버 값이 보인다 — %s", async (_shape, same) => {
    sameId = same;
    await bothTabsCached();
    pick(teamId());
    await press("r"); // 저장까지 끝났다 — 서버도 빨강
    expect(color(teamId())).toBe(KEY_COLORS.r);

    const arrive = holdList();
    await go("my"); // 15초 안 — 전에는 다시 받지 않고 옛 캐시(색 없음)를 그대로 뒀다
    expect(listsOf("my")).toBe(2);
    await arrive(rows("my"));
    expect(color()).toBe(KEY_COLORS.r);

    pick("g1");
    await press("r"); // 빨강인 카드에 r = 해제. 옛 색(색 없음)이 남아 있었다면 빨강을 또 저장한다
    expect(color()).toBeNull();
    expect(saved()).toEqual([KEY_COLORS.r, null]);
    await go("team"); // 반대 방향도 같다 — 방금의 편집 때문에 공유 & 리뷰도 다시 받는다
    expect(listsOf("team")).toBe(2);
    expect(color(teamId())).toBeNull();
  });

  it("색이 아닌 편집(태그·진행 상태·목록에서 빠진 카드)도 다른 탭을 다시 받게 한다", async () => {
    await bothTabsCached();
    // 태그 편집(lib/useGenerationTagActions)이 목록을 고치는 방식 그대로
    act(() => state.data.setGens((previous) => previous.map((item) => ({ ...item, tags: ["hero"] }))));
    await go("my");
    expect(listsOf("my")).toBe(2);
    act(() => ws.send!({ type: "progress", generation_id: "g1", status: "failed", error: "boom" })); // 진행 통지
    expect(shown()?.status).toBe("failed");
    await go("team");
    expect(listsOf("team")).toBe(2);
    act(() => state.data.setGens((previous) => previous.filter((item) => item.id !== "srv-1"))); // 보던 공간에서 빠진 카드
    await go("my");
    expect(listsOf("my")).toBe(3);
  });

  it("바뀐 것이 없는 갱신·새 카드 붙이기는 다른 탭의 캐시를 건드리지 않는다 — 짧은 탭 왕복은 전처럼 다시 받지 않는다", async () => {
    await bothTabsCached();
    act(() => state.data.setGens((previous) => previous.map((item) => ({ ...item })))); // 값이 같은 새 객체(코멘트 배지 폴링 등)
    act(() => state.data.setGens((previous) => [card(null, { id: "new-1", job_id: "job-9" }), ...previous])); // 방금 만든 생성물
    await go("my");
    expect(color()).toBeNull();
    expect(listsOf("my")).toBe(1);
  });

  it("내 변경(삭제·공유처럼 목록을 다시 받는 것)을 담은 재조회가 출발하면 다른 탭의 캐시도 낡은 것이 된다", async () => {
    await bothTabsCached();
    const origin = createLibraryMutationOrigin("DELETE")!; // api 계층이 변경 요청마다 하는 일 — 서버가 성공을 되돌려줬다
    markMutationDomainsSucceeded(origin, origin.mutation_id, ["library"]);
    await act(async () => { await state.data.reload(); }); // 삭제·공유 동작은 끝나면 지금 탭을 다시 받는다
    await go("my");
    expect(listsOf("my")).toBe(2);
  });

  it("저장이 끝나기 전에 탭을 옮겨도 화면과 저장이 어긋나지 않는다 — 다른 탭 캐시에 색을 옮겨 적지 않는다(Codex 재현 1)", async () => {
    await bothTabsCached();
    const save = deferred<{ succeeded: string[]; failed: string[] }>();
    vi.mocked(api.setColorsBatch).mockImplementationOnce(() => save.promise as never);
    pick("srv-1");
    await press("r"); // 공유 & 리뷰의 카드는 빨강, 저장은 아직 대기

    const arrive = holdList();
    await go("my"); // 서버가 아직 색을 모를 때 이 탭의 재조회가 출발한다
    expect(color()).toBeNull(); // 옮겨 적은 색이 없다 — 첫 화면은 이 탭이 알던 값이다
    await arrive(rows("my"));
    expect(color()).toBeNull();

    pick("g1");
    await press("r"); // 화면이 '색 없음'이니 r 은 빨강을 칠한다
    expect(color()).toBe(KEY_COLORS.r);
    server.color = KEY_COLORS.r;
    await act(async () => { save.resolve({ succeeded: ["srv-1"], failed: [] }); });
    await settle();
    expect(saved()).toEqual([KEY_COLORS.r, KEY_COLORS.r]); // 두 저장 모두 누를 때 화면에 보이던 색을 기준으로 했다

    await notifyChanged(); // 저장의 통보가 지금 탭을 다시 받게 한다
    expect(listsOf("my")).toBe(3);
    expect(color()).toBe(server.color);
  });

  it("job_id 가 같은 별개의 카드는 칠해지지 않는다(Codex 재현 2)", async () => {
    // 실패한 카드 A 와 정상 결과 B 가 같은 job_id 를 갖고, B 만 공유돼 있다
    const failedA = () => card(null, { id: "a1", job_id: "job-1", status: "failed", sort_ts: 9 });
    rows = (tab) => (tab === "team" ? [row("team")] : [row("my"), failedA()]);
    await bothTabsCached();
    pick("srv-1");
    await press("r"); // B 만 칠했다

    const arrive = holdList();
    await go("my");
    expect(color("a1")).toBeNull(); // 응답이 오기 전의 첫 화면에서도
    await arrive(rows("my"));
    expect([color("g1"), color("a1")]).toEqual([KEY_COLORS.r, null]);
  });

  it("칠함 → 탭 전환 → 그 탭의 재조회 응답 → 토글: 카드 id 가 같으면 색 장부가 탭을 넘어 지킨다 — 저장 전에 출발한 응답이 칠한 색을 지우지 않는다", async () => {
    sameId = true;
    await bothTabsCached();
    const save = deferred<{ succeeded: string[]; failed: string[] }>();
    vi.mocked(api.setColorsBatch).mockImplementationOnce(() => save.promise as never);
    await press("r"); // 저장은 아직 대기

    const arrive = holdList();
    await go("my"); // 이 탭의 재조회는 서버가 아직 색을 모를 때 출발한다
    await arrive(rows("my"));
    expect(color()).toBe(KEY_COLORS.r); // 저장이 대기 중인 카드 — 장부(목록 훅에 하나, 키는 카드 id)가 칠한 색을 지킨다

    await act(async () => { save.resolve({ succeeded: ["g1"], failed: [] }); });
    await settle();
    await press("r");
    expect(color()).toBeNull();
    expect(saved()).toEqual([KEY_COLORS.r, null]);
  });

  // 낡은 것으로 표시한 캐시도 그 탭의 첫 화면에는 쓴다 — 표시가 '캐시를 비운 것'처럼 굴면 편집할 때마다 빈 화면이 번쩍인다
  //  (격리 실측 2026-10-11: 편집 뒤 공유 & 리뷰로 가면 "항목이 없습니다" → "불러오는 중…" → 카드, 0장인 구간 65~74ms).
  const emptyFrames = () => frames.filter((frame) => frame.count === 0);
  describe("공유 & 리뷰로 들어가는 첫 화면 — 고른 워크스페이스가 있을 때(제품의 경로)", () => {
    beforeEach(() => { workspace = { scope: "team", id: "a", name: "R&D" }; });

    it.each([
      ["편집으로 낡은 것이 된 캐시", false],
      ["15초가 지난 캐시(전부터 있던 빈 화면)", true],
    ])("%s 도 첫 화면에 쓰고 그 위에서 다시 받는다 — 카드가 0장인 화면이 없다", async (_what, aged) => {
      await bothTabsCached();
      await go("my");
      let clock: { mockRestore: () => void } | null = null;
      if (aged) {
        const later = Date.now() + 20_000;
        clock = vi.spyOn(Date, "now").mockReturnValue(later);
      } else {
        pick("g1");
        await press("b"); // 작업 공간에서 한 편집 — 공유 & 리뷰의 캐시는 낡은 것이 된다
      }
      try {
        frames.length = 0;
        const arrive = holdList();
        await go("team");
        expect(listsOf("team")).toBe(2); // 다시 받는 중이다
        expect(state.data.loading).toBe(true);
        expect(state.data.gens.map((item) => item.id)).toEqual(["srv-1"]); // 그동안 보이는 것은 옛 목록
        await arrive(rows("team"));
        expect(color("srv-1")).toBe(aged ? null : KEY_COLORS.b); // 응답이 서버 값으로 갈아 끼운다
        expect(emptyFrames()).toEqual([]);
      } finally {
        clock?.mockRestore();
      }
    });

    it("캐시가 없어 비우고 받는 동안은 '받는 중'이다 — 0장인데 받는 중이 아닌 화면(\"항목이 없습니다\")이 없다", async () => {
      vi.mocked(api.listGenerations).mockImplementation((query) => Promise.resolve(rows(query.tab)));
      store.setJSON("filtersV2", { tab: "my", __v: "2" });
      act(() => root.render(<Harness />));
      await settle();
      frames.length = 0;
      const arrive = holdList();
      await go("team"); // 공유 & 리뷰를 처음 연다
      expect(emptyFrames().length).toBeGreaterThan(0); // 비우는 길을 탔다
      expect(emptyFrames().filter((frame) => !frame.loading)).toEqual([]);
      await arrive(rows("team"));
      expect(state.data.gens.map((item) => item.id)).toEqual(["srv-1"]);
      expect(state.data.loading).toBe(false);
    });

    it("다른 워크스페이스에서 받아 둔 캐시는 전처럼 쓰지 않는다 — 비우고 받는다", async () => {
      await bothTabsCached();
      await go("my");
      workspace = { scope: "team", id: "b", name: "Studio" }; // 작업 공간 탭에 있는 동안 워크스페이스를 바꿨다
      act(() => root.render(<Harness />));
      await settle();
      frames.length = 0;
      const arrive = holdList();
      await go("team");
      expect(frames.filter((frame) => frame.ids.includes("srv-1"))).toEqual([]); // 옛 공간의 카드가 비치지 않는다
      expect(emptyFrames().length).toBeGreaterThan(0);
      expect(emptyFrames().filter((frame) => !frame.loading)).toEqual([]);
      await arrive([]);
      expect(state.data.gens).toEqual([]);
    });

    it("워크스페이스를 아직 모르면(조회를 할 수 없다) '받는 중'으로 남지 않는다 — 내려 줄 조회가 없다", async () => {
      workspace = { scope: "unknown", id: null, name: null };
      vi.mocked(api.listGenerations).mockImplementation((query) => Promise.resolve(rows(query.tab)));
      store.setJSON("filtersV2", { tab: "my", __v: "2" });
      act(() => root.render(<Harness />));
      await settle();
      await go("team");
      expect(listsOf("team")).toBe(0);
      expect(state.data.loading).toBe(false);
    });
  });

  it("작업 공간도 같다 — 캐시가 없어 비우고 받는 동안은 '받는 중'이다", async () => {
    vi.mocked(api.listGenerations).mockImplementation((query) => Promise.resolve(rows(query.tab)));
    store.setJSON("filtersV2", { tab: "team", __v: "2" });
    act(() => root.render(<Harness />));
    await settle();
    frames.length = 0;
    const arrive = holdList();
    await go("my"); // 작업 공간을 처음 연다
    expect(emptyFrames().length).toBeGreaterThan(0);
    expect(emptyFrames().filter((frame) => !frame.loading)).toEqual([]);
    await arrive(rows("my"));
    expect(state.data.gens.map((item) => item.id)).toEqual(["g1"]);
    expect(state.data.loading).toBe(false);
  });
});

// 위 시험들은 훅에 장부를 직접 넘긴다. 제품에서 넘기는 곳은 App 하나라, 그 배선이 빠지면 두 경로는 조용히 옛 동작으로 돌아간다.
it("App 은 색 장부를 위치 따라가기·진행 WS 훅에 넘긴다", () => {
  const app = readFileSync(new NodeURL("../src/App.tsx", import.meta.url), "utf8");
  for (const hook of ["useResolveLibraryFollow", "useGenerationProgress"]) {
    const call = new RegExp(`${hook}\\(\\{[\\s\\S]*?\\n  \\}\\);`).exec(app)?.[0] ?? "";
    expect(call, `App.tsx 의 ${hook}({ ... }) 에 colorLedger 를 넘겨야 한다`).toMatch(/\bcolorLedger\b/);
  }
});
