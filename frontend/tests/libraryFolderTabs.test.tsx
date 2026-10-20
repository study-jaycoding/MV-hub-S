// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLibraryFilters } from "../src/lib/useLibraryFilters";
import { useLibraryFolderTabs } from "../src/lib/useLibraryFolderTabs";
import { FolderTabs } from "../src/components/common/FolderTabs";
import { SearchBox } from "../src/components/SearchBox";
import type { Store } from "../src/lib/storage";
import type { WorkspaceContext } from "../src/types";
import { usePlaceView } from "../src/lib/usePlaceView";
import { placeViewKey } from "../src/lib/placeViews";

let host: HTMLDivElement, root: Root, store: Store;
let library: ReturnType<typeof useLibraryFilters>;
let shownView: ReturnType<typeof usePlaceView>;
let tabs: ReturnType<typeof useLibraryFolderTabs>;
let workspace: WorkspaceContext, enabled: boolean, locked: boolean, auth: string, peek: boolean;
const navigate = vi.fn();
function Probe() {
  const base = useLibraryFilters(store, workspace, peek);
  shownView = usePlaceView(store, placeViewKey(base.filters), { scale: base.scale, fill: base.fill });
  library = { ...base, scale: shownView.scale, setScale: shownView.setScale, fill: shownView.fill, setFill: shownView.setFill };
  tabs = useLibraryFolderTabs({
    library, authKey: auth, enabled, canLeave: () => !locked,
    onNavigate: navigate,
  });
  return <><SearchBox value={library.filters.search} onSearch={(search) => library.patch({ search })}
    resetKey={JSON.stringify([library.storedTab, tabs.active, auth, library.teamScopeKey])} />
    <FolderTabs label="폴더 탭" active={tabs.active}
    tabs={tabs.tabs.map((tab) => ({ id: tab.id, view: { dir: tab.view.filters.folder_path || "", project: tab.view.projectName ?? tab.view.filters.project_id } }))}
    onSelect={tabs.select} onClose={tabs.close} onReorder={tabs.reorder} /></>;
}
const render = () => act(() => root.render(<Probe />));
const path = (value: string) => act(() => library.patch({ project_id: "p", folder_path: value }));
const choose = (path: string) => act(() => tabs.select(tabs.tabs.find((tab) => tab.view.filters.folder_path === path)!.id));
const main = (tab: "my" | "team") => act(() => {
  if (!tabs.resume(tab)) library.setFilters({ tab });
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const data: Record<string, string> = {};
  store = {
    get: (key, fallback) => data[key] ?? fallback,
    set: (key, value) => void (data[key] = value),
    loadJSON: <T,>(key: string) => data[key] ? JSON.parse(data[key]) as T : null,
    setJSON: (key, value) => void (data[key] = JSON.stringify(value)),
    loadSet: (key) => new Set(data[key] ? JSON.parse(data[key]) as string[] : []),
    setSet: (key, value) => void (data[key] = JSON.stringify([...value])),
  };
  workspace = { scope: "team", id: "a", name: "A" };
  enabled = true; locked = false; peek = false; auth = "account-a";
  navigate.mockClear();
  render();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("폴더 탭 추가는 현재 화면을 유지하고 직접 탭을 선택할 때만 이동한다", () => {
  path("e001");
  const active = tabs.active;
  const armed = library.armedFolder;
  act(() => tabs.openFolder("p", "e020"));
  act(() => tabs.openFolder("p", "e020"));
  expect(tabs.tabs).toHaveLength(2);
  expect(tabs.active).toBe(active);
  expect(library.filters.folder_path).toBe("e001");
  expect(library.armedFolder).toBe(armed);
  expect(navigate).not.toHaveBeenCalled();
  choose("e020");
  expect(library.filters.folder_path).toBe("e020");
  expect(tabs.tabs.find((tab) => tab.id === tabs.active)?.view.filters.folder_path).toBe("e020");
  expect(library.armedFolder).toEqual({ projectId: "p", path: "e020" });
  expect(navigate).toHaveBeenCalledTimes(1);
});

it("탭마다 검색·필터·크기와 폴더/전체 보기를 기억하며 다른 프로젝트의 같은 폴더도 연다", () => {
  path("e001");
  act(() => { library.patch({ search: "original" }); library.setScale(0.8); library.setTypeFilter("image"); });
  act(() => tabs.openFolder("p", "e020"));
  choose("e020");
  expect(library.filters.search).toBeUndefined();
  act(() => { library.patch({ search: "second" }); library.setScale(1.4); library.setTypeFilter("video"); });
  act(() => tabs.openFolder("other", "e020"));
  expect(tabs.tabs).toHaveLength(3);
  choose("e001");
  expect(library.filters.search).toBe("original");
  expect(library.scale).toBe(0.8);
  expect(library.typeFilter).toBe("image");
  choose("e020");
  expect(library.filters.search).toBe("second");
  expect(library.scale).toBe(1.4);
});

it("미들클릭으로 다시 연 폴더는 탭을 만든 부모의 값 대신 그 폴더의 보기·크기·맞춤을 복원한다", () => {
  path("e001");
  act(() => {
    shownView.setLayout("list"); shownView.setGroupByDate(true);
    shownView.setScale(0.8); shownView.setFill(false); shownView.setFolders(false);
  });
  path("e020");
  act(() => {
    shownView.setLayout("grid"); shownView.setGroupByDate(false);
    shownView.setScale(1.6); shownView.setFill(true); shownView.setFolders(true);
  });
  act(() => tabs.openFolder("p", "e001"));
  choose("e001");
  expect([shownView.layout, shownView.groupByDate, library.scale, library.fill, shownView.folders])
    .toEqual(["list", true, 0.8, false, false]);
  choose("e020");
  expect([shownView.layout, shownView.groupByDate, library.scale, library.fill, shownView.folders])
    .toEqual(["grid", false, 1.6, true, true]);
  act(() => tabs.close(tabs.tabs.find((tab) => tab.view.filters.folder_path === "e001")!.id));
  act(() => tabs.openFolder("p", "e001"));
  choose("e001");
  expect([shownView.layout, library.scale, library.fill, shownView.folders]).toEqual(["list", 0.8, false, false]);
});

it("워크스페이스와 공유 탭의 묶음이 서로 덮이지 않고 전체 공유 범위에서도 작동한다", () => {
  path("my-folder");
  act(() => tabs.openFolder("p", "my-background"));
  main("team");
  act(() => library.workspaceFollow!.onChange("all"));
  path("team-folder");
  act(() => tabs.openFolder("p", "team-background"));
  expect(tabs.tabs).toHaveLength(2);
  main("my");
  expect(library.filters).toMatchObject({ tab: "my", folder_path: "my-folder" });
  expect(tabs.tabs.map((tab) => tab.view.filters.folder_path)).toEqual(["my-folder", "my-background"]);
  main("team");
  expect(library.filters).toMatchObject({ tab: "team", folder_path: "team-folder" });
  expect(tabs.tabs.map((tab) => tab.view.filters.folder_path)).toEqual(["team-folder", "team-background"]);
});

it("편집 팝업의 임시 공유 필터를 주 화면 탭에 저장하지 않는다", () => {
  path("my-folder");
  act(() => tabs.openFolder("p", "background"));
  enabled = false; peek = true; render();
  expect(library.filters.tab).toBe("team");
  expect(tabs.tabs[0].view.filters.tab).toBe("my");
  act(() => tabs.openFolder("bad", "popup"));
  expect(tabs.tabs).toHaveLength(2);
  peek = false; enabled = true; render();
  choose("background");
  choose("my-folder");
  expect(library.filters.tab).toBe("my");
});

it("계정 또는 공유 공간 변경 후 이전 범위의 폴더 탭을 복원하지 않는다", () => {
  path("private-a");
  act(() => tabs.openFolder("p", "private-b"));
  auth = "account-b"; render();
  expect(tabs.tabs).toHaveLength(1);
  main("team");
  path("space-a");
  act(() => tabs.openFolder("p", "space-a-background"));
  main("my");
  workspace = { scope: "team", id: "b", name: "B" }; render();
  main("team");
  expect(library.filters.folder_path).toBeUndefined();
  expect(tabs.tabs).toHaveLength(1);
});

it("뒤로가기 등 외부 위치 변경은 현재 탭에 반영하며 복원 효과로 덮지 않는다", () => {
  path("e001");
  act(() => tabs.openFolder("p", "e020"));
  choose("e020");
  act(() => library.restoreLocation({ project_id: "p", folder_path: "e003" }, true));
  expect(tabs.tabs.find((tab) => tab.id === tabs.active)?.view.filters.folder_path).toBe("e003");
  choose("e001");
  choose("e003");
  expect(library.filters.folder_path).toBe("e003");
});

it("잠긴 목록에서는 전환·활성 닫기를 막고 비활성 닫기·정렬은 탐색을 만들지 않는다", () => {
  path("first");
  act(() => tabs.openFolder("p", "second"));
  const first = tabs.tabs.find((tab) => tab.view.filters.folder_path === "first")!.id;
  const second = tabs.tabs.find((tab) => tab.view.filters.folder_path === "second")!.id;
  choose("first");
  navigate.mockClear();
  locked = true; render();
  act(() => { expect(tabs.select(second)).toBe(false); tabs.close(first); });
  expect(tabs.tabs).toHaveLength(2);
  act(() => tabs.reorder(second, first));
  expect(tabs.tabs[0].id).toBe(second);
  act(() => tabs.close(second));
  expect(tabs.tabs).toHaveLength(1);
  expect(navigate).not.toHaveBeenCalled();
});

it("같은 Assets 탭 UI로 화살표 전환·미들클릭 닫기·마지막 탭 유지", () => {
  path("first");
  act(() => tabs.openFolder("p", "second"));
  choose("first");
  const first = host.querySelector<HTMLElement>('[role="tab"]')!;
  act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(library.filters.folder_path).toBe("second");
  const selected = host.querySelector<HTMLElement>('[aria-selected="true"]')!;
  expect(document.activeElement).toBe(selected);
  act(() => selected.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true })));
  expect(library.filters.folder_path).toBe("first");
  expect(tabs.tabs).toHaveLength(1);
  const lastClose = host.querySelector<HTMLButtonElement>(".scene-del")!;
  expect(lastClose.disabled).toBe(true);
  act(() => lastClose.click());
  expect(library.filters.folder_path).toBe("first");
  act(() => tabs.close(tabs.active));
  expect(tabs.tabs).toHaveLength(1);
});

