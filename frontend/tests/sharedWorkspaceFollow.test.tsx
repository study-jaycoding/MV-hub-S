// @vitest-environment jsdom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { makeStore } from "../src/lib/storage";
import { useLibraryFilters } from "../src/lib/useLibraryFilters";
import { useGenerationLibraryData } from "../src/lib/useGenerationLibraryData";
import { useGenerationSelection } from "../src/lib/useGenerationSelection";
import { useResolveLibraryFollow } from "../src/lib/useResolveLibraryFollow";
import { matchesWorkspaceFilter } from "../src/lib/libraryWorkspaceScope";
import type { Generation, WorkspaceContext } from "../src/types";
import type { GenerationLocation } from "../src/lib/resolveLibraryLocation";

vi.mock("../src/api", () => ({ GEN_PAGE: 200, api: {
  locateGenerations: vi.fn(), listGenerations: vi.fn(), projects: vi.fn(), facets: vi.fn(),
  generationStats: vi.fn(), listTrash: vi.fn(),
} }));
const store = makeStore("workspace-auto-test.");
const A: WorkspaceContext = { scope: "team", id: "a", name: "R&D" };
const B: WorkspaceContext = { scope: "team", id: "b", name: "Studio" };
const personal: WorkspaceContext = { scope: "personal", id: null, name: null };
let workspace: WorkspaceContext;
let root: Root;
let host: HTMLDivElement;
let state: {
  filters: ReturnType<typeof useLibraryFilters>;
  data: ReturnType<typeof useGenerationLibraryData>;
  select: ReturnType<typeof useGenerationSelection>;
  follow: ReturnType<typeof useResolveLibraryFollow>;
};
function gen(id: string, scope: WorkspaceContext, creator = "one"): Generation {
  return { id, sort_ts: 10, creator_uid: creator, workspace_scope: scope.scope, workspace_id: scope.id,
    status: "done", shared: true, deleted: false, assets: [], tags: [], auto_tags: [],
    project_id: "project-" + (scope.id || "personal"), folder_path: "shots" } as unknown as Generation;
}
const cards = [gen("a1", A), gen("b1", B), gen("p1", personal), gen("p2", personal, "two"),
  gen("legacy", { scope: "unknown", id: null, name: null })];
