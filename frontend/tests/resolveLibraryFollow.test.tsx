// @vitest-environment jsdom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, GEN_PAGE } from "../src/api";
import { useLibraryFilters } from "../src/lib/useLibraryFilters";
import { useGenerationLibraryData } from "../src/lib/useGenerationLibraryData";
import { useResolveLibraryFollow } from "../src/lib/useResolveLibraryFollow";
import { useGenerationSelection } from "../src/lib/useGenerationSelection";
import { makeStore } from "../src/lib/storage";
import { locatedItems, mergeLocatedGenerations, type GenerationLocation } from "../src/lib/resolveLibraryLocation";
import type { Generation } from "../src/types";

vi.mock("../src/api", () => ({ GEN_PAGE: 200, api: {
  locateGenerations: vi.fn(), listGenerations: vi.fn(), projects: vi.fn(), facets: vi.fn(),
  generationStats: vi.fn(), listTrash: vi.fn(),
} }));
let root: Root;
let host: HTMLDivElement;
let state: {
  filters: ReturnType<typeof useLibraryFilters>;
  data: ReturnType<typeof useGenerationLibraryData>;
  follow: ReturnType<typeof useResolveLibraryFollow>;
  select: ReturnType<typeof useGenerationSelection>;
};
let enabled = true;
let authKey = "account-a/server-a";
let visible = true;
const store = makeStore("resolve-test.");
const flash = vi.fn();
const gen = (id: string, ts = 1, folder = "e001/c0010"): Generation => ({
  id, sort_ts: ts, project_id: "project-b", project_name: "Project B", folder_path: folder,
  status: "done", shared: true, deleted: false, assets: [], tags: [], auto_tags: [],
} as unknown as Generation);
const target = gen("old-target", 1);
const location = (items = [target], folder: string | null = "e001/c0010"): GenerationLocation => ({
  items, focus_ids: items.map((g) => g.id), project_id: "project-b", folder_path: folder,
});
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); }
function Harness() {
  const filters = useLibraryFilters(store);
  const data = useGenerationLibraryData({ authReady: true, authKey, filters: filters.filters, genQuery: filters.genQuery, flash });
  const select = useGenerationSelection({ resetKey: filters.selectionResetKey });
  const follow = useResolveLibraryFollow({
    filters: filters.filters, enabled, authReady: true, authKey, manualRevision: filters.manualRevision,
    gens: data.gens, locatedVisibleIds: data.locatedVisibleIds,
    followLocation: filters.followLocation, revealLocated: data.revealLocated, canFollow: () => visible,
  });
  const queryKey = JSON.stringify(filters.genQuery);
  useEffect(() => { void data.reloadIfStale(); }, [queryKey, data.reloadIfStale]);
  state = { filters, data, follow, select };
  return null;
}
async function mount(tab = "my") {
  store.setJSON("filtersV2", { tab, project_id: "project-a", folder_path: "original", search: "hidden", __v: "2" });
  store.setJSON("armedFolder", { projectId: "project-a", path: "original" });
  store.setSet("armedAutoTags", new Set(["create-tag"]));
  act(() => root.render(<StrictMode><Harness /></StrictMode>));
  await settle();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); localStorage.clear(); enabled = true; authKey = "account-a/server-a"; visible = true;
  vi.mocked(api.locateGenerations).mockResolvedValue(location());
  vi.mocked(api.listGenerations).mockResolvedValue([]);
  vi.mocked(api.projects).mockResolvedValue({ projects: [], unassigned: 0 } as never);
  vi.mocked(api.facets).mockResolvedValue({ tags: [], auto_tags: [], models: [] } as never);
  vi.mocked(api.generationStats).mockResolvedValue({ failed_count: 0, has_unread: false });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it.each(["my", "team"])("%s: 필터만 해제하고 같은 탭에서 오래된 대상 표시, 생성 설정·수동선택 보존", async (tab) => {
  await mount(tab);
  act(() => state.select.setSelected(new Set(["manual"])));
  const before = state.filters.manualRevision;
  act(() => state.follow.receive([target.id], false));
  await settle();
  expect(state.filters.filters).toEqual({ tab, project_id: "project-b", folder_path: "e001/c0010" });
  expect(state.filters.generationScope).toEqual({ project_id: "project-a", folder_path: "original" });
  expect([...state.filters.armedAutoTags]).toEqual(["create-tag"]);
  expect([...state.filters.filterAutoTags]).toEqual([]);
  expect(state.filters.armedFolder).toEqual({ projectId: "project-a", path: "original" });
  expect(state.filters.manualRevision).toBe(before);
  expect([...state.select.selected]).toEqual(["manual"]);
  expect([...state.follow.highlightedIds]).toEqual([target.id]);
  expect(state.follow.scrollRequest?.generationId).toBe(target.id);
  expect(state.data.gens.map((g) => g.id)).toEqual([target.id]);
  expect(flash).not.toHaveBeenCalled();
});