it("입력 직후 탭 전환·활성 탭 닫기는 앞 탭의 예약 검색을 취소한다", () => {
  vi.useFakeTimers();
  path("first");
  act(() => tabs.openFolder("p", "second"));
  choose("first");
  const input = host.querySelector("input")!;
  const type = (text: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  type("first pending");
  choose("second");
  act(() => vi.advanceTimersByTime(350));
  expect(library.filters.search).toBeUndefined();
  expect(input.value).toBe("");
  type("second pending");
  act(() => tabs.close(tabs.active));
  act(() => vi.advanceTimersByTime(350));
  expect(library.filters).toMatchObject({ folder_path: "first" });
  expect(library.filters.search).toBeUndefined();
  expect(input.value).toBe("");
});

it("배경 탭 추가는 입력 중인 검색과 현재 활성 탭을 바꾸지 않는다", () => {
  vi.useFakeTimers();
  path("first");
  const active = tabs.active;
  const input = host.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "pending search");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => tabs.openFolder("p", "second"));
  expect(tabs.active).toBe(active);
  expect(input.value).toBe("pending search");
  expect(navigate).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(350));
  expect(library.filters).toMatchObject({ folder_path: "first", search: "pending search" });
  choose("second");
  expect(library.filters.search).toBeUndefined();
});