function location(items: Generation[], ack: boolean | undefined = true): GenerationLocation {
  return { items, focus_ids: items.map((item) => item.id), project_id: items[0]?.project_id || null,
    folder_path: "shots", workspace_filter_applied: ack };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function Harness() {
  const filters = useLibraryFilters(store, workspace);
  const data = useGenerationLibraryData({ authReady: filters.workspaceQueryReady,
    filters: filters.filters, genQuery: filters.genQuery, flash: () => {},
    workspaceScopeKey: filters.workspaceScopeKey });
  const select = useGenerationSelection({ resetKey: filters.selectionResetKey });
  const follow = useResolveLibraryFollow({ filters: filters.filters, enabled: true,
    authReady: filters.workspaceQueryReady, authKey: "test", manualRevision: filters.manualRevision,
    workspaceFilter: filters.filters.tab === "team" ? filters.genQuery : undefined,
    workspaceScopeKey: filters.workspaceScopeKey, gens: data.gens,
    locatedVisibleIds: data.locatedVisibleIds, followLocation: filters.followLocation,
    revealLocated: data.revealLocated, canFollow: () => true });
  const key = JSON.stringify(filters.genQuery);
  useEffect(() => { void data.reloadIfStale(); }, [key, filters.workspaceScopeKey,
    filters.workspaceQueryReady, data.reloadIfStale]);
  state = { filters, data, select, follow };
  return <div>{data.gens.map((g) => <span key={g.id}>{g.id}</span>)}</div>;
}
async function settle() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }
function render() { act(() => root.render(<StrictMode><Harness /></StrictMode>)); }
async function mount(tab = "team") {
  store.setJSON("filtersV2", { tab, workspace_ids: ["saved-manual"], __v: "2" });
  store.setJSON("generationScopeV1", { project_id: "create", folder_path: "destination" });
  store.setSet("armedAutoTags", new Set(["create-tag"]));
  render(); await settle();
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); localStorage.clear(); workspace = A;
  vi.mocked(api.listGenerations).mockImplementation(async (q) => cards.filter((g) => matchesWorkspaceFilter(g, q)));
  vi.mocked(api.locateGenerations).mockImplementation(async (q) => location(cards.filter((g) => q.gen_ids.includes(g.id) && matchesWorkspaceFilter(g, q))));
  vi.mocked(api.projects).mockResolvedValue({ projects: [], unassigned: 0 } as never);
  vi.mocked(api.facets).mockResolvedValue({ tags: [], auto_tags: [], models: [] } as never);
  vi.mocked(api.generationStats).mockResolvedValue({ failed_count: 0, has_unread: false });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("휴지통에서 공간 밖 페이지가 전부 숨겨져도 원본 offset으로 전진해 끝에서 멈춘다", async () => {
  const trash = Array.from({ length: 400 }, (_, i) => ({ ...gen(`legacy-${i}`, { scope: "unknown", id: null, name: null }), deleted: true }));
  trash.push({ ...gen("a-deleted", A), deleted: true });
  vi.mocked(api.listTrash).mockImplementation(async (_search, offset = 0) => trash.slice(offset, offset + 200));
  await mount();
  act(() => state.filters.patch({ deleted_only: true })); await settle();
  expect(state.data.gens).toEqual([]);
  expect(state.data.hasMore).toBe(true);
  expect(vi.mocked(api.listTrash).mock.calls.at(-1)?.[1]).toBe(0);
  vi.mocked(api.listTrash).mockClear();
  await act(async () => { await state.data.loadMore(); });
  expect(state.data.gens).toEqual([]);
  await act(async () => { await state.data.loadMore(); });
  expect(state.data.gens.map((g) => g.id)).toEqual(["a-deleted"]);
  expect(state.data.hasMore).toBe(false);
  expect(vi.mocked(api.listTrash).mock.calls.map((call) => call[1])).toEqual([200, 400]);
});

it("일부만 보이는 휴지통과 탭 캐시도 숨긴 행을 포함한 offset을 유지한다", async () => {
  const trash = Array.from({ length: 600 }, (_, i) => ({ ...gen(`trash-${i}`, i % 2 ? B : A), deleted: true }));
  vi.mocked(api.listTrash).mockImplementation(async (_search, offset = 0) => trash.slice(offset, offset + 200));
  await mount();
  act(() => state.filters.patch({ deleted_only: true })); await settle();
  await act(async () => { await state.data.loadMore(); });
  expect(state.data.gens).toHaveLength(200);
  act(() => state.filters.patch({ tab: "my" })); await settle();
  act(() => state.filters.patch({ tab: "team" })); await settle();
  expect(state.data.gens).toHaveLength(200);
  await act(async () => { await state.data.loadMore(); });
  expect(vi.mocked(api.listTrash).mock.calls.at(-1)?.[1]).toBe(400);
  expect(state.data.gens).toHaveLength(300);
  expect(new Set(state.data.gens.map((g) => g.id)).size).toBe(300);
});

it("공간 필터로 빈 휴지통의 추가 조회 실패는 자동 재시도를 멈추고 새로고침을 안내한다", async () => {
  vi.mocked(api.listTrash).mockImplementation(async (_search, offset = 0) => {
    if (offset) throw new Error("fixture network failure");
    return Array.from({ length: 200 }, (_, i) => ({ ...gen(`other-${i}`, B), deleted: true }));
  });
  await mount();
  act(() => state.filters.patch({ deleted_only: true })); await settle();
  expect(state.data.hasMore).toBe(true);
  await act(async () => { await state.data.loadMore(); });
  expect(state.data.gens).toEqual([]);
  expect(state.data.hasMore).toBe(false);
  expect(state.data.loadError).toContain("새로고침");
  vi.mocked(api.listTrash).mockResolvedValue([{ ...gen("restored", A), deleted: true }]);
  await act(async () => { await state.data.reload(); });
  expect(state.data.loadError).toBeNull();
  expect(state.data.gens.map((g) => g.id)).toEqual(["restored"]);
});