it.each(["empty", "private", "deleted", "error"])("team %s: 이동·필터해제 없이 무시", async (kind) => {
  await mount("team");
  const before = state.filters.filters;
  if (kind === "error") vi.mocked(api.locateGenerations).mockRejectedValue(new Error("404"));
  else vi.mocked(api.locateGenerations).mockResolvedValue(location(kind === "empty" ? [] : [{ ...target, shared: kind !== "private", deleted: kind === "deleted" }]));
  act(() => state.follow.receive([target.id], false)); await settle();
  expect(state.filters.filters).toBe(before);
  expect(state.follow.highlightedIds.size).toBe(0);
  expect(state.follow.viewedFolder).toBeNull();
  expect(flash).not.toHaveBeenCalled();
});

it.each(["setting", "manual", "account", "server", "tab", "hidden"])("대기 중 %s 변경은 응답을 무효화", async (change) => {
  await mount();
  const response = deferred<GenerationLocation>();
  vi.mocked(api.locateGenerations).mockReturnValueOnce(response.promise);
  act(() => state.follow.receive([target.id], false));
  act(() => {
    if (change === "manual") state.filters.patch({ search: "new manual" });
    if (change === "tab") state.filters.patch({ tab: "team" });
    if (change === "setting") enabled = false;
    if (change === "account" || change === "server") authKey = change;
    if (change === "hidden") visible = false;
    root.render(<StrictMode><Harness /></StrictMode>);
  });
  response.resolve(location()); await settle();
  expect(state.filters.filters.project_id).toBe("project-a");
  expect(state.follow.highlightedIds.size).toBe(0);
});

it("빠른 선택 A/B/C는 A 응답을 버리고 마지막 C만 조회·반영", async () => {
  await mount();
  const response = deferred<GenerationLocation>();
  vi.mocked(api.locateGenerations).mockReturnValueOnce(response.promise);
  act(() => {
    state.follow.receive(["A"], false); state.follow.receive(["B"], false); state.follow.receive(["C"], false);
  });
  expect(api.locateGenerations).toHaveBeenCalledTimes(1);
  vi.mocked(api.locateGenerations).mockResolvedValue(location([gen("C")]));
  response.resolve(location([gen("A")])); await settle();
  expect(vi.mocked(api.locateGenerations).mock.calls.some(([q]) => q.gen_ids.includes("B"))).toBe(false);
  expect([...state.follow.highlightedIds]).toEqual(["C"]);
});

it.each([false, true])("OFF/상한초과(%s)는 현재 표시 항목의 교집합만 강조", async (truncated) => {
  enabled = truncated;
  vi.mocked(api.listGenerations).mockResolvedValue([target]);
  await mount();
  const before = state.filters.filters;
  act(() => state.follow.receive([target.id], truncated)); await settle();
  expect(state.filters.filters).toBe(before);
  expect([...state.follow.highlightedIds]).toEqual([target.id]);
  expect(state.follow.scrollRequest).toBeNull();
});

it("일반 페이지 밖 대상을 정렬·중복제거하고 다음 커서는 200번째 정상행 유지", async () => {
  await mount();
  const page = Array.from({ length: GEN_PAGE }, (_, i) => gen(`page-${i}`, 1000 - i));
  vi.mocked(api.listGenerations).mockResolvedValue(page);
  act(() => state.follow.receive([target.id], false)); await settle();
  expect(state.data.gens).toHaveLength(201);
  expect(state.data.gens.at(-1)?.id).toBe(target.id);
  expect(state.data.hasMore).toBe(true);
  vi.mocked(api.listGenerations).mockResolvedValue([gen("next", 799), target]);
  await act(async () => { await state.data.loadMore(); });
  expect(vi.mocked(api.listGenerations).mock.calls.at(-1)?.[1]).toEqual({ ts: 801, id: "page-199" });
  expect(state.data.gens.filter((item) => item.id === target.id)).toHaveLength(1);
  expect(state.data.gens.at(-2)?.id).toBe("next");
  expect(state.data.hasMore).toBe(false);
});