it("보관함 프로젝트 루트도 받은 이름을 유지해 전체 탭과 구분한다", () => {
  act(() => tabs.openFolder("archive-a", "", "지난 작업 A"));
  act(() => tabs.openFolder("archive-b", "", "지난 작업 B"));
  const a = tabs.tabs.find((tab) => tab.view.filters.project_id === "archive-a")!.id;
  act(() => tabs.select(a));
  expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain("지난 작업 A");
  expect([...host.querySelectorAll(".scene-tab-name")].map((el) => el.textContent)).toContain("지난 작업 B");
  main("team"); main("my");
  expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain("지난 작업 A");
});

it("탭별 자동태그 조회 복원은 다음 생성 태그를 바꾸지 않는다", () => {
  path("first");
  act(() => library.toggleAutoTag("tag-a"));
  act(() => tabs.openFolder("p", "second"));
  choose("second");
  act(() => library.toggleAutoTag("tag-a"));
  expect([...library.filterAutoTags]).toEqual([]);
  expect([...library.armedAutoTags]).toEqual([]);
  choose("first");
  expect([...library.filterAutoTags]).toEqual(["tag-a"]);
  expect(library.genQuery.auto_tags).toEqual(["tag-a"]);
  expect([...library.armedAutoTags]).toEqual([]);
  choose("second");
  expect([...library.filterAutoTags]).toEqual([]);
  expect([...library.armedAutoTags]).toEqual([]);
});