it("공유만 현재 공간을 따르고 저장 수동 필터·다음 생성 목적지·태그는 보존", async () => {
  await mount();
  expect(state.filters.genQuery.workspace_ids).toEqual(["a"]);
  expect(state.filters.filters.workspace_ids).toEqual(["saved-manual"]);
  expect(state.data.gens.map((g) => g.id)).toEqual(["a1"]);
  act(() => state.filters.patch({ tab: "my" })); await settle();
  expect(state.filters.genQuery.workspace_ids).toEqual(["saved-manual"]);
  expect(state.filters.workspaceFollow).toBeUndefined();
  expect(state.filters.generationScope).toEqual({ project_id: "create", folder_path: "destination" });
  expect([...state.filters.armedAutoTags]).toEqual(["create-tag"]);
});

it("전체보기는 현재공간 한정이며 공간 전환 시 교체, 이름 보강만으로는 모드 유지", async () => {
  await mount();
  act(() => state.filters.workspaceFollow!.onChange("all")); await settle();
  expect(state.data.gens).toHaveLength(5);
  workspace = { ...A, name: "R&D renamed" }; render();
  expect(state.filters.workspaceFollow?.mode).toBe("all");
  workspace = B; render(); await settle();
  expect(state.filters.workspaceFollow?.mode).toBe("auto");
  expect(state.filters.genQuery.workspace_ids).toEqual(["b"]);
  expect(state.data.gens.map((g) => g.id)).toEqual(["b1"]);
  workspace = A; render(); await settle();
  expect(state.filters.genQuery.workspace_ids).toEqual(["a"]);
});

it("개인 모드는 다른 생성자의 개인 공유물도 포함하고 team·unknown 제외", async () => {
  workspace = personal; await mount();
  expect(state.filters.genQuery.workspace_scope).toBe("personal");
  expect(state.filters.genQuery.workspace_ids).toBeUndefined();
  expect(state.data.gens.map((g) => g.id)).toEqual(["p1", "p2"]);
});

it("공유 공간·자동/전체 전환은 생성자 선택만 해제하고 내 작업의 선택은 보존한다", async () => {
  await mount();
  act(() => state.filters.patch({ creator_uid: "old-creator" })); await settle();
  workspace = B; render(); await settle();
  expect(state.filters.filters.creator_uid).toBeUndefined();
  act(() => state.filters.patch({ creator_uid: "other-creator" })); await settle();
  act(() => state.filters.workspaceFollow!.onChange("all")); await settle();
  expect(state.filters.filters.creator_uid).toBeUndefined();
  act(() => state.filters.patch({ creator_uid: "third-creator" })); await settle();
  act(() => state.filters.workspaceFollow!.onChange("auto")); await settle();
  expect(state.filters.filters.creator_uid).toBeUndefined();
  act(() => state.filters.patch({ tab: "my", creator_uid: "my-creator" })); await settle();
  workspace = A; render(); await settle();
  expect(state.filters.filters.creator_uid).toBe("my-creator");
});

it("미확인에서는 조회하지 않고 명시적 전체보기 가능; ID만 확인돼도 팀 조회 가능", async () => {
  workspace = { scope: "unknown", id: null, name: null }; await mount();
  expect(api.listGenerations).not.toHaveBeenCalled();
  expect(state.filters.workspaceFollow?.pending).toBe(true);
  act(() => state.filters.workspaceFollow!.onChange("all")); await settle();
  expect(state.data.gens).toHaveLength(5);
  workspace = { ...A, name: null }; render(); await settle();
  expect(state.filters.workspaceQueryReady).toBe(true);
  expect(state.data.gens.map((g) => g.id)).toEqual(["a1"]);
});