it.each(["unshare", "moved", "failure"])("기존 주입 대상 %s는 재조회 후 재등장하지 않음", async (kind) => {
  await mount("team");
  act(() => state.follow.receive([target.id], false)); await settle();
  expect(state.data.gens).toHaveLength(1);
  vi.mocked(api.listGenerations).mockResolvedValue([target]); // 늦은 일반 목록도 방어
  if (kind === "failure") vi.mocked(api.locateGenerations).mockRejectedValue(new Error("offline"));
  else vi.mocked(api.locateGenerations).mockResolvedValue(kind === "moved"
    ? { ...location([{ ...target, folder_path: "elsewhere" }]), folder_path: "elsewhere" } : location([]));
  await act(async () => { await state.data.reload(true); });
  expect(state.data.gens).toEqual(kind === "failure" ? [target] : []);
  expect(state.follow.highlightedIds.size).toBe(0);
  expect(state.filters.filters.folder_path).toBe("e001/c0010");
});

it.each(["my", "team"])("%s: 같은 폴더의 이미 표시된 대상은 권한 조회 1회만 하고 정상 페이지를 재사용", async (tab) => {
  const next = gen("next-target", 2);
  vi.mocked(api.listGenerations).mockResolvedValue([next, target]);
  await mount(tab);
  act(() => state.follow.receive([target.id], false)); await settle();
  vi.mocked(api.locateGenerations).mockClear().mockResolvedValue(location([next]));
  vi.mocked(api.listGenerations).mockClear();
  act(() => state.follow.receive([next.id], false)); await settle();
  expect(api.locateGenerations).toHaveBeenCalledTimes(1);
  expect(api.listGenerations).not.toHaveBeenCalled();
  expect([...state.follow.highlightedIds]).toEqual([next.id]);
  expect(state.data.gens.map((item) => item.id)).toEqual([next.id, target.id]);
  // 일반 갱신은 생략하지 않으며, 공유 취소는 다음 조회에서 강조와 주입을 제거한다.
  vi.mocked(api.locateGenerations).mockResolvedValue(location([]));
  await act(async () => { await state.data.reload(true, true); });
  expect(api.locateGenerations).toHaveBeenCalledTimes(2);
  expect(api.listGenerations).toHaveBeenCalledTimes(1);
  expect(state.follow.highlightedIds.size).toBe(0);
  expect(state.data.gens.map((item) => item.id)).toEqual([target.id]);
});

it("같은 폴더라도 목록 밖 대상은 정상 페이지와 권한을 다시 확인한다", async () => {
  vi.mocked(api.listGenerations).mockResolvedValue([target]);
  await mount();
  act(() => state.follow.receive([target.id], false)); await settle();
  const outside = gen("outside-page", 0);
  vi.mocked(api.locateGenerations).mockClear().mockResolvedValue(location([outside]));
  vi.mocked(api.listGenerations).mockClear();
  act(() => state.follow.receive([outside.id], false)); await settle();
  expect(api.locateGenerations).toHaveBeenCalledTimes(2);
  expect(api.listGenerations).toHaveBeenCalledTimes(1);
  expect([...state.follow.highlightedIds]).toEqual([outside.id]);
});

it("같은 위치의 연속 선택은 정상 페이지 캐시 수명을 연장하지 않는다", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
  const next = gen("next-target", 2);
  vi.mocked(api.listGenerations).mockResolvedValue([next, target]);
  await mount();
  act(() => state.follow.receive([target.id], false)); await settle();
  vi.mocked(api.listGenerations).mockClear();
  for (const now of [105_000, 110_000]) {
    clock.mockReturnValue(now);
    vi.mocked(api.locateGenerations).mockResolvedValue(location([next]));
    act(() => state.follow.receive([next.id], false)); await settle();
    expect(api.listGenerations).not.toHaveBeenCalled();
  }
  clock.mockReturnValue(116_000);
  act(() => state.follow.receive([next.id], false)); await settle();
  expect(api.listGenerations).toHaveBeenCalledTimes(1);
});