it("공간 전환은 표시 폴더만 해제하고 선택·옛 카드 즉시 제거, 늦은 응답 폐기", async () => {
  await mount();
  act(() => { state.filters.followLocation({ project_id: "project-a", folder_path: "shots" });
    state.select.setSelected(new Set(["a1"])); }); await settle();
  const late = deferred<Generation[]>();
  vi.mocked(api.listGenerations).mockReturnValueOnce(late.promise);
  act(() => { void state.data.reload(); });
  workspace = B; render();
  expect(host.textContent).not.toContain("a1");
  expect(state.select.selected.size).toBe(0);
  expect(state.filters.filters.project_id).toBeUndefined();
  expect(state.filters.generationScope).toEqual({ project_id: "create", folder_path: "destination" });
  late.resolve([cards[0]]); await settle();
  expect(state.data.gens.map((g) => g.id)).toEqual(["b1"]);
});

it("다빈치 복수 선택 조회에 공간조건 전달, 같은공간만 표시·강조하고 필터 유지", async () => {
  await mount();
  act(() => state.follow.receive(["a1", "b1"], false)); await settle();
  expect(api.locateGenerations).toHaveBeenCalledWith(expect.objectContaining({ workspace_ids: ["a"] }));
  expect([...state.follow.highlightedIds]).toEqual(["a1"]);
  expect(state.filters.genQuery.workspace_ids).toEqual(["a"]);
  expect(state.filters.filters.project_id).toBe("project-a");
  expect(state.data.isLocatedView).toBe(true);
  expect(state.filters.generationScope).toEqual({ project_id: "create", folder_path: "destination" });
  act(() => state.filters.patch({ tab: "my" })); await settle();
  expect(state.filters.genQuery.workspace_ids).toEqual(["saved-manual"]);
});

it("재시작 자동복귀는 과거 표시폴더를 해제하되 레거시 생성목적지를 보존", async () => {
  store.setJSON("filtersV2", { tab: "team", project_id: "old-view", folder_path: "old-folder", __v: "2" });
  render(); await settle();
  expect(state.filters.filters.project_id).toBeUndefined();
  expect(state.filters.genQuery.workspace_ids).toEqual(["a"]);
  expect(state.filters.generationScope).toEqual({ project_id: "old-view", folder_path: "old-folder" });
  act(() => state.filters.workspaceFollow!.onChange("all"));
  act(() => state.filters.followLocation({ project_id: "project-b", folder_path: "other" }));
  act(() => root.unmount()); root = createRoot(host); render(); await settle();
  expect(state.filters.workspaceFollow?.mode).toBe("auto");
  expect(state.filters.filters.project_id).toBeUndefined();
  expect(state.filters.generationScope).toEqual({ project_id: "old-view", folder_path: "old-folder" });
});

it.each(["other", "old-server", "late"])("다빈치 %s 응답은 공간범위를 바꾸거나 카드를 주입하지 않음", async (kind) => {
  await mount();
  const late = deferred<GenerationLocation>();
  if (kind === "late") vi.mocked(api.locateGenerations).mockReturnValueOnce(late.promise);
  else vi.mocked(api.locateGenerations).mockResolvedValue({ ...location([cards[kind === "other" ? 1 : 0]]),
    workspace_filter_applied: kind === "old-server" ? undefined : true });
  act(() => state.follow.receive(["a1"], false));
  if (kind === "late") { workspace = B; render(); late.resolve(location([cards[0]])); }
  await settle();
  expect(state.filters.filters.project_id).toBeUndefined();
  expect(state.follow.highlightedIds.size).toBe(0);
  expect(state.data.gens.map((g) => g.id)).toEqual([kind === "late" ? "b1" : "a1"]);
});