it("정상 페이지 오류 뒤에는 남은 캐시가 신선해도 다시 조회한다", async () => {
  const next = gen("next-target", 2);
  vi.mocked(api.listGenerations).mockResolvedValue([next, target]);
  await mount();
  act(() => state.follow.receive([target.id], false)); await settle();
  vi.mocked(api.listGenerations).mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await state.data.reload(true, true); });
  expect(state.data.loadError).toBe("offline");
  vi.mocked(api.listGenerations).mockClear();
  vi.mocked(api.locateGenerations).mockResolvedValue(location([next]));
  act(() => state.follow.receive([next.id], false)); await settle();
  expect(api.listGenerations).toHaveBeenCalledTimes(1);
  expect(state.data.loadError).toBeNull();
});

it.each(["search", "trash"])("%s 필터를 해제할 때는 필터 적용 전 캐시를 재사용하지 않는다", async (kind) => {
  vi.mocked(api.listGenerations).mockResolvedValue([target]);
  vi.mocked(api.listTrash).mockResolvedValue([target]);
  await mount();
  act(() => state.follow.receive([target.id], false)); await settle();
  act(() => state.filters.patch(kind === "search" ? { search: "filter" } : { deleted_only: true }));
  await settle();
  vi.mocked(api.listGenerations).mockClear();
  act(() => state.follow.receive([target.id], false)); await settle();
  expect(api.listGenerations).toHaveBeenCalled();
  expect(state.filters.filters.search).toBeUndefined();
  expect(state.filters.filters.deleted_only).toBeUndefined();
  expect([...state.follow.highlightedIds]).toEqual([target.id]);
});

it("탭 이탈·복귀 뒤 도착한 예전 locate는 동일 탭이라도 적용하지 않는다", async () => {
  vi.mocked(api.listGenerations).mockResolvedValue([target]);
  await mount();
  act(() => state.follow.receive([target.id], false)); await settle();
  const response = deferred<GenerationLocation>();
  vi.mocked(api.locateGenerations).mockReturnValueOnce(response.promise);
  act(() => state.follow.receive([target.id], false));
  act(() => state.filters.patch({ tab: "team" })); await settle();
  act(() => state.filters.patch({ tab: "my" })); await settle();
  const rows = state.data.gens;
  response.resolve(location([{ ...target, project_name: "stale" }])); await settle();
  expect(state.data.gens).toBe(rows);
  expect(state.follow.highlightedIds.size).toBe(0);
});

it("재사용은 추가 페이지의 복수 대상·다음 커서·hasMore를 보존한다", async () => {
  await mount();
  const page = Array.from({ length: GEN_PAGE }, (_, i) => gen(`page-${i}`, 1000 - i));
  const nextPage = Array.from({ length: GEN_PAGE }, (_, i) => gen(`next-${i}`, 800 - i));
  vi.mocked(api.listGenerations).mockResolvedValue(page);
  act(() => state.follow.receive([target.id], false)); await settle();
  vi.mocked(api.listGenerations).mockResolvedValue(nextPage);
  await act(async () => { await state.data.loadMore(); });
  vi.mocked(api.listGenerations).mockClear();
  vi.mocked(api.locateGenerations).mockClear().mockResolvedValue(location([page[0], nextPage[0]]));
  act(() => state.follow.receive([page[0].id, nextPage[0].id], false)); await settle();
  expect(api.listGenerations).not.toHaveBeenCalled();
  expect(api.locateGenerations).toHaveBeenCalledTimes(1);
  expect(state.data.gens).toHaveLength(GEN_PAGE * 2 + 1);
  expect(state.data.hasMore).toBe(true);
  expect([...state.follow.highlightedIds]).toEqual([page[0].id, nextPage[0].id]);
  vi.mocked(api.listGenerations).mockResolvedValue([]);
  await act(async () => { await state.data.loadMore(); });
  expect(vi.mocked(api.listGenerations).mock.calls[0][1]).toEqual({ ts: 601, id: "next-199" });
});

it("추가 페이지 로드 도중 선택하면 재사용하지 않고 낡은 추가 페이지를 버린다", async () => {
  vi.mocked(api.listGenerations).mockResolvedValue([target]);
  await mount();
  act(() => state.follow.receive([target.id], false)); await settle();
  const response = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockReturnValueOnce(response.promise);
  let more!: Promise<void>;
  act(() => { more = state.data.loadMore(); });
  vi.mocked(api.listGenerations).mockClear();
  act(() => state.follow.receive([target.id], false)); await settle();
  expect(api.listGenerations).toHaveBeenCalledTimes(1);
  await act(async () => { response.resolve([gen("stale-page")]); await more; });
  expect(state.data.gens.map((item) => item.id)).toEqual([target.id]);
  expect(state.data.loadingMore).toBe(false);
});

it("일반 재조회 도중 선택 변경은 낡은 응답을 버리고 최신 선택으로 다시 검증한다", async () => {
  const next = gen("next-target", 2);
  vi.mocked(api.listGenerations).mockResolvedValue([next, target]);
  await mount("team");
  act(() => state.follow.receive([target.id], false)); await settle();
  const pending = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockReturnValueOnce(pending.promise);
  act(() => { void state.data.reload(true, true); });
  vi.mocked(api.locateGenerations).mockResolvedValue(location([next]));
  act(() => state.follow.receive([next.id], false)); await settle();
  pending.resolve([gen("stale")]); await settle();
  expect(state.data.gens.map((item) => item.id)).toEqual([next.id, target.id]);
  expect([...state.follow.highlightedIds]).toEqual([next.id]);
  expect(state.data.loading).toBe(false);
});

it("프로젝트 루트·상위 폴더에서 복수 대상은 하위 폴더를 포함", () => {
  const items = [target, gen("sibling", 2, "e001/c0020"), gen("other", 3, "e002/c0010")];
  expect(locatedItems(location(items, null), "team")).toHaveLength(3);
  expect(locatedItems(location(items, "e001"), "team").map((g) => g.id)).toEqual([target.id, "sibling"]);
  expect(mergeLocatedGenerations(items, [target]).map((g) => g.id)).toEqual(["other", "sibling", target.id]);
});

it("서버/계정 변경은 주입 목록·캐시를 지우고 옛 응답도 폐기한다", async () => {
  await mount("team");
  act(() => state.follow.receive([target.id], false)); await settle();
  expect(state.data.gens).toHaveLength(1);
  const response = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockReturnValueOnce(response.promise);
  act(() => { void state.data.reload(true); });
  authKey = "different-account/server";
  act(() => root.render(<StrictMode><Harness /></StrictMode>));
  expect(state.data.gens).toEqual([]);
  expect(state.data.hasMore).toBe(false);
  response.resolve([target]); await settle();
  expect(state.data.gens).toEqual([]);
  expect(state.follow.highlightedIds.size).toBe(0);
  vi.mocked(api.listGenerations).mockResolvedValue([]);
  await act(async () => { await state.data.reloadIfStale(); });
  expect(state.data.gens).toEqual([]);
});

it("Resolve 조회 도중 탭 복귀는 신선한 이전 탭 캐시로 즉시 전환한다", async () => {
  await mount("my");
  const mine = gen("my-only", 100);
  vi.mocked(api.listGenerations).mockResolvedValue([mine]);
  act(() => state.filters.followLocation({ project_id: "project-b", folder_path: "e001/c0010" }));
  await settle();
  expect(state.data.gens.map((item) => item.id)).toEqual(["my-only"]);
  vi.mocked(api.listGenerations).mockResolvedValue([]);
  act(() => state.filters.patch({ tab: "team" })); await settle();
  const response = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockReturnValueOnce(response.promise);
  act(() => state.follow.receive([target.id], false)); await settle();
  expect(state.data.gens.map((item) => item.id)).toEqual([target.id]);
  act(() => state.filters.patch({ tab: "my" })); await settle();
  expect(state.data.gens.map((item) => item.id)).toEqual(["my-only"]);
  response.resolve([target]); await settle();
  expect(state.data.gens.map((item) => item.id)).toEqual(["my-only"]);
});
